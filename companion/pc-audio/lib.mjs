import { timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

export function equal(a, b) {
  const aa = Buffer.from(String(a ?? '')), bb = Buffer.from(String(b ?? ''));
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}

export function privateAddress(ip) {
  if (ip.startsWith('::ffff:') && isIP(ip.slice(7)) === 4) return privateAddress(ip.slice(7));
  if (isIP(ip) === 4) {
    const [a,b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  // Permit only globally routed IPv6 space. This also blocks hexadecimal IPv4-mapped loopback.
  return !/^[23]/i.test(ip) || /^2001:db8:/i.test(ip);
}

export async function validateRemote(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error('Enter a complete HTTP or HTTPS URL.'); }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.hash)
    throw new Error('Only HTTP/HTTPS URLs without embedded login credentials or fragments are supported.');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addresses = await lookup(host, { all: true });
  if (!addresses.length || addresses.some(a => privateAddress(a.address)))
    throw new Error('Upstream sources must use a public address.');
  return u;
}

export function cleanHeaders(input = {}) {
  const result = {};
  const permitted = new Set(['user-agent', 'referer', 'origin', 'authorization', 'cookie', 'accept', 'accept-language']);
  for (const [k,v] of Object.entries(input)) {
    if (!permitted.has(k.toLowerCase())) continue;
    if (typeof v !== 'string' || /[\r\n\0]/.test(v) || v.length > 8192) throw new Error('Invalid source header.');
    result[k] = v;
  }
  return result;
}

export function resourceUrl(manifest, resourcePath) {
  const u = new URL(manifest);
  if (!u.pathname.endsWith('/manifest.json')) throw new Error('Use the saved AIOStreams link ending in /manifest.json.');
  u.pathname = u.pathname.slice(0, -'manifest.json'.length) + resourcePath;
  return u.toString();
}

export function chooseAudio(streams, preferred = 'eng') {
  const audio = streams.filter(s => s.codec_type === 'audio');
  if (!audio.length) throw new Error('This source has no audio track.');
  const score = s => {
    const lang = String(s.tags?.language || '').toLowerCase();
    const english = preferred === 'eng' && ['eng','en','english'].includes(lang);
    return (english || lang === preferred ? 1000 : 0) +
      (/commentary|description|descriptive/i.test(s.tags?.title || '') ? -500 : 0) +
      (s.disposition?.default ? 20 : 0) + (s.channels >= 6 ? 10 : 0);
  };
  return audio.toSorted((a,b) => score(b)-score(a))[0];
}

export function inputArgs(url, headers = {}) {
  const args = ['-protocol_whitelist', 'http,https,tcp,tls,crypto', '-rw_timeout', '30000000', '-probesize', '5000000', '-analyzeduration', '1000000'];
  const h = cleanHeaders(headers);
  if (Object.keys(h).length) args.push('-headers', Object.entries(h).map(([k,v]) => `${k}: ${v}\r\n`).join(''));
  return [...args, '-i', url];
}

export function ffmpegArgs(source, probe, directory, rate = 1) {
  const video = probe.streams.find(s => s.codec_type === 'video' && !s.disposition?.attached_pic);
  if (!video || !['h264','hevc'].includes(video.codec_name))
    throw new Error('This version supports H.264 and HEVC video. Choose another source for other codecs.');
  const audio = chooseAudio(probe.streams, source.language || 'eng');
  const channels = audio.channels >= 6 ? 6 : Math.min(audio.channels || 2, 2);
  const args = ['-hide_banner', '-nostdin', '-loglevel', 'warning', '-y', '-readrate', String(rate), '-readrate_initial_burst', '20',
    ...inputArgs(source.url, source.headers), '-map', `0:${video.index}`, '-map', `0:${audio.index}`,
    '-c:v', 'copy', '-c:a', 'ac3', '-b:a', channels === 6 ? '640k' : '192k', '-ac', String(channels),
    '-ar', '48000', '-sn', '-dn', '-max_muxing_queue_size', '2048',
    '-avoid_negative_ts', 'make_zero', '-f', 'hls', '-hls_time', '6', '-hls_list_size', '120',
    '-hls_delete_threshold', '5', '-hls_flags', 'delete_segments+temp_file',
    '-hls_segment_filename', `${directory}/seg-%06d.ts`, `${directory}/index.m3u8`];
  return { args, audio, video, channels };
}
