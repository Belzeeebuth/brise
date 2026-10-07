'use strict';
let state = null, pairCode = '', polling = false, pollTimer;
let filesKey = '', hadSession = false, errorCount = 0, firstFiles = true;
let uploads = [], uploading = false;
const seenFiles = new Set();
const darkMedia = matchMedia('(prefers-color-scheme: dark)');
let lookKey = '';
function syncLook(view) {
  if (!view?.id) return;
  const look = { id: view.id, accent: view.accent || null, image: view.id === 'custom' ? `/wallpapers/custom?v=${view.version || 0}` : null };
  const key = JSON.stringify(look);
  if (key === lookKey) return;
  lookKey = key; applyLook(look, darkMedia.matches);
  try { localStorage.setItem('brise-look', key); } catch {}
}
darkMedia.addEventListener('change', () => { if (lookKey) applyLook(JSON.parse(lookKey), darkMedia.matches); });
async function api(path, data, method = 'POST', timeout = 10000) {
  let response;
  try { response = await fetch(path, { method, headers: { 'X-Brise':'1', ...(data === undefined ? {} : { 'Content-Type':'application/json' }) }, body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(timeout) }); }
  catch { throw Object.assign(new Error(t('error.offline')), { status: 0 }); }
  let value; try { value = await response.json(); } catch { throw Object.assign(new Error(t('error.offline')), { status: response.status }); }
  if (!response.ok) throw Object.assign(new Error(errorText(value)), { status: response.status, code: value.error });
  return value;
}
function showShell() { $('#boot').hidden = true; $('#shell').hidden = false; }
function screen(name) {
  ['pair-screen', 'waiting-screen', 'workspace', 'error-screen'].forEach(id => { $(`#${id}`).hidden = id !== name; });
}
function showError(message) {
  showShell(); screen('error-screen'); $('#status-chip').hidden = true;
  $('#error-text').textContent = message;
}
function statusChip(text, kind = '') {
  $('#status-chip').hidden = false;
  $('#status-chip .dot').className = `dot ${kind}`;
  $('#status-text').textContent = text;
}
const mediaTypes = { jpg:'image/jpeg', jpeg:'image/jpeg', png:'image/png', heic:'image/heic', heif:'image/heif', webp:'image/webp', gif:'image/gif', avif:'image/avif', mp4:'video/mp4', mov:'video/quicktime', m4v:'video/x-m4v', webm:'video/webm' };
const mediaType = name => mediaTypes[name.split('.').pop().toLowerCase()];
const shareLimit = 500 * 1000 * 1000;
const canShareFiles = (() => { try { return window.isSecureContext && !!navigator.canShare && navigator.canShare({ files:[new File([''], 'test.jpg', { type:'image/jpeg' })] }); } catch { return false; } })();
const isApple = /iPhone|iPad/i.test(navigator.userAgent);
const prepared = new Map();
function shareButton(file) {
  if (!canShareFiles || !mediaType(file.name) || file.size > shareLimit) return '';
  const label = prepared.has(file.id) ? t('phone.save') : isApple ? t('phone.photos') : t('phone.share');
  return `<button class="button secondary small" data-share="${file.id}">${icon(fileKind(file.name))}${escape(label)}</button>`;
}
async function shareFile(button) {
  const file = state?.files.find(f => f.id === button.dataset.share); if (!file) return;
  let shared = prepared.get(file.id);
  if (!shared) {
    button.disabled = true; button.textContent = t('phone.preparing', { percent: 0 });
    const response = await fetch(`/api/files/${file.id}`);
    if (!response.ok || !response.body) throw new Error(t('error.file_unavailable'));
    const reader = response.body.getReader(), parts = []; let received = 0;
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      parts.push(value); received += value.length;
      button.textContent = t('phone.preparing', { percent: Math.floor(received / Math.max(file.size, 1) * 100) });
    }
    shared = new File(parts, file.name, { type: mediaType(file.name) });
    prepared.set(file.id, shared);
    button.innerHTML = `${icon(fileKind(file.name))}${escape(t('phone.save'))}`;
  }
  try { await navigator.share({ files:[shared] }); }
  catch (error) {
    if (error.name === 'NotAllowedError') toast(t('phone.ready_tap'));
    else if (error.name !== 'AbortError') throw error;
  }
}
function fileRow(file) {
  const isNew = !firstFiles && !seenFiles.has(file.id);
  seenFiles.add(file.id);
  return `<div class="row${isNew ? ' fresh' : ''}">${kindTile(file.name)}<div class="row-main"><span class="row-name" title="${escape(file.name)}">${escape(file.name)}</span><span class="row-meta">${formatSize(file.size)}</span></div><div class="row-actions">${shareButton(file)}<a class="button secondary small" href="/api/files/${file.id}" download>${icon('download')}${escape(t('phone.download'))}</a></div></div>`;
}
function updateState(next) {
  state = next; hadSession = true; errorCount = 0;
  syncLook(next.wallpaper);
  showShell();
  if (next.status === 'pending') {
    screen('waiting-screen'); statusChip(t('device.pending'), 'warn live');
    $('#pair-code').innerHTML = String(next.code || '').split('').map((c, i) => `${i === 3 ? '<span class="gap"></span>' : ''}<span>${escape(c)}</span>`).join('');
    return;
  }
  screen('workspace');
  statusChip(next.pc ? t('phone.connected_to', { pc: next.pc }) : t('phone.connected'));
  $('#file-count').hidden = !next.files.length;
  $('#file-count').textContent = next.files.length;
  for (const id of prepared.keys()) if (!next.files.some(f => f.id === id)) prepared.delete(id);
  const key = JSON.stringify([lang, next.files.map(f => [f.id, f.name, f.size])]);
  if (key !== filesKey) {
    $('#file-list').innerHTML = next.files.length ? next.files.map(fileRow).join('') : emptyState('laptop', t('phone.files.empty.title'), t('phone.files.empty.text'));
    filesKey = key; firstFiles = false;
  }
  renderUploads();
}
async function refresh() {
  if (polling) return;
  polling = true;
  try { updateState(await api('/api/state', undefined, 'GET')); }
  catch (error) {
    if (error.status === 401) {
      clearTimeout(pollTimer); hadSession = false;
      showError(t('phone.error.closed'));
    } else {
      errorCount++; statusChip(t('phone.reconnecting'), 'warn live');
      if (!hadSession) showError(t('phone.error.unreachable'));
    }
  } finally { polling = false; }
  clearTimeout(pollTimer);
  if (hadSession) pollTimer = setTimeout(refresh, Math.min(errorCount ? 3000 : document.hidden ? 5000 : 1500, 10000));
}
function uploadCaption(item) {
  if (item.status === 'queued') return t('upload.queued');
  if (item.retrying) return t('upload.retrying');
  if (item.status === 'done') return t('upload.done');
  if (item.status === 'cancelled') return t('upload.cancelled');
  if (item.status === 'error') return item.error;
  return percentOf(item.bytes, item.size) >= 100 ? t('upload.finishing') : `${t('upload.sending')} ${formatSize(item.bytes)} / ${formatSize(item.size)}`;
}
function uploadRow(item) {
  const active = ['queued', 'uploading'].includes(item.status);
  const action = active ? `<button class="icon-button small" data-cancel="${item.id}" aria-label="${escape(t('upload.cancel', { name: item.name }))}">${icon('x')}</button>`
    : item.status === 'error' ? `<button class="button secondary small" data-retry="${item.id}">${icon('refresh')}${escape(t('action.retry'))}</button>`
    : item.status === 'done' ? `<span class="status ok">${icon('check')}</span>` : '';
  return `<div class="upload ${item.status}${item.isNew ? ' fresh' : ''}">${kindTile(item.name)}<div class="row-main"><span class="row-name">${escape(item.name)}</span><span class="row-meta">${escape(uploadCaption(item))}</span>${item.status === 'uploading' ? progressBar(percentOf(item.bytes, item.size), item.name) : ''}</div>${action}</div>`;
}
function renderUploads() {
  const active = uploads.filter(u => ['queued', 'uploading'].includes(u.status));
  const recent = uploads.filter(u => ['done', 'error', 'cancelled'].includes(u.status)).slice(-8).reverse();
  $('#uploads').innerHTML = active.concat(recent).map(uploadRow).join('');
  uploads.forEach(u => { u.isNew = false; });
}
function addFiles(files) {
  if (!state || state.status !== 'approved') return toast(t('upload.connect_first'), 'error');
  for (const file of files) {
    if (file.size > state.maxFileSize) { toast(t('upload.too_big', { name: file.name }), 'error'); continue; }
    uploads.push({ id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, file, name: file.name, size: file.size, bytes: 0, status: 'queued', isNew: true });
  }
  renderUploads(); processQueue();
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function xhrUpload(item, path, blob, headers, offset = 0) {
  return new Promise((resolve, reject) => {
    if (item.status === 'cancelled') return reject(new Error(t('upload.cancelled')));
    const xhr = new XMLHttpRequest(); item.xhr = xhr;
    const fail = (message, status = 0) => reject(Object.assign(new Error(message), { status }));
    xhr.open('POST', path); xhr.setRequestHeader('X-Brise', '1');
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    for (const [key, value] of Object.entries(headers)) xhr.setRequestHeader(key, value);
    xhr.timeout = 10 * 60 * 1000;
    xhr.upload.onprogress = event => { item.bytes = offset + event.loaded; item.retrying = false; renderUploads(); };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve();
      let body = {}; try { body = JSON.parse(xhr.responseText); } catch {}
      fail(errorText(body), xhr.status);
    };
    xhr.onerror = () => fail(t('error.offline'));
    xhr.ontimeout = () => fail(t('error.idle'));
    xhr.onabort = () => fail(t('upload.cancelled'));
    xhr.send(blob);
  });
}
function checkCancelled(item) { if (item.status === 'cancelled') throw new Error(t('upload.cancelled')); }
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
      item.retrying = false; renderUploads();
      for (;;) {
        checkCancelled(item);
        const completion = await api(`/api/uploads/${item.remoteId}`, undefined, 'GET');
        if (completion.status === 'error') throw Object.assign(new Error(errorText(completion.error)), { final: true });
        if (completion.status === 'done') return;
        await pause(700);
      }
    } catch (error) {
      if (item.status === 'cancelled' || error.final || [401, 403, 404, 507].includes(error.status)) throw error;
      if (attempt >= 5) throw Object.assign(new Error(t('upload.interrupted')), { resumable: true });
      item.retrying = true; renderUploads();
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
      item.status = 'uploading'; renderUploads();
      try {
        await sendFile(item);
        item.status = 'done'; item.file = null;
        toast(t('toast.received_pc', { name: item.name }));
      } catch (error) {
        if (item.status !== 'cancelled') { item.status = 'error'; item.error = error.message; toast(error.message, 'error'); }
      } finally { item.xhr = null; item.retrying = false; renderUploads(); await refresh(); }
    }
  } finally { uploading = false; keepAwake(false); uploads = uploads.filter(u => u.status !== 'done').concat(uploads.filter(u => u.status === 'done').slice(-8)); }
}
function help() {
  openDialog(t('help.title'), [1, 2, 3, 4].map(n => `<div class="section"><p>${escape(t(`phone.help.text${n}`))}</p></div>`).join(''));
}
document.addEventListener('click', async event => {
  const el = event.target.closest('button'); if (!el || el.closest('[data-close]')) return;
  try {
    if (el.dataset.share) await shareFile(el);
    if (el.dataset.cancel) { const item = uploads.find(u => u.id === el.dataset.cancel); if (item) { item.status = 'cancelled'; item.xhr?.abort(); discardRemote(item); item.file = null; renderUploads(); } }
    if (el.dataset.retry) { const item = uploads.find(u => u.id === el.dataset.retry); if (item?.file) { item.status = 'queued'; if (!item.remoteId) item.bytes = 0; renderUploads(); processQueue(); } }
    if (el.id === 'send-card') $('#file-picker').click();
    if (el.dataset.action === 'help') help();
    if (el.dataset.action === 'refresh') { hadSession = true; await refresh(); }
  } catch (error) { toast(error.message, 'error'); }
  finally { el.disabled = false; }
});
document.addEventListener('submit', async event => {
  if (event.target.id !== 'pair-form') return;
  event.preventDefault(); const submit = event.target.querySelector('button[type=submit]'); submit.disabled = true;
  try { await api('/api/pair', { code: pairCode, name: $('#device-name').value.trim() }); pairCode = ''; await refresh(); }
  catch (error) { toast(error.message, 'error'); }
  finally { submit.disabled = false; }
});
document.addEventListener('change', event => {
  if (event.target.id === 'file-picker') { addFiles([...event.target.files]); event.target.value = ''; }
});
let dragDepth = 0;
document.addEventListener('dragenter', event => { if (!event.dataTransfer.types.includes('Files') || state?.status !== 'approved') return; event.preventDefault(); dragDepth++; });
document.addEventListener('dragover', event => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); });
document.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); });
document.addEventListener('drop', event => {
  event.preventDefault(); dragDepth = 0;
  const items = [...(event.dataTransfer.items || [])];
  const files = items.length ? items.filter(i => { if (i.webkitGetAsEntry?.()?.isDirectory) { toast(t('error.only_files'), 'error'); return false; } return i.kind === 'file'; }).map(i => i.getAsFile()).filter(Boolean) : [...event.dataTransfer.files];
  addFiles(files);
});
document.addEventListener('visibilitychange', () => { if (!document.hidden && wakeWanted) keepAwake(true); if (!document.hidden && hadSession) refresh(); });
window.addEventListener('online', () => { if (hadSession) refresh(); });
function defaultName() {
  const device = /iPad/i.test(navigator.userAgent) ? 'iPad' : /iPhone/i.test(navigator.userAgent) ? 'iPhone' : /Android/i.test(navigator.userAgent) ? 'Android' : t('phone.default_device');
  return t('phone.default_name', { device });
}
async function init() {
  const fragment = location.hash.slice(1);
  if (fragment) history.replaceState(null, '', location.pathname);
  api('/api/look', undefined, 'GET').then(syncLook).catch(() => {});
  try {
    if (location.pathname === '/connect' && fragment) {
      pairCode = fragment; showShell(); screen('pair-screen');
      $('#device-name').value = defaultName();
    } else {
      updateState(await api('/api/state', undefined, 'GET')); pollTimer = setTimeout(refresh, 1500);
    }
  } catch (error) { showError(error.status === 401 ? t('phone.error.scan') : error.message); }
}
document.addEventListener('DOMContentLoaded', init);
