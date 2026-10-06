'use strict';
const paths = {
  transfer:'M7 7h14m-4-4 4 4-4 4M17 17H3m4-4-4 4 4 4',
  swap:'M7 7h14m-4-4 4 4-4 4M17 17H3m4-4-4 4 4 4',
  devices:'M3 4h13v11H3zM6 19h7M9 15v4M18 9h4v12h-7v-4',
  monitor:'M3 4h18v13H3zM8 21h8M12 17v4', phone:'M8 2h8a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2ZM10 5h4M11 19h2',
  clock:'M12 8v5l3 2M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
  leaf:'M20 3c-9-1-17 5-15 12s15 5 15-12ZM4 21 15 10',
  help:'M9.1 9a3 3 0 0 1 5.8 1c0 2-3 2-3 4m.1 3h.01M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
  settings:'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM9 3l1-1h4l1 3 3 1 3-1 2 4-2 2v3l2 2-2 4-3-1-3 1-1 2h-4l-1-2-3-1-3 1-2-4 2-2v-3L1 9l2-4 3 1 3-1Z',
  wind:'M3 8h12a3 3 0 1 0-3-3M2 12h18M5 16h10a3 3 0 1 1-3 3',
  'arrow-up-right':'M7 17 17 7M7 7h10v10', 'arrow-right':'M4 12h16m-6-6 6 6-6 6',
  upload:'M12 16V3m-5 5 5-5 5 5M4 15v6h16v-6', download:'M12 3v13m-5-5 5 5 5-5M4 17v4h16v-4',
  plus:'M12 5v14M5 12h14', x:'m6 6 12 12M6 18 18 6',
  'check-circle':'M9 12l2 2 5-5M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
  check:'m5 12 4 4L19 6', wifi:'M3 8a15 15 0 0 1 18 0M6 12a10 10 0 0 1 12 0M9 16a5 5 0 0 1 6 0M12 20h.01',
  'wifi-off':'M2 2l20 20M3 8a15 15 0 0 1 3-2m4-1a15 15 0 0 1 11 3M6 12a10 10 0 0 1 4-2m4 0a10 10 0 0 1 4 2M9 16a5 5 0 0 1 6 0M12 20h.01',
  scan:'M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5M7 12h10',
  link:'m10 13 4-4m-6 6-2 2a3.5 3.5 0 0 1-5-5l5-5a3.5 3.5 0 0 1 5 0m2 2 2-2a3.5 3.5 0 0 1 5 5l-5 5a3.5 3.5 0 0 1-5 0',
  refresh:'M20 7v5h-5M4 17v-5h5M5.3 7a8 8 0 0 1 13.2-1L20 9M4 15l1.5 3A8 8 0 0 0 18.7 17',
  folder:'M3 6h6l2 3h10v11H3ZM3 9V4h6l2 2h8v3',
  file:'M6 2h8l5 5v15H5V2ZM14 2v6h5M8 13h8M8 17h6',
  image:'M3 3h18v18H3ZM3 16l6-6 5 5 3-3 4 4M15 7h.01',
  video:'M3 5h13v14H3ZM16 10l6-4v12l-6-4',
  trash:'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7',
  alert:'m12 3 10 18H2ZM12 9v5M12 17h.01',
};
const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${paths[name] || paths.file}"/></svg>`;
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
function icons(element = document) { element.querySelectorAll('[data-icon]').forEach(e => e.innerHTML = icon(e.dataset.icon)); }
icons();
let state = null, pairCode = '', polling = false, stopped = false, currentView = 'transfer', pollTimer;
let lastFiles = '', lastDevices = '', lastQr = '', lastHotspot = '', hadSession = false, errorCount = 0;
let uploads = [], uploading = false;
const formatSize = bytes => { if (bytes < 1000) return `${bytes} o`; const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1000)), 3); return `${(bytes / 1000 ** i).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} ${['o','Ko','Mo','Go'][i]}`; };
const formatDate = time => new Intl.DateTimeFormat('fr-FR', { day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' }).format(time);
function fileType(name) { return /\.(png|jpe?g|webp|gif|heic|avif|svg)$/i.test(name) ? 'image' : /\.(mp4|mov|mkv|webm)$/i.test(name) ? 'video' : 'file'; }
function toast(message, error = false) {
  const el = document.createElement('div'); el.className = `toast${error ? ' error' : ''}`;
  el.innerHTML = `${icon(error ? 'alert' : 'check-circle')}<span>${escape(message)}</span>`;
  $('#toasts').append(el); setTimeout(() => el.remove(), error ? 8500 : 4500);
}
async function api(path, data, method = 'POST', timeout = 10000, signal) {
  const response = await fetch(path, { method, headers: { 'X-Brise':'1', ...(data === undefined ? {} : { 'Content-Type':'application/json' }) }, body: data === undefined ? undefined : JSON.stringify(data), signal: signal || AbortSignal.timeout(timeout) });
  let value; try { value = await response.json(); } catch { throw new Error('Le PC ne répond pas. Vérifiez la connexion.'); }
  if (!response.ok) { const error = new Error(value.error || 'Une erreur est survenue.'); error.status = response.status; throw error; }
  return value;
}
function showShell(phone) {
  $('#boot').hidden = true; $('#shell').hidden = false;
  document.body.classList.toggle('phone-mode', phone);
  $('#desktop-content').hidden = phone; $('#phone-content').hidden = !phone;
}
function phoneScreen(name) {
  ['pair-screen','waiting-screen','phone-workspace','error-screen'].forEach(id => $(`#${id}`).hidden = id !== name);
}
function showError(message) {
  showShell(true); phoneScreen('error-screen');
  $('#session-error').textContent = message;
}
function empty(title, description, glyph = 'folder') {
  return `<div class="empty-files"><span class="empty-icon">${icon(glyph)}</span><div><strong>${escape(title)}</strong><p>${escape(description)}</p></div></div>`;
}
const mediaTypes = { jpg:'image/jpeg', jpeg:'image/jpeg', png:'image/png', heic:'image/heic', webp:'image/webp', gif:'image/gif', avif:'image/avif', mp4:'video/mp4', mov:'video/quicktime', m4v:'video/x-m4v', webm:'video/webm' };
const mediaType = name => mediaTypes[name.split('.').pop().toLowerCase()];
const shareLimit = 500 * 1000 * 1000;
const canShareFiles = (() => { try { return window.isSecureContext && !!navigator.canShare && navigator.canShare({ files:[new File([''], 'test.jpg', { type:'image/jpeg' })] }); } catch { return false; } })();
const shareLabel = /iPhone|iPad/i.test(navigator.userAgent) ? 'Photos' : 'Partager';
const prepared = new Map();
function shareButton(file) {
  if (!canShareFiles || !mediaType(file.name) || file.size > shareLimit) return '';
  return `<button class="button secondary" data-share="${file.id}" aria-label="${prepared.has(file.id) ? 'Enregistrer' : shareLabel} ${escape(file.name)}">${icon(fileType(file.name))}${prepared.has(file.id) ? 'Enregistrer' : shareLabel}</button>`;
}
async function shareFile(button) {
  const file = state?.files.find(f => f.id === button.dataset.share); if (!file) return;
  let shared = prepared.get(file.id);
  if (!shared) {
    button.disabled = true; button.textContent = 'Préparation…';
    const response = await fetch(`/api/files/${file.id}`);
    if (!response.ok || !response.body) throw new Error('Ce fichier n’est plus disponible.');
    const reader = response.body.getReader(), parts = []; let received = 0;
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      parts.push(value); received += value.length;
      button.textContent = `Préparation… ${Math.floor(received / Math.max(file.size, 1) * 100)} %`;
    }
    shared = new File(parts, file.name, { type:mediaType(file.name) });
    prepared.set(file.id, shared);
    button.innerHTML = `${icon(fileType(file.name))}Enregistrer`;
  }
  try { await navigator.share({ files:[shared] }); }
  catch (error) {
    if (error.name === 'NotAllowedError') toast('Fichier prêt : touchez « Enregistrer ».');
    else if (error.name !== 'AbortError') throw error;
  }
}
function fileRow(file, mode) {
  const type = fileType(file.name);
  const detail = mode === 'history' ? `${escape(file.sender)} · ${formatDate(file.createdAt)}` : mode === 'phone' ? 'Depuis votre PC' : file.downloads ? `${file.downloads} téléchargement${file.downloads > 1 ? 's' : ''}` : 'En attente de téléchargement';
  return `<div class="file-row"><span class="file-icon ${type}">${icon(type)}</span><div class="file-meta"><span class="file-name" title="${escape(file.name)}">${escape(file.name)}</span><div class="file-details"><span>${formatSize(file.size)}</span><span>·</span><span>${detail}</span></div></div>${mode === 'shared' ? `<span class="file-status">${icon(file.downloads ? 'check-circle' : 'check')}${file.downloads ? 'Récupéré' : 'Disponible'}</span><button class="icon-button" data-remove="${file.id}" aria-label="Retirer du partage ${escape(file.name)}" title="Retirer du partage">${icon('x')}</button>` : `${mode === 'phone' ? shareButton(file) : ''}<a class="${mode === 'phone' ? 'button secondary' : 'icon-button'}" href="/api/files/${file.id}" download aria-label="Télécharger ${escape(file.name)}">${icon('download')}${mode === 'phone' ? 'Recevoir' : ''}</a>`}</div>`;
}
function deviceCard(d) {
  const pending = d.status === 'pending';
  return `<article class="device-card ${pending ? 'pending' : ''}"><span class="device-icon">${icon('phone')}</span><div class="device-info"><strong>${escape(d.name)}</strong><p>${pending ? 'Souhaite se connecter · code ' + `<code>${escape(d.code)}</code>` : d.online ? 'Connecté · prêt à partager' : 'En veille · ouvrez Brise sur le téléphone'}</p></div><div class="device-actions">${pending ? `<button class="button secondary" data-decide="${d.id}" data-approve="false">Refuser</button><button class="button primary" data-decide="${d.id}" data-approve="true">${icon('check')}Accepter</button>` : `<button class="button secondary" data-decide="${d.id}" data-approve="false">Déconnecter</button>`}</div></article>`;
}
function updateState(next) {
  state = next; hadSession = true; errorCount = 0;
  showShell(next.role === 'phone'); $('#offline').hidden = true;
  $('#network-status').classList.remove('offline');
  $('#network-status span').textContent = modeLabel(next.connectionMode || 'local');
  if (next.role === 'phone') {
    if (next.status === 'pending') { phoneScreen('waiting-screen'); $('#pair-code').textContent = next.code?.replace(/(.{3})/, '$1 '); return; }
    phoneScreen('phone-workspace');
    $('#phone-file-count').textContent = next.files.length;
    for (const id of prepared.keys()) if (!next.files.some(f => f.id === id)) prepared.delete(id);
    const key = JSON.stringify(next.files);
    if (key !== lastFiles) { $('#phone-file-list').innerHTML = next.files.length ? next.files.map(f => fileRow(f, 'phone')).join('') : empty('Aucun fichier disponible', 'Ajoutez des fichiers dans Brise sur votre PC.'); lastFiles = key; }
  } else {
    renderConnection(next.connection);
    $('#computer-name').textContent = next.network.hostname;
    $('#receive-path').textContent = next.receiveDir;
    $('#device-count').textContent = next.devices.filter(d => d.status === 'approved').length;
    if (lastQr !== next.pairUrl) {
      lastQr = next.pairUrl; $('#qr').hidden = !lastQr; $('#qr-empty').hidden = !!lastQr;
      if (lastQr) $('#qr').src = `/api/qr.svg?v=${next.expiresAt}&mode=${next.connectionMode || 'local'}`;
      $('[data-action="copy-link"]').disabled = !lastQr;
    }
    const key = JSON.stringify(next.files);
    if (lastFiles !== key) {
      const shared = next.files.filter(f => f.direction === 'outgoing');
      const received = next.files.filter(f => f.direction === 'incoming');
      $('#shared-count').textContent = shared.length;
      $('#history-count').textContent = received.length;
      $('#shared-list').innerHTML = shared.length ? shared.map(f => fileRow(f, 'shared')).join('') : empty('Aucun fichier partagé', 'Déposez des fichiers ci-dessus ou cliquez sur Parcourir.');
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
    countdown();
  }
  renderTransfers();
}
function countdown() {
  if (state?.role !== 'admin') return;
  if (!state.pairUrl) { $('#expiry').textContent = '—'; return; }
  const sec = Math.max(0, Math.floor((state.expiresAt - Date.now()) / 1000));
  $('#expiry').textContent = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}
async function refresh() {
  if (polling || stopped) return;
  polling = true;
  try { updateState(await api('/api/state', undefined, 'GET')); }
  catch (error) {
    if (error.status === 401) {
      clearTimeout(pollTimer);
      showError(state?.role === 'admin' ? 'Brise a redémarré. Ouvrez à nouveau l’application depuis votre lanceur.' : 'Cette connexion est fermée. Scannez le QR code sur le PC pour vous reconnecter.');
      hadSession = false;
    } else {
      errorCount++; $('#offline').hidden = false; $('#network-status').classList.add('offline');
      $('#network-status span').textContent = 'Reconnexion…';
      if (!hadSession) showError(error.message || 'Impossible de joindre Brise. Vérifiez votre réseau.');
    }
  } finally { polling = false; }
  clearTimeout(pollTimer);
  if (hadSession) pollTimer = setTimeout(refresh, Math.min(errorCount ? 3000 : document.hidden ? 5000 : 1500, 10000));
}
function switchView(name) {
  if (state?.role !== 'admin') return;
  currentView = name;
  $$('.view').forEach(e => e.hidden = e.id !== `view-${name}`);
  $$('.nav-item[data-view]').forEach(e => { e.classList.toggle('selected', e.dataset.view === name); if (e.dataset.view === name) e.setAttribute('aria-current', 'page'); else e.removeAttribute('aria-current'); });
  const titles = {
    transfer: ['Transferts', 'Partagez des fichiers avec les appareils connectés.'],
    devices: ['Appareils', 'Autorisez ou déconnectez les appareils.'],
    history: ['Historique', 'Fichiers reçus sur ce PC.'],
  };
  $('#page-title').textContent = titles[name][0]; $('#page-subtitle').textContent = titles[name][1];
}
function switchPhoneTab(tab) {
  $$('[data-phone-tab]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.phoneTab === tab)));
  $('#phone-send').hidden = tab !== 'send'; $('#phone-receive').hidden = tab !== 'receive';
}
function transferRow(item, local = false) {
  const percentage = item.size ? Math.min(100, Math.floor(item.bytes / item.size * 100)) : 0;
  const caption = local ? item.status === 'queued' ? 'Dans la file d’attente' : item.retrying ? 'Connexion perdue, nouvel essai…' : percentage === 100 ? 'Finalisation sur le PC…' : state?.role === 'admin' ? 'Ajout au partage…' : 'Envoi au PC…' : item.paused ? `En pause · en attente de ${item.sender}` : item.direction === 'download' ? `Vers ${item.sender}` : `Depuis ${item.sender}`;
  return `<div class="file-row transfer-row"><span class="file-icon">${icon(item.direction === 'download' ? 'download' : 'upload')}</span><div class="transfer-body"><div class="transfer-line"><span>${escape(item.name)}</span><span>${percentage} %</span></div><progress value="${percentage}" max="100" aria-label="Progression de ${escape(item.name)}"></progress><div class="transfer-caption">${escape(caption)} · ${formatSize(item.bytes)} / ${formatSize(item.size)}</div></div>${local ? `<button class="icon-button" data-cancel="${item.id}" aria-label="Annuler l’envoi de ${escape(item.name)}">${icon('x')}</button>` : ''}</div>`;
}
function renderTransfers() {
  const pending = uploads.filter(u => ['queued','uploading'].includes(u.status));
  const recent = uploads.filter(u => ['done','error','cancelled'].includes(u.status)).slice(-8).reverse();
  let rows = pending.map(u => transferRow(u, true)).join('');
  if (state?.role === 'admin') {
    rows += (state.transfers || []).filter(t => t.ownerId !== 'admin').map(t => transferRow(t)).join('');
    rows += recent.filter(u => u.status === 'error').map(resultRow).join('');
    $('#active-section').hidden = !rows; $('#active-list').innerHTML = rows;
  } else { $('#phone-upload-list').innerHTML = rows + recent.map(resultRow).join(''); }
}
function resultRow(u) {
  const label = u.status === 'done' ? 'Transfert terminé' : u.status === 'cancelled' ? 'Envoi annulé' : u.error;
  return `<div class="upload-result ${u.status === 'error' ? 'error' : ''}"><span>${icon(u.status === 'done' ? 'check-circle' : 'alert')}</span><div><p>${escape(u.name)}</p><span class="muted small">${escape(label)}</span></div>${u.status === 'error' ? `<button class="text-button" data-retry="${u.id}">Réessayer</button>` : ''}</div>`;
}
function addFiles(files) {
  if (!state || state.status !== 'approved') return toast('Connectez d’abord votre téléphone au PC.', true);
  for (const file of files) {
    if (file.size > state.maxFileSize) { toast(`${file.name} dépasse la limite de 10 Go.`, true); continue; }
    uploads.push({ id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, file, name:file.name, size:file.size, bytes:0, status:'queued' });
  }
  if (state.role === 'admin') switchView('transfer'); else switchPhoneTab('send');
  renderTransfers(); processQueue();
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function xhrUpload(item, path, blob, headers, offset = 0) {
  return new Promise((resolve, reject) => {
    if (item.status === 'cancelled') return reject(new Error('Envoi annulé.'));
    const xhr = new XMLHttpRequest(); item.xhr = xhr;
    const fail = (message, status = 0) => reject(Object.assign(new Error(message), { status }));
    xhr.open('POST', path); xhr.setRequestHeader('X-Brise', '1');
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    for (const [key, value] of Object.entries(headers)) xhr.setRequestHeader(key, value);
    xhr.timeout = 10 * 60 * 1000;
    xhr.upload.onprogress = event => { item.bytes = offset + event.loaded; item.retrying = false; renderTransfers(); };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve();
      let message; try { message = JSON.parse(xhr.responseText).error; } catch {}
      fail(message || 'Le transfert n’a pas abouti. Réessayez.', xhr.status);
    };
    xhr.onerror = () => fail('Connexion interrompue. Vérifiez le réseau, puis réessayez.');
    xhr.ontimeout = () => fail('Le transfert a pris trop de temps. Réessayez.');
    xhr.onabort = () => fail('Envoi annulé.');
    xhr.send(blob);
  });
}
function checkCancelled(item) { if (item.status === 'cancelled') throw new Error('Envoi annulé.'); }
function discardRemote(item) {
  const id = item.remoteId; item.remoteId = null;
  if (id) api(`/api/uploads/${id}`, undefined, 'DELETE').catch(() => {});
}
async function sendChunks(item) {
  for (let attempt = 0; ; attempt++) {
    try {
      checkCancelled(item);
      const progress = await api(`/api/uploads/${item.remoteId}`, undefined, 'GET');
      if (progress.status === 'uploading') {
        item.bytes = progress.offset;
        for (let offset = progress.offset; offset < item.size; offset += item.chunkSize) {
          checkCancelled(item);
          await xhrUpload(item, `/api/uploads/${item.remoteId}`, item.file.slice(offset, offset + item.chunkSize), { 'X-Chunk-Offset': String(offset) }, offset);
          attempt = 0;
        }
        checkCancelled(item);
        await api(`/api/uploads/${item.remoteId}/finish`);
      }
      item.retrying = false; renderTransfers();
      for (;;) {
        checkCancelled(item);
        const completion = await api(`/api/uploads/${item.remoteId}`, undefined, 'GET');
        if (completion.status === 'error') throw Object.assign(new Error(completion.error), { final: true });
        if (completion.status === 'done') return;
        await pause(700);
      }
    } catch (error) {
      if (item.status === 'cancelled' || error.final || [401, 403, 404, 507].includes(error.status)) throw error;
      if (attempt >= 5) throw Object.assign(new Error('Envoi interrompu. « Réessayer » reprend là où il s’est arrêté.'), { resumable: true });
      item.retrying = true; renderTransfers();
      await pause(Math.min(1000 * 2 ** attempt, 15000));
    }
  }
}
async function sendFile(item) {
  if (!state.chunkSize) return xhrUpload(item, '/api/upload', item.file, { 'X-File-Name': encodeURIComponent(item.name), 'X-File-Size': String(item.size) });
  if (item.remoteId) await api(`/api/uploads/${item.remoteId}`, undefined, 'GET').catch(error => { if (error.status === 404) item.remoteId = null; });
  if (!item.remoteId) {
    const upload = await api('/api/uploads', { name: item.name, size: item.size });
    item.remoteId = upload.id; item.chunkSize = upload.chunkSize; item.bytes = 0;
  }
  try { await sendChunks(item); }
  catch (error) { if (!error.resumable) discardRemote(item); throw error; }
  discardRemote(item);
}
let wakeLock = null, wakeWanted = false;
async function keepAwake(on) {
  wakeWanted = on;
  if (!navigator.wakeLock) return;
  try {
    if (on && !wakeLock && !document.hidden) {
      wakeLock = 'pending';
      const lock = await navigator.wakeLock.request('screen');
      wakeLock = lock; lock.addEventListener('release', () => { if (wakeLock === lock) wakeLock = null; });
      if (!wakeWanted) await lock.release();
    } else if (!on && wakeLock && wakeLock !== 'pending') await wakeLock.release();
  } catch { wakeLock = null; }
}
async function processQueue() {
  if (uploading) return;
  uploading = true; keepAwake(true);
  try {
    for (;;) {
      const item = uploads.find(u => u.status === 'queued'); if (!item) break;
      item.status = 'uploading'; renderTransfers();
      try {
        await sendFile(item);
        item.status = 'done'; item.file = null;
        toast(state.role === 'admin' ? `${item.name} ajouté au partage.` : `${item.name} reçu sur le PC.`);
      } catch (error) {
        if (item.status !== 'cancelled') { item.status = 'error'; item.error = error.message; toast(error.message, true); }
      } finally { item.xhr = null; item.retrying = false; renderTransfers(); await refresh(); }
    }
  } finally { uploading = false; keepAwake(false); uploads = uploads.filter(u => u.status !== 'done').concat(uploads.filter(u => u.status === 'done').slice(-8)); }
}
function dialog(title, html) {
  $('#dialog-title').textContent = title; $('#dialog-body').innerHTML = html; $('#dialog').showModal();
}
function modeLabel(mode) { return { local: 'Réseau local', internet: 'Internet', hotspot: 'Point d’accès Wi-Fi' }[mode] || 'Réseau local'; }
function renderConnection(connection) {
  const c = connection || { mode: 'local', status: 'ready' };
  $('#connection-mode').value = c.mode;
  $('#connection-mode').disabled = c.status === 'starting';
  const descriptions = { local: 'PC et téléphone sur le même réseau.', internet: 'Connexion HTTPS via Cloudflare. Le téléphone peut utiliser la 4G/5G.', hotspot: 'Connexion au Wi-Fi du PC, sans box ni Internet.' };
  $('#connection-status').textContent = c.status === 'starting' ? 'Changement de connexion en cours…' : c.message || descriptions[c.mode];
  $('#connection-status').classList.toggle('error', c.status === 'error');
  $('#mode-retry').hidden = c.status !== 'error';
  $('#hotspot-details').hidden = !(c.mode === 'hotspot' && c.status === 'ready' && c.hotspot);
  $('.connect-panel .panel-heading h2').textContent = c.mode === 'hotspot' && c.hotspot ? '2. Ouvrir Brise' : 'Connecter un téléphone';
  if (c.hotspot && c.status === 'ready') {
    $('#hotspot-ssid').textContent = c.hotspot.ssid;
    $('#hotspot-password').textContent = c.hotspot.password;
    if (lastHotspot !== c.hotspot.ssid) { $('#wifi-qr').src = `/api/wifi-qr.svg?v=${encodeURIComponent(c.hotspot.ssid)}`; lastHotspot = c.hotspot.ssid; }
  }
  const unavailable = c.status === 'starting' ? 'Connexion en cours…' : c.status === 'error' ? 'Connexion indisponible.' : 'Aucune adresse réseau sélectionnée.';
  $('#qr-empty p').textContent = unavailable;
  const setup = $('#qr-empty button');
  setup.hidden = c.status === 'starting';
  setup.dataset.action = c.mode === 'local' && c.status !== 'error' ? 'settings' : 'mode-setup';
  setup.textContent = c.mode === 'local' && c.status !== 'error' ? 'Configurer le réseau' : 'Configurer la connexion';
  $('[data-action="rotate"]').disabled = c.status !== 'ready';
}
function connectionDialog(mode) {
  const c = state?.connection;
  if (!c) return toast('Redémarrez Brise pour accéder aux nouveaux modes.', true);
  if (uploading || uploads.some(u => u.status === 'queued')) return toast('Attendez la fin des transferts avant de changer de mode.', true);
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
  if (state?.role !== 'admin') return;
  dialog('Réglages', `<h3>Adresse du mode local</h3><p>Choisissez ici l’adresse utilisée en mode réseau local. Le choix entre réseau local, Internet et point d’accès se trouve à côté du QR code.</p><form id="network-form">${state.network.interfaces.length > 1 ? `<label for="network-select">Interfaces disponibles</label><select id="network-select">${state.network.interfaces.map(i => `<option value="${escape(i.address)}" ${i.address === state.network.address ? 'selected' : ''}>${escape(i.name)} · ${escape(i.address)}</option>`).join('')}</select>` : ''}<label for="network-address">Adresse IPv4 du PC</label><div class="inline-form"><input id="network-address" name="address" inputmode="decimal" value="${escape(state.network.address || '')}" placeholder="192.168.1.42" required><button class="button primary" type="submit">Appliquer</button></div></form><div class="dialog-section"><h3>Dossier de réception</h3><p>Vos fichiers reçus sont conservés dans :</p><p><code>${escape(state.receiveDir)}</code></p><button class="button secondary" data-action="folder">${icon('folder')}Ouvrir le dossier</button></div><div class="dialog-section"><h3>Terminer le partage</h3><p>Fermer cet onglet laisse Brise actif. Quitter déconnecte les téléphones et ferme les liens de partage. Vos fichiers reçus sont conservés.</p><button class="button danger" data-action="quit-confirm">Quitter Brise</button></div>`);
}
function help() {
  dialog('Aide', `<h3>Choisir une connexion</h3><p><strong>Réseau local :</strong> le PC et le téléphone utilisent la même box ou le même réseau Wi-Fi. Internet n’est pas nécessaire.</p><p><strong>Internet :</strong> le téléphone peut utiliser la 4G/5G ou un autre Wi-Fi. Les deux appareils doivent avoir Internet. Le lien HTTPS temporaire passe par Cloudflare et nécessite cloudflared sur le PC.</p><p><strong>Point d’accès Wi-Fi :</strong> le PC crée un réseau Wi-Fi. Scannez le premier QR code pour le rejoindre, puis le second pour ouvrir Brise. La carte Wi-Fi doit prendre en charge ce mode.</p><h3>Autoriser le téléphone</h3><p>Ouvrez le lien Brise, donnez un nom au téléphone, comparez les codes puis acceptez la connexion sur le PC. Un changement de mode ferme les anciennes sessions.</p><h3>Transférer des fichiers</h3><p>Sur le PC, ajoutez des fichiers. Sur le téléphone, ouvrez « Recevoir » pour les télécharger ou « Envoyer au PC » pour faire l’inverse. Gardez la page ouverte pendant l’envoi.</p><div class="dialog-section"><h3>Connexion impossible</h3><p>En mode local, vérifiez l’adresse du PC, le VPN et le pare-feu (port 53317/TCP par défaut). Un réseau invité peut isoler les appareils.</p><p>En mode Internet, vérifiez la connexion du PC et la présence de cloudflared. Les tunnels temporaires n’ont pas de garantie de disponibilité.</p><p>En mode point d’accès, vérifiez NetworkManager, ses permissions et votre carte Wi-Fi. Le téléphone peut indiquer « Pas d’Internet » : restez connecté à ce Wi-Fi pour le transfert.</p><p class="settings-caption">Les modes locaux utilisent HTTP. Le mode Internet utilise HTTPS via Cloudflare, qui peut accéder au contenu en transit ; il ne fournit pas de chiffrement de bout en bout. Le QR de connexion expire après dix minutes. Les appareils acceptés restent associés jusqu’à leur déconnexion, un changement de mode ou l’arrêt de Brise.</p></div>`);
}

async function copyLink() {
  if (!state?.pairUrl) return toast('Choisissez d’abord une adresse réseau dans les réglages.', true);
  try { await navigator.clipboard.writeText(state.pairUrl); toast('Lien copié.'); }
  catch { dialog('Lien de connexion', `<p>Copiez ce lien et ouvrez-le sur votre téléphone.</p><input id="copy-value" aria-label="Lien de connexion" readonly value="${escape(state.pairUrl)}">`); $('#copy-value').select(); }
}
document.addEventListener('click', async event => {
  const button = event.target.closest('button,[data-view],[data-action]'); if (!button) return;
  try {
    if (button.dataset.view) switchView(button.dataset.view);
    if (button.dataset.phoneTab) switchPhoneTab(button.dataset.phoneTab);
    if (button.dataset.decide) {
      button.disabled = true; await api(`/api/devices/${button.dataset.decide}`, { approve:button.dataset.approve === 'true' }); await refresh();
      toast(button.dataset.approve === 'true' ? 'Appareil connecté. Vous pouvez partager.' : 'Connexion fermée.');
    }
    if (button.dataset.share) await shareFile(button);
    if (button.dataset.remove) { await api(`/api/files/${button.dataset.remove}`, undefined, 'DELETE'); await refresh(); toast('Fichier retiré du partage.'); }
    if (button.dataset.cancel) { const item = uploads.find(u => u.id === button.dataset.cancel); if (item) { item.status = 'cancelled'; item.xhr?.abort(); discardRemote(item); item.file = null; renderTransfers(); } }
    if (button.dataset.retry) { const item = uploads.find(u => u.id === button.dataset.retry); if (item?.file) { item.status = 'queued'; if (!item.remoteId) item.bytes = 0; processQueue(); } }
    switch (button.dataset.action) {
      case 'help': help(); break;
      case 'settings': settings(); break;
      case 'mode-setup': connectionDialog(state?.connection?.mode || 'local'); break;
      case 'probe-modes': button.disabled = true; await api('/api/connection/probe', undefined, 'POST', 60000); await refresh(); connectionDialog(button.dataset.mode); break;
      case 'close-dialog': $('#dialog').close(); break;
      case 'copy-link': await copyLink(); break;
      case 'rotate': button.disabled = true; await api('/api/rotate'); await refresh(); toast('QR code renouvelé.'); break;
      case 'folder': await api('/api/folder'); break;
      case 'refresh': hadSession = true; await refresh(); break;
      case 'quit-confirm': dialog('Quitter Brise ?', `<p>Quitter Brise interrompt les transferts en cours et déconnecte vos appareils. Les fichiers déjà reçus restent sur votre PC.</p><div class="dialog-actions"><button class="button secondary" data-action="close-dialog">Continuer le partage</button><button class="button danger" data-action="quit">Quitter Brise</button></div>`); break;
      case 'quit':
        await api('/api/shutdown'); stopped = true; clearTimeout(pollTimer); $('#dialog').close();
        $('#shell').hidden = true; $('#boot').hidden = false;
        $('#boot').innerHTML = `<img src="/icon.svg" width="58" height="58" alt="Brise"><div class="shutdown-message"><h1>Brise est arrêté</h1><p>Le partage est arrêté. Vous pouvez fermer cette fenêtre.</p></div>`;
        break;
    }
  } catch (error) { toast(error.message, true); }
  finally { button.disabled = false; }
});
document.addEventListener('submit', async event => {
  if (!['pair-form','network-form','connection-form'].includes(event.target.id)) return;
  event.preventDefault(); const submit = event.target.querySelector('button[type=submit]'); submit.disabled = true;
  try {
    if (event.target.id === 'connection-form') {
      await api('/api/connection', { mode: event.target.dataset.mode, interface: $('#hotspot-interface')?.value, confirmWifiChange: $('#confirm-wifi')?.checked === true });
      $('#dialog').close(); await refresh();
    }
    else if (event.target.id === 'pair-form') { await api('/api/pair', { code:pairCode, name:$('#device-name').value.trim() || 'Mon téléphone' }); pairCode = ''; await refresh(); }
    else { await api('/api/network', { address:$('#network-address').value.trim() }); await refresh(); $('#dialog').close(); toast('Adresse mise à jour. Scannez le nouveau QR code.'); }
  } catch (error) { toast(error.message, true); }
  finally { submit.disabled = false; }
});
document.addEventListener('change', event => {
  if (event.target.id === 'connection-mode') { const mode = event.target.value; event.target.value = state?.connection?.mode || 'local'; connectionDialog(mode); }
  if (event.target.id === 'network-select') $('#network-address').value = event.target.value;
  if (event.target.id === 'file-picker') { addFiles([...event.target.files]); event.target.value = ''; }
});
['#drop-desktop','#drop-phone'].forEach(selector => {
  $(selector).addEventListener('click', () => $('#file-picker').click());
  $(selector).addEventListener('keydown', event => { if (['Enter',' '].includes(event.key)) { event.preventDefault(); $('#file-picker').click(); } });
});
let dragDepth = 0;
document.addEventListener('dragenter', event => { if (!event.dataTransfer.types.includes('Files') || state?.status !== 'approved') return; event.preventDefault(); dragDepth++; document.body.classList.add('dragging'); });
document.addEventListener('dragover', event => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); });
document.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) document.body.classList.remove('dragging'); });
document.addEventListener('drop', event => {
  event.preventDefault(); dragDepth = 0; document.body.classList.remove('dragging');
  const items = [...(event.dataTransfer.items || [])];
  const files = items.length ? items.filter(i => { if (i.webkitGetAsEntry?.()?.isDirectory) { toast('Sélectionnez des fichiers, ou compressez votre dossier en ZIP.', true); return false; } return i.kind === 'file'; }).map(i => i.getAsFile()).filter(Boolean) : [...event.dataTransfer.files];
  addFiles(files);
});
document.addEventListener('keydown', event => {
  if (['ArrowRight','ArrowLeft'].includes(event.key) && event.target.matches('[data-phone-tab]')) { event.preventDefault(); const tab = event.target.dataset.phoneTab === 'send' ? 'receive' : 'send'; switchPhoneTab(tab); $(`[data-phone-tab="${tab}"]`).focus(); }
});
document.addEventListener('visibilitychange', () => { if (!document.hidden && wakeWanted) keepAwake(true); if (!document.hidden && hadSession) refresh(); });
window.addEventListener('online', () => { if (hadSession) refresh(); });
$('#dialog').addEventListener('click', event => { if (event.target === $('#dialog')) { const r = $('#dialog').getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) $('#dialog').close(); } });
$('#qr').addEventListener('error', () => { $('#qr').hidden = true; $('#qr-empty').hidden = false; lastQr = ''; });
setInterval(countdown, 1000);

async function init() {
  if (location.protocol === 'https:') $('#network-status span').textContent = 'Internet';
  const fragment = location.hash.slice(1);
  if (fragment) history.replaceState(null, '', location.pathname);
  try {
    if (fragment.startsWith('admin=')) { await api('/api/admin/login', { secret:fragment.slice(6) }); await refresh(); }
    else if (location.pathname === '/connect' && fragment) {
      // A new scan can reconnect a revoked browser session.
      pairCode = fragment; showShell(true); phoneScreen('pair-screen');
      $('#device-name').value = /iPad/i.test(navigator.userAgent) ? 'Mon iPad' : /iPhone/i.test(navigator.userAgent) ? 'Mon iPhone' : /Android/i.test(navigator.userAgent) ? 'Mon Android' : 'Mon appareil';
    } else {
      const initial = await api('/api/state', undefined, 'GET'); updateState(initial); pollTimer = setTimeout(refresh, 1500);
    }
  } catch (error) { showError(error.status === 401 ? 'Ouvrez Brise depuis le lanceur du PC, ou scannez son QR code avec votre téléphone.' : error.message); }
}
init();
