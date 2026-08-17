/**
 * xtimeline.js — fetch tweets for a handle via UserTweets (not SearchTimeline).
 *
 * X's SearchTimeline endpoint often 401/404s while UserByScreenName + UserTweets
 * still work with the same session cookies. autobuy.js uses this instead of search().
 */

import {
  ENDPOINTS,
  BASE_HEADERS,
  GRAPHQL_FEATURES,
  loadCookiesFromFile,
  extractAuthCredentials,
  extractCsrfFromSetCookie,
  cookiesToString,
  parseTimeline,
  extractInstructions,
  parseUser,
} from 'goat-x-pro';
import { ClientTransaction, handleXMigration } from 'x-client-transaction-id';

/** pro.x.com GraphQL often 401 without X Pro — try x.com first. */
const GQL_HOST = 'https://x.com/i/api/graphql';

function gqlUrl(path) {
  return `${GQL_HOST}/${path}`;
}

const GQL = {
  USER_BY_SCREEN_NAME: gqlUrl('jUKA--0QkqGIFhmfRZdWrQ/UserByScreenName'),
  USER_TWEETS: gqlUrl('2ItQrd86P8C0pDU6td3Z7Q/UserTweets'),
};

/** @type {Map<string, string>} handle → userId */
const userIdCache = new Map();

/** Cached x-client-transaction-id generator. */
let _txClient = null;

/**
 * Lazily build transaction-id signer from X homepage assets.
 */
async function getTransactionClient() {
  if (!_txClient) {
    const doc = await handleXMigration();
    _txClient = await ClientTransaction.create(doc);
  }
  return _txClient;
}
let _auth = null;
let _cookiesPath = null;

/**
 * Resolve cookies path from env or default.
 * @returns {string}
 */
function cookiesPath() {
  return process.env.X_COOKIES_PATH || './cookies.json';
}

/**
 * Build auth credentials and refresh CSRF from pro.x.com.
 * @param {string} [path]
 */
export async function refreshXAuth(path = cookiesPath()) {
  const cookies = await loadCookiesFromFile(path);
  let auth = extractAuthCredentials(cookies);

  const response = await fetch('https://x.com/home', {
    method: 'GET',
    headers: {
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
      cookie: auth.cookieString,
      'user-agent': BASE_HEADERS['user-agent'],
    },
  });

  if (!response.ok) {
    throw new Error(`X login failed: ${response.status} ${response.statusText}`);
  }

  const freshCsrf = extractCsrfFromSetCookie(response.headers.get('set-cookie'));
  if (freshCsrf) {
    auth = {
      ...auth,
      csrfToken: freshCsrf,
      // Keep full cookie jar — stripping to auth_token+ct0 alone breaks GraphQL for some sessions.
      cookieString: cookiesToString(
        cookies.map((c) => (c.name === 'ct0' ? { ...c, value: freshCsrf } : c)),
      ),
    };
  }

  _auth = auth;
  _cookiesPath = path;
  return auth;
}

/** Drop cached auth/user ids — call after cookie refresh or 401. */
export function resetXTimelineCache() {
  _auth = null;
  _cookiesPath = null;
  _txClient = null;
  userIdCache.clear();
}

/**
 * @param {import('goat-x-pro').AuthCredentials} auth
 * @param {string} endpoint
 * @param {Record<string, unknown>} variables
 */
async function graphqlGet(auth, endpoint, variables) {
  const params = new URLSearchParams({
    variables: JSON.stringify(variables),
    features: JSON.stringify(GRAPHQL_FEATURES),
  });
  const url = `${endpoint}?${params.toString()}`;
  const apiPath = new URL(url).pathname;
  const tx = await getTransactionClient();
  const transactionId = await tx.generateTransactionId('GET', apiPath);

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      ...BASE_HEADERS,
      'x-csrf-token': auth.csrfToken,
      cookie: auth.cookieString,
      'x-client-transaction-id': transactionId,
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Request failed: ${response.status} ${response.statusText}${text ? ' — ' + text.slice(0, 120) : ''}`);
  }

  const data = await response.json();
  if (data.errors?.length) {
    const fatal = data.errors.find((e) => e.kind !== 'NonFatal');
    if (fatal) throw new Error(fatal.message || 'GraphQL error');
  }
  return data;
}

/**
 * Resolve X user id for a screen name (cached per process).
 * @param {import('goat-x-pro').AuthCredentials} auth
 * @param {string} handle
 */
async function resolveUserId(auth, handle) {
  const key = handle.toLowerCase();
  if (userIdCache.has(key)) return userIdCache.get(key);

  const data = await graphqlGet(auth, GQL.USER_BY_SCREEN_NAME, {
    screen_name: handle,
    withGrokTranslatedBio: false,
  });

  const profile = parseUser(data?.data?.user?.result);
  if (!profile?.id) throw new Error(`User @${handle} not found`);

  userIdCache.set(key, profile.id);
  return profile.id;
}

/**
 * Fetch tweets via syndication embed API (works when GraphQL 401s).
 * @param {import('goat-x-pro').AuthCredentials} auth
 * @param {string} handle
 * @param {number} count
 * @returns {Promise<import('goat-x-pro').Tweet[]>}
 */
async function fetchViaSyndication(auth, handle, count, attempt = 0) {
  const url = `https://syndication.twitter.com/srv/timeline-profile/screen-name/${encodeURIComponent(handle)}`;
  const response = await fetch(url, {
    headers: {
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      cookie: auth.cookieString,
      'user-agent': BASE_HEADERS['user-agent'],
    },
  });

  if (response.status === 429 && attempt < 2) {
    // X syndication rate-limits aggressive polling — back off and retry.
    await new Promise((r) => setTimeout(r, 30000 * (attempt + 1)));
    return fetchViaSyndication(auth, handle, count, attempt + 1);
  }

  if (!response.ok) {
    throw new Error(`Syndication failed: ${response.status} ${response.statusText}`);
  }

  const html = await response.text();
  const marker = '<script id="__NEXT_DATA__" type="application/json">';
  const start = html.indexOf(marker);
  if (start === -1) throw new Error('Syndication: __NEXT_DATA__ not found');

  const jsonStart = start + marker.length;
  const jsonEnd = html.indexOf('</script>', jsonStart);
  const payload = JSON.parse(html.slice(jsonStart, jsonEnd));
  const entries = payload?.props?.pageProps?.timeline?.entries || [];

  /** @type {import('goat-x-pro').Tweet[]} */
  const tweets = [];
  for (const entry of entries) {
    const tweet = entry?.content?.tweet;
    if (!tweet) continue;
    const id = tweet.conversation_id_str || tweet.id_str || (tweet.id ? String(tweet.id) : null);
    const text = tweet.full_text || tweet.text;
    if (!id || id === '0' || !text) continue;
    tweets.push({
      id: String(id),
      text: String(text),
      username: handle,
      name: handle,
      userId: tweet.user_id_str || '',
      createdAt: tweet.created_at || '',
      timestamp: tweet.created_at ? Date.parse(tweet.created_at) : 0,
      likes: tweet.favorite_count ?? 0,
      retweets: tweet.retweet_count ?? 0,
      replies: tweet.reply_count ?? 0,
      quotes: tweet.quote_count ?? 0,
      bookmarks: 0,
      views: 0,
      isLiked: false,
      isRetweeted: false,
      isBookmarked: false,
      isReply: Boolean(tweet.in_reply_to_status_id_str),
      isRetweet: Boolean(tweet.retweeted_status_id_str),
      isQuoted: false,
      urls: [],
      hashtags: [],
      mentions: [],
      photos: [],
      videos: [],
      sensitiveContent: false,
    });
    if (tweets.length >= count) break;
  }

  if (!tweets.length) throw new Error('Syndication returned no tweets');
  return tweets;
}

/**
 * Fetch latest tweets for a handle.
 * Tries GraphQL UserTweets first; falls back to syndication embed API on 401.
 * @param {string} handle — without @
 * @param {number} [count=10]
 * @returns {Promise<import('goat-x-pro').Tweet[]>}
 */
export async function fetchHandleTweets(handle, count = 10) {
  const path = cookiesPath();
  if (!_auth || _cookiesPath !== path) await refreshXAuth(path);

  // Syndication embed API is reliable for public profiles; GraphQL often 401s.
  try {
    return await fetchViaSyndication(_auth, handle, count);
  } catch (syndErr) {
    // GraphQL always 401 on this account — don't waste time when syndication is rate-limited.
    if (/429|Too Many Requests/i.test(String(syndErr.message))) throw syndErr;
    if (!_auth?.csrfToken) await refreshXAuth(path);
    // Last resort: GraphQL UserTweets (needs valid x-client-transaction-id).
    try {
      const userId = await resolveUserId(_auth, handle);
      const data = await graphqlGet(_auth, GQL.USER_TWEETS, {
        userId,
        count,
        includePromotedContent: false,
        withQuickPromoteEligibilityTweetFields: true,
        withVoice: true,
      });
      const instructions = extractInstructions(data);
      const { tweets } = parseTimeline(instructions);
      return (tweets || []).slice(0, count);
    } catch (gqlErr) {
      throw new Error(`syndication: ${syndErr.message} | graphql: ${gqlErr.message}`);
    }
  }
}
