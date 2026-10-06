import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, unlink, link, stat, readdir } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { join, extname, basename } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { EventEmitter } from 'node:events';

export const MAX_FILE_SIZE = 10 * 1024 ** 3;
export const TOKEN_TTL = 10 * 60 * 1000;
export class AppError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export const token = () => randomBytes(24).toString('base64url');
export function equal(a, b) {
  return typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
export function safeName(value) {
  let name = basename(String(value || 'Fichier').replaceAll('\\', '/'))
    .replace(/[\x00-\x1f\x7f<>:"|?*\u202a-\u202e\u2066-\u2069]/g, '_').replace(/^\.+/, '').trim();
  if (Buffer.byteLength(name) > 180) {
    let extension = extname(name);
    if (Buffer.byteLength(extension) > 24) extension = '';
    let stem = '';
    for (const char of name.slice(0, name.length - extension.length)) {
      if (Buffer.byteLength(stem + char + extension) > 180) break;
      stem += char;
    }
    name = (stem.trim() + extension).replace(/^\.+/, '');
  }
  return name || 'Fichier';
}

export class Brise extends EventEmitter {
  constructor({ dataDir, receiveDir, maxFileSize = MAX_FILE_SIZE, now = Date.now }) {
    super();
    this.dataDir = dataDir; this.receiveDir = receiveDir; this.maxFileSize = maxFileSize; this.now = now;
    this.adminSecret = token(); this.adminSession = token(); this.sessionId = randomUUID();
    this.devices = new Map(); this.files = new Map(); this.active = new Map();
    this.saveQueue = Promise.resolve(); this.rotate();
  }
  async init() {
    this.cacheDir = join(this.dataDir, 'shared');
    this.partialDir = join(this.receiveDir, '.partial');
    await Promise.all([this.dataDir, this.receiveDir, this.cacheDir, this.partialDir].map(p => mkdir(p, { recursive: true, mode: 0o700 })));
    // These directories only contain Brise's temporary copies, never user originals.
    for (const dir of [this.cacheDir, this.partialDir]) {
      for (const file of await readdir(dir)) if (/^[0-9a-f-]{36}\.part$|^[0-9a-f-]{36}\.bin$/.test(file)) await unlink(join(dir, file)).catch(() => {});
    }
    try {
      const history = JSON.parse(await readFile(join(this.dataDir, 'history.json'), 'utf8'));
      for (const f of history) {
        if (f.direction !== 'incoming' || !/^[0-9a-f-]{36}$/.test(f.id) || f.diskName !== safeName(f.diskName)) continue;
        const path = join(this.receiveDir, f.diskName);
        if ((await stat(path).catch(() => null))?.isFile()) this.files.set(f.id, { ...f, path });
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error('Historique Brise illisible. Conservez history.json avant de le réparer.', { cause: error });
    }
    return this;
  }
  rotate() {
    this.pairToken = token(); this.expiresAt = this.now() + TOKEN_TTL;
    this.emit('change');
  }
  get uploads() { return [...this.active.values()].filter(t => t.direction !== 'download' && !t.paused).length; }
  ensurePairToken() { if (this.now() >= this.expiresAt) this.rotate(); }
  pair(code, name) {
    if (!equal(code, this.pairToken) || this.now() >= this.expiresAt) throw new AppError(403, 'Ce QR code a expiré. Scannez le nouveau code sur le PC.');
    for (const [id, d] of this.devices) if (d.status === 'pending' && this.now() - d.createdAt > TOKEN_TTL) this.devices.delete(id);
    if ([...this.devices.values()].filter(d => ['pending', 'approved'].includes(d.status)).length >= 12) throw new AppError(429, 'Trop de connexions. Fermez une session sur le PC.');
    const device = { id: randomUUID(), name: [...safeName(name)].slice(0, 48).join(''), secret: token(), status: 'pending', createdAt: this.now(), lastSeen: this.now(), code: String(randomBytes(3).readUIntBE(0, 3) % 1000000).padStart(6, '0') };
    this.devices.set(device.id, device); this.emit('change');
    return device;
  }
  decide(id, approve) {
    const device = this.devices.get(id);
    if (!device) throw new AppError(404, 'Appareil introuvable.');
    device.status = approve ? 'approved' : 'revoked';
    if (!approve) for (const item of this.active.values()) if (item.ownerId === id) item.controller.abort();
    this.emit('change');
  }
  authenticate(secret, local) {
    if (local && equal(secret, this.adminSession)) return { role: 'admin', id: 'admin', name: 'Ce PC' };
    const d = [...this.devices.values()].find(d => equal(d.secret, secret));
    if (!d || d.status === 'revoked') throw new AppError(401, 'Cette session est fermée. Scannez à nouveau le QR code.');
    d.lastSeen = this.now();
    return { role: 'phone', ...d };
  }
  allowed(actor) {
    if (actor.role === 'admin') return;
    if (this.devices.get(actor.id)?.status !== 'approved') throw new AppError(403, 'Validez la connexion sur votre PC.');
  }
  fileFor(id, actor) {
    this.allowed(actor);
    const file = this.files.get(id);
    if (!file || (actor.role !== 'admin' && file.direction !== 'outgoing')) throw new AppError(404, 'Ce fichier n’est plus disponible.');
    return file;
  }
  state(actor) {
    const admin = actor.role === 'admin';
    const d = admin ? null : this.devices.get(actor.id);
    const permitted = admin || d?.status === 'approved';
    const files = permitted ? [...this.files.values()].filter(f => admin || f.direction === 'outgoing').map(({ path, diskName, ...f }) => f) : [];
    return {
      role: actor.role, name: actor.name, status: admin ? 'approved' : d?.status,
      code: d?.code, files: files.sort((a, b) => b.createdAt - a.createdAt),
      transfers: permitted ? [...this.active.values()].filter(t => admin || t.ownerId === actor.id).map(({ controller, ...t }) => t) : [],
      devices: admin ? [...this.devices.values()].filter(d => d.status !== 'revoked').map(({ secret, ...d }) => ({ ...d, online: this.now() - d.lastSeen < 15000 })) : [],
      maxFileSize: this.maxFileSize, receiveDir: admin ? this.receiveDir : undefined,
    };
  }
  save() {
    const snapshot = [...this.files.values()].filter(f => f.direction === 'incoming').map(({ path, ...f }) => f);
    const next = this.saveQueue.catch(() => {}).then(async () => {
      const temp = join(this.dataDir, 'history.json.tmp');
      await writeFile(temp, JSON.stringify(snapshot, null, 2), { mode: 0o600 });
      await rename(temp, join(this.dataDir, 'history.json'));
    });
    this.saveQueue = next; return next;
  }
  temp(id, outgoing) { return join(outgoing ? this.cacheDir : this.partialDir, `${id}.part`); }
  async upload({ stream, name, size, actor }) {
    this.allowed(actor);
    if (!Number.isSafeInteger(size) || size < 0) throw new AppError(400, 'Taille du fichier invalide.');
    if (size > this.maxFileSize) throw new AppError(413, 'Ce fichier dépasse la limite de 10 Go.');
    if (this.uploads >= 3) throw new AppError(429, 'Trois envois sont déjà en cours. Réessayez dans un instant.');
    const id = randomUUID(); const outgoing = actor.role === 'admin';
    const temp = this.temp(id, outgoing);
    const controller = new AbortController();
    const item = { id, name: safeName(name), size, bytes: 0, direction: outgoing ? 'outgoing' : 'incoming', ownerId: actor.id, sender: actor.name, startedAt: this.now(), controller };
    this.active.set(id, item); this.emit('change');
    let lastTick = 0;
    const meter = new Transform({ transform: (chunk, encoding, done) => {
      item.bytes += chunk.length;
      if (item.bytes > size) return done(new AppError(400, 'La taille reçue ne correspond pas au fichier.'));
      if (this.now() - lastTick > 250) { this.emit('change'); lastTick = this.now(); }
      done(null, chunk);
    } });
    try {
      await pipeline(stream, meter, createWriteStream(temp, { flags: 'wx', mode: 0o600 }), { signal: controller.signal });
      if (item.bytes !== size) throw new AppError(400, 'Le transfert a été interrompu. Réessayez.');
      return await this.store({ id, temp, name: item.name, size, actor });
    } catch (error) {
      await unlink(temp).catch(() => {});
      if (error.code === 'ENOSPC') throw new AppError(507, 'Le disque du PC est plein.');
      throw error;
    } finally { this.active.delete(id); this.emit('change'); }
  }
  async store({ id, temp, name, size, actor }) {
    this.allowed(actor);
    const outgoing = actor.role === 'admin';
    let diskName = `${id}.bin`, destination;
    if (outgoing) { destination = join(this.cacheDir, diskName); await rename(temp, destination); }
    else {
      const extension = extname(name), stem = name.slice(0, name.length - extension.length);
      for (let n = 0; ; n++) {
        diskName = n ? `${stem} (${n})${extension}` : name;
        destination = join(this.receiveDir, diskName);
        try { await link(temp, destination); break; } catch (e) { if (e.code !== 'EEXIST') throw e; }
      }
      await unlink(temp).catch(e => { if (e.code !== 'ENOENT') throw e; });
    }
    const file = { id, name, size, direction: outgoing ? 'outgoing' : 'incoming', sender: actor.name, createdAt: this.now(), downloads: 0, diskName, path: destination };
    this.files.set(id, file);
    await this.save();
    return { id, name, size };
  }
  async removeShared(id) {
    const f = this.files.get(id);
    if (!f || f.direction !== 'outgoing') throw new AppError(404, 'Fichier partagé introuvable.');
    await unlink(f.path).catch(e => { if (e.code !== 'ENOENT') throw e; });
    this.files.delete(id); this.emit('change');
  }
  async close() {
    for (const item of this.active.values()) item.controller.abort();
    await this.saveQueue.catch(() => {});
  }
}
