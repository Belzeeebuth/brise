import { randomUUID } from 'node:crypto';
import { mkdir, readdir, unlink, writeFile, open } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import { AppError, safeName } from './core.mjs';

export const CHUNK_SIZE = 8 * 1024 * 1024;
const IDLE_LIMIT = 15 * 60 * 1000;

// Bounded requests let large uploads cross proxies without buffering a whole file.
export class ChunkUploads {
  constructor(app) { this.app = app; this.records = new Map(); this.dir = join(app.dataDir, 'chunks'); }
  async init() {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    for (const name of await readdir(this.dir)) if (/^[0-9a-f-]{36}\.part$/.test(name)) await unlink(join(this.dir, name));
    this.timer = setInterval(() => {
      for (const r of this.records.values()) if (!r.busy && Date.now() - r.updatedAt > IDLE_LIMIT) this.discard(r.id).catch(() => {});
    }, 60000).unref();
    return this;
  }
  async begin(actor, { name, size }) {
    this.app.allowed(actor);
    if (!Number.isSafeInteger(size) || size < 0 || size > this.app.maxFileSize) throw new AppError(400, 'Taille de fichier invalide (10 Go maximum).');
    if (this.app.uploads >= 3) throw new AppError(429, 'Trois envois sont déjà en cours.');
    const id = randomUUID(), controller = new AbortController();
    const record = { id, ownerId: actor.id, actor, name: safeName(name), size, bytes: 0, direction: actor.role === 'admin' ? 'outgoing' : 'incoming', sender: actor.name, startedAt: Date.now(), updatedAt: Date.now(), busy: false, controller, path: join(this.dir, `${id}.part`) };
    // Reserve capacity before the first await.
    this.records.set(id, record);
    this.app.active.set(id, this.progress(record));
    try { await writeFile(record.path, '', { flag: 'wx', mode: 0o600 }); }
    catch (error) { this.records.delete(id); this.app.active.delete(id); throw error; }
    controller.signal.addEventListener('abort', () => {
      record.finalStream?.destroy(new AppError(409, 'Transfert annulé.'));
      this.discard(id).catch(() => {});
    }, { once: true });
    if (controller.signal.aborted) { await this.discard(id); throw new AppError(409, 'Transfert annulé.'); }
    this.app.emit('change');
    return { id, chunkSize: CHUNK_SIZE, offset: 0 };
  }
  progress(r) {
    return { id: r.id, ownerId: r.ownerId, name: r.name, size: r.size, bytes: r.bytes, direction: r.direction, sender: r.sender, startedAt: r.startedAt, controller: r.controller };
  }
  get(id, actor) {
    this.app.allowed(actor);
    const r = this.records.get(id);
    if (!r || r.ownerId !== actor.id) throw new AppError(404, 'Envoi introuvable ou expiré.');
    return r;
  }
  async append(id, actor, offset, stream) {
    const r = this.get(id, actor);
    if (r.busy) throw new AppError(409, 'Un bloc est déjà en cours.');
    if (!Number.isSafeInteger(offset) || offset !== r.bytes) throw new AppError(409, 'Position du bloc incorrecte.');
    const expected = Math.min(CHUNK_SIZE, r.size - r.bytes);
    if (!expected) throw new AppError(409, 'Tous les blocs ont déjà été reçus.');
    r.busy = true;
    let handle;
    try {
      const buffers = []; let received = 0;
      for await (const chunk of stream) {
        if (r.controller.signal.aborted) throw new AppError(409, 'Transfert annulé.');
        received += chunk.length;
        if (received > expected) throw new AppError(413, 'Bloc trop volumineux.');
        buffers.push(Buffer.from(chunk));
      }
      if (received !== expected) throw new AppError(400, 'Bloc incomplet.');
      this.app.allowed(actor);
      if (r.controller.signal.aborted) throw new AppError(409, 'Transfert annulé.');
      const buffer = Buffer.concat(buffers);
      handle = await open(r.path, 'r+');
      for (let written = 0; written < buffer.length;) {
        const result = await handle.write(buffer, written, buffer.length - written, offset + written);
        if (!result.bytesWritten) throw new Error('Écriture du bloc interrompue.');
        written += result.bytesWritten;
      }
      r.bytes += received; r.updatedAt = Date.now();
      if (this.records.has(id)) this.app.active.set(id, this.progress(r));
      return { offset: r.bytes };
    } finally { await handle?.close(); r.busy = false; this.app.emit('change'); }
  }
  async finish(id, actor) {
    const r = this.get(id, actor);
    if (r.busy || r.bytes !== r.size) throw new AppError(409, 'Le fichier n’est pas encore complet.');
    r.busy = true;
    this.app.active.delete(id);
    r.finalStream = createReadStream(r.path);
    try { return await this.app.upload({ stream: r.finalStream, name: r.name, size: r.size, actor }); }
    finally { await unlink(r.path).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
  }
  startFinish(id, actor) {
    const r = this.get(id, actor);
    if (r.completion) return r.completion;
    if (r.busy || r.bytes !== r.size) throw new AppError(409, 'Le fichier n’est pas encore complet.');
    r.completion = { status: 'processing' };
    r.job = this.finish(id, actor).then(result => {
      r.completion = { status: 'done', result }; r.updatedAt = Date.now(); r.busy = false;
    }).catch(error => {
      r.completion = { status: 'error', error: error.status ? error.message : 'Impossible de terminer l’envoi. Vérifiez l’espace disque et réessayez.' }; r.updatedAt = Date.now(); r.busy = false;
    });
    return r.completion;
  }
  get pending() { return [...this.records.values()].some(r => !['done', 'error'].includes(r.completion?.status)); }
  async discard(id) {
    const r = this.records.get(id);
    if (!r) return;
    this.records.delete(id); this.app.active.delete(id);
    if (!r.controller.signal.aborted) r.controller.abort();
    await unlink(r.path).catch(e => { if (e.code !== 'ENOENT') throw e; });
    this.app.emit('change');
  }
  async close() {
    clearInterval(this.timer);
    const jobs = [...this.records.values()].map(r => r.job).filter(Boolean);
    await Promise.all([...this.records.keys()].map(id => this.discard(id)));
    await Promise.allSettled(jobs);
  }
}
