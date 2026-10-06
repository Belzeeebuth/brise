'use strict';
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
let state = null, refreshing = false, again = false;
let lastFiles = '', lastDevices = '', lastQr = '', lastHotspot = '', lastTransfers = '';
async function call(command, args) {
  try { return await invoke(command, args); }
  catch (error) { throw new Error(typeof error === 'string' ? error : error?.message || 'Une erreur est survenue.'); }
}
const svgData = svg => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
function fileRow(file, mode) {
  const type = fileType(file.name);
  const detail = mode === 'history' ? `${escape(file.sender)} · ${formatDate(file.createdAt)}` : file.downloads ? `${file.downloads} téléchargement${file.downloads > 1 ? 's' : ''}` : 'En attente de téléchargement';
  const actions = mode === 'shared'
    ? `<span class="file-status">${icon(file.downloads ? 'check-circle' : 'check')}${file.downloads ? 'Récupéré' : 'Disponible'}</span><button class="icon-button" data-remove="${file.id}" aria-label="Retirer du partage ${escape(file.name)}" title="Retirer du partage">${icon('x')}</button>`
    : `<button class="icon-button reveal" data-reveal="${file.id}" aria-label="Afficher ${escape(file.name)} dans le dossier" title="Afficher dans le dossier">${icon('folder')}</button>`;
  return `<div class="file-row"><span class="file-icon ${type}">${icon(type)}</span><div class="file-meta"><span class="file-name" title="${escape(file.name)}">${escape(file.name)}</span><div class="file-details"><span>${formatSize(file.size)}</span><span>·</span><span>${detail}</span></div></div>${actions}</div>`;
}
function deviceCard(d) {
  const pending = d.status === 'pending';
  return `<article class="device-card ${pending ? 'pending' : ''}"><span class="device-icon">${icon('phone')}</span><div class="device-info"><strong>${escape(d.name)}</strong><p>${pending ? 'Souhaite se connecter · code ' + `<code>${escape(d.code.replace(/(.{3})/, '$1 '))}</code>` : d.online ? 'Connecté · prêt à partager' : 'En veille · ouvrez Brise sur le téléphone'}</p></div><div class="device-actions">${pending ? `<button class="button secondary" data-decide="${d.id}" data-approve="false">Refuser</button><button class="button primary" data-decide="${d.id}" data-approve="true">${icon('check')}Accepter</button>` : `<button class="button secondary" data-decide="${d.id}" data-approve="false">Déconnecter</button>`}</div></article>`;
}
function transferCaption(t) {
  return t.paused ? `En pause · en attente de ${t.sender}` : t.direction === 'download' ? `Vers ${t.sender}` : `Depuis ${t.sender}`;
}
async function updateQr(next) {
  const url = next.pairUrl || '';
  if (lastQr === `${url}|${next.expiresAt}`) return;
  lastQr = `${url}|${next.expiresAt}`;
  $('#qr').hidden = !url; $('#qr-empty').hidden = !!url;
  $('[data-action="copy-link"]').disabled = !url;
  if (url) { try { $('#qr').src = svgData(await call('qr')); } catch { $('#qr').hidden = true; $('#qr-empty').hidden = false; } }
}
function updateState(next) {
  state = next;
  $('#boot').hidden = true; $('#shell').hidden = false;
  $('#network-status span').textContent = modeLabel(next.connectionMode || 'local');
  renderConnection(next.connection, next.serverError);
  $('#computer-name').textContent = next.network.hostname;
  $('#receive-path').textContent = next.receiveDir;
  $('#device-count').textContent = next.devices.filter(d => d.status === 'approved').length;
  updateQr(next);
  const key = JSON.stringify(next.files);
  if (lastFiles !== key) {
    const shared = next.files.filter(f => f.direction === 'outgoing');
    const received = next.files.filter(f => f.direction === 'incoming');
    $('#shared-count').textContent = shared.length;
    $('#history-count').textContent = received.length;
    $('#shared-list').innerHTML = shared.length ? shared.map(f => fileRow(f, 'shared')).join('') : empty('Aucun fichier partagé', 'Glissez des fichiers dans la fenêtre ou cliquez sur Parcourir.');
    $('#history-list').innerHTML = received.length ? received.map(f => fileRow(f, 'history')).join('') : empty('Aucun fichier reçu', 'Les fichiers envoyés depuis le téléphone apparaîtront ici.', 'clock');
    lastFiles = key;
  }
  const devicesKey = JSON.stringify(next.devices.map(d => ({ id:d.id, name:d.name, status:d.status, code:d.code, online:d.online })));
  if (devicesKey !== lastDevices) {
    lastDevices = devicesKey;
    $('#pending-requests').innerHTML = next.devices.filter(d => d.status === 'pending').map(deviceCard).join('');
    $('#devices-list').innerHTML = next.devices.length ? next.devices.map(deviceCard).join('') : empty('Aucun appareil autorisé', 'Scannez le QR code dans Transferts pour connecter votre téléphone.', 'devices');
    const approved = next.devices.filter(d => d.status === 'approved');
    $('#connected-label').textContent = approved.length ? `${approved.length} appareil${approved.length > 1 ? 's' : ''} associé${approved.length > 1 ? 's' : ''}.` : 'Aucun appareil connecté';
    $('#connected-detail').textContent = approved.length ? approved.map(d => d.name).join(' · ') : 'Scannez le QR code pour vous connecter.';
  }
  const transfersKey = JSON.stringify(next.transfers);
  if (transfersKey !== lastTransfers) {
    lastTransfers = transfersKey;
    $('#active-section').hidden = !next.transfers.length;
    $('#active-list').innerHTML = next.transfers.map(t => transferRow(t, transferCaption(t))).join('');
  }
  countdown();
}
function countdown() {
  if (!state) return;
  if (!state.pairUrl) { $('#expiry').textContent = '—'; return; }
  const sec = Math.max(0, Math.floor((state.expiresAt - Date.now()) / 1000));
  $('#expiry').textContent = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}
async function refresh() {
  if (refreshing) { again = true; return; }
  refreshing = true;
  try { updateState(await call('get_state')); }
  catch (error) { toast(error.message, true); }
  finally { refreshing = false; if (again) { again = false; refresh(); } }
}
function switchView(name) {
  $$('.view').forEach(e => e.hidden = e.id !== `view-${name}`);
  $$('.nav-item[data-view]').forEach(e => { e.classList.toggle('selected', e.dataset.view === name); if (e.dataset.view === name) e.setAttribute('aria-current', 'page'); else e.removeAttribute('aria-current'); });
  const titles = {
    transfer: ['Transferts', 'Partagez des fichiers avec les appareils connectés.'],
    devices: ['Appareils', 'Autorisez ou déconnectez les appareils.'],
    history: ['Historique', 'Fichiers reçus sur ce PC.'],
  };
  $('#page-title').textContent = titles[name][0]; $('#page-subtitle').textContent = titles[name][1];
}
function renderConnection(c, serverError) {
  $('#connection-mode').value = c.mode;
  $('#connection-mode').disabled = c.status === 'starting' || !!serverError;
  const descriptions = { local: 'PC et téléphone sur le même réseau.', internet: 'Connexion HTTPS via Cloudflare. Le téléphone peut utiliser la 4G/5G.', hotspot: 'Connexion au Wi-Fi du PC, sans box ni Internet.' };
  $('#connection-status').textContent = c.status === 'starting' ? 'Changement de connexion en cours…' : c.message || descriptions[c.mode];
  $('#connection-status').classList.toggle('error', c.status === 'error');
  $('#mode-retry').hidden = c.status !== 'error';
  $('#hotspot-details').hidden = !(c.mode === 'hotspot' && c.status === 'ready' && c.hotspot);
  $('.connect-panel .panel-heading h2').textContent = c.mode === 'hotspot' && c.hotspot ? '2. Ouvrir Brise' : 'Connecter un téléphone';
  if (c.hotspot && c.status === 'ready') {
    $('#hotspot-ssid').textContent = c.hotspot.ssid;
    $('#hotspot-password').textContent = c.hotspot.password;
    if (lastHotspot !== c.hotspot.ssid) { lastHotspot = c.hotspot.ssid; call('wifi_qr').then(svg => { $('#wifi-qr').src = svgData(svg); }).catch(() => {}); }
  }
  const unavailable = serverError || (c.status === 'starting' ? 'Connexion en cours…' : c.status === 'error' ? 'Connexion indisponible.' : 'Aucune adresse réseau sélectionnée.');
  $('#qr-empty').classList.toggle('error', !!serverError);
  $('#qr-empty p').textContent = unavailable;
  const setup = $('#qr-empty button');
  setup.hidden = c.status === 'starting' || !!serverError;
  setup.dataset.action = c.mode === 'local' && c.status !== 'error' ? 'settings' : 'mode-setup';
  setup.textContent = c.mode === 'local' && c.status !== 'error' ? 'Configurer le réseau' : 'Configurer la connexion';
  $('[data-action="rotate"]').disabled = c.status !== 'ready' || !!serverError;
}
function connectionDialog(mode) {
  const c = state?.connection; if (!c) return;
  if (state.transfers.some(t => !t.paused)) return toast('Attendez la fin des transferts avant de changer de mode.', true);
  const capability = c.capabilities[mode];
  let content = '';
  if (mode === 'internet') content = '<p>Le PC et le téléphone peuvent utiliser des réseaux différents. Le PC doit rester connecté à Internet.</p><p>Brise ouvre un lien HTTPS temporaire via Cloudflare. Les fichiers transitent par ce service ; le transport n’est pas chiffré de bout en bout. L’adresse est fermée à l’arrêt du mode Internet.</p><p class="settings-caption">Le service de tunnel temporaire ne garantit pas sa disponibilité.</p>';
  if (mode === 'hotspot') content = '<p>Le PC crée un réseau Wi-Fi pour le téléphone. Une connexion Internet n’est pas nécessaire.</p><p>Sur la carte sélectionnée, le point d’accès remplace la connexion Wi-Fi actuelle. Brise tentera de rétablir celle-ci à l’arrêt du point d’accès.</p>';
  if (mode === 'local') content = '<p>Le PC et le téléphone doivent être sur le même réseau local. Le tunnel ou le point d’accès actif sera arrêté.</p>';
  if (capability && !capability.available) {
    content += `<div class="dialog-section"><p>${escape(capability.reason)}</p>${capability.install ? `<p>Installez cet outil dans un terminal :</p><p><code>${escape(capability.install)}</code></p>` : ''}<button class="button secondary" data-action="probe-modes" data-mode="${mode}">Vérifier à nouveau</button></div>`;
  } else {
    content += `<form id="connection-form" data-mode="${mode}">${mode === 'hotspot' ? `<label for="hotspot-interface">Carte Wi-Fi</label><select id="hotspot-interface">${capability.interfaces.map(i => `<option value="${escape(i)}">${escape(i)}</option>`).join('')}</select><label class="check-label"><input type="checkbox" id="confirm-wifi" required><span>J’accepte de remplacer la connexion Wi-Fi de cette carte pendant le partage.</span></label>` : ''}<p class="settings-caption">Les appareils associés devront se reconnecter avec le nouveau QR code.</p><div class="dialog-actions"><button class="button secondary" type="button" data-action="close-dialog">Annuler</button><button class="button primary" type="submit">Activer ${modeLabel(mode).toLowerCase()}</button></div></form>`;
  }
  dialog(modeLabel(mode), content);
}
function settings() {
  const n = state.network;
  dialog('Réglages', `<h3>Adresse du mode local</h3><p>Brise suit automatiquement l’adresse de ce PC. Choisissez-en une autre seulement si le téléphone n’arrive pas à se connecter (VPN, plusieurs cartes réseau).</p><form id="network-form">${n.interfaces.length > 1 ? `<label for="network-select">Interfaces disponibles</label><select id="network-select">${n.interfaces.map(i => `<option value="${escape(i.address)}" ${i.address === n.address ? 'selected' : ''}>${escape(i.name)} · ${escape(i.address)}</option>`).join('')}</select>` : ''}<label for="network-address">Adresse IPv4 du PC</label><div class="inline-form"><input id="network-address" name="address" inputmode="decimal" value="${escape(n.address || '')}" placeholder="192.168.1.42" required><button class="button primary" type="submit">Appliquer</button></div></form><p class="settings-caption">Port ${n.port}/TCP. S’il ne passe pas, autorisez-le dans votre pare-feu.</p><div class="dialog-section"><h3>Dossier de réception</h3><p>Vos fichiers reçus sont conservés dans :</p><p><code>${escape(state.receiveDir)}</code></p><button class="button secondary" data-action="folder">${icon('folder')}Ouvrir le dossier</button></div><div class="dialog-section"><h3>Terminer le partage</h3><p>Fermer la fenêtre laisse Brise actif dans la barre système. Quitter déconnecte les téléphones et arrête le partage. Vos fichiers reçus sont conservés.</p><button class="button danger" data-action="quit-confirm">Quitter Brise</button></div>`);
}
function help() {
  dialog('Aide', `<h3>Choisir une connexion</h3><p><strong>Réseau local :</strong> le PC et le téléphone utilisent la même box ou le même réseau Wi-Fi. Internet n’est pas nécessaire.</p><p><strong>Internet :</strong> le téléphone peut utiliser la 4G/5G ou un autre Wi-Fi. Les deux appareils doivent avoir Internet. Le lien HTTPS temporaire passe par Cloudflare et nécessite cloudflared sur le PC.</p><p><strong>Point d’accès Wi-Fi :</strong> le PC crée un réseau Wi-Fi. Scannez le premier QR code pour le rejoindre, puis le second pour ouvrir Brise. La carte Wi-Fi doit prendre en charge ce mode.</p><h3>Autoriser le téléphone</h3><p>Scannez le QR code avec l’appareil photo du téléphone, donnez-lui un nom, comparez les codes puis acceptez la connexion ici. Un changement de mode ferme les anciennes sessions.</p><h3>Transférer des fichiers</h3><p>Glissez des fichiers dans la fenêtre ou cliquez sur « Parcourir… » : ils restent à leur place sur le PC, sans copie. Sur le téléphone, « Recevoir » les télécharge et « Envoyer au PC » fait l’inverse. Les fichiers reçus arrivent dans le dossier indiqué dans l’Historique.</p><p>Fermer la fenêtre laisse Brise actif dans la barre système ; une notification signale chaque demande de connexion et chaque fichier reçu.</p><div class="dialog-section"><h3>Connexion impossible</h3><p>En mode local, vérifiez l’adresse du PC dans les réglages, le VPN et le pare-feu (port ${state?.network.port || 53318}/TCP). Un réseau invité peut isoler les appareils.</p><p>En mode Internet, vérifiez la connexion du PC et la présence de cloudflared. Les tunnels temporaires n’ont pas de garantie de disponibilité.</p><p>En mode point d’accès, vérifiez NetworkManager, ses permissions et votre carte Wi-Fi. Le téléphone peut indiquer « Pas d’Internet » : restez connecté à ce Wi-Fi pour le transfert.</p><p class="settings-caption">Les modes locaux utilisent HTTP. Le mode Internet utilise HTTPS via Cloudflare, qui peut accéder au contenu en transit ; il ne fournit pas de chiffrement de bout en bout. Le QR de connexion expire après dix minutes. Les appareils acceptés restent associés jusqu’à leur déconnexion, un changement de mode ou l’arrêt de Brise.</p></div>`);
}
async function copyLink() {
  if (!state?.pairUrl) return toast('Aucune adresse réseau disponible.', true);
  try { await navigator.clipboard.writeText(state.pairUrl); toast('Lien copié.'); }
  catch { dialog('Lien de connexion', `<p>Copiez ce lien et ouvrez-le sur votre téléphone.</p><input id="copy-value" aria-label="Lien de connexion" readonly value="${escape(state.pairUrl)}">`); $('#copy-value').select(); }
}
document.addEventListener('click', async event => {
  const button = event.target.closest('button,[data-view],[data-action]'); if (!button) return;
  try {
    if (button.dataset.view) switchView(button.dataset.view);
    if (button.dataset.decide) {
      button.disabled = true; await call('decide', { id:button.dataset.decide, approve:button.dataset.approve === 'true' }); await refresh();
      toast(button.dataset.approve === 'true' ? 'Appareil connecté. Vous pouvez partager.' : 'Connexion fermée.');
    }
    if (button.dataset.remove) { await call('remove_shared', { id:button.dataset.remove }); await refresh(); toast('Fichier retiré du partage.'); }
    if (button.dataset.reveal) await call('reveal_file', { id:button.dataset.reveal });
    switch (button.dataset.action) {
      case 'help': help(); break;
      case 'settings': settings(); break;
      case 'mode-setup': connectionDialog(state?.connection?.mode || 'local'); break;
      case 'probe-modes': button.disabled = true; await call('probe_modes'); await refresh(); connectionDialog(button.dataset.mode); break;
      case 'copy-link': await copyLink(); break;
      case 'rotate': button.disabled = true; await call('rotate'); await refresh(); toast('QR code renouvelé.'); break;
      case 'folder': await call('open_folder'); break;
      case 'quit-confirm': dialog('Quitter Brise ?', `<p>Quitter Brise interrompt les transferts en cours et déconnecte vos appareils. Les fichiers déjà reçus restent sur votre PC.</p><div class="dialog-actions"><button class="button secondary" data-action="close-dialog">Continuer le partage</button><button class="button danger" data-action="quit">Quitter Brise</button></div>`); break;
      case 'quit': await call('quit'); break;
    }
  } catch (error) { toast(error.message, true); }
  finally { button.disabled = false; }
});
document.addEventListener('submit', async event => {
  if (!['network-form','connection-form'].includes(event.target.id)) return;
  event.preventDefault(); const submit = event.target.querySelector('button[type=submit]'); submit.disabled = true;
  try {
    if (event.target.id === 'connection-form') {
      await call('select_mode', { mode: event.target.dataset.mode, interface: $('#hotspot-interface')?.value ?? null, confirmWifiChange: $('#confirm-wifi')?.checked === true });
      $('#dialog').close(); await refresh();
    } else {
      await call('set_address', { address:$('#network-address').value.trim() }); await refresh(); $('#dialog').close(); toast('Adresse mise à jour. Scannez le nouveau QR code.');
    }
  } catch (error) { toast(error.message, true); }
  finally { submit.disabled = false; }
});
document.addEventListener('change', event => {
  if (event.target.id === 'connection-mode') { const mode = event.target.value; event.target.value = state?.connection?.mode || 'local'; connectionDialog(mode); }
  if (event.target.id === 'network-select') $('#network-address').value = event.target.value;
});
async function pickFiles() {
  try { const added = await call('pick_files'); if (added) { switchView('transfer'); toast(added === 1 ? 'Fichier ajouté au partage.' : `${added} fichiers ajoutés au partage.`); } }
  catch (error) { toast(error.message, true); }
}
document.addEventListener('DOMContentLoaded', async () => {
  $('#drop-desktop').addEventListener('click', pickFiles);
  $('#drop-desktop').addEventListener('keydown', event => { if (['Enter',' '].includes(event.key)) { event.preventDefault(); pickFiles(); } });
  await listen('brise:changed', refresh);
  await listen('brise:drag', event => document.body.classList.toggle('dragging', event.payload === true));
  await listen('brise:toast', event => { toast(event.payload.message, event.payload.error); if (!event.payload.error) switchView('transfer'); });
  setInterval(countdown, 1000);
  setInterval(refresh, 3000);
  await refresh();
});
