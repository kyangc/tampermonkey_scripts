import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
const { createMxgaVideoSource } = createRequire(import.meta.url)('../scripts/make-x-great-again.user.js');
const url = 'https://video.twimg.com/amplify_video/12/vid/720x1280/a.mp4?tag=29';
const media = (id, variants = [{content_type:'video/mp4', bitrate:100, url}]) => ({rest_id:id, legacy:{extended_entities:{media:[{type:'video',video_info:{variants}}]}}});
const environment = () => ({setTimeout,clearTimeout,location:{origin:'https://x.com',href:'https://x.com/home'}});
test('media index isolates tweet IDs, wrappers and quotes, and chooses highest bitrate', () => {
  const source = createMxgaVideoSource(environment());
  source.ingest({tweet:media('123',[{content_type:'video/mp4',bitrate:1,url:url.replace('a.mp4','low.mp4')},{content_type:'video/mp4',bitrate:100,url}]), quote:{tweet:media('456')}});
  assert.equal(source.get('123').items[0].url,url);
  assert.equal(source.get('456').items[0].filename,'x-456-1.mp4');
  assert.equal(source.get('789'),undefined);
  source.get('123').items[0].url='changed';
  assert.equal(source.get('123').items[0].url,url);
});
test('rejects unsafe URLs and incomplete mixed video collections', () => {
  const source=createMxgaVideoSource(environment());
  for (const value of ['http://video.twimg.com/a.mp4','https://video.twimg.com.evil/a.mp4','https://key@video.twimg.com/a.mp4','https://video.twimg.com:444/a.mp4','blob:https://x.com/a','https://video.twimg.com/a.m3u8']) assert.equal(source.videoUrl(value),'');
  const data=media('123'); data.legacy.extended_entities.media.push({type:'video',video_info:{variants:[{content_type:'application/x-mpegURL',url:'https://video.twimg.com/a.m3u8'}]}});
  source.ingest(data); assert.equal(source.get('123').unsupported,true); assert.deepEqual(source.get('123').items,[]);
});
test('bounds cache and expires it, ignores oversized input and private endpoints', () => {
  const source=createMxgaVideoSource(environment());
  for(let i=0;i<105;i++) source.ingest(media(String(i)));
  assert.equal(source.get('0'),undefined);assert.ok(source.get('104'));
  source.ingestText(' '.repeat(2*1024*1024+1));
  assert.equal(source.acceptUrl('https://x.com/i/api/graphql/id/TweetDetail'),true);
  assert.equal(source.acceptUrl('https://evil.com/i/api/graphql/id/TweetDetail'),false);
  assert.equal(source.acceptUrl('https://x.com/i/api/graphql/id/DmInbox'),false);
  const original=Date.now;try{Date.now=()=>original()+600001;assert.equal(source.get('104'),undefined)}finally{Date.now=original}
});
test('fetch observation preserves promise and original body; ignores unrelated responses', async () => {
  const env=environment();
  const response=new Response(JSON.stringify(media('123')),{headers:{'content-type':'application/json'}});
  Object.defineProperty(response,'url',{value:'https://x.com/i/api/graphql/id/TweetDetail'});
  const promise=Promise.resolve(response);env.fetch=()=>promise;
  const source=createMxgaVideoSource(env);
  assert.equal(env.fetch('unused'),promise);
  assert.equal((await (await promise).json()).rest_id,'123');
  await new Promise(r=>setTimeout(r,30)); assert.equal(source.get('123').items[0].url,url);
  assert.equal(createMxgaVideoSource(env),source);
});
test('XHR observation preserves send result and application listeners', () => {
  class XHR extends EventTarget {send(){return 42}getResponseHeader(){return 'application/json'}}
  const env=environment();env.XMLHttpRequest=XHR;const source=createMxgaVideoSource(env);
  const xhr=new XHR();Object.assign(xhr,{responseURL:'https://x.com/i/api/graphql/id/TweetDetail',status:200,responseType:'',responseText:JSON.stringify(media('123'))});
  let loaded=0;xhr.addEventListener('load',()=>loaded++);assert.equal(xhr.send(),42);xhr.dispatchEvent(new Event('load'));
  assert.equal(loaded,1);assert.equal(source.get('123').items[0].url,url);
});
test('resolution supports delayed page data and abort without a new request', async () => {
  const source=createMxgaVideoSource(environment());
  const pending=source.resolve('https://x.com/a/status/123');source.ingest(media('123'));assert.equal((await pending)[0].url,url);
  const controller=new AbortController();const cancelled=source.resolve('https://x.com/a/status/456',controller.signal);controller.abort();await assert.rejects(cancelled,/取消/);
});
