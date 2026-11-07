import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createPairing } from '../pairing.mjs';

test('four-digit pairing: discovery, expiry, single use, attempt limit and old-code invalidation', async () => {
  const token='a'.repeat(48); let time=1000, beacon, stops=0;
  const pairing=createPairing({config:()=>({baseUrl:'http://192.168.1.110:8787',token}),now:()=>time,
    advertise:async b=>{beacon=b;return()=>{stops++;};}});
  const server=http.createServer(async(req,res)=>{if(!await pairing.handle(req,res)){res.writeHead(404);res.end();}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const url=`http://127.0.0.1:${server.address().port}/v1/pair`;
  const claim=(code,ticket=beacon.ticket,headers={})=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify({code,ticket})});
  try {
    assert.equal(pairing.status().state,'off');
    let s=await pairing.begin();assert.match(s.code,/^\d{4}$/);assert.equal(s.expiresAt,121000);
    assert.equal(beacon.address,'192.168.1.110');assert.equal(beacon.port,8787);assert.equal(beacon.active(),true);
    assert.equal('code' in beacon,false,'The PIN must not be advertised.');assert.equal('token' in beacon,false);
    assert.equal((await claim(s.code,beacon.ticket,{Origin:'https://example.com'})).status,403);
    assert.equal((await fetch(url)).status,405);
    const result=await claim(s.code);assert.equal(result.status,200);assert.deepEqual(await result.json(),{protocol:1,token});
    assert.equal(pairing.status().state,'paired');assert.equal(pairing.status().code,'');
    assert.equal(beacon.active(),false);assert.equal((await claim(s.code)).status,410);
    s=await pairing.begin();time=s.expiresAt;assert.equal((await claim(s.code)).status,410);assert.equal(pairing.status().state,'expired');
    s=await pairing.begin();const wrong=s.code==='0000'?'0001':'0000';
    for(let i=0;i<4;i++)assert.equal((await claim(wrong)).status,401);
    assert.equal((await claim(wrong)).status,429);assert.equal(pairing.status().state,'locked');
    assert.equal((await claim(s.code)).status,410);
    s=await pairing.begin();const old=beacon.ticket;const fresh=await pairing.begin();assert.notEqual(old,beacon.ticket);
    assert.equal((await claim(s.code,old)).status,410);assert.equal((await claim(fresh.code)).status,200);
    await pairing.begin();pairing.cancel();assert.equal(pairing.status().state,'cancelled');assert.equal(pairing.status().code,'');
    assert.ok(stops>=5);
  } finally { pairing.close();server.closeAllConnections();await new Promise(r=>server.close(r)); }
});
