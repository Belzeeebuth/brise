import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable, PassThrough, Writable } from 'node:stream';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Brise } from '../src/core.mjs';
import { ChunkUploads, CHUNK_SIZE } from '../src/chunks.mjs';
import { Connections, wifiPayload } from '../src/connections.mjs';
import { createHandler } from '../src/server.mjs';

async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'brise-modes-'));
  const app = await new Brise({ dataDir: join(dir, 'data'), receiveDir: join(dir, 'received') }).init();
  const chunks = await new ChunkUploads(app).init();
  t.after(async () => { await chunks.close(); await app.close(); await rm(dir, { recursive: true, force: true }); });
  const network = { port: 53317, address: '192.168.1.42', interfaces: [{ name: 'wlan0', address: '192.168.1.42' }] };
  const device = app.pair(app.pairToken, 'Téléphone'); app.decide(device.id, true);
  const phone = { role: 'phone', ...device };
  return { app, chunks, phone, device, network };
}
const stream = value => Readable.from([Buffer.from(value)]);

test('chunk upload reconstructs binary bytes and persists the received file', async t => {
  const { app, chunks, phone } = await setup(t);
  const first = Buffer.alloc(CHUNK_SIZE, 0xab), second = Buffer.from([0, 1, 254, 255]);
  const upload = await chunks.begin(phone, { name: 'photo.bin', size: first.length + second.length });
  assert.equal((await chunks.append(upload.id, phone, 0, stream(first))).offset, first.length);
  assert.equal((await chunks.append(upload.id, phone, first.length, stream(second))).offset, first.length + second.length);
  assert.equal(chunks.startFinish(upload.id, phone).status, 'processing');
  const record = chunks.get(upload.id, phone); await record.job;
  assert.equal(record.completion.status, 'done');
  const file = app.files.get(record.completion.result.id);
  assert.deepEqual(await readFile(file.path), Buffer.concat([first, second]));
  assert.equal(app.active.size, 0); assert.equal(chunks.pending, false);
  await chunks.discard(upload.id); assert.equal(chunks.records.size, 0);
  assert.deepEqual(await readdir(chunks.dir), []);
});

test('chunks reject wrong offsets, partial blocks and cross-device access', async t => {
  const { app, chunks, phone } = await setup(t);
  const other = app.pair(app.pairToken, 'Autre appareil'); app.decide(other.id, true);
  const actor = { role: 'phone', ...other };
  const upload = await chunks.begin(phone, { name: 'test.txt', size: 4 });
  await assert.rejects(chunks.append(upload.id, phone, 1, stream('abcd')), { status: 409 });
  await assert.rejects(chunks.append(upload.id, actor, 0, stream('abcd')), { status: 404 });
  await assert.rejects(chunks.append(upload.id, phone, 0, stream('ab')), { status: 400 });
  await assert.rejects(chunks.append(upload.id, phone, 0, stream('abcde')), { status: 413 });
  assert.throws(() => chunks.startFinish(upload.id, phone), { status: 409 });
  assert.equal(chunks.get(upload.id, phone).bytes, 0);
  await chunks.append(upload.id, phone, 0, stream('abcd'));
  chunks.startFinish(upload.id, phone); const r = chunks.get(upload.id, phone); await r.job;
  assert.equal(r.completion.status, 'done');
});

test('zero-byte chunk uploads finalize and revocation deletes incomplete uploads', async t => {
  const { app, chunks, phone, device } = await setup(t);
  const zero = await chunks.begin(phone, { name: 'empty.txt', size: 0 });
  chunks.startFinish(zero.id, phone); const r = chunks.get(zero.id, phone); await r.job;
  assert.equal(r.completion.status, 'done'); await chunks.discard(zero.id);
  const unfinished = await chunks.begin(phone, { name: 'unfinished.txt', size: 10 });
  app.decide(device.id, false);
  assert.equal(chunks.records.has(unfinished.id), false);
  assert.equal(app.active.size, 0);
  await new Promise(resolve => setImmediate(resolve));
});

function fakeSystem({ failHotspot = false, failRestore = false } = {}) {
  const previous = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  let current = previous, profile = null;
  const calls = [];
  const runCommand = async (command, args) => {
    calls.push({ command, args });
    if (command === 'cloudflared') return 'cloudflared test';
    if (args.includes('DEVICE,TYPE')) return 'wlan0:wifi\neth0:ethernet';
    if (args.includes('WIFI-PROPERTIES.AP')) return 'yes';
    if (args.includes('GENERAL.CON-UUID')) return current || '--';
    if (args.includes('IP4.ADDRESS')) return '10.42.0.1/24';
    if (args[0] === 'radio') return 'enabled';
    if (args.includes('add')) { profile = args[args.indexOf('connection.uuid') + 1]; return ''; }
    if (args.includes('up')) {
      const uuid = args[args.indexOf('uuid') + 1];
      if ((uuid === profile && failHotspot) || (uuid === previous && failRestore)) throw new Error('activation failed');
      current = uuid; return '';
    }
    if (args.includes('delete')) { if (current === profile) current = null; profile = null; return ''; }
    if (args.includes('UUID')) return [previous, profile].filter(Boolean).join('\n');
    throw new Error(`Unexpected command: ${args.join(' ')}`);
  };
  return { runCommand, calls, previous, switchManually: value => { current = value; } };
}
function fakeTunnel() {
  let child;
  const spawnCommand = () => {
    child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = null;
    child.kill = () => { child.exitCode = 0; queueMicrotask(() => child.emit('exit', 0)); };
    queueMicrotask(() => {
      child.stderr.write('https://example-tunnel.trycloudflare.com\n');
      child.stderr.write('Registered tunnel connection connIndex=0\n');
    });
    return child;
  };
  return { spawnCommand, fail: () => { child.exitCode = 1; child.emit('exit', 1); } };
}

test('mode transition revokes old sessions and tunnel shutdown closes the public gateway', async t => {
  const { app, network, chunks, device } = await setup(t);
  const system = fakeSystem(), tunnel = fakeTunnel(); let closed = 0;
  const modes = await new Connections(app, network, { ...system, ...tunnel, chunks, createGateway: async () => ({ port: 54321, close: async () => { closed++; } }) }).init();
  modes.select('internet'); assert.equal(modes.status, 'starting'); assert.equal(modes.origin(), null);
  await modes.job;
  assert.equal(modes.origin(), 'https://example-tunnel.trycloudflare.com');
  assert.equal(app.devices.get(device.id).status, 'revoked');
  modes.select('local'); await modes.job;
  assert.equal(closed, 1); assert.equal(modes.publicOrigin, null);
  assert.equal(modes.origin(), 'http://192.168.1.42:53317');
  await modes.close();
});

test('unexpected tunnel exit invalidates the URL and connected phones', async t => {
  const { app, network } = await setup(t); const tunnel = fakeTunnel();
  const modes = await new Connections(app, network, { ...fakeSystem(), ...tunnel, createGateway: async () => ({ port: 54321, close: async () => {} }) }).init();
  modes.select('internet'); await modes.job;
  const device = app.pair(app.pairToken, 'Remote'); app.decide(device.id, true);
  tunnel.fail(); assert.equal(modes.status, 'error'); assert.equal(modes.origin(), null);
  assert.equal(app.devices.get(device.id).status, 'revoked'); await modes.close();
});

test('hotspot requires explicit confirmation, configures WPA2 and restores the previous Wi-Fi', async t => {
  const { app, network } = await setup(t); const system = fakeSystem();
  const modes = await new Connections(app, network, system).init();
  assert.throws(() => modes.select('hotspot', { interface: 'wlan0' }), { status: 409 });
  modes.select('hotspot', { interface: 'wlan0', confirmWifiChange: true }); await modes.job;
  assert.equal(modes.status, 'ready'); assert.equal(network.address, '10.42.0.1');
  const profile = modes.hotspot.uuid;
  const creation = system.calls.find(c => c.args.includes('add')).args;
  assert.ok(creation.includes('wpa-psk')); assert.ok(creation.includes('rsn'));
  assert.ok(creation.includes('connection.autoconnect')); assert.ok(creation.includes('no'));
  assert.ok(modes.hotspot.password.length >= 12);
  modes.select('local'); await modes.job;
  assert.ok(system.calls.some(c => c.args.includes('delete') && c.args.includes(profile)));
  assert.ok(system.calls.some(c => c.args.includes('up') && c.args.includes(system.previous)));
  assert.equal(modes.hotspot, null); await modes.close();
});

test('hotspot cleanup preserves a network manually selected by the user', async t => {
  const { app, network } = await setup(t); const system = fakeSystem();
  const modes = await new Connections(app, network, system).init();
  modes.select('hotspot', { interface: 'wlan0', confirmWifiChange: true }); await modes.job;
  system.switchManually('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
  modes.select('local'); await modes.job;
  assert.equal(system.calls.some(c => c.args.includes('up') && c.args.includes(system.previous)), false);
  await modes.close();
});

test('an unavailable previous Wi-Fi does not prevent returning to local mode', async t => {
  const { app, network } = await setup(t); const system = fakeSystem({ failRestore: true });
  const modes = await new Connections(app, network, system).init();
  modes.select('hotspot', { interface: 'wlan0', confirmWifiChange: true }); await modes.job;
  modes.select('local'); await modes.job;
  assert.equal(modes.mode, 'local'); assert.equal(modes.status, 'ready');
  assert.equal(modes.hotspot, null); assert.match(modes.message, /n’a pas pu être rétablie/);
  await assert.rejects(readFile(modes.journal), { code: 'ENOENT' });
  await modes.close();
});

test('the next launch cleans a hotspot left by an interrupted process', async t => {
  const { app, network } = await setup(t); const system = fakeSystem();
  const original = await new Connections(app, network, system).init();
  original.select('hotspot', { interface: 'wlan0', confirmWifiChange: true }); await original.job;
  const profile = original.hotspot.uuid;
  const resumed = await new Connections(app, network, system).init();
  assert.equal(resumed.mode, 'local'); assert.equal(resumed.hotspot, null);
  assert.ok(system.calls.some(c => c.args.includes('delete') && c.args.includes(profile)));
  await assert.rejects(readFile(resumed.journal), { code: 'ENOENT' });
  await resumed.close();
});

test('failed hotspot activation cleans its own profile; missing dependencies and active transfers block mode changes', async t => {
  const { app, network, chunks, phone } = await setup(t); const system = fakeSystem({ failHotspot: true });
  const modes = await new Connections(app, network, { ...system, chunks }).init();
  const upload = await chunks.begin(phone, { name: 'waiting.txt', size: 1 });
  assert.throws(() => modes.select('internet'), { status: 409 }); await chunks.discard(upload.id);
  modes.select('hotspot', { interface: 'wlan0', confirmWifiChange: true }); await modes.job;
  assert.equal(modes.status, 'error'); assert.equal(modes.hotspot, null);
  assert.ok(system.calls.some(c => c.args.includes('delete')));
  await modes.close();
  const missing = await new Connections(app, network, { runCommand: async () => { throw new Error('ENOENT'); } }).init();
  assert.equal(missing.capabilities.internet.available, false);
  assert.equal(missing.capabilities.hotspot.available, false);
  assert.throws(() => missing.select('internet'), { status: 409 });
});

class Response extends Writable {
  constructor() { super(); this.headers = {}; this.chunks = []; this.headersSent = false; this.statusCode = 200; }
  _write(chunk, _, done) { this.chunks.push(Buffer.from(chunk)); done(); }
  setHeader(key, value) { this.headers[key.toLowerCase()] = value; }
  writeHead(status, headers = {}) { this.statusCode = status; for (const [k, v] of Object.entries(headers)) this.setHeader(k, v); this.headersSent = true; }
  get json() { return JSON.parse(Buffer.concat(this.chunks)); }
}
async function request(handler, path, { method = 'GET', data, cookie, headers = {}, raw } = {}) {
  const req = Readable.from(raw ? [raw] : data === undefined ? [] : [Buffer.from(JSON.stringify(data))]);
  req.socket = { remoteAddress: '127.0.0.1' }; req.url = path; req.method = method;
  req.headers = { host: '127.0.0.1:54321', origin: 'https://example-tunnel.trycloudflare.com', 'x-brise': '1', ...(cookie ? { cookie } : {}), ...headers };
  const res = new Response(); await handler(req, res); return res;
}

test('public listener rejects every admin capability even with a valid PC cookie and spoofed headers', async t => {
  const { app, network, chunks } = await setup(t);
  const connections = { publicOrigin: 'https://example-tunnel.trycloudflare.com', status: 'ready' };
  const handler = createHandler(app, network, { publicGateway: true, gatewayPort: () => 54321, connections, chunks });
  for (const route of ['/api/admin/login', '/api/connection', '/api/folder', '/api/shutdown', '/api/network', '/api/rotate', '/api/wifi-qr.svg']) {
    const res = await request(handler, route, { method: 'POST', cookie: `brise=${app.adminSession}`, data: { secret: app.adminSecret }, headers: { 'x-forwarded-for': '127.0.0.1', 'x-forwarded-host': '127.0.0.1:53317' } });
    assert.equal(res.statusCode, 403, route);
  }
  assert.equal((await request(handler, '/api/state', { cookie: `brise=${app.adminSession}` })).statusCode, 401);
  const pair = await request(handler, '/api/pair', { method: 'POST', data: { code: app.pairToken, name: 'Internet' } });
  assert.equal(pair.statusCode, 201); assert.match(pair.headers['set-cookie'], /; Secure$/);
  const cookie = pair.headers['set-cookie'].split(';')[0]; app.decide(pair.json.id, true);
  const state = (await request(handler, '/api/state', { cookie })).json;
  assert.equal(state.connectionMode, 'internet'); assert.equal(state.chunkSize, CHUNK_SIZE);
  assert.equal(state.connection, undefined); assert.equal(state.receiveDir, undefined);
  assert.equal((await request(handler, '/api/pair', { method: 'POST', data: {}, headers: { origin: 'https://evil.invalid' } })).statusCode, 403);
  const upload = await request(handler, '/api/uploads', { method: 'POST', cookie, data: { name: 'remote.txt', size: 3 } });
  assert.equal(upload.statusCode, 201);
  assert.equal((await request(handler, `/api/uploads/${upload.json.id}`, { method: 'POST', cookie, raw: Buffer.from('abc'), headers: { 'x-chunk-offset': '0' } })).statusCode, 200);
  assert.equal((await request(handler, `/api/uploads/${upload.json.id}/finish`, { method: 'POST', cookie })).statusCode, 202);
  await chunks.records.get(upload.json.id).job;
  assert.equal((await request(handler, `/api/uploads/${upload.json.id}`, { cookie })).json.status, 'done');
  connections.status = 'error'; assert.equal((await request(handler, '/api/state', { cookie })).statusCode, 503);
});

test('Wi-Fi QR escapes separator characters', () => {
  assert.equal(wifiPayload('Brise-test', 'abc;def:g'), 'WIFI:T:WPA;S:Brise-test;P:abc\\;def\\:g;;');
});
