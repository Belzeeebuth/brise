import http from 'node:http';
import os from 'node:os';
import { isIP } from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { readFile, mkdir, writeFile, rm, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { spawn } from 'node:child_process';
import { Brise, AppError, equal } from './core.mjs';
import { qrSvg } from './qr.mjs';
import { ChunkUploads, CHUNK_SIZE } from './chunks.mjs';
import { Connections, wifiPayload } from './connections.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
export function paths(env = process.env) {
  const home = os.homedir();
  return { dataDir: env.BRISE_DATA_DIR || join(env.XDG_DATA_HOME || join(home, '.local/share'), 'brise'), receiveDir: env.BRISE_RECEIVE_DIR || join(home, 'Téléchargements', 'Brise') };
}
export function interfaces() {
  try {
    return Object.entries(os.networkInterfaces()).flatMap(([name, addresses]) => addresses.filter(a => a.family === 'IPv4' && !a.internal).map(a => ({ name, address: a.address })))
      .sort((a, b) => (/^(wl|en|eth)/.test(b.name) ? 1 : 0) - (/^(wl|en|eth)/.test(a.name) ? 1 : 0));
  } catch { return []; }
}
const local = req => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket?.remoteAddress);
const json = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
async function body(req) {
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (text.length > 4096) throw new AppError(413, 'Requête trop volumineuse.');
  }
  try { return JSON.parse(text); } catch { throw new AppError(400, 'Requête invalide.'); }
}
function sessionCookie(res, value, secure = false) {
  res.setHeader('Set-Cookie', `brise=${value}; HttpOnly; SameSite=Strict; Path=/${secure ? '; Secure' : ''}`);
}
function credential(req) {
  return String(req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('brise='))?.slice(6);
}

export function createHandler(app, network, { openFolder = () => {}, shutdown = () => {}, connections, chunks, publicGateway = false, gatewayPort, idleTimeout = 120000 } = {}) {
  const rate = new Map();
  function throttle(req) {
    const key = req.socket.remoteAddress;
    const now = Date.now();
    for (const [ip, window] of rate) if (window.until <= now) rate.delete(ip);
    const entry = rate.get(key) || { count: 0, until: now + 60000 };
    entry.count++; rate.set(key, entry);
    if (entry.count > 15) throw new AppError(429, 'Trop de tentatives. Réessayez dans une minute.');
  }
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      const host = req.headers.host;
      if (publicGateway && (!connections?.publicOrigin || connections.status !== 'ready')) throw new AppError(503, 'Le mode Internet est fermé.');
      if (!publicGateway) connections?.syncNetwork?.();
      const validHosts = publicGateway ? [`127.0.0.1:${gatewayPort()}`] : ['localhost', '127.0.0.1', ...network.interfaces.map(i => i.address), network.address].filter(Boolean).map(ip => `${ip}:${network.port}`);
      if (!validHosts.includes(host)) throw new AppError(403, 'Adresse de connexion non autorisée.');
      const url = new URL(req.url, `http://${host}`);
      const method = req.method, path = url.pathname;
      const requestOrigin = publicGateway ? connections.publicOrigin : `http://${host}`;
      const isAdminConnection = !publicGateway && local(req);
      // The tunnel has a separate listener: forwarded headers can never grant PC access.
      if (publicGateway && path.startsWith('/api/') && !/^\/api\/(pair|state|uploads(?:\/[0-9a-f-]+(?:\/finish)?)?|files\/[0-9a-f-]+)$/.test(path)) throw new AppError(403, 'Action indisponible depuis Internet.');
      if (!['GET', 'HEAD', 'POST', 'DELETE'].includes(method)) throw new AppError(405, 'Méthode non autorisée.');
      if (['POST', 'DELETE'].includes(method)) {
        if (req.headers['x-brise'] !== '1' || (req.headers.origin && req.headers.origin !== requestOrigin)) throw new AppError(403, 'Origine de la requête non autorisée.');
      }
      if (path === '/api/health' && method === 'GET') return json(res, 200, { app: 'brise', session: app.sessionId });
      if (path === '/api/admin/login' && method === 'POST') {
        throttle(req);
        const value = await body(req);
        if (!isAdminConnection || !equal(value.secret, app.adminSecret)) throw new AppError(403, 'Ouvrez Brise depuis le lanceur du PC.');
        sessionCookie(res, app.adminSession); return json(res, 200, { ok: true });
      }
      if (path === '/api/pair' && method === 'POST') {
        throttle(req); const value = await body(req);
        const d = app.pair(value.code, value.name || 'Mon téléphone');
        sessionCookie(res, d.secret, publicGateway); return json(res, 201, { id: d.id });
      }
      if (path.startsWith('/api/')) {
        const actor = app.authenticate(credential(req), isAdminConnection);
        const admin = () => { if (actor.role !== 'admin') throw new AppError(403, 'Cette action est réservée au PC.'); };
        if (path === '/api/state' && method === 'GET') {
          const state = app.state(actor);
          state.connectionMode = publicGateway ? 'internet' : connections?.mode || 'local';
          state.chunkSize = chunks ? CHUNK_SIZE : null;
          if (actor.role === 'admin') {
            app.ensurePairToken();
            const origin = connections ? connections.origin() : network.address ? `http://${network.address}:${network.port}` : null;
            Object.assign(state, { network: { ...network, hostname: os.hostname() }, connection: connections?.state(), expiresAt: app.expiresAt, pairUrl: origin ? `${origin}/connect#${app.pairToken}` : null });
          }
          return json(res, 200, state);
        }
        if (path === '/api/qr.svg' && method === 'GET') {
          admin(); app.ensurePairToken();
          const origin = connections ? connections.origin() : network.address ? `http://${network.address}:${network.port}` : null;
          if (!origin) throw new AppError(409, 'Activez un mode de connexion.');
          res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
          return res.end(qrSvg(`${origin}/connect#${app.pairToken}`));
        }
        if (path === '/api/wifi-qr.svg' && method === 'GET') {
          admin(); const hotspot = connections?.hotspot;
          if (!hotspot || connections.status !== 'ready') throw new AppError(409, 'Le point d’accès n’est pas actif.');
          res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
          return res.end(qrSvg(wifiPayload(hotspot.ssid, hotspot.password)));
        }
        if (path === '/api/connection' && method === 'POST') {
          admin(); if (!connections) throw new AppError(503, 'Gestion des connexions indisponible.');
          const options = await body(req);
          return json(res, 202, connections.select(options.mode, options));
        }
        if (path === '/api/connection/probe' && method === 'POST') {
          admin(); if (!connections) throw new AppError(503, 'Gestion des connexions indisponible.');
          return json(res, 200, await connections.probe());
        }
        if (path === '/api/rotate' && method === 'POST') { admin(); app.rotate(); return json(res, 200, { ok: true }); }
        if (path === '/api/network' && method === 'POST') {
          admin(); const { address } = await body(req);
          if (connections && (connections.mode !== 'local' || connections.status === 'starting')) throw new AppError(409, 'L’adresse manuelle est réservée au mode réseau local.');
          if (isIP(address) !== 4 || address.startsWith('127.') || ['0.0.0.0', '255.255.255.255'].includes(address)) throw new AppError(400, 'Indiquez l’adresse IPv4 du PC sur votre réseau local.');
          network.address = address; network.fixed = null; network.manual = true; app.rotate(); return json(res, 200, { ok: true });
        }
        const deviceMatch = path.match(/^\/api\/devices\/([0-9a-f-]+)$/);
        if (deviceMatch && method === 'POST') {
          admin(); const { approve } = await body(req);
          app.decide(deviceMatch[1], approve === true); return json(res, 200, { ok: true });
        }
        if (path === '/api/upload' && method === 'POST') {
          req.setTimeout?.(idleTimeout);
          let name; try { name = decodeURIComponent(req.headers['x-file-name'] || 'Fichier'); } catch { throw new AppError(400, 'Nom de fichier invalide.'); }
          const size = req.headers['x-file-size'];
          if (size === undefined || !/^\d+$/.test(size)) throw new AppError(400, 'Taille du fichier manquante.');
          return json(res, 201, await app.upload({ stream: req, name, size: Number(size), actor }));
        }
        if (path === '/api/uploads' && method === 'POST' && chunks) return json(res, 201, await chunks.begin(actor, await body(req)));
        const chunkMatch = path.match(/^\/api\/uploads\/([0-9a-f-]+)(\/finish)?$/);
        if (chunkMatch && chunks) {
          if (chunkMatch[2] && method === 'POST') return json(res, 202, chunks.startFinish(chunkMatch[1], actor));
          if (!chunkMatch[2] && method === 'GET') { const r = chunks.get(chunkMatch[1], actor); return json(res, 200, r.completion || { status: 'uploading', offset: r.bytes }); }
          if (!chunkMatch[2] && method === 'POST') {
            const offset = req.headers['x-chunk-offset'];
            if (!/^\d+$/.test(offset || '')) throw new AppError(400, 'Position du bloc manquante.');
            req.setTimeout?.(idleTimeout);
            return json(res, 200, await chunks.append(chunkMatch[1], actor, Number(offset), req));
          }
          if (!chunkMatch[2] && method === 'DELETE') { chunks.get(chunkMatch[1], actor); await chunks.discard(chunkMatch[1]); return json(res, 200, { ok: true }); }
        }
        const fileMatch = path.match(/^\/api\/files\/([0-9a-f-]+)$/);
        if (fileMatch && method === 'DELETE') { admin(); await app.removeShared(fileMatch[1]); return json(res, 200, { ok: true }); }
        if (fileMatch && ['GET', 'HEAD'].includes(method)) {
          const file = app.fileFor(fileMatch[1], actor);
          const info = await stat(file.path).catch(() => { throw new AppError(404, 'Ce fichier a été déplacé ou supprimé du PC.'); });
          let start = 0, end = info.size - 1, status = 200;
          if (req.headers.range) {
            const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
            if (!range || (!range[1] && !range[2])) throw new AppError(416, 'Plage de téléchargement invalide.');
            start = range[1] ? Number(range[1]) : Math.max(0, info.size - Number(range[2]));
            end = range[1] && range[2] ? Math.min(Number(range[2]), end) : end;
            if (start > end || start >= info.size) { res.setHeader('Content-Range', `bytes */${info.size}`); throw new AppError(416, 'Plage de téléchargement invalide.'); }
            status = 206; res.setHeader('Content-Range', `bytes ${start}-${end}/${info.size}`);
          }
          const length = Math.max(0, end - start + 1);
          res.writeHead(status, { 'Content-Type': 'application/octet-stream', 'Content-Length': length, 'Accept-Ranges': 'bytes', 'Content-Disposition': `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(file.name).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16))}` });
          if (method === 'HEAD' || length === 0) return res.end();
          const controller = new AbortController();
          const id = crypto.randomUUID();
          const transfer = { id, ownerId: actor.id, name: file.name, size: length, bytes: 0, direction: 'download', sender: actor.name, startedAt: Date.now(), controller };
          app.active.set(id, transfer); app.emit('change');
          res.setTimeout?.(idleTimeout, () => res.destroy());
          const meter = new Transform({ transform(chunk, _, done) { transfer.bytes += chunk.length; done(null, chunk); } });
          try {
            await pipeline(createReadStream(file.path, { start, end }), meter, res, { signal: controller.signal });
            if (status === 200 && actor.role !== 'admin') file.downloads++;
          } finally { app.active.delete(id); app.emit('change'); }
          return;
        }
        if (path === '/api/folder' && method === 'POST') { admin(); await openFolder(app.receiveDir); return json(res, 200, { ok: true }); }
        if (path === '/api/shutdown' && method === 'POST') { admin(); json(res, 200, { ok: true }); setTimeout(shutdown, 100); return; }
        throw new AppError(404, 'Action introuvable.');
      }
      if (!['GET', 'HEAD'].includes(method)) throw new AppError(405, 'Méthode non autorisée.');
      const assets = { '/': 'index.html', '/connect': 'index.html', '/app.js': 'app.js', '/styles.css': 'styles.css', '/icon.svg': 'icon.svg' };
      const asset = assets[path];
      if (!asset) throw new AppError(404, 'Page introuvable.');
      const mime = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', svg: 'image/svg+xml' };
      const content = await readFile(join(root, 'public', asset));
      res.writeHead(200, { 'Content-Type': mime[asset.split('.').pop()] });
      res.end(method === 'HEAD' ? undefined : content);
    } catch (error) {
      if (res.headersSent || res.destroyed) { res.destroy?.(); return; }
      if (!error.status && error.name !== 'AbortError') console.error('Brise:', error.message);
      json(res, error.status || (error.name === 'AbortError' ? 409 : 500), { error: error.status ? error.message : error.name === 'AbortError' ? 'Transfert annulé.' : 'Une erreur est survenue. Réessayez.' });
    }
  };
}

export async function start() {
  const config = paths();
  // Honor the user's XDG download folder when no explicit destination is provided.
  if (!process.env.BRISE_RECEIVE_DIR) {
    try {
      const dirs = await readFile(join(process.env.XDG_CONFIG_HOME || join(os.homedir(), '.config'), 'user-dirs.dirs'), 'utf8');
      const match = /^XDG_DOWNLOAD_DIR="([^"]+)"/m.exec(dirs);
      if (match) config.receiveDir = join(match[1].replace(/^\$HOME(?=\/|$)/, os.homedir()), 'Brise');
    } catch {}
  }
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  const lock = join(config.dataDir, 'server.lock');
  try { await mkdir(lock, { mode: 0o700 }); }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    let pid; try { pid = Number(await readFile(join(lock, 'pid'), 'utf8')); } catch {}
    if (!pid) throw new Error('Un démarrage est déjà en cours, ou server.lock est incomplet. Vérifiez qu’aucun serveur Brise ne tourne avant de retirer ce dossier.');
    let alive = true;
    try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
    if (alive) throw new Error('Brise est déjà lancé. Utilisez ./brise pour ouvrir sa fenêtre.');
    await rm(lock, { recursive: true }); await mkdir(lock, { mode: 0o700 });
  }
  await writeFile(join(lock, 'pid'), String(process.pid), { mode: 0o600 });
  let app, server, connections, chunks;
  const runtime = join(config.dataDir, 'runtime.json');
  const cleanup = async () => {
    await connections?.close().catch(() => console.error('Brise : arrêt du point d’accès incomplet ; restauration prévue au prochain lancement.'));
    await chunks?.close(); await app?.close(); await rm(runtime, { force: true }); await rm(lock, { recursive: true, force: true });
  };
  const shutdown = async () => { server?.closeAllConnections(); server?.close(); await cleanup(); process.exit(0); };
  try {
    app = await new Brise(config).init();
    const network = { interfaces: interfaces(), port: Number(process.env.BRISE_PORT || 53317) };
    network.address = process.env.BRISE_ADDRESS || network.interfaces[0]?.address || null;
    network.fixed = process.env.BRISE_ADDRESS || null;
    if (network.address && isIP(network.address) !== 4) throw new Error('BRISE_ADDRESS doit être une adresse IPv4.');
    chunks = await new ChunkUploads(app).init();
    connections = new Connections(app, network, {
      chunks, getInterfaces: interfaces,
      createGateway: async () => {
        const gateway = http.createServer(createHandler(app, network, { connections, chunks, publicGateway: true, gatewayPort: () => gateway.address()?.port }));
        gateway.requestTimeout = 0; gateway.headersTimeout = 15000;
        await new Promise((resolve, reject) => { gateway.once('error', reject); gateway.listen(0, '127.0.0.1', resolve); });
        return { port: gateway.address().port, close: () => new Promise(resolve => { gateway.closeAllConnections(); gateway.close(resolve); }) };
      },
    });
    await connections.init();
    server = http.createServer(createHandler(app, network, {
      shutdown, connections, chunks,
      openFolder: path => new Promise((resolve, reject) => {
        const child = spawn('xdg-open', [path], { stdio: 'ignore' });
        child.on('error', () => reject(new AppError(500, 'Impossible d’ouvrir le gestionnaire de fichiers.')));
        child.on('exit', code => code === 0 ? resolve() : reject(new AppError(500, 'Impossible d’ouvrir le dossier.')));
      }),
    }));
    server.requestTimeout = 0;
    server.headersTimeout = 15000;
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(network.port, '0.0.0.0', resolve); });
    network.port = server.address().port;
    const adminUrl = `http://127.0.0.1:${network.port}/#admin=${app.adminSecret}`;
    await writeFile(runtime, JSON.stringify({ pid: process.pid, session: app.sessionId, adminUrl, port: network.port }), { mode: 0o600 });
    console.log(`Brise est prêt sur le port ${network.port}.\nInterface PC : ${adminUrl}\nDossier de réception : ${config.receiveDir}`);
    process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
    return { app, server, shutdown };
  } catch (error) { server?.close(); await cleanup(); throw error; }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  start().catch(e => { console.error(`Brise : ${e.message}`); process.exitCode = 1; });
}
