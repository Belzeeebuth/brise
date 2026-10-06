import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes, randomUUID } from 'node:crypto';
import { writeFile, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { isIP } from 'node:net';
import { AppError } from './core.mjs';

const exec = promisify(execFile);
export async function run(command, args) {
  const { stdout } = await exec(command, args, { encoding: 'utf8', timeout: 45000, maxBuffer: 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } });
  return stdout.trim();
}
export function wifiPayload(ssid, password) {
  const escape = value => value.replace(/[\\;,:"']/g, '\\$&');
  return `WIFI:T:WPA;S:${escape(ssid)};P:${escape(password)};;`;
}

export class Connections {
  constructor(app, network, { runCommand = run, spawnCommand = spawn, getInterfaces, createGateway, chunks } = {}) {
    this.app = app; this.network = network; this.run = runCommand; this.spawn = spawnCommand;
    this.getInterfaces = getInterfaces || (() => network.interfaces); this.createGateway = createGateway; this.chunks = chunks;
    this.mode = 'local'; this.status = 'ready'; this.message = ''; this.publicOrigin = null;
    this.capabilities = { internet: { available: false, reason: 'Vérification…' }, hotspot: { available: false, reason: 'Vérification…', interfaces: [] } };
    this.journal = join(app.dataDir, 'hotspot.json');
  }
  async init() {
    await this.recoverHotspot();
    await this.probe();
    return this;
  }
  async probe() {
    try { await this.run('cloudflared', ['--version']); this.capabilities.internet = { available: true }; }
    catch { this.capabilities.internet = { available: false, reason: 'cloudflared est requis pour le mode Internet.', install: 'sudo pacman -S cloudflared' }; }
    try {
      const lines = await this.run('nmcli', ['-t', '-f', 'DEVICE,TYPE', 'device', 'status']);
      const devices = [];
      for (const line of lines.split('\n')) {
        const match = /^([a-zA-Z0-9_.-]+):wifi$/.exec(line);
        if (!match) continue;
        const supported = await this.run('nmcli', ['-g', 'WIFI-PROPERTIES.AP', 'device', 'show', match[1]]);
        if (supported === 'yes') devices.push(match[1]);
      }
      this.capabilities.hotspot = { available: devices.length > 0, interfaces: devices, reason: devices.length ? '' : 'Aucune carte Wi-Fi compatible point d’accès détectée.' };
    } catch { this.capabilities.hotspot = { available: false, interfaces: [], reason: 'NetworkManager est inaccessible. Vérifiez qu’il fonctionne dans votre session.' }; }
    return this.state();
  }
  state() {
    return { mode: this.mode, status: this.status, message: this.message, capabilities: this.capabilities,
      hotspot: this.hotspot ? { ssid: this.hotspot.ssid, password: this.hotspot.password, interface: this.hotspot.interface } : null,
      publicOrigin: this.publicOrigin,
    };
  }
  origin() { return this.status !== 'ready' ? null : this.mode === 'internet' ? this.publicOrigin : this.network.address ? `http://${this.network.address}:${this.network.port}` : null; }
  changed() { this.app.emit('change'); }
  revoke() { for (const d of this.app.devices.values()) if (d.status !== 'revoked') this.app.decide(d.id, false); this.app.rotate(); }
  select(mode, options = {}) {
    if (!['local', 'internet', 'hotspot'].includes(mode)) throw new AppError(400, 'Mode inconnu.');
    if (this.job) throw new AppError(409, 'Un changement de mode est en cours.');
    if ([...this.app.active.values()].some(t => !t.paused) || this.chunks?.pending) throw new AppError(409, 'Attendez la fin des transferts avant de changer de mode.');
    if (mode === 'hotspot') {
      if (!this.capabilities.hotspot.available) throw new AppError(409, this.capabilities.hotspot.reason);
      if (!options.confirmWifiChange) throw new AppError(409, 'Confirmez le remplacement de la connexion Wi-Fi sur la carte choisie.');
      if (!this.capabilities.hotspot.interfaces.includes(options.interface)) throw new AppError(400, 'Carte Wi-Fi invalide.');
    }
    if (mode === 'internet' && !this.capabilities.internet.available) throw new AppError(409, this.capabilities.internet.reason);
    this.status = 'starting'; this.message = ''; this.revoke(); this.changed();
    this.job = this.transition(mode, options).catch(error => {
      this.status = 'error'; this.message = error.message; this.changed();
    }).finally(() => { this.job = null; });
    return this.state();
  }
  async transition(mode, options) {
    await this.stopResources();
    this.mode = mode; this.publicOrigin = null; this.changed();
    if (mode === 'local') this.refreshNetwork();
    if (mode === 'internet') await this.startTunnel();
    if (mode === 'hotspot') await this.startHotspot(options.interface);
    this.status = 'ready'; this.changed();
  }
  refreshNetwork() {
    this.network.interfaces = this.getInterfaces();
    if (this.network.fixed) { this.network.address = this.network.fixed; return; }
    if (!this.network.interfaces.some(i => i.address === this.network.address)) this.network.manual = false;
    if (!this.network.manual) this.network.address = this.network.interfaces[0]?.address || null;
  }
  syncNetwork() {
    if (this.mode !== 'local' || this.status !== 'ready' || this.job || Date.now() - (this.syncedAt || 0) < 2000) return;
    this.syncedAt = Date.now();
    const previous = this.network.address;
    this.refreshNetwork();
    if (this.network.address !== previous) this.app.rotate();
  }
  async startTunnel() {
    this.gateway = await this.createGateway();
    const port = this.gateway.port;
    try {
      // Do not inherit a user's named tunnel or ingress configuration.
      const tunnelConfig = join(this.app.dataDir, 'quick-tunnel.yml');
      await writeFile(tunnelConfig, '{}\n', { mode: 0o600 });
      await new Promise((resolve, reject) => {
        let buffer = '', origin = null, settled = false;
        const finish = (error) => {
          if (settled) return;
          settled = true; clearTimeout(timeout);
          if (error) reject(error); else { this.publicOrigin = origin; resolve(); }
        };
        const child = this.spawn('cloudflared', ['tunnel', '--config', tunnelConfig, '--no-autoupdate', '--loglevel', 'info', '--url', `http://127.0.0.1:${port}`, '--http-host-header', `127.0.0.1:${port}`, '--protocol', 'http2'], {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('TUNNEL_'))),
        });
        this.tunnel = child;
        const timeout = setTimeout(() => finish(new Error('Le tunnel n’a pas démarré. Vérifiez la connexion Internet du PC.')), 45000);
        const output = chunk => {
          buffer = (buffer + chunk.toString()).slice(-16384);
          origin ||= buffer.match(/https:\/\/[a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com\b/)?.[0];
          if (origin && /Registered tunnel connection/.test(buffer)) finish();
        };
        child.stdout.on('data', output); child.stderr.on('data', output);
        child.once('error', () => finish(new Error('Impossible de lancer cloudflared. Installez-le puis réessayez.')));
        child.once('exit', () => {
          if (!settled) finish(new Error('Le tunnel s’est arrêté avant la connexion.'));
          else if (this.tunnel === child) {
            this.tunnel = null; this.publicOrigin = null; this.status = 'error';
            this.message = 'Le tunnel Internet s’est arrêté. Cliquez sur Réessayer.'; this.revoke(); this.changed();
          }
        });
      });
    } catch (error) { await this.stopTunnel(); throw error; }
  }
  async stopTunnel() {
    const child = this.tunnel; this.tunnel = null; this.publicOrigin = null;
    if (child && child.exitCode === null) {
      await new Promise(resolve => {
        const timeout = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 3000);
        child.once('exit', () => { clearTimeout(timeout); resolve(); });
        child.kill('SIGTERM');
      });
    }
    await this.gateway?.close(); this.gateway = null;
  }
  async startHotspot(iface) {
    const previous = await this.run('nmcli', ['-g', 'GENERAL.CON-UUID', 'device', 'show', iface]);
    const radio = await this.run('nmcli', ['radio', 'wifi']);
    const h = { uuid: randomUUID(), interface: iface, previous: /^[0-9a-f-]{36}$/.test(previous) ? previous : null, radioWasOff: radio === 'disabled', ssid: `Brise-${randomBytes(2).toString('hex')}`, password: randomBytes(12).toString('base64url') };
    this.hotspot = h;
    // The journal lets the next launch restore Wi-Fi after an unexpected exit.
    await writeFile(this.journal, JSON.stringify(h), { mode: 0o600 });
    try {
      await this.run('nmcli', ['--wait', '15', 'connection', 'add', 'type', 'wifi', 'ifname', iface,
        'con-name', h.ssid, 'connection.uuid', h.uuid, 'connection.autoconnect', 'no',
        'ssid', h.ssid, '802-11-wireless.mode', 'ap',
        '802-11-wireless-security.key-mgmt', 'wpa-psk', '802-11-wireless-security.proto', 'rsn', '802-11-wireless-security.psk', h.password,
        'ipv4.method', 'shared', 'ipv6.method', 'disabled']);
      if (h.radioWasOff) await this.run('nmcli', ['radio', 'wifi', 'on']);
      await this.run('nmcli', ['--wait', '30', 'connection', 'up', 'uuid', h.uuid]);
      const addresses = await this.run('nmcli', ['-g', 'IP4.ADDRESS', 'device', 'show', iface]);
      const address = addresses.split('\n').map(a => a.split('/')[0]).find(a => isIP(a) === 4);
      if (!address) throw new Error('Le point d’accès n’a pas obtenu d’adresse IPv4.');
      this.network.interfaces = this.getInterfaces(); this.network.address = address;
    } catch {
      await this.stopHotspot();
      throw new Error('Impossible de démarrer le point d’accès. Vérifiez les permissions NetworkManager et la compatibilité de la carte Wi-Fi.');
    }
  }
  async stopHotspot() {
    const h = this.hotspot;
    if (!h) return;
    // Delete only the UUID created by this instance, never another user profile.
    const profiles = await this.run('nmcli', ['-g', 'UUID', 'connection', 'show']);
    if (profiles.split('\n').includes(h.uuid)) await this.run('nmcli', ['--wait', '15', 'connection', 'delete', 'uuid', h.uuid]);
    const current = await this.run('nmcli', ['-g', 'GENERAL.CON-UUID', 'device', 'show', h.interface]);
    // Do not replace a different network the user selected manually meanwhile.
    if (h.previous && (!current || current === '--' || current === h.uuid)) {
      try { await this.run('nmcli', ['--wait', '30', 'connection', 'up', 'uuid', h.previous]); }
      catch { this.message = 'Le point d’accès est arrêté, mais la connexion Wi-Fi précédente n’a pas pu être rétablie. Reconnectez le PC depuis les réglages réseau.'; }
    }
    if (h.radioWasOff && (!current || current === '--' || current === h.uuid)) await this.run('nmcli', ['radio', 'wifi', 'off']);
    await unlink(this.journal).catch(e => { if (e.code !== 'ENOENT') throw e; });
    this.hotspot = null; this.refreshNetwork();
  }
  async recoverHotspot() {
    try { this.hotspot = JSON.parse(await readFile(this.journal, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (!/^[0-9a-f-]{36}$/.test(this.hotspot?.uuid) || !/^[a-zA-Z0-9_.-]+$/.test(this.hotspot?.interface)) throw new Error('État du point d’accès invalide.');
    try { await this.stopHotspot(); }
    catch { this.mode = 'hotspot'; this.status = 'error'; this.message = 'Le précédent point d’accès n’a pas pu être arrêté. Vérifiez NetworkManager puis revenez au mode local.'; }
  }
  async stopResources() { await this.stopTunnel(); await this.stopHotspot(); }
  async close() { await this.job; await this.stopResources(); }
}
