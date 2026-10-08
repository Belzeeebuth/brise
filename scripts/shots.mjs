// Captures de l'interface du PC sans ouvrir de fenêtre : un navigateur Chromium
// sans affichage charge ui/index.html avec un faux window.__TAURI__ et un état
// fictif. Pratique pour vérifier un changement de style.
//
//   node scripts/shots.mjs <scène> <largeur> <hauteur> <sortie.png> [thème] [langue] [fond] [action JS]
//
// Scènes : connect, share, busy, pending, hotspot, error. Variable BRISE_BROWSER
// pour choisir le navigateur.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const [scene, width, height, out, theme = 'dark', lang = 'fr', wallpaper = 'brume', action = ''] = process.argv.slice(2);
const ui = join(dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const browserBinary = process.env.BRISE_BROWSER || ['/usr/bin/chromium', '/usr/bin/google-chrome', '/usr/bin/brave'].find(p => { try { return require('node:fs').accessSync(p) === undefined; } catch { return false; } }) || '/usr/bin/chromium';
const types = { html: 'text/html', js: 'text/javascript', css: 'text/css', svg: 'image/svg+xml', png: 'image/png', woff2: 'font/woff2', jpg: 'image/jpeg' };
const server = createServer(async (req, res) => {
  const path = decodeURIComponent(req.url.split('?')[0]);
  const file = path === '/' ? '/index.html' : path;
  try {
    const data = await readFile(join(ui, file));
    res.writeHead(200, { 'content-type': types[file.split('.').pop()] || 'application/octet-stream' });
    res.end(data);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const now = Date.now();
const devices = {
  none: [],
  one: [{ id: 'd1', name: 'iPhone d’Ana', status: 'approved', online: true }],
  two: [{ id: 'd1', name: 'iPhone d’Ana', status: 'approved', online: true }, { id: 'd2', name: 'Pixel de Léo', status: 'approved', online: false }],
  pending: [{ id: 'd1', name: 'iPhone d’Ana', status: 'approved', online: true }, { id: 'd3', name: 'iPad', status: 'pending', code: '482913' }],
};
const files = {
  empty: [],
  some: [
    { id: 'f1', name: 'IMG_4021.jpg', size: 3_200_000, direction: 'incoming', sender: 'iPhone d’Ana', createdAt: now - 120000, path: '/tmp/mock/IMG_4021.jpg' },
    { id: 'f2', name: 'Notes de réunion.pdf', size: 184_000, direction: 'incoming', sender: 'iPhone d’Ana', createdAt: now - 3600000, path: '/tmp/mock/notes.pdf' },
    { id: 'f3', name: 'Vidéo plage.mov', size: 212_000_000, direction: 'incoming', sender: 'Pixel de Léo', createdAt: now - 90000000, path: '/tmp/mock/v.mov' },
    { id: 'f4', name: 'Facture octobre.pdf', size: 92_000, direction: 'outgoing', downloads: 1, path: '/tmp/mock/facture.pdf' },
    { id: 'f5', name: 'Présentation.key', size: 24_000_000, direction: 'outgoing', downloads: 0, path: '/tmp/mock/p.key' },
    { id: 'f6', name: 'album.zip', size: 540_000_000, direction: 'outgoing', downloads: 0, path: '/tmp/mock/album.zip' },
  ],
};
const transfers = {
  none: [],
  busy: [
    { id: 't1', direction: 'incoming', name: 'IMG_4022.mov', size: 480_000_000, bytes: 210_000_000, sender: 'iPhone d’Ana', paused: false },
    { id: 't2', direction: 'download', fileId: 'f6', name: 'album.zip', size: 540_000_000, bytes: 120_000_000, sender: 'iPhone d’Ana' },
  ],
};
const scenes = {
  connect: { devices: devices.none, files: files.empty, transfers: transfers.none },
  share: { devices: devices.one, files: files.some, transfers: transfers.none },
  busy: { devices: devices.two, files: files.some, transfers: transfers.busy },
  pending: { devices: devices.pending, files: files.some, transfers: transfers.none },
  hotspot: { devices: devices.none, files: files.empty, transfers: transfers.none, mode: 'hotspot' },
  error: { devices: devices.none, files: files.empty, transfers: transfers.none, serverError: { error: 'port_in_use', params: { port: 53318 } } },
};
const s = scenes[scene] || scenes.connect;
const mode = s.mode || 'local';
const state = {
  lang, version: '0.4.0',
  network: { address: '192.168.1.47', port: 53318, interfaces: [{ name: 'wlp0s20f3', address: '192.168.1.47' }], hostname: 'levya' },
  connectionMode: mode,
  connection: { mode, status: 'ready', message: null, hotspot: mode === 'hotspot' ? { ssid: 'Brise-7K2P', password: 'vent-leger-4821' } : null, capabilities: { internet: { available: false, reason: 'cloudflared_required', install: 'sudo pacman -S cloudflared', installUrl: 'https://example.invalid' }, hotspot: { available: true, interfaces: ['wlp0s20f3'] } } },
  devices: s.devices, files: s.files, transfers: s.transfers,
  pairCode: 'K7P4QX',
  notes: s.files.length ? [
    { id: 'n1', text: 'https://fr.wikipedia.org/wiki/Brise_de_mer', direction: 'outgoing', sender: '', createdAt: now - 60000 },
    { id: 'n2', text: 'Code wifi de la maison : vent-leger-4821\nIl est aussi sur le frigo.', direction: 'incoming', sender: 'iPhone d’Ana', createdAt: now - 1800000 },
  ] : [],
  expiresAt: now + 540000, pairUrl: 'http://192.168.1.47:53318/connect#abcdef', receiveDir: '/home/ana/Téléchargements/Brise', maxFileSize: 10737418240,
  serverError: s.serverError || null,
  wallpaper: wallpaper === 'custom' ? { id: 'custom', accent: { light: '#b25a2a', dark: '#e3a373' }, version: 7, customPath: '/tmp/mock/photo.jpg' } : { id: wallpaper, accent: null, version: 0, customPath: null },
};
const qr = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 29 29" shape-rendering="crispEdges"><rect width="29" height="29" fill="#fff"/><path fill="#000" d="${Array.from({ length: 29 }, (_, y) => Array.from({ length: 29 }, (_, x) => ((x * 7 + y * 13 + (x * y) % 5) % 3 === 0 || (x < 7 && y < 7 && (x === 0 || y === 0 || x === 6 || y === 6 || (x > 1 && x < 5 && y > 1 && y < 5))) ? `M${x} ${y}h1v1h-1z` : '')).join('')).join('')}"/></svg>`;
const bootstrap = `
  window.__TAURI__ = {
    core: { invoke: async (cmd, args) => {
      if (cmd === 'get_state') return ${JSON.stringify(state)};
      if (cmd === 'qr' || cmd === 'wifi_qr') return ${JSON.stringify(qr)};
      if (cmd === 'set_wallpaper') { window.__state.wallpaper.id = args.id; return null; }
      return null;
    }, convertFileSrc: p => '${base}/wallpapers/aurore-light.svg' },
    event: { listen: async () => () => {} },
    window: { getCurrentWindow: () => ({ theme: async () => '${theme}', setTheme: async () => {}, onThemeChanged: async () => {} }) },
  };
  try { localStorage.setItem('brise-theme', '${theme}'); localStorage.removeItem('brise-look'); } catch {}
`;
const profile = mkdtempSync(join(tmpdir(), 'brise-shots-'));
const port = 9400 + Math.floor(Math.random() * 400);
const browser = spawn(browserBinary, ['--headless=new', '--no-sandbox', '--no-first-run', '--hide-scrollbars', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, `--lang=${lang}`, 'about:blank'], { stdio: 'ignore' });
process.on('exit', () => { try { browser.kill('SIGKILL'); } catch {} });
const wait = ms => new Promise(r => setTimeout(r, ms));
let page;
for (let i = 0; i < 60; i++) { await wait(200); try { page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(t => t.type === 'page'); if (page) break; } catch {} }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
let seq = 0; const pending = new Map();
ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } else if (m.method === 'Runtime.exceptionThrown') console.log('EXC', JSON.stringify(m.params.exceptionDetails).slice(0, 500)); });
const cdp = (method, params = {}) => new Promise(r => { const id = ++seq; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
await cdp('Runtime.enable'); await cdp('Page.enable');
await cdp('Emulation.setDeviceMetricsOverride', { width: +width, height: +height, deviceScaleFactor: 1, mobile: false });
await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] });
await cdp('Page.addScriptToEvaluateOnNewDocument', { source: bootstrap });
await cdp('Page.navigate', { url: `${base}/index.html` });
await wait(1500);
if (action) {
  const r = await cdp('Runtime.evaluate', { expression: action, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) console.log('ACTION EXC', JSON.stringify(r.result.exceptionDetails).slice(0, 400));
  await wait(700);
}
const shot = await cdp('Page.captureScreenshot', { format: 'png' });
writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
console.log('saved', out);
server.close(); browser.kill('SIGKILL'); process.exit(0);
