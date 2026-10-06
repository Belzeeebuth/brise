// Static visual fixtures only. No mock data is ever served by the application.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { qrSvg } from '../src/qr.mjs';
import { wifiPayload } from '../src/connections.mjs';
const dir = new URL('../artifacts/', import.meta.url); await mkdir(dir, { recursive:true });
const [html, css, script, logo] = await Promise.all(['index.html','styles.css','app.js','icon.svg'].map(f => readFile(new URL(`../public/${f}`, import.meta.url), 'utf8')));
const state = { role:'admin', name:'Ce PC', status:'approved', network:{ hostname:'CachyOS', address:'192.168.1.42', port:53318, interfaces:[{ name:'wlan0',address:'192.168.1.42' }] }, expiresAt:Date.now()+600000, pairUrl:'http://192.168.1.42:53318/connect#visual-fixture', receiveDir:'/home/ana/Téléchargements/Brise', maxFileSize:10737418240, devices:[], transfers:[], files:[] };
state.connectionMode = 'local';
state.connection = { mode: 'local', status: 'ready', message: '', hotspot: null, capabilities: { internet: { available: true }, hotspot: { available: true, interfaces: ['wlan0'] } } };
const hotspot = { ssid: 'Brise-demo', password: 'preview-only-1234', interface: 'wlan0' };
const wifi = qrSvg(wifiPayload(hotspot.ssid, hotspot.password));
await writeFile(new URL('wifi-qr.svg', dir), wifi);
const qr = qrSvg(state.pairUrl);
await writeFile(new URL('qr.svg', dir), qr);
for (const [name, data] of [['desktop', state], ['mobile', { ...state, role:'phone', files:[] }], ['desktop-files', { ...state, files:[{ id:'test-1', name:'IMG_2048.jpg', size:3450000, direction:'outgoing', createdAt:Date.now(), downloads:0 }, { id:'test-2', name:'document.pdf', size:248000, direction:'outgoing', createdAt:Date.now(), downloads:1 }], devices:[{ id:'test-phone',name:'Mon iPhone',status:'approved',online:true }] }], ['internet', { ...state, connectionMode: 'internet', connection: { ...state.connection, mode: 'internet', publicOrigin: 'https://example-tunnel.trycloudflare.com' }, pairUrl: 'https://example-tunnel.trycloudflare.com/connect#visual-fixture' }], ['hotspot', { ...state, connectionMode: 'hotspot', connection: { ...state.connection, mode: 'hotspot', hotspot }, pairUrl: 'http://10.42.0.1:53318/connect#visual-fixture' }]]) {
  const fixture = script.replace(/init\(\);\s*$/, `updateState(${JSON.stringify(data)}); if (state.role === 'admin') $('#qr').src = ${JSON.stringify('data:image/svg+xml;base64,' + Buffer.from(qrSvg(data.pairUrl)).toString('base64'))}; $('#wifi-qr').src = ${JSON.stringify('data:image/svg+xml;base64,' + Buffer.from(wifi).toString('base64'))};`);
  await writeFile(new URL(`${name}.html`, dir), html.replace('<link rel="stylesheet" href="/styles.css">', `<style>${css}</style>`).replace('<script src="/app.js" defer></script>', '').replaceAll('src="/icon.svg"', `src="data:image/svg+xml;base64,${Buffer.from(logo).toString('base64')}"`).replace('</body>', `<script>${fixture}</script></body>`));
}
console.log('Aperçus : desktop, desktop-files, mobile, internet et hotspot dans artifacts/.');
