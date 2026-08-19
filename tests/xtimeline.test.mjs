/**
 * X polling helpers under Node — Bun must not exist and must not be required.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = path.join(os.tmpdir(), 'rh-x-' + process.pid);
mkdirSync(dir, { recursive: true });
const cookiesPath = path.join(dir, 'cookies.json');
writeFileSync(cookiesPath, JSON.stringify([
  { name: 'auth_token', value: 'test-auth', domain: '.x.com' },
  { name: 'ct0', value: 'test-csrf', domain: '.x.com' },
]), 'utf8');

process.env.X_COOKIES_PATH = cookiesPath;
process.env.AUTOBUY_STATE_PATH = path.join(dir, 'state.json');
process.env.AUTOBUY_AUDIT_PATH = path.join(dir, 'audit.jsonl');

test('X cookie/auth path does not require Bun', async () => {
  assert.equal(globalThis.Bun, undefined);
  const { loadXCookies, loadXAuth } = await import('../src/xcookies.js');
  const cookies = await loadXCookies(cookiesPath);
  assert.equal(cookies[0].name, 'auth_token');
  const { auth } = await loadXAuth(cookiesPath);
  assert.equal(auth.authToken, 'test-auth');
  assert.equal(auth.csrfToken, 'test-csrf');
});

test('refreshXAuth under Node never throws Bun is not defined', async () => {
  assert.equal(globalThis.Bun, undefined);
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('ok', {
    status: 200,
    headers: { 'set-cookie': 'ct0=freshcsrf; Path=/' },
  });
  try {
    const { refreshXAuth, resetXTimelineCache } = await import('../src/xtimeline.js');
    resetXTimelineCache();
    const auth = await refreshXAuth(cookiesPath);
    assert.ok(auth.authToken);
    assert.notEqual(String(auth.csrfToken || ''), 'Bun is not defined');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('fetchHandleTweets with no Bun returns data or a genuine upstream error', async () => {
  assert.equal(globalThis.Bun, undefined);
  const origFetch = globalThis.fetch;
  const html = '<html><script id="__NEXT_DATA__" type="application/json">'
    + JSON.stringify({
      props: {
        pageProps: {
          timeline: {
            entries: [{
              content: {
                tweet: {
                  id_str: '123',
                  full_text: 'hi 0x1111111111111111111111111111111111111111',
                  created_at: 'Tue Aug 18 00:00:00 +0000 2026',
                },
              },
            }],
          },
        },
      },
    })
    + '</script></html>';
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('syndication.twitter.com')) {
      return new Response(html, { status: 200 });
    }
    return new Response('ok', { status: 200, headers: { 'set-cookie': 'ct0=x; Path=/' } });
  };
  try {
    const { fetchHandleTweets, resetXTimelineCache } = await import('../src/xtimeline.js');
    resetXTimelineCache();
    const tweets = await fetchHandleTweets('clockincoin', 5);
    assert.ok(Array.isArray(tweets));
    assert.equal(tweets[0].id, '123');
  } catch (e) {
    assert.equal(String(e.message).includes('Bun is not defined'), false, e.message);
    assert.match(String(e.message), /syndication|graphql|Request failed|X login|Cookie|auth_token|ct0|429/i);
  } finally {
    globalThis.fetch = origFetch;
  }
});
