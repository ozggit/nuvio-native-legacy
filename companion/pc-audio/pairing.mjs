import dgram from 'node:dgram';
import os from 'node:os';
import { randomBytes, randomInt } from 'node:crypto';
import { equal } from './lib.mjs';

export const discoveryPort = 8789;
const problem = (message, status) => Object.assign(new Error(message), { status });

// Outgoing advertisements need no new inbound UDP rule on the PC. The TV
// exchanges the PIN over the existing LAN HTTP port; no secret is broadcast.
async function announce({ address, port, ticket, active, failed }) {
  const nic = Object.values(os.networkInterfaces()).flat().find(n => n.family === 'IPv4' && n.address === address && !n.internal);
  if (!nic) throw problem('Select this PC’s Wi-Fi or LAN address first.', 400);
  const ip = address.split('.').map(Number), mask = nic.netmask.split('.').map(Number);
  const broadcast = ip.map((n, i) => n | (255 ^ mask[i])).join('.');
  const socket = dgram.createSocket('udp4');
  let timer, closed = false;
  const stop = () => { if (!closed) { closed = true; clearInterval(timer); socket.close(); } };
  await new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(0, address, () => { socket.removeListener('error', reject); resolve(); });
  }).catch(e => { stop(); throw e; });
  socket.on('error', () => { failed(); stop(); });
  try { socket.setBroadcast(true); } catch (e) { stop(); throw e; }
  const packet = Buffer.from(`NUVIO-PC-PAIR/1 ${port} ${ticket}`);
  const send = () => {
    if (!active()) { stop(); return; }
    socket.send(packet, discoveryPort, broadcast, e => { if (e && !closed) { failed(); stop(); } });
  };
  timer = setInterval(send, 750); timer.unref(); send();
  return stop;
}

export function createPairing({ config, now = Date.now, advertise = announce }) {
  let current = null;
  const end = (s, state) => { if (s) { s.state = state; s.code = ''; s.stop?.(); } };
  function status() {
    if (current?.state === 'waiting' && now() >= current.expiresAt) end(current, 'expired');
    return current ? { state: current.state, code: current.code, expiresAt: current.expiresAt } : { state: 'off', code: '' };
  }
  async function begin() {
    end(current, 'cancelled');
    const address = new URL(config().baseUrl);
    const s = current = { state: 'waiting', code: String(randomInt(10000)).padStart(4, '0'),
      ticket: randomBytes(16).toString('hex'), expiresAt: now() + 120000, failures: 0 };
    try {
      s.stop = await advertise({ address: address.hostname, port: Number(address.port), ticket: s.ticket,
        active: () => current === s && status().state === 'waiting', failed: () => end(s, 'error') });
      if (current !== s || s.state !== 'waiting') s.stop();
    } catch { end(s, 'error'); throw problem('Could not start local discovery. Check the selected network address.', 503); }
    return status();
  }
  async function handle(req, res) {
    if (new URL(req.url, 'http://local').pathname !== '/v1/pair') return false;
    let code = 200, result;
    try {
      if (req.headers.origin) throw problem('Browser access is disabled.', 403);
      if (req.method !== 'POST') throw problem('Method not allowed.', 405);
      let raw = '';
      for await (const chunk of req) { raw += chunk; if (raw.length > 1024) throw problem('Request too large.', 413); }
      let body; try { body = JSON.parse(raw); } catch { throw problem('Invalid pairing request.', 400); }
      const s = current;
      if (status().state !== 'waiting' || !s || !equal(body.ticket, s.ticket))
        throw problem('Generate a new code on the PC.', 410);
      if (typeof body.code !== 'string' || !/^\d{4}$/.test(body.code) || !equal(body.code, s.code)) {
        if (++s.failures >= 5) end(s, 'locked');
        throw problem(s.state === 'locked' ? 'Too many attempts. Generate a new code on the PC.' : 'Code did not match. Check the four digits on the PC.', s.state === 'locked' ? 429 : 401);
      }
      result = { protocol: 1, token: config().token };
      end(s, 'paired'); // Single use; the persistent key never appears in the UI.
    } catch (e) { code = e.status || 500; result = { error: e.status ? e.message : 'Pairing failed.' }; }
    res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(result)); return true;
  }
  return { begin, status, handle, cancel: () => end(current, 'cancelled'), close: () => end(current, 'cancelled') };
}
