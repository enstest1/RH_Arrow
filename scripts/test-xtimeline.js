/** Quick smoke test — UserTweets path for @clockincoin */
import { fetchHandleTweets } from '../src/xtimeline.js';

const tweets = await fetchHandleTweets('clockincoin', 3);
console.log('tweets:', tweets.length);
if (tweets[0]) console.log('latest:', tweets[0].text?.slice(0, 120));
