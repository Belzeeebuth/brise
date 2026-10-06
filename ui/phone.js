'use strict';
let state = null, pairCode = '', polling = false, pollTimer;
let lastFiles = '', hadSession = false, errorCount = 0;
let uploads = [], uploading = false;
async function api(path, data, method = 'POST', timeout = 10000) {
  const response = await fetch(path, { method, headers: { 'X-Brise':'1', ...(data === undefined ? {} : { 'Content-Type':'application/json' }) }, body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(timeout) });
  let value; try { value = await response.json(); } catch { throw new Error('Le PC ne répond pas. Vérifiez la connexion.'); }
  if (!response.ok) { const error = new Error(value.error || 'Une erreur est survenue.'); error.status = response.status; throw error; }
  return value;
}
function showShell() { $('#boot').hidden = true; $('#shell').hidden = false; }
function phoneScreen(name) {
  ['pair-screen','waiting-screen','phone-workspace','error-screen'].forEach(id => $(`#${id}`).hidden = id !== name);
}
function showError(message) {
  showShell(); phoneScreen('error-screen');
  $('#session-error').textContent = message;
}
const mediaTypes = { jpg:'image/jpeg', jpeg:'image/jpeg', png:'image/png', heic:'image/heic', webp:'image/webp', gif:'image/gif', avif:'image/avif', mp4:'video/mp4', mov:'video/quicktime', m4v:'video/x-m4v', webm:'video/webm' };
const mediaType = name => mediaTypes[name.split('.').pop().toLowerCase()];
const shareLimit = 500 * 1000 * 1000;
const canShareFiles = (() => { try { return window.isSecureContext && !!navigator.canShare && navigator.canShare({ files:[new File([''], 'test.jpg', { type:'image/jpeg' })] }); } catch { return false; } })();
const shareLabel = /iPhone|iPad/i.test(navigator.userAgent) ? 'Photos' : 'Partager';
const prepared = new Map();
function shareButton(file) {
  if (!canShareFiles || !mediaType(file.name) || file.size > shareLimit) return '';
  const label = prepared.has(file.id) ? 'Enregistrer' : shareLabel;
  return `<button class="button secondary" data-share="${file.id}" aria-label="${label} ${escape(file.name)}">${icon(fileType(file.name))}${label}</button>`;
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
function fileRow(file) {
  const type = fileType(file.name);
  return `<div class="file-row"><span class="file-icon ${type}">${icon(type)}</span><div class="file-meta"><span class="file-name" title="${escape(file.name)}">${escape(file.name)}</span><div class="file-details"><span>${formatSize(file.size)}</span><span>·</span><span>Depuis votre PC</span></div></div>${shareButton(file)}<a class="button secondary" href="/api/files/${file.id}" download aria-label="Télécharger ${escape(file.name)}">${icon('download')}Recevoir</a></div>`;
}
function updateState(next) {
  state = next; hadSession = true; errorCount = 0;
  showShell();
  $('#network-status').classList.remove('offline');
  $('#network-status span').textContent = modeLabel(next.connectionMode || 'local');
  if (next.status === 'pending') { phoneScreen('waiting-screen'); $('#pair-code').textContent = next.code?.replace(/(.{3})/, '$1 '); return; }
  phoneScreen('phone-workspace');
  $('#phone-file-count').textContent = next.files.length;
  for (const id of prepared.keys()) if (!next.files.some(f => f.id === id)) prepared.delete(id);
  const key = JSON.stringify(next.files);
  if (key !== lastFiles) { $('#phone-file-list').innerHTML = next.files.length ? next.files.map(fileRow).join('') : empty('Aucun fichier disponible', 'Ajoutez des fichiers dans Brise sur votre PC.'); lastFiles = key; }
  renderTransfers();
}
async function refresh() {
  if (polling) return;
  polling = true;
  try { updateState(await api('/api/state', undefined, 'GET')); }
  catch (error) {
    if (error.status === 401) {
      clearTimeout(pollTimer);
      showError('Cette connexion est fermée. Scannez le QR code sur le PC pour vous reconnecter.');
      hadSession = false;
    } else {
      errorCount++; $('#network-status').classList.add('offline');
      $('#network-status span').textContent = 'Reconnexion…';
      if (!hadSession) showError(error.message || 'Impossible de joindre Brise. Vérifiez votre réseau.');
    }
  } finally { polling = false; }
  clearTimeout(pollTimer);
  if (hadSession) pollTimer = setTimeout(refresh, Math.min(errorCount ? 3000 : document.hidden ? 5000 : 1500, 10000));
}
function switchPhoneTab(tab) {
  $$('[data-phone-tab]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.phoneTab === tab)));
  $('#phone-send').hidden = tab !== 'send'; $('#phone-receive').hidden = tab !== 'receive';
}
function uploadCaption(item) {
  const percentage = item.size ? Math.floor(item.bytes / item.size * 100) : 0;
  return item.status === 'queued' ? 'Dans la file d’attente' : item.retrying ? 'Connexion perdue, nouvel essai…' : percentage >= 100 ? 'Finalisation sur le PC…' : 'Envoi au PC…';
}
function resultRow(u) {
  const label = u.status === 'done' ? 'Transfert terminé' : u.status === 'cancelled' ? 'Envoi annulé' : u.error;
  return `<div class="upload-result ${u.status === 'error' ? 'error' : ''}"><span>${icon(u.status === 'done' ? 'check-circle' : 'alert')}</span><div><p>${escape(u.name)}</p><span class="muted small">${escape(label)}</span></div>${u.status === 'error' ? `<button class="text-button" data-retry="${u.id}">Réessayer</button>` : ''}</div>`;
}
function renderTransfers() {
  const pending = uploads.filter(u => ['queued','uploading'].includes(u.status));
  const recent = uploads.filter(u => ['done','error','cancelled'].includes(u.status)).slice(-8).reverse();
  $('#phone-upload-list').innerHTML = pending.map(u => transferRow(u, uploadCaption(u), true)).join('') + recent.map(resultRow).join('');
}
function addFiles(files) {
  if (!state || state.status !== 'approved') return toast('Connectez d’abord votre téléphone au PC.', true);
  for (const file of files) {
    if (file.size > state.maxFileSize) { toast(`${file.name} dépasse la limite de 10 Go.`, true); continue; }
    uploads.push({ id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, file, name:file.name, size:file.size, bytes:0, status:'queued' });
  }
  switchPhoneTab('send'); renderTransfers(); processQueue();
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
        toast(`${item.name} reçu sur le PC.`);
      } catch (error) {
        if (item.status !== 'cancelled') { item.status = 'error'; item.error = error.message; toast(error.message, true); }
      } finally { item.xhr = null; item.retrying = false; renderTransfers(); await refresh(); }
    }
  } finally { uploading = false; keepAwake(false); uploads = uploads.filter(u => u.status !== 'done').concat(uploads.filter(u => u.status === 'done').slice(-8)); }
}
function help() {
  dialog('Aide', `<h3>Se connecter</h3><p>Scannez le QR code affiché par Brise sur le PC, donnez un nom à ce téléphone, vérifiez que le code est le même sur les deux écrans puis acceptez sur le PC.</p><h3>Transférer des fichiers</h3><p>« Recevoir » liste les fichiers partagés par le PC. « Envoyer au PC » envoie vos photos, vidéos ou documents. Gardez la page ouverte pendant l’envoi : si l’écran se verrouille ou si la connexion saute, l’envoi reprend là où il s’était arrêté.</p><p>Sur iPhone, les fichiers reçus vont dans l’app Fichiers. En mode Internet, le bouton « Photos » enregistre directement les images et vidéos dans Photos.</p><div class="dialog-section"><h3>Connexion impossible</h3><p>Vérifiez que le téléphone est sur le même réseau que le PC (ou sur son point d’accès Wi-Fi). Un réseau invité peut isoler les appareils. Si le téléphone indique « Pas d’Internet » sur le point d’accès de Brise, restez connecté à ce Wi-Fi.</p></div>`);
}
document.addEventListener('click', async event => {
  const button = event.target.closest('button,[data-action]'); if (!button) return;
  try {
    if (button.dataset.phoneTab) switchPhoneTab(button.dataset.phoneTab);
    if (button.dataset.share) await shareFile(button);
    if (button.dataset.cancel) { const item = uploads.find(u => u.id === button.dataset.cancel); if (item) { item.status = 'cancelled'; item.xhr?.abort(); discardRemote(item); item.file = null; renderTransfers(); } }
    if (button.dataset.retry) { const item = uploads.find(u => u.id === button.dataset.retry); if (item?.file) { item.status = 'queued'; if (!item.remoteId) item.bytes = 0; processQueue(); } }
    if (button.dataset.action === 'help') help();
    if (button.dataset.action === 'refresh') { hadSession = true; await refresh(); }
  } catch (error) { toast(error.message, true); }
  finally { button.disabled = false; }
});
document.addEventListener('submit', async event => {
  if (event.target.id !== 'pair-form') return;
  event.preventDefault(); const submit = event.target.querySelector('button[type=submit]'); submit.disabled = true;
  try { await api('/api/pair', { code:pairCode, name:$('#device-name').value.trim() || 'Mon téléphone' }); pairCode = ''; await refresh(); }
  catch (error) { toast(error.message, true); }
  finally { submit.disabled = false; }
});
document.addEventListener('change', event => {
  if (event.target.id === 'file-picker') { addFiles([...event.target.files]); event.target.value = ''; }
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
async function init() {
  $('#drop-phone').addEventListener('click', () => $('#file-picker').click());
  $('#drop-phone').addEventListener('keydown', event => { if (['Enter',' '].includes(event.key)) { event.preventDefault(); $('#file-picker').click(); } });
  if (location.protocol === 'https:') $('#network-status span').textContent = 'Internet';
  const fragment = location.hash.slice(1);
  if (fragment) history.replaceState(null, '', location.pathname);
  try {
    if (location.pathname === '/connect' && fragment) {
      pairCode = fragment; showShell(); phoneScreen('pair-screen');
      $('#device-name').value = /iPad/i.test(navigator.userAgent) ? 'Mon iPad' : /iPhone/i.test(navigator.userAgent) ? 'Mon iPhone' : /Android/i.test(navigator.userAgent) ? 'Mon Android' : 'Mon appareil';
    } else {
      updateState(await api('/api/state', undefined, 'GET')); pollTimer = setTimeout(refresh, 1500);
    }
  } catch (error) { showError(error.status === 401 ? 'Scannez le QR code affiché par Brise sur votre PC.' : error.message); }
}
document.addEventListener('DOMContentLoaded', init);
