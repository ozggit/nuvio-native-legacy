import http from 'node:http';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { equal, validateRemote, cleanHeaders, resourceUrl, ffmpegArgs, inputArgs } from './lib.mjs';
import { createNativeApi } from './native.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const data = path.resolve(process.env.NUVIO_DATA || path.join(root, 'data'));
const cache = path.join(data, 'cache');
const port = Number(process.env.NUVIO_PORT || 8787);
const adminPort = Number(process.env.NUVIO_ADMIN_PORT || 8788);
const ffmpeg = process.env.FFMPEG || 'ffmpeg';
const ffprobe = process.env.FFPROBE || 'ffprobe';
const adminSecret = randomBytes(24).toString('hex');
await fs.mkdir(cache, { recursive: true });
let config;
try { config = JSON.parse(await fs.readFile(path.join(data, 'config.json'), 'utf8')); }
catch (e) {
  if (e.code !== 'ENOENT') throw e;
  const ips = Object.values(os.networkInterfaces()).flat().filter(x => x.family === 'IPv4' && !x.internal);
  const preferred = ips.find(x => x.address.startsWith('192.168.1.')) || ips[0];
  config = { token: randomBytes(24).toString('hex'), upstream: '', baseUrl: `http://${preferred?.address || '127.0.0.1'}:${port}`, language: 'eng', maxCacheGB: 24 };
  await saveConfig();
}
async function saveConfig() {
  const target = path.join(data, 'config.json');
  await fs.writeFile(target + '.tmp', JSON.stringify(config, null, 2), { mode: 0o600 });
  await fs.rename(target + '.tmp', target);
}
// Only cache directories owned by this application are removed, never media sources.
for (const item of await fs.readdir(cache, { withFileTypes: true }))
  if (item.isDirectory() && /^[a-f0-9]{24}$/.test(item.name)) await fs.rm(path.join(cache, item.name), { recursive: true, force: true });

const tickets = new Map(), sessions = new Map();
let lastError = '', upstreamManifest = null, closing = false;
const log = message => console.log(`${new Date().toISOString()} ${message}`);
function fail(message, status = 400) { return Object.assign(new Error(message), { status }); }
function json(res, code, value) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}
async function body(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) throw fail('Request too large.', 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks)); } catch { throw fail('Invalid JSON.'); }
}
async function remoteFetch(raw, headers = {}, method = 'GET', signal) {
  let u = await validateRemote(raw);
  let h = cleanHeaders(headers);
  for (let i=0; i<6; i++) {
    const r = await fetch(u, { method, headers: h, redirect: 'manual', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(25000)]) : AbortSignal.timeout(25000) });
    if ([301,302,303,307,308].includes(r.status)) {
      await r.body?.cancel();
      const next = await validateRemote(new URL(r.headers.get('location'), u).href);
      if (next.origin !== u.origin) h = Object.fromEntries(Object.entries(h).filter(([k]) => !['authorization','cookie'].includes(k.toLowerCase())));
      u = next; continue;
    }
    if (!r.ok) { await r.body?.cancel(); throw fail(`Upstream returned HTTP ${r.status}.`, 502); }
    return { response: r, url: u.href, headers: h };
  }
  throw fail('Too many upstream redirects.', 502);
}
async function remoteJson(url) {
  const { response } = await remoteFetch(url);
  const chunks = []; let size = 0; const reader = response.body.getReader();
  try {
    for (;;) { const {value,done} = await reader.read(); if (done) break;
      chunks.push(Buffer.from(value)); size += value.length;
      if (size > 8*1024*1024) throw fail('Upstream response too large.', 502);
    }
  } finally { await reader.cancel().catch(()=>{}); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw fail('Upstream did not return JSON. Check the saved manifest URL.', 502); }
}
function runCapture(exe, args, timeout = 45000) {
  return new Promise((resolve,reject) => {
    const p = spawn(exe,args,{windowsHide:true}); let out='', err='';
    const timer = setTimeout(()=>{ p.kill(); reject(fail('Media inspection timed out.',504)); },timeout);
    p.stdout.on('data',b=>{out+=b; if(out.length>4*1024*1024)p.kill();});
    p.stderr.on('data',b=>{err=(err+b).slice(-6000);});
    p.once('error',()=>{clearTimeout(timer); reject(fail(`${path.basename(exe)} could not start. Check its installation.`,500));});
    p.once('close',code=>{clearTimeout(timer); if(code===0)resolve(out); else reject(fail('Media inspection failed. The source may have expired or may require different headers.',502));});
  });
}
function ticket(source) {
  const id = createHash('sha256').update(JSON.stringify(source)).digest('hex').slice(0,24);
  tickets.set(id, { ...source, created: Date.now() });
  if(tickets.size>2000)tickets.delete(tickets.keys().next().value);
  return id;
}
function streamUrl(id) { return `${config.baseUrl}/play/${config.token}/${id}/index.m3u8`; }
async function createSession(id) {
  if(sessions.has(id))return sessions.get(id).ready;
  const source = tickets.get(id);
  if(!source)throw fail('This stream link expired. Open the film again in Nuvio.',410);
  const s = {id, loading:true, running:false, lastAccess:Date.now(), bytes:0, error:'', title:source.title||'Stream'};
  sessions.set(id,s);
  s.ready = (async()=>{
    await Promise.all([...sessions.keys()].filter(other=>other!==id).map(stopSession));
    if(s.stopping)throw fail('Playback was cancelled.',410);
    lastError='';
    let input = {...source};
    if(!source.demo) {
      // Resolve HTTP redirects before passing the source to FFmpeg.
      const r = await remoteFetch(source.url,source.headers);
      await r.response.body?.cancel(); input.url=r.url; input.headers=r.headers;
    }
    const probe = JSON.parse(await runCapture(ffprobe,['-v','error',...inputArgs(input.url,input.headers),'-show_streams','-show_format','-of','json']));
    if(s.stopping)throw fail('Playback was cancelled.',410);
    const format = probe.format?.format_name || '';
    if(!/matroska|webm|mov|mp4|mpegts|avi/.test(format))throw fail('Use a direct MKV, MP4, TS or AVI file. Nested playlists are not supported in this version.',422);
    s.duration=Number(probe.format?.duration||0); s.directory=path.join(cache,id);
    await fs.mkdir(s.directory,{recursive:true});
    if(s.stopping)throw fail('Playback was cancelled.',410);
    const built = ffmpegArgs(input,probe,s.directory,Number(process.env.NUVIO_READRATE||1));
    s.audio = `${built.audio.codec_name} → AC-3 ${built.channels===6?'5.1':built.channels+' channels'}`;
    s.video = `${built.video.codec_name} copied`;
    s.language = built.audio.tags?.language || 'unspecified';
    s.channels = built.channels;
    s.process=spawn(ffmpeg,built.args,{windowsHide:true});
    s.running=true; s.loading=false;
    let stderr='';
    s.process.stderr.on('data',b=>{stderr=(stderr+b).slice(-8000);});
    s.process.once('error',()=>{s.running=false;s.error='FFmpeg could not start.';lastError=s.error;});
    s.process.once('close',code=>{
      s.running=false;
      if(code!==0&&!s.stopping) {s.error='Conversion stopped unexpectedly. Try another source or check the source audio format.';lastError=s.error;}
      // Do not write FFmpeg stderr: it can contain private TorBox links.
      log(`Session ${id.slice(0,6)} ended (${code ?? 'stopped'}).`);
    });
    log(`Session ${id.slice(0,6)}: ${s.video}; ${s.audio}; ${s.language}.`);
    const deadline=Date.now()+60000;
    while(Date.now()<deadline) {
      if(s.error)throw fail(s.error,502);
      try { const p=await fs.readFile(path.join(s.directory,'index.m3u8'),'utf8'); if(p.includes('#EXTINF:'))return s; }catch{}
      if(!s.running)throw fail('FFmpeg stopped before a playable segment was produced.',502);
      await new Promise(r=>setTimeout(r,200));
    }
    throw fail('The first video segment took too long. Try a different source.',504);
  })().catch(e=>{s.loading=false;s.error=e.message;lastError=e.message;s.stopping=true;s.process?.kill();throw e;});
  return s.ready;
}
async function stopSession(id) {
  const s=sessions.get(id); if(!s)return;
  s.stopping=true;
  if(s.process && s.running) {
    await new Promise(resolve=>{s.process.once('close',resolve);s.process.kill();setTimeout(resolve,3000).unref();});
  }
  sessions.delete(id);
  if(s.directory)await fs.rm(s.directory,{recursive:true,force:true,maxRetries:5,retryDelay:200}).catch(()=>{});
}
async function fileResponse(req,res,file,type) {
  const st=await fs.stat(file).catch(()=>{throw fail('Segment is not available yet.',404);});
  let start=0,end=st.size-1,status=200;
  if(req.headers.range) {
    const m=/^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if(!m)throw fail('Invalid range.',416);
    if(!m[1])start=Math.max(0,st.size-Number(m[2]));
    else {start=Number(m[1]);if(m[2])end=Math.min(end,Number(m[2]));}
    if(start>end||start>=st.size) {res.writeHead(416,{'Content-Range':`bytes */${st.size}`});res.end();return;}
    status=206;
  }
  const headers={'Content-Type':type,'Content-Length':end-start+1,'Accept-Ranges':'bytes','Cache-Control':'private, max-age=300'};
  if(status===206)headers['Content-Range']=`bytes ${start}-${end}/${st.size}`;
  res.writeHead(status,headers);
  if(req.method==='HEAD')res.end();else await pipeline(createReadStream(file,{start,end}),res).catch(()=>{});
}
function cors(req,res) {
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Headers','Range, Content-Type');
  res.setHeader('Access-Control-Expose-Headers','Content-Length, Content-Range, Accept-Ranges');
  res.setHeader('X-Content-Type-Options','nosniff');
  if(req.method==='OPTIONS'){res.writeHead(204);res.end();return true;}
}
const native = createNativeApi({ config: () => config, ffmpeg, ffprobe,
  rate: Number(process.env.NUVIO_READRATE || 1),
  resolveSource: async (source, signal) => {
    const r = await remoteFetch(source.url, source.headers, 'GET', signal);
    await r.response.body?.cancel();
    return { url: r.url, headers: r.headers };
  } });
const playback=http.createServer(async(req,res)=>{
  if(await native.handle(req,res))return;
  if(cors(req,res))return;
  const started=Date.now();
  const requestKind=req.url.includes('/play/')?(req.url.endsWith('.ts')?'segment':req.url.endsWith('/media.m3u8')?'media playlist':'master playlist'):req.url.includes('/stream/')?'stream list':null;
  if(requestKind)res.once('close',()=>log(`${requestKind}: ${req.method} ${res.statusCode} in ${Date.now()-started}ms${res.writableFinished?'':' (client disconnected)'}.`));
  try {
    const u=new URL(req.url,'http://local');
    if(u.pathname==='/health'){json(res,200,{ok:true,name:'Nuvio PC Audio'});return;}
    const parts=u.pathname.split('/').filter(Boolean);
    if(parts[0]==='addon'&&equal(parts[1],config.token)) {
      if(!config.upstream)throw fail('Configure AIOStreams on the PC setup page first.',503);
      if(parts.length===3&&parts[2]==='manifest.json') {
        upstreamManifest ||= await remoteJson(config.upstream);
        const resources=upstreamManifest.resources||[];
        const sr=resources.find(r=>r==='stream'||r?.name==='stream');
        json(res,200,{id:'local.nuvio.pc.audio',version:'0.1.0',name:'PC Audio 5.1',
          description:'AIOStreams through your PC: video copied, English audio converted to Dolby Digital. Seek within converted buffer.',
          resources:[sr||'stream'],types:upstreamManifest.types||['movie','series'],catalogs:[],
          ...(upstreamManifest.idPrefixes?{idPrefixes:upstreamManifest.idPrefixes}:{}),behaviorHints:{configurable:false}});return;
      }
      if(parts[2]==='stream'&&parts.length>=5&&parts.length<=6) {
        const resource=parts.slice(2).join('/');
        if(!resource.endsWith('.json')||resource.includes('..'))throw fail('Invalid stream request.');
        const result=await remoteJson(resourceUrl(config.upstream,resource));
        const streams=[];
        for(const s of result.streams||[]) {
          if(!s.url||!/^https?:\/\//i.test(s.url))continue;
          const source={url:s.url,headers:cleanHeaders(s.behaviorHints?.proxyHeaders?.request),language:config.language,title:s.title||s.name||'Stream'};
          const id=ticket(source);
          const hints={...(s.behaviorHints||{}),notWebReady:false};
          delete hints.proxyHeaders;delete hints.filename;delete hints.videoSize;delete hints.videoHash;
          if(hints.bingeGroup)hints.bingeGroup+='-pc-ac3';
          streams.push({name:`PC 5.1 · ${s.name||'AIOStreams'}`,title:s.title,description:s.description,
            ...(s.subtitles?{subtitles:s.subtitles}:{}),url:streamUrl(id),behaviorHints:hints});
        }
        json(res,200,{streams,cacheMaxAge:0});return;
      }
      throw fail('Unknown add-on resource.',404);
    }
    if(parts[0]==='play'&&equal(parts[1],config.token)&&/^[a-f0-9]{24}$/.test(parts[2]||'')&&parts.length===4) {
      const id=parts[2],name=parts[3];
      if(name==='index.m3u8') {
        if(!tickets.has(id))throw fail('This stream link expired. Open the film again in Nuvio.',410);
        // Nuvio probes the selected URL with a short timeout before starting its player.
        // Return a real master playlist immediately, while the variant prepares in the background.
        if(req.method!=='HEAD')createSession(id).catch(e=>{lastError=e.message;});
        const master='#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-STREAM-INF:BANDWIDTH=160000000\nmedia.m3u8\n';
        res.writeHead(200,{'Content-Type':'application/vnd.apple.mpegurl','Content-Length':Buffer.byteLength(master),'Cache-Control':'no-store'});
        res.end(req.method==='HEAD'?'':master);return;
      }
      if(name==='media.m3u8') {
        const s=await createSession(id);s.lastAccess=Date.now();
        if(s.error)throw fail(s.error,502);
        let playlist=await fs.readFile(path.join(s.directory,'index.m3u8'),'utf8');
        if(playlist.includes('#EXT-X-MEDIA-SEQUENCE:0\n'))playlist=playlist.replace('#EXTM3U\n','#EXTM3U\n#EXT-X-START:TIME-OFFSET=0,PRECISE=NO\n');
        res.writeHead(200,{'Content-Type':'application/vnd.apple.mpegurl','Content-Length':Buffer.byteLength(playlist),'Cache-Control':'no-store'});
        res.end(req.method==='HEAD'?'':playlist);return;
      }
      if(/^seg-\d{6}\.ts$/.test(name)) {
        const s=sessions.get(id);if(!s)throw fail('Session expired. Select the stream again.',410);
        s.lastAccess=Date.now();s.delivering=true;await fileResponse(req,res,path.join(s.directory,name),'video/mp2t');return;
      }
    }
    if(parts[0]==='demo'&&equal(parts[1],config.token)&&parts[2]==='sample.mkv'&&parts.length===3) {
      await fileResponse(req,res,path.join(data,'sample.mkv'),'video/x-matroska');return;
    }
    // Compatible with AIOStreams' MediaFlow adapter. Optional alternative to the local add-on.
    if(u.pathname==='/generate_urls'&&req.method==='POST') {
      const b=await body(req);
      if(!Array.isArray(b.urls)||!b.urls.length||b.urls.length>250)throw fail('Invalid URL batch.');
      if(!equal(b.api_password,config.token)&&!b.urls.every(x=>equal(x.query_params?.api_password,config.token)))throw fail('Unauthorized.',401);
      const urls=b.urls.map(x=>streamUrl(ticket({url:x.destination_url,headers:cleanHeaders(x.request_headers),language:config.language,title:x.filename||'AIOStreams'})));
      json(res,200,{urls});return;
    }
    if(u.pathname==='/proxy/ip'&&equal(u.searchParams.get('api_password'),config.token)) {
      const r=await remoteJson('https://api.ipify.org?format=json');json(res,200,r);return;
    }
    throw fail('Not found.',404);
  }catch(e){if(!res.headersSent)json(res,e.status||500,{error:e.status?e.message:'Request failed. Check the setup page.'});else res.destroy();}
});

const admin=http.createServer(async(req,res)=>{
  try {
    const u=new URL(req.url,`http://127.0.0.1:${adminPort}`);
    if(!['127.0.0.1','localhost'].includes((req.headers.host||'').split(':')[0]))throw fail('Invalid setup host.',403);
    if(u.pathname==='/favicon.ico'){res.writeHead(204);res.end();return;}
    if(u.pathname==='/'&&req.method==='GET') {
      const html=(await fs.readFile(path.join(root,'native-setup.html'),'utf8')).replace('__ADMIN_TOKEN__',adminSecret);
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Frame-Options':'DENY',
        'Content-Security-Policy':"default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'"});res.end(html);return;
    }
    if(!equal(req.headers['x-setup-token'],adminSecret))throw fail('Reload the setup page.',403);
    if(u.pathname==='/api/status'&&req.method==='GET') {
      json(res,200,{configured:!!config.upstream,baseUrl:config.baseUrl,language:config.language,
        pairing: `${config.baseUrl}#${config.token}`, native: native.status(),
        addonUrl:`${config.baseUrl}/addon/${config.token}/manifest.json`,lastError,
        addresses:Object.values(os.networkInterfaces()).flat().filter(x=>x.family==='IPv4'&&!x.internal).map(x=>`http://${x.address}:${port}`),
        sessions:[...sessions.values()].map(s=>({id:s.id,title:s.title,loading:s.loading,running:s.running,delivering:!!s.delivering,audio:s.audio,video:s.video,language:s.language,channels:s.channels,duration:s.duration,cacheGB:(s.bytes/1e9).toFixed(2),error:s.error})),
        maxCacheGB:config.maxCacheGB});return;
    }
    if(u.pathname==='/api/native-config'&&req.method==='POST') {
      const b=await body(req);const base=new URL(b.baseUrl);
      const ips=Object.values(os.networkInterfaces()).flat().filter(x=>x.family==='IPv4'&&!x.internal).map(x=>x.address);
      if(base.protocol!=='http:'||!ips.includes(base.hostname)||Number(base.port)!==port||base.pathname!=='/'||base.search||base.hash||base.username||base.password)throw fail('Choose this PC’s local address.');
      config={...config,baseUrl:base.origin};await saveConfig();json(res,200,{ok:true});return;
    }
    if(u.pathname==='/api/config'&&req.method==='POST') {
      const b=await body(req);let upstream=String(b.upstream||'').trim().replace(/^stremio:\/\//,'https://');
      if(!upstream)upstream=config.upstream;
      resourceUrl(upstream,'stream/movie/test.json');
      const manifest=await remoteJson(upstream);
      if(!(manifest.resources||[]).some(r=>r==='stream'||r?.name==='stream'))throw fail('That add-on has no stream resource. Use your saved AIOStreams manifest.');
      const base=new URL(b.baseUrl||config.baseUrl);
      const localAddresses=Object.values(os.networkInterfaces()).flat().filter(x=>x.family==='IPv4').map(x=>x.address);
      if(base.protocol!=='http:'||!localAddresses.includes(base.hostname)||Number(base.port)!==port||base.pathname!=='/'||base.search||base.hash)throw fail('Choose this PC’s local network address from the list.');
      config={...config,upstream,baseUrl:base.origin,language:b.language==='first'?'und':'eng'};
      await saveConfig();upstreamManifest=manifest;
      json(res,200,{ok:true,name:manifest.name});return;
    }
    if(u.pathname==='/api/stop'&&req.method==='POST') {const b=await body(req);native.stop();await stopSession(b.id);json(res,200,{ok:true});return;}
    if(u.pathname==='/api/demo'&&req.method==='POST') {
      await fs.access(path.join(data,'sample.mkv')).catch(()=>{throw fail('The test clip has not been generated yet.',404);});
      const id=ticket({url:`http://127.0.0.1:${port}/demo/${config.token}/sample.mkv`,headers:{},language:'eng',title:'Local DTS 5.1 test clip',demo:true});
      json(res,200,{url:streamUrl(id)});return;
    }
    throw fail('Not found.',404);
  }catch(e){const message=e.status?e.message:'Setup request failed. Verify the URL and network connection.';if(e.status!==403&&e.status!==404)lastError=message;json(res,e.status||500,{error:message});}
});
const reaper=setInterval(async()=>{
  let total=0;
  for(const s of sessions.values()) {
    if(!s.loading&&Date.now()-s.lastAccess>90*1000){await stopSession(s.id);continue;}
    if(s.directory) {
      const files=await fs.readdir(s.directory).catch(()=>[]);
      s.bytes=(await Promise.all(files.map(f=>fs.stat(path.join(s.directory,f)).then(x=>x.size).catch(()=>0)))).reduce((a,b)=>a+b,0);
      total+=s.bytes;
    }
  }
  if(total>config.maxCacheGB*1e9) {
    for(const s of sessions.values())if(s.running){s.error='The temporary cache limit was reached. Stop this session on the setup page to clear it.';s.stopping=true;s.process.kill();lastError=s.error;}
  }
},15000);reaper.unref();
playback.listen(port,'0.0.0.0',()=>log(`Playback listening on port ${port}.`));
admin.listen(adminPort,'127.0.0.1',()=>log(`Setup: http://127.0.0.1:${adminPort}`));
for(const s of [playback,admin])s.on('error',e=>{log(`Cannot open server port (${e.code}).`);shutdown();});
async function shutdown() {
  if(closing)return;closing=true;clearInterval(reaper);playback.close();admin.close();
  native.close();
  await Promise.all([...sessions.keys()].map(stopSession));process.exit(0);
}
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
