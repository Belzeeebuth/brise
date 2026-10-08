// Test de bout en bout de la page du téléphone : un navigateur Chromium sans
// fenêtre pilote la vraie page servie par le serveur de test (e2e_server), avec
// des coupures réseau simulées pendant les envois.
//
//   cargo build --manifest-path src-tauri/Cargo.toml --example e2e_server
//   node tests/e2e/phone.mjs
//
// Variables : BRISE_BROWSER (chemin du navigateur), BRISE_E2E_SERVER (chemin du
// serveur de test).
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, readdir, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const serverBinary = process.env.BRISE_E2E_SERVER || join(repo, 'src-tauri/target/debug/examples/e2e_server');
async function findBrowser() {
  const candidates = [process.env.BRISE_BROWSER, process.env.CHROME_BIN, '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/brave', '/usr/bin/brave-browser'].filter(Boolean);
  for (const candidate of candidates) {
    try { await access(candidate); return candidate; } catch {}
  }
  throw new Error('Aucun navigateur Chromium trouvé : définissez BRISE_BROWSER');
}
const browserBinary = await findBrowser();
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const root = await mkdtemp(join(tmpdir(), 'brise-e2e-'));
const cleanup = [];
process.on('exit', () => cleanup.forEach(fn => { try { fn(); } catch {} }));

const photo = randomBytes(3 * 1024 * 1024);
await writeFile(join(root, 'IMG_0042.MOV'), photo);
const env = { ...process.env, BRISE_DATA_DIR: join(root, 'data'), BRISE_RECEIVE_DIR: join(root, 'recv'), BRISE_PORT: '0', BRISE_E2E_TEXT: 'https://example.org/depuis-le-pc' };
const server = spawn(serverBinary, [join(root, 'IMG_0042.MOV')], { env, stdio: ['ignore', 'pipe', 'inherit'] });
cleanup.push(() => server.kill('SIGKILL'));
let out = '';
server.stdout.on('data', chunk => { out += chunk; });
for (let i = 0; i < 100 && !out.includes('\n'); i++) await wait(100);
assert.ok(out.includes('\n'), 'le serveur de test ne démarre pas');
const { port, pairUrl, pairCode } = JSON.parse(out.split('\n')[0]);
const base = `http://127.0.0.1:${port}`;
const payload = randomBytes(20 * 1024 * 1024 + 12345);
const filePath = join(root, 'clip.mov');
await writeFile(filePath, payload);

let step = 0;
const log = message => console.log(`${String(++step).padStart(2)}. ${message}`);

async function openBrowser(profile) {
  const debugPort = 9500 + Math.floor(Math.random() * 400);
  const browser = spawn(browserBinary, ['--headless=new', '--no-first-run', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${join(root, profile)}`, '--lang=fr', 'about:blank'], { stdio: 'ignore' });
  cleanup.push(() => browser.kill('SIGKILL'));
  let page;
  for (let i = 0; i < 100 && !page; i++) {
    await wait(200);
    try { page = (await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json()).find(t => t.type === 'page'); } catch {}
  }
  assert.ok(page, 'le navigateur ne démarre pas');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(resolve => ws.addEventListener('open', resolve));
  let seq = 0;
  const pending = new Map();
  const listeners = [];
  ws.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
    else listeners.forEach(listener => listener(message));
  });
  const cdp = (method, params = {}) => new Promise(resolve => { const id = ++seq; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
  const evaluate = async expression => {
    const reply = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (reply.result?.exceptionDetails) throw new Error(`évaluation : ${JSON.stringify(reply.result.exceptionDetails).slice(0, 300)}`);
    return reply.result?.result?.value;
  };
  const until = async (expression, ms = 60000) => {
    for (let elapsed = 0; elapsed < ms; elapsed += 200) {
      const value = await evaluate(expression);
      if (value) return value;
      await wait(200);
    }
    throw new Error(`délai dépassé : ${expression}`);
  };
  listeners.push(message => { if (message.method === 'Runtime.exceptionThrown') console.log('   exception page :', JSON.stringify(message.params.exceptionDetails).slice(0, 300)); });
  await cdp('Runtime.enable'); await cdp('Page.enable'); await cdp('DOM.enable');
  return { browser, cdp, evaluate, until, listeners, close: () => { ws.close(); browser.kill('SIGKILL'); } };
}

// Premier téléphone : QR, textes, envois avec coupures, partage.
const phone = await openBrowser('profile-1');
let failPlan = [];
const chunkLog = [];
phone.listeners.push(message => {
  if (message.method !== 'Fetch.requestPaused') return;
  const { requestId, request } = message.params;
  const isChunk = request.method === 'POST' && /\/api\/uploads\/[0-9a-f-]+$/.test(request.url);
  if (isChunk) {
    const offset = request.headers['X-Chunk-Offset'] ?? request.headers['x-chunk-offset'];
    const fail = failPlan.length && failPlan[0](offset);
    chunkLog.push(`${fail ? 'coupé' : 'ok'}@${offset}`);
    if (fail) { failPlan.shift(); phone.cdp('Fetch.failRequest', { requestId, errorReason: 'ConnectionReset' }); return; }
  }
  phone.cdp('Fetch.continueRequest', { requestId });
});
await phone.cdp('Fetch.enable', { patterns: [{ urlPattern: '*/api/uploads/*', requestStage: 'Request' }] });
await phone.cdp('Page.navigate', { url: pairUrl });
await phone.until(`location.pathname === '/connect' && document.querySelector('#shell')?.hidden === false && !document.querySelector('#pair-screen').hidden`, 15000);
assert.equal(await phone.evaluate(`document.querySelector('#pair-code-field').hidden`), true, 'avec le QR, pas de code à taper');
await phone.evaluate(`document.querySelector('#device-name').value = 'Test'; document.querySelector('#pair-form').requestSubmit(); true`);
await phone.until(`!document.querySelector('#workspace').hidden`, 15000);
log('association par QR code, acceptée automatiquement');

await phone.until(`document.querySelector('[data-copy]')`, 10000);
assert.equal(await phone.evaluate(`document.querySelector('.text-row .row-name').textContent`), 'https://example.org/depuis-le-pc');
log('le lien partagé depuis le PC est affiché');

await phone.evaluate(`document.querySelector('#send-text').click(); true`);
await phone.until(`document.querySelector('#phone-text')`, 5000);
await phone.evaluate(`document.querySelector('#phone-text').value = 'Bonjour depuis le téléphone'; document.querySelector('#phone-text-form').requestSubmit(); true`);
await phone.until(`document.querySelector('#toasts').textContent.includes('arrivé')`, 10000);
for (let i = 0; i < 50; i++) {
  try { if ((await readFile(join(root, 'data/notes.json'), 'utf8')).includes('Bonjour depuis le téléphone')) break; } catch {}
  await wait(100);
}
assert.ok((await readFile(join(root, 'data/notes.json'), 'utf8')).includes('Bonjour depuis le téléphone'), 'le texte envoyé est conservé sur le PC');
log('un texte envoyé depuis le téléphone est reçu et conservé');

async function pick() {
  const { root: doc } = (await phone.cdp('DOM.getDocument')).result;
  const { nodeId } = (await phone.cdp('DOM.querySelector', { nodeId: doc.nodeId, selector: '#file-picker' })).result;
  await phone.cdp('DOM.setFileInputFiles', { nodeId, files: [filePath] });
}
async function received() {
  const files = (await readdir(join(root, 'recv'))).filter(name => !name.startsWith('.'));
  return Promise.all(files.map(async name => ({ name, same: Buffer.compare(await readFile(join(root, 'recv', name)), payload) === 0 })));
}

failPlan = [offset => offset === String(8 * 1024 * 1024)];
await pick();
await phone.until(`uploads.length && uploads.every(u => ['done', 'error'].includes(u.status))`, 120000);
assert.equal(await phone.evaluate(`uploads.map(u => u.status).join()`), 'done');
assert.deepEqual(chunkLog.splice(0), ['ok@0', 'coupé@8388608', 'ok@8388608', 'ok@16777216']);
assert.deepEqual(await received(), [{ name: 'clip.mov', same: true }]);
log('un bloc coupé est renvoyé et le fichier arrive intact');

failPlan = Array(6).fill(offset => offset === String(16 * 1024 * 1024));
await pick();
await phone.until(`uploads.some(u => u.status === 'error')`, 120000);
assert.match(await phone.evaluate(`uploads.find(u => u.status === 'error').error`), /Réessayer/);
assert.equal(chunkLog.splice(0).filter(entry => entry.startsWith('coupé')).length, 6);
await phone.evaluate(`document.querySelector('[data-retry]').click(); true`);
await phone.until(`uploads.filter(u => u.status === 'done').length === 2`, 60000);
assert.deepEqual(chunkLog.splice(0), ['ok@16777216'], 'la reprise repart du dernier bloc');
assert.deepEqual((await received()).sort((a, b) => a.name.localeCompare(b.name)), [{ name: 'clip (1).mov', same: true }, { name: 'clip.mov', same: true }]);
assert.deepEqual(await readdir(join(root, 'recv', '.partial')), [], 'aucun fichier temporaire oublié');
log('après six coupures, « Réessayer » reprend au bon endroit, sans résidu');

failPlan = [];
await phone.cdp('Page.addScriptToEvaluateOnNewDocument', { source: `navigator.canShare = () => true; navigator.share = async data => { window.sharedFiles = await Promise.all(data.files.map(async f => ({ name: f.name, type: f.type, size: f.size, head: [...new Uint8Array(await f.slice(0, 4).arrayBuffer())] }))); };` });
await phone.cdp('Page.navigate', { url: `${base}/` });
await phone.until(`document.querySelector('#workspace') && !document.querySelector('#workspace').hidden && document.querySelector('[data-share]')`, 15000);
log('rouvrir la page sans QR retrouve la connexion (appareil mémorisé)');
assert.equal(await phone.evaluate(`document.querySelector('[data-share]').textContent`), 'Partager');
await phone.evaluate(`document.querySelector('[data-share]').click(); true`);
const shared = await phone.until('window.sharedFiles', 15000);
assert.deepEqual(shared, [{ name: 'IMG_0042.MOV', type: 'video/quicktime', size: photo.length, head: [...photo.subarray(0, 4)] }]);
log('le bouton Partager prépare le fichier complet avec son type');
phone.close();

// Second téléphone : connexion en tapant le code court, sans QR.
const typed = await openBrowser('profile-2');
await typed.cdp('Page.navigate', { url: `${base}/` });
await typed.until(`document.querySelector('#shell')?.hidden === false && !document.querySelector('#pair-screen').hidden && !document.querySelector('#pair-code-field').hidden`, 15000);
await typed.evaluate(`document.querySelector('#pair-code-input').value = 'zzz-zzz'; document.querySelector('#device-name').value = 'Clavier'; document.querySelector('#pair-form').requestSubmit(); true`);
await typed.until(`document.querySelector('#toasts').textContent.includes('expiré')`, 10000);
await typed.evaluate(`document.querySelector('#pair-code-input').value = '${pairCode.slice(0, 3).toLowerCase()} ${pairCode.slice(3)}'; document.querySelector('#pair-form').requestSubmit(); true`);
await typed.until(`!document.querySelector('#workspace').hidden`, 15000);
log('un code tapé à la main (minuscules, espace) connecte le téléphone');
typed.close();

server.kill('SIGTERM');
await wait(300);
await rm(root, { recursive: true, force: true });
console.log('\nTest de bout en bout : tout passe.');
process.exit(0);
