'use strict';
const TAURI = window.__TAURI__;
const invoke = TAURI.core.invoke;
const listen = TAURI.event.listen;
const appWindow = TAURI.window?.getCurrentWindow?.();
const assetUrl = path => TAURI.core.convertFileSrc(path);
let state = null, refreshing = false, again = false, firstRender = true;
let themeChoice = 'system', systemDark = matchMedia('(prefers-color-scheme: dark)').matches;
let lastPairId = null, modeDraft = null, dialogKind = null;
const keys = {};
const seen = { shared: new Set(), received: new Set(), devices: new Set() };
const qrCache = { pair: { key: '', src: '' }, wifi: { key: '', src: '' } };
let approvedBefore = null, lookKey = '', settingsPane = 'appearance', inboxView = 'list', lightboxId = null;
try { inboxView = localStorage.getItem('brise-inbox-view') === 'grid' ? 'grid' : 'list'; } catch {}

async function call(command, args) {
  try { return await invoke(command, args); }
  catch (error) { throw new Error(errorText(error)); }
}
const svgData = svg => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
function patch(element, key, html) {
  if (!element || keys[element.id] === key) return false;
  keys[element.id] = key; element.innerHTML = html; return true;
}
function fresh(set, id) {
  const isNew = !firstRender && !set.has(id);
  set.add(id);
  return isNew ? ' fresh' : '';
}

function applyTheme() {
  const dark = themeChoice === 'dark' || (themeChoice === 'system' && systemDark);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  const look = currentLook();
  if (look) applyLook(look, dark);
  if (dialogKind === 'settings') renderSettingsPane();
}
function customImage() {
  const w = state?.wallpaper;
  return w?.customPath ? `${assetUrl(w.customPath)}?v=${w.version || 0}` : '';
}
function currentLook() {
  const w = state?.wallpaper;
  return w ? { id: w.id, accent: w.accent || null, image: w.id === 'custom' ? customImage() : null } : null;
}
function syncLook() {
  const look = currentLook(), key = JSON.stringify(look);
  if (!look || key === lookKey) return;
  lookKey = key;
  applyLook(look, document.documentElement.dataset.theme === 'dark');
  try { localStorage.setItem('brise-look', key); } catch {}
}
async function setThemeChoice(choice) {
  themeChoice = choice;
  try { localStorage.setItem('brise-theme', choice); } catch {}
  try {
    await appWindow?.setTheme(choice === 'system' ? null : choice);
    if (choice === 'system') systemDark = (await appWindow.theme()) === 'dark';
  } catch {}
  applyTheme();
}
async function initTheme() {
  try { themeChoice = localStorage.getItem('brise-theme') || 'system'; } catch {}
  try {
    if (themeChoice !== 'system') await appWindow?.setTheme(themeChoice);
    else systemDark = (await appWindow.theme()) === 'dark';
  } catch {}
  applyTheme();
  try { await appWindow?.onThemeChanged(({ payload }) => { if (themeChoice === 'system') { systemDark = payload === 'dark'; applyTheme(); } }); } catch {}
}

const approvedDevices = () => state.devices.filter(d => d.status === 'approved');
const modeLabel = mode => t(`mode.${mode}`);
function deviceState(d) { return d.status === 'pending' ? t('device.pending') : d.online ? t('device.online') : t('device.asleep'); }
function avatar(d) { return `<span class="avatar">${icon('phone')}<span class="dot ${d.status === 'pending' ? 'warn live' : d.online ? '' : 'idle'}"></span></span>`; }
function media(file) {
  if (file.path && fileKind(file.name) === 'image' && !/\.(heic|heif)$/i.test(file.name)) return `<img class="thumb" loading="lazy" decoding="async" src="${escape(assetUrl(file.path))}" data-name="${escape(file.name)}" alt="">`;
  return kindTile(file.name);
}
function digits(code) {
  const chars = String(code || '').split('');
  return chars.slice(0, 3).map(c => `<span>${escape(c)}</span>`).join('') + '<span class="gap"></span>' + chars.slice(3).map(c => `<span>${escape(c)}</span>`).join('');
}

function connectStatus() {
  const c = state.connection;
  if (state.serverError) return { status: 'error', message: errorText(state.serverError), server: true };
  return { status: c.status, message: c.message ? errorText(c.message) : '' };
}
function qrBlock(size = '') {
  const c = state.connection, s = connectStatus();
  if (s.status === 'starting') return `<div class="qr-placeholder ${size}"><span class="spinner"></span><span>${escape(t(`connect.starting.${c.mode}`))}</span></div>`;
  if (s.status === 'error') return `<div class="qr-placeholder error ${size}">${icon('alert')}<strong>${escape(s.server ? t('connect.server_error') : t('connect.unavailable'))}</strong><span>${escape(s.message)}</span>${s.server ? '' : `<button class="button secondary small" data-action="modes">${escape(t('action.change_mode'))}</button>`}</div>`;
  if (!state.pairUrl) return `<div class="qr-placeholder ${size}">${icon('alert')}<span>${escape(t('connect.no_address'))}</span><button class="button secondary small" data-action="settings">${escape(t('action.settings'))}</button></div>`;
  if (c.mode === 'hotspot' && c.hotspot && size !== 'mini') {
    return `<div class="qr-pair"><div class="qr-step"><span class="qr-step-label"><b>1</b>${escape(t('connect.hotspot.join'))}</span><div class="qr-card"><img data-qr="wifi" alt="${escape(t('connect.wifi_qr_alt'))}"></div><dl class="wifi-credentials"><dt>${escape(t('connect.hotspot.network'))}</dt><dd>${escape(c.hotspot.ssid)}</dd><dt>${escape(t('connect.hotspot.password'))}</dt><dd>${escape(c.hotspot.password)}</dd></dl></div><div class="qr-step"><span class="qr-step-label"><b>2</b>${escape(t('connect.hotspot.open'))}</span><div class="qr-card"><img data-qr="pair" alt="${escape(t('connect.qr_alt'))}"></div></div></div>`;
  }
  return `<div class="qr-card"><img data-qr="pair" alt="${escape(t('connect.qr_alt'))}"></div>`;
}
function heroConnect(dialog = false) {
  const c = state.connection, ready = connectStatus().status === 'ready' && state.pairUrl;
  const twoCodes = c.mode === 'hotspot' && c.hotspot && ready;
  const steps = twoCodes ? [t('connect.hotspot.step1'), t('connect.hotspot.step2'), t('connect.step3')] : [t('connect.step1'), t('connect.step2'), t('connect.step3')];
  const meta = ready ? `<div class="qr-meta"><span>${escape(t(`connect.need.${c.mode}`))}</span><button class="icon-button small" data-action="rotate" title="${escape(t('action.new_code'))}" aria-label="${escape(t('action.new_code'))}">${icon('refresh')}</button></div>${manualLine()}` : '';
  return `<div class="connect-inner${twoCodes ? ' two-qr' : ''}"><div class="connect-copy"><h1 id="connect-title">${escape(t('connect.title'))}</h1><p class="lead">${escape(t('connect.lead'))}</p><ol class="steps">${steps.map(step => `<li>${escape(step)}</li>`).join('')}</ol><div class="connect-actions">${ready ? `<button class="button primary" data-action="copy-link">${icon('link')}${escape(t('action.copy_link'))}</button>` : ''}<button class="link-button" data-action="modes">${icon(c.mode)}${escape(t('action.change_mode'))}</button></div></div><div class="qr-zone">${qrBlock()}${meta}</div></div>`;
}
function pairCodeText() { const code = String(state.pairCode || ''); return code ? `${code.slice(0, 3)}-${code.slice(3)}` : ''; }
function manualLine() {
  if (!state.pairUrl || !state.pairCode) return '';
  const url = state.pairUrl.replace(/\/connect#.*$/, '');
  return `<p class="manual">${escape(t('connect.manual', { url }))} <code>${escape(pairCodeText())}</code></p>`;
}
function miniConnect() {
  const ready = connectStatus().status === 'ready' && state.pairUrl;
  return `<div class="mini-connect">${ready ? `<div class="qr-card"><img data-qr="pair" alt="${escape(t('connect.qr_alt'))}"></div>` : qrBlock('mini')}<strong>${escape(t('devices.connect_another'))}</strong><p>${escape(t(`connect.need.${state.connection.mode}`))}</p>${ready ? `<button class="button secondary small" data-action="copy-link">${icon('link')}${escape(t('action.copy_link'))}</button>` : ''}</div>`;
}
async function loadQrs() {
  const pairKey = state.pairUrl || '';
  if (pairKey && qrCache.pair.key !== pairKey) {
    try { qrCache.pair = { key: pairKey, src: svgData(await call('qr')) }; } catch { qrCache.pair = { key: '', src: '' }; }
  }
  const hotspot = state.connection.hotspot;
  const wifiKey = hotspot && state.connection.status === 'ready' ? `${hotspot.ssid}|${hotspot.password}` : '';
  if (wifiKey && qrCache.wifi.key !== wifiKey) {
    try { qrCache.wifi = { key: wifiKey, src: svgData(await call('wifi_qr')) }; } catch { qrCache.wifi = { key: '', src: '' }; }
  }
  $$('img[data-qr="pair"]').forEach(img => { if (qrCache.pair.src && img.src !== qrCache.pair.src) img.src = qrCache.pair.src; });
  $$('img[data-qr="wifi"]').forEach(img => { if (qrCache.wifi.src && img.src !== qrCache.wifi.src) img.src = qrCache.wifi.src; });
}
function renderConnect() {
  const key = JSON.stringify([lang, state.connection.mode, state.connection.status, state.connection.message, state.connection.hotspot, state.pairUrl, state.pairCode, state.serverError]);
  patch($('#connect-panel'), key, heroConnect());
  patch($('#rail-connect'), key, miniConnect());
  if (dialogKind === 'connect' && keys['dialog-connect'] !== key) { keys['dialog-connect'] = key; $('#dialog-connect').innerHTML = heroConnect(true); }
  loadQrs();
}

function renderTopbar(approved) {
  const c = state.connection, s = connectStatus();
  $('#mode-chip .mode-label').textContent = modeLabel(c.mode);
  $('#mode-chip .dot').className = `dot ${s.status === 'starting' ? 'warn live' : s.status === 'error' ? 'error' : ''}`;
  $('#mode-chip').title = s.message || t(`mode.${c.mode}.desc`);
  const visible = state.devices.filter(d => d.status !== 'revoked');
  const chips = visible.slice(0, 3).map(d => `<button class="device-chip${fresh(seen.devices, d.id)}" data-action="devices" title="${escape(d.name)}">${avatar(d)}<span class="who"><strong>${escape(d.name)}</strong><span>${escape(deviceState(d))}</span></span></button>`).join('');
  const more = visible.length > 3 ? `<button class="chip more-chip" data-action="devices">+${visible.length - 3}</button>` : '';
  patch($('#device-chips'), JSON.stringify([lang, visible.map(d => [d.id, d.name, d.status, d.online])]), chips + more);
  $('#add-device').hidden = !approved.length;
}

function sharedRow(file, downloads) {
  const dl = downloads.find(d => d.fileId === file.id);
  const percent = dl ? percentOf(dl.bytes, dl.size) : 0;
  const status = dl
    ? `<span class="status busy" data-percent-for="${dl.id}">${icon('download')}${percent}\u00a0%</span>`
    : file.downloads ? `<span class="status ok">${icon('check')}${escape(file.downloads > 1 ? t('file.downloaded_n', { count: file.downloads }) : t('file.downloaded'))}</span>` : `<span class="status">${escape(t('file.available'))}</span>`;
  const meta = `<span>${formatSize(file.size)}</span>${dl ? `<span class="sep">·</span><span>${escape(t('file.downloading', { name: dl.sender }))}</span><span data-rate="${dl.id}">${rateOf(dl.id, dl.bytes, dl.size) ? `<span class="sep">·</span>${escape(rateOf(dl.id, dl.bytes, dl.size))}` : ''}</span>` : ''}`;
  return `<div class="row shared${fresh(seen.shared, file.id)}" data-file="${file.id}">${media(file)}<div class="row-main"><span class="row-name" title="${escape(file.name)}">${escape(file.name)}</span><span class="row-meta">${meta}</span>${dl ? `<span data-progress="${dl.id}">${progressBar(percent, file.name)}</span>` : ''}</div>${status}<div class="row-actions"><button class="icon-button small" data-reveal="${file.id}" title="${escape(t('action.reveal'))}" aria-label="${escape(t('action.reveal'))}">${icon('folder')}</button><button class="icon-button small danger" data-remove="${file.id}" title="${escape(t('file.remove'))}" aria-label="${escape(`${t('file.remove')} : ${file.name}`)}">${icon('x')}</button></div></div>`;
}
function noteRow(note) {
  const link = isLink(note.text);
  const outgoing = note.direction === 'outgoing';
  const meta = outgoing
    ? `<span>${escape(link ? t('text.link') : t('text.kind'))}</span>`
    : `<span>${escape(link ? t('text.link') : t('text.kind'))}</span><span class="sep">·</span><span>${escape(t('inbox.from', { name: note.sender }))}</span><span class="sep">·</span><span>${formatTime(note.createdAt)}</span>`;
  const actions = `<button class="icon-button small" data-copy="${note.id}" title="${escape(t('text.copy'))}" aria-label="${escape(t('text.copy'))}">${icon('copy')}</button>${link ? `<a class="icon-button small" href="${escape(note.text)}" target="_blank" rel="noreferrer" title="${escape(t('text.open'))}" aria-label="${escape(t('text.open'))}">${icon('open')}</a>` : ''}<button class="icon-button small danger" data-remove-note="${note.id}" title="${escape(outgoing ? t('text.remove') : t('text.delete'))}" aria-label="${escape(outgoing ? t('text.remove') : t('text.delete'))}">${icon('x')}</button>`;
  return `<div class="row text-row clickable${fresh(outgoing ? seen.shared : seen.received, note.id)}" data-note="${note.id}"><span class="kind-tile kind-text">${icon('text')}</span><div class="row-main"><span class="row-name" title="${escape(notePreview(note.text))}">${escape(notePreview(note.text))}</span><span class="row-meta">${meta}</span></div><div class="row-actions">${actions}</div></div>`;
}
function renderSend(approved) {
  $('#send-title').textContent = approved.length > 1 ? t('send.title_many') : t('send.title');
  const shared = state.files.filter(f => f.direction === 'outgoing');
  const notes = (state.notes || []).filter(n => n.direction === 'outgoing');
  const downloads = state.transfers.filter(t => t.direction === 'download');
  const items = shared.map(f => ({ at: f.createdAt, html: () => sharedRow(f, downloads) })).concat(notes.map(n => ({ at: n.createdAt, html: () => noteRow(n) }))).sort((a, b) => b.at - a.at);
  $('#dropzone').classList.toggle('big', !items.length);
  const key = JSON.stringify([lang, shared.map(f => [f.id, f.downloads, f.size]), notes.map(n => n.id), downloads.map(d => [d.id, d.fileId, d.sender])]);
  const html = items.length ? items.map(i => i.html()).join('') : `<p class="dropzone-note">${escape(approved.length ? t('send.empty') : t('send.waiting_device'))}</p>`;
  if (!patch($('#shared-list'), key, html)) updateProgress(downloads);
}

function incomingCard(transfer) {
  const percent = percentOf(transfer.bytes, transfer.size);
  const caption = transfer.paused ? t('inbox.paused', { name: transfer.sender }) : t('inbox.receiving', { name: transfer.sender });
  return `<div class="incoming${transfer.paused ? ' paused' : ''}" data-transfer="${transfer.id}">${kindTile(transfer.name)}<div class="row-main"><span class="row-name">${escape(transfer.name)}</span><span class="row-meta"><span>${escape(caption)}</span><span class="sep">·</span><span data-bytes>${formatSize(transfer.bytes)} / ${formatSize(transfer.size)}</span><span data-rate="${transfer.id}">${rateText(transfer)}</span></span><span data-progress="${transfer.id}">${progressBar(percent, transfer.name).replace('class="progress"', `class="progress${transfer.paused ? ' paused' : ''}"`)}</span></div><span class="status ${transfer.paused ? 'warn' : 'busy'}" data-percent>${transfer.paused ? icon('pause') : ''}${percent}\u00a0%</span></div>`;
}
function receivedRow(file) {
  return `<div class="row clickable${fresh(seen.received, file.id)}" data-open-row="${file.id}">${media(file)}<div class="row-main"><span class="row-name" title="${escape(file.name)}">${escape(file.name)}</span><span class="row-meta"><span>${formatSize(file.size)}</span><span class="sep">·</span><span>${escape(t('inbox.from', { name: file.sender }))}</span><span class="sep">·</span><span>${formatTime(file.createdAt)}</span></span></div><div class="row-actions"><button class="icon-button small" data-open="${file.id}" title="${escape(t('action.open'))}" aria-label="${escape(`${t('action.open')} : ${file.name}`)}">${icon('open')}</button><button class="icon-button small" data-reveal="${file.id}" title="${escape(t('action.reveal'))}" aria-label="${escape(t('action.reveal'))}">${icon('folder')}</button></div></div>`;
}
function galleryTile(file) {
  const image = file.path && fileKind(file.name) === 'image' && !/\.(heic|heif)$/i.test(file.name);
  const art = image ? `<img class="tile-img" loading="lazy" decoding="async" src="${escape(assetUrl(file.path))}" alt="">` : `<span class="tile-art">${kindTile(file.name)}</span>`;
  return `<button class="tile${fresh(seen.received, file.id)}" data-open-row="${file.id}" ${image ? `data-preview="${file.id}"` : ''} title="${escape(file.name)}">${art}<span class="tile-name">${escape(file.name)}</span><span class="tile-meta">${escape(t('inbox.from', { name: file.sender }))} · ${formatTime(file.createdAt)}</span></button>`;
}
function noteTile(note) {
  return `<button class="tile tile-note${fresh(seen.received, note.id)}" data-note="${note.id}"><span class="tile-art">${icon('text')}<span class="tile-text">${escape(note.text)}</span></span><span class="tile-name">${escape(isLink(note.text) ? t('text.link') : t('text.kind'))}</span><span class="tile-meta">${escape(t('inbox.from', { name: note.sender }))} · ${formatTime(note.createdAt)}</span></button>`;
}
function receivedImages() {
  return state.files.filter(f => f.direction === 'incoming' && f.path && fileKind(f.name) === 'image' && !/\.(heic|heif)$/i.test(f.name));
}
function lightbox(id) {
  const images = receivedImages();
  const index = images.findIndex(f => f.id === id);
  if (index < 0) return;
  const file = images[index];
  lightboxId = id;
  const html = `<div class="lightbox-stage"><img src="${escape(assetUrl(file.path))}" alt="${escape(file.name)}"><button class="icon-button bordered lightbox-nav prev" data-lightbox="${escape(images[index - 1]?.id || '')}" ${index === 0 ? 'disabled' : ''} title="${escape(t('action.previous'))}" aria-label="${escape(t('action.previous'))}">${icon('left')}</button><button class="icon-button bordered lightbox-nav next" data-lightbox="${escape(images[index + 1]?.id || '')}" ${index === images.length - 1 ? 'disabled' : ''} title="${escape(t('action.next'))}" aria-label="${escape(t('action.next'))}">${icon('right')}</button></div><div class="lightbox-caption"><span><strong>${index + 1} / ${images.length}</strong> · ${escape(t('inbox.from', { name: file.sender }))} · ${formatSize(file.size)} · ${formatTime(file.createdAt)}</span><span class="row-actions"><button class="button secondary small" data-open="${file.id}">${icon('open')}${escape(t('action.open'))}</button><button class="button secondary small" data-reveal="${file.id}">${icon('folder')}${escape(t('action.reveal'))}</button></span></div>`;
  if (dialogKind === 'lightbox' && $('#dialog').open) { $('#dialog-title').textContent = file.name; $('#dialog-body').innerHTML = html; }
  else show('lightbox', file.name, html, { wide: true, className: 'lightbox' });
}
function renderInbox() {
  const received = state.files.filter(f => f.direction === 'incoming').map(f => ({ at: f.createdAt, id: f.id, html: () => receivedRow(f), tile: () => galleryTile(f) }))
    .concat((state.notes || []).filter(n => n.direction === 'incoming').map(n => ({ at: n.createdAt, id: n.id, html: () => noteRow(n), tile: () => noteTile(n) })))
    .sort((a, b) => b.at - a.at);
  const incoming = state.transfers.filter(t => t.direction === 'incoming');
  $('#inbox-count').hidden = !received.length;
  $('#inbox-count').textContent = received.length;
  const key = JSON.stringify([lang, inboxView, received.map(f => f.id), incoming.map(t => [t.id, t.paused, t.sender])]);
  $$('[data-view]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.view === inboxView)));
  let html = incoming.map(incomingCard).join('');
  let day = '';
  if (inboxView === 'grid') {
    const groups = [];
    for (const item of received) {
      const label = dayLabel(item.at);
      if (label !== day) { day = label; groups.push({ label, tiles: [] }); }
      groups[groups.length - 1].tiles.push(item.tile());
    }
    html += groups.map(g => `<div class="group-label">${escape(g.label)}</div><div class="gallery">${g.tiles.join('')}</div>`).join('');
  } else {
    for (const item of received) {
      const label = dayLabel(item.at);
      if (label !== day) { day = label; html += `<div class="group-label">${escape(label)}</div>`; }
      html += item.html();
    }
  }
  if (!html) html = emptyState('download', t('inbox.empty.title'), t('inbox.empty.text'));
  if (!patch($('#inbox-list'), key, html)) updateProgress(incoming);
}
function rateText(transfer) {
  const rate = transfer.paused ? '' : rateOf(transfer.id, transfer.bytes, transfer.size);
  return rate ? `<span class="sep">·</span>${escape(rate)}` : '';
}
function updateProgress(transfers) {
  for (const transfer of transfers) {
    const percent = percentOf(transfer.bytes, transfer.size);
    $$(`[data-progress="${transfer.id}"] progress`).forEach(p => { p.value = percent; });
    $$(`[data-rate="${transfer.id}"]`).forEach(el => { el.innerHTML = rateText(transfer); });
    const card = $(`[data-transfer="${transfer.id}"]`);
    if (card) {
      card.querySelector('[data-bytes]').textContent = `${formatSize(transfer.bytes)} / ${formatSize(transfer.size)}`;
      const badge = card.querySelector('[data-percent]');
      badge.innerHTML = `${transfer.paused ? icon('pause') : ''}${percent}\u00a0%`;
    }
    const pill = $(`[data-percent-for="${transfer.id}"]`);
    if (pill) pill.innerHTML = `${icon('download')}${percent}\u00a0%`;
  }
}

function renderRail() {
  const visible = state.devices.filter(d => d.status !== 'revoked');
  const html = visible.map(d => `<div class="device-row">${avatar(d)}<span class="who"><strong>${escape(d.name)}</strong><span>${escape(deviceState(d))}</span></span>${d.status === 'pending' ? `<button class="button primary small" data-decide="${d.id}" data-approve="true">${escape(t('action.accept'))}</button>` : `<button class="icon-button small danger" data-decide="${d.id}" data-approve="false" title="${escape(t('action.disconnect'))}" aria-label="${escape(`${t('action.disconnect')} : ${d.name}`)}">${icon('x')}</button>`}</div>`).join('');
  patch($('#rail-devices'), JSON.stringify([lang, visible.map(d => [d.id, d.name, d.status, d.online])]), html);
}

function renderPairRequest() {
  const pending = state.devices.find(d => d.status === 'pending');
  const dialog = $('#pair-dialog');
  if (!pending) { if (dialog.open) dialog.close(); lastPairId = null; return; }
  if (pending.id === lastPairId) return;
  lastPairId = pending.id;
  dialog.dataset.id = pending.id;
  $('#pair-title').textContent = t('pair.title', { name: pending.name });
  $('#pair-code').innerHTML = digits(pending.code);
  if (!dialog.open) dialog.showModal();
}
function announceDevices(approved) {
  const now = new Map(approved.map(d => [d.id, d.name]));
  if (approvedBefore) {
    for (const [id, name] of now) if (!approvedBefore.has(id)) toast(t('toast.device_connected', { name }));
    for (const [id, name] of approvedBefore) if (!now.has(id)) toast(t('toast.device_disconnected', { name }));
  }
  approvedBefore = now;
}

function updateState(next) {
  const langChanged = setLang(next.lang);
  state = next;
  if (langChanged) for (const key of Object.keys(keys)) delete keys[key];
  $('#boot').hidden = true; $('#app').hidden = false;
  syncLook();
  const approved = approvedDevices();
  $('#app').dataset.view = approved.length ? 'share' : 'connect';
  renderTopbar(approved);
  renderConnect();
  renderSend(approved);
  renderInbox();
  renderRail();
  renderPairRequest();
  announceDevices(approved);
  const names = approved.map(d => d.name).join(', ');
  $('#drop-text').textContent = names ? t('drop.to', { name: names }) : t('drop.later');
  if (dialogKind === 'devices') devicesDialog(true);
  firstRender = false;
}
async function refresh() {
  if (refreshing) { again = true; return; }
  refreshing = true;
  try { updateState(await call('get_state')); }
  catch (error) { toast(error.message, 'error'); }
  finally { refreshing = false; if (again) { again = false; refresh(); } }
}

function show(kind, title, html, options) {
  dialogKind = kind;
  openDialog(title, html, options);
}
function connectDialog() {
  show('connect', t('connect.dialog_title'), '<div id="dialog-connect" class="panel connect in-dialog"></div>', { wide: true });
  keys['dialog-connect'] = ''; renderConnect();
}
function devicesDialog(rerender = false) {
  const visible = state.devices.filter(d => d.status !== 'revoked');
  const html = `<p>${escape(t('devices.trusted_text'))}</p><div class="section"><div class="device-list">${visible.length ? visible.map(d => `<div class="device-row">${avatar(d)}<span class="who"><strong>${escape(d.name)}</strong><span>${escape(deviceState(d))}</span></span>${d.status === 'pending' ? `<button class="button secondary small" data-decide="${d.id}" data-approve="false">${escape(t('action.decline'))}</button><button class="button primary small" data-decide="${d.id}" data-approve="true">${escape(t('action.accept'))}</button>` : `<button class="button secondary small" data-decide="${d.id}" data-approve="false">${escape(t('action.disconnect'))}</button>`}</div>`).join('') : `<p>${escape(t('devices.empty'))}</p>`}</div></div><div class="modal-actions"><button class="button primary" data-action="connect-dialog">${icon('plus')}${escape(t('devices.connect_another'))}</button></div>`;
  if (rerender) { if ($('#dialog').open) $('#dialog-body').innerHTML = html; return; }
  show('devices', t('devices.title'), html);
}
function modeDetails(mode) {
  const c = state.connection;
  const capability = mode === 'local' ? { available: true } : c.capabilities[mode];
  if (mode === c.mode && c.status === 'ready') return '';
  if (!capability?.available) {
    return `<div class="mode-details"><div class="note error">${icon('alert')}<span>${escape(errorText(capability?.reason || 'unexpected'))}</span></div>${capability?.install ? `<p>${escape(t('mode.install'))}</p><div class="command">${icon('terminal')}<code>${escape(capability.install)}</code></div>` : ''}${capability?.installUrl ? `<a class="link-button" href="${escape(capability.installUrl)}" target="_blank" rel="noreferrer">${icon('open')}${escape(t('mode.install_link'))}</a>` : ''}<div class="modal-actions"><button class="button secondary" data-action="probe" data-mode="${mode}">${icon('refresh')}${escape(t('action.check_again'))}</button></div></div>`;
  }
  const notes = { internet: `<div class="note">${icon('lock')}<span>${escape(t('mode.internet.privacy'))}</span></div>`, hotspot: `<div class="note warn">${icon('alert')}<span>${escape(t('mode.hotspot.warning'))}</span></div>`, local: '' };
  const hotspotForm = mode === 'hotspot' ? `<label class="field"><span class="field-label">${escape(t('mode.hotspot.card'))}</span><span class="select-wrap"><select id="hotspot-interface" class="input">${capability.interfaces.map(i => `<option value="${escape(i)}">${escape(i)}</option>`).join('')}</select>${icon('chevron')}</span></label><label class="check"><input type="checkbox" id="confirm-wifi"><span>${escape(t('mode.hotspot.confirm'))}</span></label>` : '';
  return `<div class="mode-details">${notes[mode]}${hotspotForm}<p class="hint">${icon('info')}<span>${escape(t('mode.reconnect_note'))}</span></p><div class="modal-actions"><button class="button primary" data-action="activate" data-mode="${mode}">${escape(t('mode.activate'))}</button></div></div>`;
}
function modesDialog(selected) {
  const c = state.connection;
  modeDraft = selected || c.mode;
  const badge = mode => mode !== c.mode ? '' : c.status === 'starting' ? `<span class="status busy">${escape(t('mode.starting'))}</span>` : c.status === 'error' ? `<span class="status warn">${escape(t('mode.failed'))}</span>` : `<span class="status ok">${escape(t('mode.active'))}</span>`;
  const cards = ['local', 'internet', 'hotspot'].map(mode => `<button class="mode-card" data-mode-card="${mode}" aria-pressed="${mode === modeDraft}"><span class="mode-icon">${icon(mode)}</span><span class="mode-text"><strong>${escape(modeLabel(mode))}${badge(mode)}</strong><span>${escape(t(`mode.${mode}.desc`))}</span></span></button>`).join('');
  const failure = c.status === 'error' && c.message ? `<div class="note error">${icon('alert')}<span>${escape(errorText(c.message))}</span></div>` : '';
  show('modes', t('mode.title'), `${failure}<div class="mode-cards">${cards}</div>${modeDetails(modeDraft)}`);
}
function settingsDialog(pane) {
  if (pane) settingsPane = pane;
  const nav = [['appearance', 'palette'], ['files', 'folder'], ['network', 'local'], ['general', 'settings'], ['about', 'info']].map(([key, glyph]) => `<button data-pane="${key}" aria-pressed="${settingsPane === key}">${icon(glyph)}${escape(t(`settings.nav.${key}`))}</button>`).join('');
  show('settings', t('settings.title'), `<div class="settings"><nav class="settings-nav" aria-label="${escape(t('settings.title'))}">${nav}</nav><div id="settings-pane" class="settings-pane">${settingsPaneHtml()}</div></div>`, { wide: true });
}
function wallpaperTile(id, thumb, label) {
  const selected = state.wallpaper.id === id;
  return `<button class="wall-tile" data-wallpaper="${id}" aria-pressed="${selected}"><span class="wall-thumb${thumb.cls || ''}">${thumb.html || ''}</span><span>${selected ? `<span class="check">${icon('check')}</span>` : ''}${escape(label)}</span></button>`;
}
function settingsPaneHtml() {
  const n = state.network, w = state.wallpaper;
  switch (settingsPane) {
    case 'appearance': {
      const dark = document.documentElement.dataset.theme === 'dark';
      const themeButtons = [['system', 'monitor'], ['light', 'sun'], ['dark', 'moon']].map(([choice, glyph]) => `<button data-theme-choice="${choice}" aria-pressed="${themeChoice === choice}">${icon(glyph)}${escape(t(`theme.${choice}`))}</button>`).join('');
      const tiles = [wallpaperTile('none', { cls: ' swatch' }, t('wallpaper.none'))]
        .concat(Object.keys(WALLPAPERS).map(id => wallpaperTile(id, { html: `<img src="wallpapers/${id}-${dark ? 'dark' : 'light'}.svg" alt="" loading="lazy">` }, t(`wallpaper.${id}`))));
      if (w.customPath) tiles.push(wallpaperTile('custom', { html: `<img src="${escape(customImage())}" alt="">` }, t('wallpaper.custom')));
      tiles.push(`<button class="wall-tile" data-action="pick-wallpaper"><span class="wall-thumb add">${icon('plus')}</span><span>${escape(t('wallpaper.pick'))}</span></button>`);
      return `<div class="setting"><span class="label">${escape(t('settings.theme'))}</span><div class="segmented" role="group" aria-label="${escape(t('settings.theme'))}">${themeButtons}</div></div>
        <div class="setting"><span class="label">${escape(t('settings.wallpaper'))}</span><div class="wall-grid">${tiles.join('')}</div><p>${escape(t('settings.wallpaper_text'))}</p>${w.customPath ? `<div><button class="button ghost small" data-action="remove-wallpaper">${icon('trash')}${escape(t('wallpaper.remove'))}</button></div>` : ''}</div>`;
    }
    case 'files':
      return `<div class="setting"><h3>${escape(t('settings.receive'))}</h3><p>${escape(t('settings.receive_text'))}</p><div class="path">${escape(state.receiveDir)}</div><div><button class="button secondary small" data-action="folder">${icon('folder')}${escape(t('inbox.open_folder'))}</button></div></div>`;
    case 'network': {
      const local = state.connection.mode === 'local';
      const form = local
        ? `<form id="network-form" class="field">${n.interfaces.length > 1 ? `<span class="select-wrap"><select id="network-select" class="input" aria-label="${escape(t('settings.interface'))}">${n.interfaces.map(i => `<option value="${escape(i.address)}" ${i.address === n.address ? 'selected' : ''}>${escape(i.name)} · ${escape(i.address)}</option>`).join('')}</select>${icon('chevron')}</span>` : ''}<span class="inline"><input id="network-address" class="input" inputmode="decimal" aria-label="${escape(t('settings.address'))}" value="${escape(n.address || '')}" placeholder="192.168.1.42" required><button class="button secondary" type="submit">${escape(t('action.apply'))}</button></span></form>`
        : `<div class="note">${icon('info')}<span>${escape(t('settings.local_only'))}</span></div>`;
      return `<div class="setting"><h3>${escape(t('settings.network'))}</h3><p>${escape(t('settings.network_text'))}</p>${form}<p class="hint">${icon('info')}<span>${escape(t('settings.port_note', { port: n.port }))}</span></p></div>`;
    }
    case 'general':
      return `<div class="setting"><label class="toggle"><input type="checkbox" id="autostart-toggle" ${state.autostart ? 'checked' : ''}><span class="toggle-text"><strong>${escape(t('settings.autostart'))}</strong><span>${escape(t('settings.autostart_text'))}</span></span></label><p class="hint">${icon('info')}<span>${escape(t('settings.open_with'))}</span></p></div>
        <div class="setting"><h3>${escape(t('settings.quit'))}</h3><p>${escape(t('settings.quit_text'))}</p><div><button class="button danger" data-action="quit-confirm">${icon('power')}${escape(t('settings.quit_button'))}</button></div></div>`;
    default:
      return `<div class="about"><img src="icon.svg" alt=""><div><strong>${escape(t('settings.version', { version: state.version }))}</strong><p>${escape(t('settings.about_text'))}</p></div></div><p class="hint">${icon('info')}<span>${escape(t('help.shortcuts.text'))}</span></p>`;
  }
}
function renderSettingsPane() {
  const pane = $('#settings-pane');
  if (!pane) return;
  pane.innerHTML = settingsPaneHtml();
  $$('[data-pane]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.pane === settingsPane)));
}
function textDialog(prefill = '') {
  show('text', t('text.title'), `<form id="text-form" class="field"><textarea id="text-input" class="input multiline" rows="6" placeholder="${escape(t('text.placeholder'))}" required>${escape(prefill)}</textarea><p class="hint">${icon('info')}<span>${escape(t('text.paste_hint'))}</span></p><div class="modal-actions"><button class="button secondary" type="button" data-close>${escape(t('action.cancel'))}</button><button class="button primary" type="submit">${icon('upload')}${escape(t('text.submit'))}</button></div></form>`);
  const input = $('#text-input'); input.focus(); input.setSelectionRange(input.value.length, input.value.length);
}
function noteDialog(id) {
  const note = (state.notes || []).find(n => n.id === id);
  if (!note) return;
  const link = isLink(note.text);
  show('note', link ? t('text.link') : t('text.kind'), `<div class="note-full">${escape(note.text)}</div><div class="modal-actions">${link ? `<a class="button secondary" href="${escape(note.text)}" target="_blank" rel="noreferrer">${icon('open')}${escape(t('text.open'))}</a>` : ''}<button class="button primary" data-copy="${note.id}">${icon('copy')}${escape(t('text.copy'))}</button></div>`);
}
function helpDialog() {
  const card = (glyph, key) => `<div class="help-card"><h3>${icon(glyph)}${escape(t(`help.${key}.title`))}</h3><p>${escape(t(`help.${key}.text`))}</p></div>`;
  show('help', t('help.title'), `<div class="help-grid">${card('scan', 'connect')}${card('upload', 'transfer')}${card('internet', 'modes')}${card('alert', 'trouble')}${card('lock', 'privacy')}${card('terminal', 'shortcuts')}</div>`, { wide: true });
}
async function copyLink() {
  if (!state?.pairUrl) return;
  try { await navigator.clipboard.writeText(state.pairUrl); toast(t('connect.link_copied')); }
  catch { show('link', t('action.copy_link'), `<p>${escape(t('connect.copy_fallback'))}</p><input id="copy-value" class="input" readonly value="${escape(state.pairUrl)}">`); $('#copy-value').select(); }
}
async function pickFiles() {
  try {
    const count = await call('pick_files');
    if (count) toast(count === 1 ? t('toast.shared_one') : t('toast.shared_other', { count }));
  } catch (error) { toast(error.message, 'error'); }
}

document.addEventListener('click', async event => {
  const el = event.target.closest('button, a[data-action]');
  if (!el || el.closest('[data-close]')) return;
  try {
    if (el.dataset.pair) {
      const dialog = $('#pair-dialog');
      el.disabled = true;
      await call('decide', { id: dialog.dataset.id, approve: el.dataset.pair === 'accept' });
      dialog.close(); await refresh();
      return;
    }
    if (el.dataset.decide) { el.disabled = true; await call('decide', { id: el.dataset.decide, approve: el.dataset.approve === 'true' }); await refresh(); return; }
    if (el.dataset.remove) { await call('remove_shared', { id: el.dataset.remove }); seen.shared.delete(el.dataset.remove); toast(t('toast.removed')); await refresh(); return; }
    if (el.dataset.copy) { const note = (state.notes || []).find(n => n.id === el.dataset.copy); if (note && await copyText(note.text)) toast(t('text.copied')); return; }
    if (el.dataset.removeNote) { await call('remove_note', { id: el.dataset.removeNote }); toast(t('toast.text_removed')); await refresh(); return; }
    if (el.dataset.open) { await call('open_file', { id: el.dataset.open }); return; }
    if (el.dataset.reveal) { await call('reveal_file', { id: el.dataset.reveal }); return; }
    if (el.dataset.themeChoice) { await setThemeChoice(el.dataset.themeChoice); $$('[data-theme-choice]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.themeChoice === themeChoice))); return; }
    if (el.dataset.pane) { settingsPane = el.dataset.pane; renderSettingsPane(); return; }
    if (el.dataset.view) { inboxView = el.dataset.view; try { localStorage.setItem('brise-inbox-view', inboxView); } catch {} renderInbox(); return; }
    if (el.dataset.preview) { lightbox(el.dataset.preview); return; }
    if (el.dataset.lightbox !== undefined) { if (el.dataset.lightbox) lightbox(el.dataset.lightbox); return; }
    if (el.dataset.wallpaper) { await call('set_wallpaper', { id: el.dataset.wallpaper }); await refresh(); renderSettingsPane(); return; }
    if (el.dataset.modeCard) { modesDialog(el.dataset.modeCard); return; }
    if (el.id === 'dropzone') { await pickFiles(); return; }
    switch (el.dataset.action) {
      case 'modes': modesDialog(); break;
      case 'settings': settingsDialog(); break;
      case 'text': textDialog(); break;
      case 'help': helpDialog(); break;
      case 'devices': devicesDialog(); break;
      case 'connect-dialog': connectDialog(); break;
      case 'copy-link': await copyLink(); break;
      case 'rotate': el.disabled = true; await call('rotate'); await refresh(); break;
      case 'folder': await call('open_folder'); break;
      case 'pick-wallpaper': el.disabled = true; if (await call('pick_wallpaper')) { await refresh(); renderSettingsPane(); } break;
      case 'remove-wallpaper': await call('remove_wallpaper'); await refresh(); renderSettingsPane(); break;
      case 'probe': el.disabled = true; await call('probe_modes'); await refresh(); modesDialog(el.dataset.mode); break;
      case 'activate': {
        const mode = el.dataset.mode;
        el.disabled = true;
        await call('select_mode', { mode, interface: $('#hotspot-interface')?.value ?? null, confirmWifiChange: $('#confirm-wifi')?.checked === true });
        closeDialog(); await refresh();
        break;
      }
      case 'quit-confirm': show('quit', t('quit.title'), `<p>${escape(t('quit.text'))}</p><div class="modal-actions"><button class="button secondary" data-close>${escape(t('quit.keep'))}</button><button class="button danger" data-action="quit">${icon('power')}${escape(t('settings.quit_button'))}</button></div>`); break;
      case 'quit': await call('quit'); break;
    }
  } catch (error) { toast(error.message, 'error'); }
  finally { el.disabled = false; }
});
document.addEventListener('dblclick', event => {
  const row = event.target.closest('[data-open-row]');
  if (row && !event.target.closest('button')) call('open_file', { id: row.dataset.openRow }).catch(error => toast(error.message, 'error'));
});
document.addEventListener('click', event => {
  const row = event.target.closest('[data-note]');
  if (row && (row.tagName === 'BUTTON' || !event.target.closest('button, a'))) noteDialog(row.dataset.note);
});
document.addEventListener('paste', event => {
  if (event.target.closest('input, textarea') || $('#dialog').open || $('#pair-dialog').open || !state) return;
  const text = event.clipboardData?.getData('text/plain')?.trim();
  if (text) { event.preventDefault(); textDialog(text); }
});
document.addEventListener('submit', async event => {
  if (event.target.id === 'text-form') {
    event.preventDefault();
    const button = event.target.querySelector('button[type=submit]'); button.disabled = true;
    try { await call('share_text', { text: $('#text-input').value }); closeDialog(); toast(t('toast.text_shared')); await refresh(); }
    catch (error) { toast(error.message, 'error'); }
    finally { button.disabled = false; }
    return;
  }
  if (event.target.id !== 'network-form') return;
  event.preventDefault();
  try { await call('set_address', { address: $('#network-address').value.trim() }); closeDialog(); toast(t('toast.address_updated')); await refresh(); }
  catch (error) { toast(error.message, 'error'); }
});
document.addEventListener('change', async event => {
  if (event.target.id === 'network-select') $('#network-address').value = event.target.value;
  if (event.target.id === 'autostart-toggle') {
    const box = event.target;
    try { box.checked = await call('set_autostart_enabled', { enabled: box.checked }); state.autostart = box.checked; }
    catch (error) { box.checked = !box.checked; toast(error.message, 'error'); }
  }
});
document.addEventListener('keydown', event => {
  if (!state) return;
  if (dialogKind === 'lightbox' && $('#dialog').open && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
    const target = $(`.lightbox-nav.${event.key === 'ArrowLeft' ? 'prev' : 'next'}`);
    if (target && !target.disabled) { event.preventDefault(); lightbox(target.dataset.lightbox); }
    return;
  }
  if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
  const key = event.key.toLowerCase();
  if (key === 'o') { event.preventDefault(); pickFiles(); }
  else if (key === 't') { event.preventDefault(); textDialog(); }
  else if (key === ',') { event.preventDefault(); settingsDialog(); }
});

document.addEventListener('DOMContentLoaded', async () => {
  $('#dialog').addEventListener('close', () => { dialogKind = null; });
  await initTheme();
  await listen('brise:changed', refresh);
  await listen('brise:drag', event => document.body.classList.toggle('dragging', event.payload === true));
  await listen('brise:shared', event => {
    const payload = event.payload || {};
    if (payload.count) toast(payload.count === 1 ? t('toast.shared_one') : t('toast.shared_other', { count: payload.count }));
    else toast(errorText(payload), 'error');
  });
  setInterval(refresh, 4000);
  await refresh();
});
