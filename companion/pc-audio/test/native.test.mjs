import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createNativeApi, planAudio } from '../native.mjs';

function run(exe,args) { return new Promise((resolve,reject) => {
  const p=spawn(exe,args,{windowsHide:true});let out='',err='';
  p.stdout.on('data',x=>out+=x);p.stderr.on('data',x=>err+=x);
  p.on('error',reject);p.on('close',c=>c===0?resolve(out):reject(Error(`${exe}: ${err.slice(-1500)}`)));
}); }
const sleep = ms => new Promise(r=>setTimeout(r,ms));
test('auto mode converts unsupported audio only, preserves mono/stereo and downmixes 7.1',()=>{
  const base={format:{duration:'20'},streams:[{index:0,codec_type:'video',codec_name:'hevc'}]};
  for(const [codec,channels,convert,out] of [['ac3',6,false,6],['eac3',8,false,6],['aac',2,false,2],['dts',6,true,6],['truehd',8,true,6],['dts',2,true,2],['dts',1,true,1]]) {
    const p=planAudio({start:0},{...base,streams:[...base.streams,{index:1,codec_type:'audio',codec_name:codec,channels}]});
    assert.equal(p.convert,convert);assert.equal(p.channels,out);
  }
});

test('native sessions: real DTS and TrueHD conversion, copied frames, seeks, headers, cancellation and isolation',{timeout:180000},async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'nuvio-native-test-'));
  const token=randomBytes(24).toString('hex');let sourceFile='';let seenHeaders=0;
  const source=http.createServer(async(req,res)=>{
    if(req.headers.authorization!=='Bearer fixture'){res.writeHead(403);res.end();return;}
    seenHeaders++;
    const stat=await fs.stat(sourceFile);let start=0,end=stat.size-1;
    if(req.headers.range){const m=/bytes=(\d+)-(\d*)/.exec(req.headers.range);start=Number(m[1]);if(m[2])end=Math.min(end,Number(m[2]));res.statusCode=206;res.setHeader('Content-Range',`bytes ${start}-${end}/${stat.size}`);}
    res.setHeader('Content-Length',end-start+1);res.setHeader('Accept-Ranges','bytes');
    createReadStream(sourceFile,{start,end}).pipe(res);
  });
  await new Promise(r=>source.listen(0,'127.0.0.1',r));
  const sourceUrl=`http://127.0.0.1:${source.address().port}/movie.mkv`;
  let delayPrepare=false;
  // Local source allowance exists only in this injected test resolver.
  const native=createNativeApi({config:()=>({token}),rate:100,resolveSource:async s=>{if(delayPrepare)await sleep(300);return s;}});
  const server=http.createServer(async(req,res)=>{if(!await native.handle(req,res)){res.writeHead(404);res.end();}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${server.address().port}`;
  const request=(url,method='GET',body,extra={})=>fetch(base+url,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json',...extra},...(body?{body:JSON.stringify(body)}:{})});
  const create=async(start=0)=>{
    const id=randomBytes(16).toString('hex');
    const r=await request(`/v1/sessions/${id}`,'PUT',{url:sourceUrl,headers:'Authorization: Bearer fixture\r\n',start});
    assert.equal(r.status,202);return id;
  };
  const ready=async id=>{for(let n=0;n<300;n++){const r=await request(`/v1/sessions/${id}`);assert.ok(r.ok);const s=await r.json();if(s.state==='error')throw Error(s.error);if(s.state==='ready')return s;await sleep(50);}throw Error('Preparation timeout');};
  const probe=async file=>JSON.parse(await run('ffprobe',['-v','error','-show_streams','-show_format','-of','json',file]));
  const hashes=async file=>(await run('ffmpeg',['-v','error','-i',file,'-map','0:v:0','-f','framemd5','-'])).split('\n').filter(l=>l&&!l.startsWith('#')).map(l=>l.split(',').at(-1).trim());
  try {
    assert.equal((await fetch(base+'/v1/health')).status,401);
    assert.equal((await request('/v1/health','GET',null,{Origin:'https://attacker.example'})).status,403);
    assert.equal((await request('/v1/health')).status,200);
    for(const [video,audio,layout] of [['libx264','dca','5.1'],['libx265','truehd','7.1']]) {
      sourceFile=path.join(directory,`${video}.mkv`);
      const channels=layout==='7.1'?8:6;
      const expression=Array.from({length:channels},(_,i)=>`0.03*sin(2*PI*${110+i*80}*t)`).join('|');
      await run('ffmpeg',['-v','error','-y','-f','lavfi','-i','testsrc2=size=320x180:rate=24:duration=10',
        '-f','lavfi','-i',`aevalsrc=${expression}:s=48000:d=10:c=${layout}`,
        '-map','0:v','-map','1:a','-map','1:a','-c:v',video,'-preset','ultrafast','-g','48',
        ...(video==='libx265'?['-x265-params','log-level=error:pools=2']:[]),'-c:a',audio,'-strict','-2',
        '-metadata:s:a:0','language=spa','-metadata:s:a:1','language=eng','-disposition:a:0','default','-disposition:a:1','0',sourceFile]);
      const id=await create();const s=await ready(id);assert.equal(s.mode,'pc');assert.equal(s.channels,6);assert.equal(s.language,'eng');
      assert.equal((await fetch(base+s.path,{method:'HEAD'})).status,200);assert.equal(native.status().bytesSent,0);
      assert.equal((await fetch(base+s.path,{headers:{Range:'bytes=200-'}})).status,416);
      const r=await fetch(base+s.path);assert.equal(r.status,200);assert.equal(r.headers.get('content-type'),'video/mp2t');
      const output=path.join(directory,`${video}.ts`);await fs.writeFile(output,Buffer.from(await r.arrayBuffer()));
      const p=await probe(output);assert.equal(p.streams.find(s=>s.codec_type==='audio').codec_name,'ac3');assert.equal(p.streams.find(s=>s.codec_type==='audio').channels,6);
      assert.deepEqual(await hashes(output),await hashes(sourceFile),'All decoded video frames are identical.');
      const seekId=await create(5.25);const seek=await ready(seekId);assert.ok(seek.start>=0&&seek.start<=5.25,JSON.stringify(seek));
      assert.equal((await fetch(base+s.path)).status,410,'Old capability cannot play a replaced session.');
      const seekFile=path.join(directory,'seek.ts');await fs.writeFile(seekFile,Buffer.from(await(await fetch(base+seek.path)).arrayBuffer()));
      const seekHashes=await hashes(seekFile), originalHashes=await hashes(sourceFile);
      assert.ok(seekHashes.length>0&&seekHashes.length<originalHashes.length);
      const first=originalHashes.indexOf(seekHashes[0]);assert.ok(first>=0);
      assert.ok(Math.abs(first/24-seek.start)<0.1,`Reported seek ${seek.start} matches copied frame ${first/24}`);
      assert.deepEqual(seekHashes,originalHashes.slice(first));
      assert.equal((await request(`/v1/sessions/${seekId}`,'DELETE')).status,200);
      assert.equal(native.status(),null);
    }
    delayPrepare=true;const old=await create();await request(`/v1/sessions/${old}`,'DELETE');const fresh=await create();await ready(fresh);
    assert.equal(native.status().id,fresh,'Cancelled preparation cannot replace the new session.');
    await request(`/v1/sessions/${old}`,'DELETE');assert.equal(native.status().id,fresh,'Late stop cannot cancel a newer source.');
    assert.ok(seenHeaders>4,'Both probe and converter forward required source headers.');
  } finally {
    native.close();server.closeAllConnections();source.closeAllConnections();
    await Promise.all([new Promise(r=>server.close(r)),new Promise(r=>source.close(r))]);
    assert.ok(directory.startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(directory).startsWith('nuvio-native-test-'));
    await fs.rm(directory,{recursive:true,force:true,maxRetries:8,retryDelay:200});
  }
});
