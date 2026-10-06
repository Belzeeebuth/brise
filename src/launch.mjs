import { spawn } from 'node:child_process';
import { readFile, mkdir, open } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { paths } from './server.mjs';

const { dataDir } = paths();
const readyFile = join(dataDir, 'runtime.json');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function existing() {
  try {
    const ready = JSON.parse(await readFile(readyFile, 'utf8'));
    const response = await fetch(`http://127.0.0.1:${ready.port}/api/health`, { signal: AbortSignal.timeout(1000) });
    const state = await response.json();
    return state.app === 'brise' && state.session === ready.session ? ready : null;
  } catch { return null; }
}
try {
  let ready = await existing();
  if (!ready) {
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    const log = await open(join(dataDir, 'server.log'), 'a', 0o600);
    const child = spawn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), 'server.mjs')], { detached: true, stdio: ['ignore', log.fd, log.fd], env: process.env });
    child.unref(); await log.close();
    for (let attempt = 0; attempt < 40 && !ready; attempt++) { await wait(150); ready = await existing(); }
    if (!ready) throw new Error(`Le serveur n’a pas démarré. Consultez ${join(dataDir, 'server.log')}`);
  }
  const child = spawn('xdg-open', [ready.adminUrl], { detached: true, stdio: 'ignore' });
  child.on('error', () => console.error(`Ouvrez cette adresse dans votre navigateur : ${ready.adminUrl}`));
  child.unref();
  console.log('Brise est ouvert dans votre navigateur. Pour arrêter le partage, utilisez « Quitter Brise » dans les réglages.');
} catch (error) { console.error(error.message); process.exitCode = 1; }
