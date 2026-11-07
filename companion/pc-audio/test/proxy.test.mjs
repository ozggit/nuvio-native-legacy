import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cleanHeaders, chooseAudio, privateAddress, resourceUrl, ffmpegArgs, validateRemote } from '../lib.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
function run(exe,args){return new Promise((resolve,reject)=>{const p=spawn(exe,args,{windowsHide:true});let stdout='',stderr='';p.stdout.on('data',x=>stdout+=x);p.stderr.on('data',x=>stderr+=x);p.on('error',reject);p.on('close',c=>c===0?resolve(stdout):reject(Error(`${exe} exited ${c}: ${stderr.slice(-2500)}`)));});}

test('audio selection prefers English main audio and preserves source channel counts',()=>{
  const streams=[
    {index:1,codec_type:'audio',codec_name:'dts',channels:6,tags:{language:'spa'},disposition:{default:1}},
    {index:2,codec_type:'audio',codec_name:'dts',channels:8,tags:{language:'eng',title:'Main audio'}},
    {index:3,codec_type:'audio',codec_name:'aac',channels:2,tags:{language:'eng',title:'Director commentary'},disposition:{default:1}}
  ];
  assert.equal(chooseAudio(streams).index,2);
  const video={index:0,codec_type:'video',codec_name:'hevc'};
  const result=ffmpegArgs({url:'https://example.com/movie.mkv'}, {streams:[video,...streams]},'cache');
  assert.equal(result.channels,6);assert.equal(result.args[result.args.indexOf('-c:v')+1],'copy');
  assert.equal(result.args[result.args.indexOf('-c:a')+1],'ac3');
  assert.equal(ffmpegArgs({url:'https://example.com/x'}, {streams:[video,{...streams[2],index:1}]},'cache').channels,2);
});

test('add-on URL mapping retains saved configuration and query parameters',()=>{
  assert.equal(resourceUrl('https://example.com/private/manifest.json?ver=2','stream/series/tt1%3A1%3A2.json'),'https://example.com/private/stream/series/tt1%3A1%3A2.json?ver=2');
  assert.throws(()=>resourceUrl('https://example.com/configure','stream/movie/x.json'));
});

test('rejects local-network upstreams, non-HTTP URLs and injected headers',async()=>{
  for(const ip of ['127.0.0.1','192.168.1.1','10.0.0.1','172.16.1.1','169.254.169.254','::1','::ffff:127.0.0.1','::ffff:7f00:1'])assert.ok(privateAddress(ip));
  assert.equal(privateAddress('1.1.1.1'),false);
  await assert.rejects(validateRemote('file:///C:/Windows/win.ini'));
  await assert.rejects(validateRemote('http://127.0.0.1:8788/'));
  assert.throws(()=>cleanHeaders({Referer:'https://example.com/\r\nX-Evil: yes'}));
  assert.deepEqual(cleanHeaders({Host:'localhost',Range:'bytes=0-1','User-Agent':'Nuvio'}),{'User-Agent':'Nuvio'});
});

test('real HTTP playback: DTS 5.1 to AC3, H.264 and HEVC frames unchanged, byte ranges and access control', {timeout:180000},async()=>{
  const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'nuvio-audio-test-'));
  const playbackPort=18787,adminPort=18788;
  const server=spawn(process.execPath,[path.join(root,'server.mjs')],{cwd:root,windowsHide:true,env:{...process.env,NUVIO_DATA:tmp,NUVIO_PORT:String(playbackPort),NUVIO_ADMIN_PORT:String(adminPort),NUVIO_READRATE:'100'}});
  let logs='';server.stdout.on('data',b=>logs+=b);server.stderr.on('data',b=>logs+=b);
  try {
    let ready=false;
    for(let i=0;i<100;i++){try{ready=(await fetch(`http://127.0.0.1:${playbackPort}/health`)).ok;if(ready)break;}catch{}await new Promise(r=>setTimeout(r,100));}
    assert.ok(ready,logs);
    const html=await(await fetch(`http://127.0.0.1:${adminPort}/`)).text();
    const key=/const key='([a-f0-9]+)'/.exec(html)[1];
    const api=async(url,body)=>{const r=await fetch(`http://127.0.0.1:${adminPort}${url}`,{method:body?'POST':'GET',headers:{'X-Setup-Token':key,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});assert.ok(r.ok,await r.clone().text());return r.json();};
    assert.equal((await fetch(`http://127.0.0.1:${adminPort}/api/status`)).status,403);
    assert.equal((await fetch(`http://127.0.0.1:${playbackPort}/play/wrong/token/index.m3u8`)).status,404);
    assert.equal((await fetch(`http://127.0.0.1:${playbackPort}/generate_urls`,{method:'POST',body:JSON.stringify({urls:[{destination_url:'https://example.com/movie'}]})})).status,401);
    for(const codec of ['libx264','libx265']) {
      const source=path.join(tmp,'sample.mkv');
      await run('ffmpeg',['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','testsrc2=size=320x180:rate=24:duration=16','-f','lavfi','-i','aevalsrc=0.05*sin(2*PI*220*t)|0.05*sin(2*PI*330*t)|0.05*sin(2*PI*440*t)|0.05*sin(2*PI*60*t)|0.05*sin(2*PI*550*t)|0.05*sin(2*PI*660*t):s=48000:d=16:c=5.1','-map','0:v','-map','1:a','-map','1:a','-c:v',codec,'-preset','ultrafast','-g','48',...(codec==='libx265'?['-x265-params','log-level=error:pools=2']:[]),'-c:a','dca','-strict','-2','-b:a','1536k','-metadata:s:a:0','language=spa','-metadata:s:a:1','language=eng','-disposition:a:0','default','-disposition:a:1','0',source]);
      const demo=await api('/api/demo',{});
      const localUrl=demo.url.replace(/http:\/\/[^/]+/,`http://127.0.0.1:${playbackPort}`);
      assert.equal((await fetch(localUrl,{method:'HEAD'})).status,200);
      assert.equal((await api('/api/status')).sessions.length,0,'A metadata-only HEAD request must not start conversion.');
      const start=Date.now();
      const master=await(await fetch(localUrl)).text();
      assert.ok(master.includes('#EXT-X-STREAM-INF'));
      assert.ok(Date.now()-start<2000,'Nuvio preflight must receive a master playlist without waiting for transcoding.');
      const mediaUrl=new URL('media.m3u8',localUrl);
      let playlist='';
      for(let i=0;i<100;i++) {const r=await fetch(mediaUrl);assert.ok(r.ok,await r.clone().text());playlist=await r.text();if(playlist.includes('#EXT-X-ENDLIST'))break;await new Promise(r=>setTimeout(r,100));}
      assert.ok(playlist.includes('#EXT-X-ENDLIST'),playlist);
      const segments=playlist.split('\n').filter(x=>/^seg-\d+\.ts$/.test(x));assert.ok(segments.length>=2);
      const chunks=[];
      for(const segment of segments){const r=await fetch(new URL(segment,localUrl));assert.ok(r.ok);chunks.push(Buffer.from(await r.arrayBuffer()));}
      const combined=path.join(tmp,codec+'.ts');await fs.writeFile(combined,Buffer.concat(chunks));
      const info=JSON.parse(await run('ffprobe',['-v','error','-show_streams','-of','json',combined]));
      const audio=info.streams.find(x=>x.codec_type==='audio');assert.equal(audio.codec_name,'ac3');assert.equal(audio.channels,6);
      assert.equal(info.streams.find(x=>x.codec_type==='video').codec_name,codec==='libx264'?'h264':'hevc');
      async function frameHashes(file){return (await run('ffmpeg',['-v','error','-i',file,'-map','0:v:0','-f','framemd5','-'])).split('\n').filter(x=>x&&!x.startsWith('#')).map(x=>x.split(',').at(-1).trim());}
      assert.deepEqual(await frameHashes(combined),await frameHashes(source),'Every decoded video frame must remain identical.');
      const status=await api('/api/status');assert.equal(status.sessions[0].language,'eng');assert.equal(status.sessions[0].channels,6);
      const range=await fetch(new URL(segments[0],localUrl),{headers:{Range:'bytes=0-99'}});assert.equal(range.status,206);assert.equal((await range.arrayBuffer()).byteLength,100);
      const head=await fetch(new URL(segments[0],localUrl),{method:'HEAD'});assert.equal(head.status,200);assert.ok(Number(head.headers.get('content-length'))>100);
      await api('/api/stop',{id:status.sessions[0].id});assert.equal((await api('/api/status')).sessions.length,0);
    }
  }finally{
    server.kill();await new Promise(r=>{server.once('close',r);setTimeout(r,3000).unref();});
    const resolved=path.resolve(tmp), tempRoot=path.resolve(os.tmpdir());
    assert.ok(resolved.startsWith(tempRoot+path.sep)&&path.basename(resolved).startsWith('nuvio-audio-test-'));
    await fs.rm(resolved,{recursive:true,force:true,maxRetries:8,retryDelay:250});
  }
});
