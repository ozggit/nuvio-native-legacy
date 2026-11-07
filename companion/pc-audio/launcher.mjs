import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
const root=path.dirname(fileURLToPath(import.meta.url)),data=path.join(root,'data');
const health=async()=>{try{const r=await fetch('http://127.0.0.1:8787/health',{signal:AbortSignal.timeout(1000)});return await r.json();}catch{return null;}};
try {
  if(process.argv[2]==='stop') {
    if(!(await health())?.nativeProtocol) throw Error('The native PC Audio companion is not running.');
    const page=await(await fetch('http://127.0.0.1:8788/',{signal:AbortSignal.timeout(2000)})).text();
    const token=/const key='([a-f0-9]{48})'/.exec(page)?.[1];
    if(!token)throw Error('Could not identify the companion setup page.');
    const response=await fetch('http://127.0.0.1:8788/api/shutdown',{method:'POST',headers:{'X-Setup-Token':token},signal:AbortSignal.timeout(5000)});
    if(!response.ok)throw Error('The companion refused to stop.');
    console.log('PC Audio companion stopped.');
  } else {
    let running=await health();
    if(running&&!running.nativeProtocol)throw Error('Another service is using port 8787. Stop the old proxy first.');
    if(!running) {
      for(const executable of ['ffmpeg','ffprobe'])if(spawnSync(executable,['-version'],{windowsHide:true,stdio:'ignore'}).status!==0)throw Error(`${executable} must be installed and available on PATH.`);
      fs.mkdirSync(data,{recursive:true});
      const out=fs.openSync(path.join(data,'server.log'),'a'),err=fs.openSync(path.join(data,'server-error.log'),'a');
      const child=spawn(process.execPath,[path.join(root,'server.mjs')],{cwd:root,windowsHide:true,detached:true,stdio:['ignore',out,err]});
      child.on('error',()=>{});child.unref();fs.closeSync(out);fs.closeSync(err);
      fs.writeFileSync(path.join(data,'server.pid'),String(child.pid));
      for(let i=0;i<50;i++){running=await health();if(running?.nativeProtocol)break;await new Promise(r=>setTimeout(r,100));}
      if(!running?.nativeProtocol)throw Error('The companion did not start. See data/server-error.log.');
    }
    spawn('rundll32.exe',['url.dll,FileProtocolHandler','http://127.0.0.1:8788'],{windowsHide:true,detached:true,stdio:'ignore'}).unref();
    console.log('PC Audio is running. Its status page is open in your browser.');
  }
}catch(e){console.error(e.message);process.exitCode=1;}
