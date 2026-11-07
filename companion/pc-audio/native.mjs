import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { equal, inputArgs, cleanHeaders, chooseAudio } from './lib.mjs';

const problem = (message, status = 400) => Object.assign(new Error(message), { status });
const idPattern = /^[a-f0-9]{32}$/;

export function planAudio(source, probe) {
  const video = probe.streams?.find(s => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const audio = chooseAudio(probe.streams || [], source.language || 'eng');
  // Auto mode offloads only codecs this implementation knows need conversion.
  const convert = ['dts', 'truehd', 'mlp'].includes(audio.codec_name);
  if (convert && (!video || !['h264', 'hevc'].includes(video.codec_name)))
    throw problem('PC audio supports copied H.264 or HEVC video for this test.', 422);
  const duration = Number(probe.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0)
    throw problem('PC audio requires a finite movie or episode.', 422);
  if (source.start >= duration) throw problem('Requested position is past the end.', 422);
  if (convert && !Number.isInteger(audio.channels)) throw problem('The source channel count is unknown.', 422);
  const channels = Math.min(audio.channels, 6);
  const audioOrdinal = probe.streams.filter(s => s.codec_type === 'audio').indexOf(audio);
  return { video, audio, audioOrdinal, channels, duration, convert };
}

export function tsArgs(source, plan, rate = 1) {
  const input = inputArgs(source.url, source.headers);
  const inputStart = source.inputStart ?? source.start;
  if (inputStart > 0) input.unshift('-ss', String(inputStart), '-noaccurate_seek');
  return ['-hide_banner', '-nostdin', '-loglevel', 'error',
    '-readrate', String(rate), '-readrate_initial_burst', '8', ...input,
    '-map', `0:${plan.video.index}`, '-map', `0:${plan.audio.index}`,
    '-c:v', 'copy', '-c:a', 'ac3', '-b:a', plan.channels > 2 ? '640k' : '192k',
    '-ac', String(plan.channels), '-ar', '48000', '-sn', '-dn',
    '-metadata:s:a:0', `language=${plan.audio.tags?.language || 'und'}`,
    '-metadata:s:a:0', 'title=PC AC-3',
    '-max_muxing_queue_size', '2048', '-avoid_negative_ts', 'make_zero',
    '-f', 'mpegts', '-mpegts_flags', '+resend_headers', '-muxdelay', '0', '-muxpreload', '0', 'pipe:1'];
}

// One current session, bounded pipes (no movie cache), and no source URLs in logs.
export function createNativeApi({ config, resolveSource, ffmpeg = 'ffmpeg', ffprobe = 'ffprobe', rate = 1 }) {
  let current = null;
  function publicState(s) {
    return { id: s.id, state: s.state, error: s.error || '', duration: s.plan?.duration || 0,
      start: s.source.start, mode: s.plan ? (s.plan.convert ? 'pc' : 'direct') : '',
      audio: s.plan ? `${s.plan.audio.codec_name}${s.plan.convert ? ' → AC-3' : ''}` : '',
      channels: s.plan ? (s.plan.convert ? s.plan.channels : s.plan.audio.channels) : 0,
      language: s.plan?.audio.tags?.language || '', video: s.plan?.video?.codec_name || '',
      audioOrdinal: s.plan?.audioOrdinal ?? -1,
      bytesSent: s.bytes || 0,
      // A capability URL scoped to one session, never the long-lived pairing token.
      ...(s.state === 'ready' && s.plan.convert ? { path: `/v1/media/${s.id}/${s.capability}/stream.ts` } : {}) };
  }
  function stop(s) {
    if (!s) return;
    s.stopped = true; s.state = 'stopped'; s.controller.abort();
    s.probe?.kill(); s.encoder?.kill(); s.response?.destroy();
  }
  function capture(s, args) {
    return new Promise((resolve, reject) => {
      if (s.stopped) return reject(problem('Session cancelled.', 410));
      const p = s.probe = spawn(ffprobe, args, { windowsHide: true });
      let result = '';
      const timer = setTimeout(() => { p.kill(); reject(problem('Media inspection timed out.', 504)); }, 45000);
      p.stdout.on('data', b => { result += b; if (result.length > 4 * 1024 * 1024) p.kill(); });
      p.stderr.resume(); // May contain signed URLs; never persist or display it.
      p.on('error', () => { clearTimeout(timer); reject(problem('FFprobe could not start.', 500)); });
      p.on('close', code => { clearTimeout(timer); s.probe = null;
        code === 0 ? resolve(result) : reject(problem('Media inspection failed. Check the source or required headers.', 502)); });
    });
  }
  async function prepare(s) {
    try {
      const resolved = await resolveSource(s.source, s.controller.signal);
      if (s.stopped) return;
      s.source = { ...s.source, ...resolved };
      const probe = JSON.parse(await capture(s, ['-v', 'error', ...inputArgs(s.source.url, s.source.headers),
        '-show_streams', '-show_format', '-of', 'json']));
      if (s.stopped) return;
      if (!/matroska|webm|mov|mp4|mpegts|avi/.test(probe.format?.format_name || ''))
        throw problem('Use a direct media file; nested playlists are not supported.', 422);
      s.plan = planAudio(s.source, probe);
      if (s.plan.convert && s.source.start > 0) {
        // Report the actual video keyframe used for a stream-copy seek. Never
        // pretend an arbitrary requested timestamp can be an exact copied cut.
        const packets = JSON.parse(await capture(s, ['-v', 'error', '-read_intervals', `${s.source.start}%+#1`,
          ...inputArgs(s.source.url, s.source.headers), '-select_streams', 'v:0',
          '-show_packets', '-show_entries', 'packet=pts_time,flags', '-of', 'json']));
        const packet = packets.packets?.[0];
        const offset = Number(packet?.pts_time) - Number(probe.format?.start_time || 0);
        if (!Number.isFinite(offset) || !packet.flags?.includes('K'))
          throw problem('This source cannot provide a safe video-copy seek.', 422);
        s.source.inputStart = s.source.start;
        s.source.start = Math.max(0, offset);
      }
      if (!s.stopped) s.state = 'ready';
    } catch (e) {
      if (!s.stopped) { s.state = 'error'; s.error = e.status ? e.message : 'PC media preparation failed.'; }
    }
  }
  async function readBody(req) {
    let text = '';
    for await (const chunk of req) { text += chunk; if (text.length > 65536) throw problem('Request too large.', 413); }
    try { return JSON.parse(text); } catch { throw problem('Invalid JSON.'); }
  }
  const json = (res, code, value) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
  async function handle(req, res) {
    const u = new URL(req.url, 'http://local');
    if (!u.pathname.startsWith('/v1/')) return false;
    try {
      if (req.headers.origin) throw problem('Browser access to the native API is disabled.', 403);
      const parts = u.pathname.split('/').filter(Boolean);
      if (parts[1] === 'media') {
        const s = current;
        if (parts.length !== 5 || parts[4] !== 'stream.ts' || !s || s.stopped || parts[2] !== s.id ||
            !equal(parts[3], s.capability)) throw problem('Playback session expired.', 410);
        if (!['GET', 'HEAD'].includes(req.method)) throw problem('Method not allowed.', 405);
        if (s.state !== 'ready' || !s.plan?.convert) throw problem('Session is not ready.', 409);
        s.access = Date.now();
        // A continuous response cannot satisfy arbitrary byte ranges. Initial
        // probes may request bytes=0-; a real seek creates a new time session.
        if (req.headers.range && !/^bytes=0-\d*$/.test(req.headers.range)) throw problem('Use a time-based session to seek.', 416);
        if (req.method === 'HEAD') { res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Accept-Ranges': 'none', 'Cache-Control': 'no-store' }); res.end(); return true; }
        if (s.encoder) throw problem('This session already has a stream reader.', 409);
        const encoder = s.encoder = spawn(ffmpeg, tsArgs(s.source, s.plan, rate), { windowsHide: true });
        s.response = res;
        encoder.stderr.resume();
        encoder.on('error', () => { s.error = 'FFmpeg could not start.'; s.state = 'error'; res.destroy(); });
        encoder.on('close', code => {
          if (s.encoder === encoder) { s.encoder = null; s.response = null; }
          if (code !== 0 && !s.stopped && !res.destroyed) { s.state = 'error'; s.error = 'Audio conversion stopped unexpectedly.'; res.destroy(); }
        });
        res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Accept-Ranges': 'none', 'Cache-Control': 'no-store' });
        res.on('close', () => { encoder.kill(); s.access = Date.now(); });
        encoder.stdout.on('data', b => { s.bytes += b.length; s.access = Date.now(); });
        // pipeline propagates backpressure into FFmpeg; memory stays bounded on pause.
        pipeline(encoder.stdout, res).catch(() => {});
        return true;
      }
      if (!equal(req.headers.authorization, `Bearer ${config().token}`)) throw problem('Pair this TV with the PC first.', 401);
      if (parts.length === 2 && parts[1] === 'health' && req.method === 'GET') { json(res, 200, { protocol: 1, transport: 'mpegts' }); return true; }
      if (parts[1] !== 'sessions' || parts.length !== 3 || !idPattern.test(parts[2])) throw problem('Not found.', 404);
      const id = parts[2];
      if (req.method === 'PUT') {
        const b = await readBody(req);
        if (typeof b.url !== 'string' || b.url.length > 16384 || !/^https?:\/\//i.test(b.url)) throw problem('A direct HTTP media URL is required.');
        const start = Number(b.start ?? 0);
        if (!Number.isFinite(start) || start < 0) throw problem('Invalid playback position.');
        // Native sends its raw source headers in JSON, never in a URL.
        let headers = b.headers || {};
        if (typeof headers === 'string') {
          headers = Object.fromEntries(headers.split(/\r?\n/).filter(Boolean).map(line => {
            const colon = line.indexOf(':'); if (colon <= 0) throw problem('Invalid source headers.');
            return [line.slice(0, colon).trim(), line.slice(colon + 1).trim()];
          }));
        }
        headers = cleanHeaders(headers);
        if (current?.id === id) { json(res, 200, publicState(current)); return true; }
        stop(current);
        const s = current = { id, source: { url: b.url, headers, start, language: 'eng' },
          state: 'preparing', capability: randomBytes(24).toString('hex'), controller: new AbortController(), access: Date.now(), bytes: 0 };
        void prepare(s);
        json(res, 202, publicState(s)); return true;
      }
      if (req.method === 'DELETE') {
        if (current?.id === id) { stop(current); current = null; }
        json(res, 200, { stopped: true }); return true;
      }
      if (req.method !== 'GET') throw problem('Method not allowed.', 405);
      if (!current || current.id !== id) throw problem('Session expired.', 410);
      current.access = Date.now(); json(res, 200, publicState(current));
    } catch (e) { if (!res.headersSent) json(res, e.status || 500, { error: e.status ? e.message : 'Native API request failed.' }); else res.destroy(); }
    return true;
  }
  const timer = setInterval(() => { if (current && !current.encoder && Date.now() - current.access > 90000) { stop(current); current = null; } }, 10000);
  timer.unref();
  return { handle, status: () => current ? publicState(current) : null,
    stop: () => { stop(current); current = null; }, close: () => { clearInterval(timer); stop(current); current = null; } };
}
