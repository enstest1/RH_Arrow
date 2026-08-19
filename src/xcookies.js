/**
 * xcookies.js — Node-safe cookie load for the X fallback path.
 *
 * goat-x-pro's loadCookiesFromFile uses Bun.file(); we never call it.
 */
import { readFile } from 'node:fs/promises';
import { extractAuthCredentials, cookiesToString } from 'goat-x-pro';

/**
 * Normalize EditThisCookie / simple cookie objects.
 * @param {Record<string, unknown>} cookie
 */
function normalizeCookie(cookie) {
  return {
    name: String(cookie.name ?? cookie.key ?? ''),
    value: String(cookie.value ?? ''),
    domain: String(cookie.domain ?? '.x.com'),
    path: String(cookie.path ?? '/'),
    expires: typeof cookie.expires === 'number' ? cookie.expires : undefined,
    httpOnly: Boolean(cookie.httpOnly ?? cookie.http_only ?? false),
    secure: Boolean(cookie.secure ?? true),
    sameSite: String(cookie.sameSite ?? cookie.same_site ?? 'None'),
  };
}

/**
 * Load cookies from X_COOKIES_JSON or a JSON file. Never uses Bun.
 * @param {string} [filePath]
 * @returns {Promise<import('goat-x-pro').Cookie[]>}
 */
export async function loadXCookies(filePath) {
  const rawJson = (process.env.X_COOKIES_JSON || '').trim();
  let parsed;
  if (rawJson) {
    parsed = JSON.parse(rawJson);
  } else {
    const path = filePath || process.env.X_COOKIES_PATH || './cookies.json';
    const content = await readFile(path, 'utf8');
    parsed = JSON.parse(content);
  }

  if (Array.isArray(parsed)) return parsed.map(normalizeCookie);
  if (parsed?.cookies && Array.isArray(parsed.cookies)) return parsed.cookies.map(normalizeCookie);
  throw new Error('Invalid cookie file format. Expected array or { cookies: [...] }');
}

/**
 * Auth credentials from Node-loaded cookies.
 * @param {string} [filePath]
 */
export async function loadXAuth(filePath) {
  const cookies = await loadXCookies(filePath);
  return { cookies, auth: extractAuthCredentials(cookies), cookiesToString };
}
