import { refreshXAuth } from '../src/xtimeline.js';
import { BASE_HEADERS } from 'goat-x-pro';

const auth = await refreshXAuth('./cookies.json');
const handle = 'clockincoin';
const url = `https://syndication.twitter.com/srv/timeline-profile/screen-name/${handle}`;
const response = await fetch(url, {
  headers: {
    accept: 'text/html',
    cookie: auth.cookieString,
    'user-agent': BASE_HEADERS['user-agent'],
  },
});
console.log('status', response.status);
const html = await response.text();
console.log('html len', html.length);
const marker = '<script id="__NEXT_DATA__" type="application/json">';
const start = html.indexOf(marker);
console.log('next_data at', start);
if (start >= 0) {
  const jsonStart = start + marker.length;
  const jsonEnd = html.indexOf('</script>', jsonStart);
  const payload = JSON.parse(html.slice(jsonStart, jsonEnd));
  const entries = payload?.props?.pageProps?.timeline?.entries;
  console.log('entries type', Array.isArray(entries) ? entries.length : typeof entries);
  console.log('pageProps keys', Object.keys(payload?.props?.pageProps || {}));
  if (entries?.[0]) {
    const t = entries[0].content?.tweet;
    console.log('tweet keys', Object.keys(t || {}));
    console.log('id', t?.id, 'conv', t?.conversation_id_str);
    console.log('text', (t?.text || t?.full_text || '').slice(0, 120));
  }
}
