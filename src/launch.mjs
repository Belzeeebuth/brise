import { spawn } from 'node:child_process';
import { readFile, mkdir, open, stat } from 'node:fs/promises';
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
    const logPath = join(dataDir, 'server.log');
    const logStart = (await stat(logPath).catch(() => null))?.size || 0;
    const log = await open(logPath, 'a', 0o600);
    const child = spawn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), 'server.mjs')], { detached: true, stdio: ['ignore', log.fd, log.fd], env: process.env });
    let exited = false; child.once('exit', () => { exited = true; });
    child.unref(); await log.close();
    for (let attempt = 0; attempt < 40 && !ready && !exited; attempt++) { await wait(150); ready = await existing(); }
    if (!ready) {
      const output = (await readFile(logPath).catch(() => Buffer.alloc(0))).subarray(logStart).toString('utf8');
      const reason = output.split('\n').reverse().find(line => line.startsWith('Brise : '));
      throw new Error(reason ? reason.slice(8) : `Le serveur n’a pas démarré. Consultez ${logPath}`);
    }
  }
  const child = spawn('xdg-open', [ready.adminUrl], { detached: true, stdio: 'ignore' });
  child.on('error', () => console.error(`Ouvrez cette adresse dans votre navigateur : ${ready.adminUrl}`));
  child.unref();
  console.log('Brise est ouvert dans votre navigateur. Pour arrêter le partage, utilisez « Quitter Brise » dans les réglages.');
} catch (error) {
  console.error(error.message); process.exitCode = 1;
  spawn('notify-send', ['--app-name=Brise', '--icon', join(dirname(dirname(fileURLToPath(import.meta.url))), 'public', 'icon.svg'), 'Brise n’a pas pu démarrer', error.message], { stdio: 'ignore' }).on('error', () => {});
}
