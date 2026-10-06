import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { Brise, TOKEN_TTL, safeName, equal } from '../src/core.mjs';
import { createHandler } from '../src/server.mjs';
import { qrSvg } from '../src/qr.mjs';

async function setup(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'brise-test-'));
  const config = { dataDir:join(root, 'data'), receiveDir:join(root, 'received'), ...options };
  const app = await new Brise(config).init();
  t.after(async () => { await app.close(); await rm(root, { recursive:true, force:true }); });
  const admin = { role:'admin', id:'admin', name:'Ce PC' };
  const device = app.pair(app.pairToken, 'iPhone de test');
  const phone = { role:'phone', ...device };
  const upload = (actor, name, data, size = Buffer.byteLength(data)) => app.upload({ actor, name, stream:Readable.from([Buffer.from(data)]), size });
  return { app, admin, phone, device, config, upload };
}

class Response extends Writable {
  constructor() { super(); this.headers = {}; this.chunks = []; this.statusCode = 200; this.headersSent = false; }
  _write(chunk, encoding, done) { this.chunks.push(Buffer.from(chunk)); done(); }
  setHeader(key, value) { this.headers[key.toLowerCase()] = value; }
  writeHead(status, headers = {}) { this.statusCode = status; for (const [key, value] of Object.entries(headers)) this.setHeader(key, value); this.headersSent = true; return this; }
  get body() { return Buffer.concat(this.chunks); }
  get json() { return JSON.parse(this.body); }
}
async function request(handler, url, { method = 'GET', cookie, data, raw, headers = {}, remoteAddress = '127.0.0.1' } = {}) {
  const req = Readable.from(raw === undefined ? data === undefined ? [] : [Buffer.from(JSON.stringify(data))] : [raw]);
  req.method = method; req.url = url; req.socket = { remoteAddress };
  req.headers = { host:'127.0.0.1:53317', 'x-brise':'1', ...(cookie ? { cookie } : {}), ...headers };
  const res = new Response(); await handler(req, res); return res;
}

test('pairing requires approval; a phone can neither approve itself nor access files early', async t => {
  const { app, admin, phone, device, upload } = await setup(t);
  const f = await upload(admin, 'bonjour.txt', 'Bonjour depuis CachyOS');
  assert.deepEqual(app.state(phone).files, []);
  assert.throws(() => app.fileFor(f.id, phone), { status:403 });
  await assert.rejects(upload(phone, 'photo.txt', 'test'), { status:403 });
  app.decide(device.id, true);
  assert.equal(app.state(phone).files[0].name, 'bonjour.txt');
  assert.equal(await readFile(app.fileFor(f.id, phone).path, 'utf8'), 'Bonjour depuis CachyOS');
  app.decide(device.id, false);
  assert.throws(() => app.authenticate(device.secret, false), { status:401 });
});

test('received names are safe, Unicode is preserved and duplicates never overwrite a file', async t => {
  const { app, phone, device, upload } = await setup(t); app.decide(device.id, true);
  const first = await upload(phone, '../../été 🌿.txt', 'premier');
  const second = await upload(phone, '../../été 🌿.txt', 'second');
  const one = app.files.get(first.id), two = app.files.get(second.id);
  assert.equal(one.name, 'été 🌿.txt');
  assert.equal(two.diskName, 'été 🌿 (1).txt');
  assert.equal(await readFile(one.path, 'utf8'), 'premier');
  assert.equal(await readFile(two.path, 'utf8'), 'second');
  assert.equal((await stat(one.path)).mode & 0o777, 0o600);
  assert.throws(() => app.fileFor(first.id, phone), { status:404 });
});

test('incomplete, oversized, and interrupted uploads clean their temporary files', async t => {
  const { app, admin, upload } = await setup(t, { maxFileSize:8 });
  await assert.rejects(upload(admin, 'large.bin', '123456789'), { status:413 });
  await assert.rejects(upload(admin, 'short.bin', '12', 4), { status:400 });
  await assert.rejects(upload(admin, 'long.bin', '12345', 2), { status:400 });
  async function* interrupted() { yield Buffer.from('a'); throw new Error('disconnected'); }
  await assert.rejects(app.upload({ actor:admin, name:'interrupted.bin', size:3, stream:Readable.from(interrupted()) }), /disconnected/);
  assert.deepEqual(await readdir(app.cacheDir), []);
  assert.equal(app.files.size, 0); assert.equal(app.active.size, 0);
});

test('revoking an active phone cancels its upload', async t => {
  const { app, phone, device } = await setup(t); app.decide(device.id, true);
  async function* chunks() { yield Buffer.from('a'); app.decide(device.id, false); yield Buffer.from('b'); }
  await assert.rejects(app.upload({ actor:phone, name:'stopped.txt', size:2, stream:Readable.from(chunks()) }));
  assert.equal(app.files.size, 0);
  assert.deepEqual(await readdir(app.partialDir), []);
});

test('QR expiry and rotation do not revoke devices already approved', async t => {
  let now = 10000;
  const { app, device } = await setup(t, { now:() => now }); app.decide(device.id, true);
  const code = app.pairToken; now += TOKEN_TTL;
  assert.throws(() => app.pair(code, 'late'), { status:403 });
  app.ensurePairToken(); assert.notEqual(app.pairToken, code);
  assert.equal(app.authenticate(device.secret, false).status, 'approved');
  assert.throws(() => app.pair(code, 'old'), { status:403 });
});

test('received history survives restart; shared copies and approved sessions do not', async t => {
  const { app, admin, phone, device, upload, config } = await setup(t); app.decide(device.id, true);
  const incoming = await upload(phone, 'durable.txt', 'conserver');
  await upload(admin, 'temporaire.txt', 'copie');
  await app.close();
  const restarted = await new Brise(config).init();
  assert.equal(restarted.files.size, 1);
  assert.equal(await readFile(restarted.files.get(incoming.id).path, 'utf8'), 'conserver');
  assert.equal(restarted.devices.size, 0);
  assert.deepEqual(await readdir(restarted.cacheDir), []);
  await restarted.close();
});

test('removing a shared file never removes a received file', async t => {
  const { app, admin, phone, device, upload } = await setup(t); app.decide(device.id, true);
  const incoming = await upload(phone, 'received.txt', 'a');
  const outgoing = await upload(admin, 'shared.txt', 'b');
  await assert.rejects(app.removeShared(incoming.id), { status:404 });
  await app.removeShared(outgoing.id);
  assert.equal(app.files.has(outgoing.id), false);
  assert.equal(await readFile(app.files.get(incoming.id).path, 'utf8'), 'a');
});

test('HTTP flow: PC login, phone pairing, PC approval, bidirectional transfer and range download', async t => {
  const { app } = await setup(t);
  const handler = createHandler(app, { interfaces:[{ address:'192.168.1.42', name:'wlan0' }], address:'192.168.1.42', port:53317 });
  const login = await request(handler, '/api/admin/login', { method:'POST', data:{ secret:app.adminSecret } });
  assert.equal(login.statusCode, 200);
  const adminCookie = login.headers['set-cookie'].split(';')[0];
  assert.match(login.headers['set-cookie'], /HttpOnly; SameSite=Strict/);
  const paired = await request(handler, '/api/pair', { method:'POST', data:{ code:app.pairToken, name:'Android' }, remoteAddress:'192.168.1.10' });
  assert.equal(paired.statusCode, 201);
  const phoneCookie = paired.headers['set-cookie'].split(';')[0];
  assert.equal((await request(handler, `/api/devices/${paired.json.id}`, { method:'POST', cookie:phoneCookie, data:{ approve:true } })).statusCode, 403);
  assert.equal((await request(handler, `/api/devices/${paired.json.id}`, { method:'POST', cookie:adminCookie, data:{ approve:true } })).statusCode, 200);
  const shared = await request(handler, '/api/upload', { method:'POST', cookie:adminCookie, raw:Buffer.from('abcdefghij'), headers:{ 'x-file-name':encodeURIComponent('été.txt'), 'x-file-size':'10' } });
  assert.equal(shared.statusCode, 201);
  const downloaded = await request(handler, `/api/files/${shared.json.id}`, { cookie:phoneCookie });
  assert.equal(downloaded.body.toString(), 'abcdefghij');
  assert.match(downloaded.headers['content-disposition'], /%C3%A9t%C3%A9.txt/);
  const partial = await request(handler, `/api/files/${shared.json.id}`, { cookie:phoneCookie, headers:{ range:'bytes=2-5' } });
  assert.equal(partial.statusCode, 206); assert.equal(partial.body.toString(), 'cdef');
  assert.equal(partial.headers['content-range'], 'bytes 2-5/10');
  const uploaded = await request(handler, '/api/upload', { method:'POST', cookie:phoneCookie, raw:Buffer.from('bonjour'), headers:{ 'x-file-name':'mobile.txt', 'x-file-size':'7' } });
  assert.equal(uploaded.statusCode, 201);
  assert.equal((await request(handler, `/api/files/${uploaded.json.id}`, { cookie:adminCookie })).body.toString(), 'bonjour');
  assert.equal((await request(handler, `/api/files/${uploaded.json.id}`, { cookie:phoneCookie })).statusCode, 404);
  const state = (await request(handler, '/api/state', { cookie:phoneCookie })).json;
  assert.equal(state.files.length, 1); assert.equal(state.receiveDir, undefined);
  assert.equal(JSON.stringify(state).includes(app.adminSecret), false);
  assert.equal(JSON.stringify(state).includes(app.dataDir), false);
});

test('HTTP rejects remote administration, forged origins, hostile hosts, and anonymous downloads', async t => {
  const { app, admin, upload } = await setup(t);
  const handler = createHandler(app, { interfaces:[], address:null, port:53317 });
  const f = await upload(admin, 'private.txt', 'secret');
  assert.equal((await request(handler, `/api/files/${f.id}`)).statusCode, 401);
  assert.equal((await request(handler, '/api/admin/login', { method:'POST', data:{ secret:app.adminSecret }, remoteAddress:'192.168.1.5' })).statusCode, 403);
  assert.equal((await request(handler, '/api/state', { cookie:`brise=${app.adminSession}`, remoteAddress:'192.168.1.5' })).statusCode, 401);
  assert.equal((await request(handler, '/api/rotate', { method:'POST', cookie:`brise=${app.adminSession}`, headers:{ origin:'https://evil.invalid' } })).statusCode, 403);
  assert.equal((await request(handler, '/api/rotate', { method:'POST', cookie:`brise=${app.adminSession}`, headers:{ 'x-brise':'' } })).statusCode, 403);
  assert.equal((await request(handler, '/', { headers:{ host:'evil.invalid:53317' } })).statusCode, 403);
  const page = await request(handler, '/');
  assert.equal(page.statusCode, 200); assert.match(page.body.toString(), /Brise/);
  assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.equal((await request(handler, '/../../src/server.mjs')).statusCode, 404);
});

test('empty files, suffix ranges, and invalid ranges behave correctly', async t => {
  const { app, admin, upload } = await setup(t);
  const handler = createHandler(app, { interfaces:[], address:null, port:53317 });
  const cookie = `brise=${app.adminSession}`;
  const zero = await upload(admin, 'empty.txt', '');
  assert.equal((await request(handler, `/api/files/${zero.id}`, { cookie })).body.length, 0);
  const normal = await upload(admin, 'normal.txt', '12345');
  const suffix = await request(handler, `/api/files/${normal.id}`, { cookie, headers:{ range:'bytes=-2' } });
  assert.equal(suffix.statusCode, 206); assert.equal(suffix.body.toString(), '45');
  for (const range of ['bytes=99-100','bytes=3-1','bytes=-','garbage']) {
    assert.equal((await request(handler, `/api/files/${normal.id}`, { cookie, headers:{ range } })).statusCode, 416);
  }
});

test('QR contains vector modules and a white quiet zone; filenames and tokens tolerate hostile input', () => {
  const svg = qrSvg('http://192.168.1.42:53317/connect#test-token');
  assert.match(svg, /shape-rendering="crispEdges"/); assert.match(svg, /fill="#fff"/);
  assert.match(svg, /M4,4h1v1h-1z/);
  assert.equal(safeName('..\\..\\hello.txt'), 'hello.txt');
  assert.equal(safeName('...'), 'Fichier');
  assert.ok(Buffer.byteLength(safeName('🌿'.repeat(200))) <= 180);
  assert.equal(equal('a', 'é'), false);
  assert.equal(equal(undefined, 'test'), false);
});
