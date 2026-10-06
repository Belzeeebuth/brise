import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Brise } from '../src/core.mjs';
import { createHandler } from '../src/server.mjs';

test('real HTTP server: pair, approve, upload and download a binary file', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'brise-network-'));
  const app = await new Brise({ dataDir:join(directory, 'data'), receiveDir:join(directory, 'received') }).init();
  const network = { port:0, address:'127.0.0.1', interfaces:[] };
  const server = http.createServer(createHandler(app, network));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await app.close(); await rm(directory, { recursive:true, force:true }); });
  try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); }); }
  catch (error) { if (['EPERM','EACCES'].includes(error.code)) return t.skip('This environment prohibits local network sockets.'); throw error; }
  network.port = server.address().port;
  const base = `http://127.0.0.1:${network.port}`;
  const post = (path, data, cookie) => fetch(base + path, { method:'POST', headers:{ 'X-Brise':'1', 'Content-Type':'application/json', Origin:base, ...(cookie ? { Cookie:cookie } : {}) }, body:JSON.stringify(data) });
  const login = await post('/api/admin/login', { secret:app.adminSecret });
  assert.equal(login.status, 200); const adminCookie = login.headers.get('set-cookie').split(';')[0];
  const pair = await post('/api/pair', { code:app.pairToken, name:'Téléphone réseau' });
  assert.equal(pair.status, 201); const phoneCookie = pair.headers.get('set-cookie').split(';')[0];
  const paired = await pair.json();
  assert.equal((await post(`/api/devices/${paired.id}`, { approve:true }, adminCookie)).status, 200);
  const payload = Buffer.from(Array.from({ length:262144 }, (_, i) => i % 256));
  const sent = await fetch(base + '/api/upload', { method:'POST', headers:{ 'X-Brise':'1', 'X-File-Name':'binary.dat', 'X-File-Size':String(payload.length), Cookie:adminCookie, Origin:base }, body:payload });
  assert.equal(sent.status, 201);
  const file = await sent.json();
  const received = await fetch(`${base}/api/files/${file.id}`, { headers:{ Cookie:phoneCookie } });
  assert.equal(received.status, 200);
  assert.deepEqual(Buffer.from(await received.arrayBuffer()), payload);
});
