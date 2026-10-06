'use strict';
const ICONS = {
  upload: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12',
  download: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3',
  x: 'M18 6 6 18M6 6l12 12',
  check: 'M20 6 9 17l-5-5',
  plus: 'M12 5v14M5 12h14',
  settings: 'M20 7h-9M14 17H5M17 20a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM7 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  help: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01',
  folder: 'M6 14l1.45-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.93a2 2 0 0 1 1.66.9l.82 1.2a2 2 0 0 0 1.66.9H18a2 2 0 0 1 2 2v2',
  open: 'M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6',
  phone: 'M7 2h10a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zM11 18h2',
  laptop: 'M20 16V7a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v9m16 0H4m16 0 1.28 2.55a1 1 0 0 1-.9 1.45H3.62a1 1 0 0 1-.9-1.45L4 16',
  local: 'M3 10.5 12 3l9 7.5M5 9v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9M9 14.5a4.2 4.2 0 0 1 6 0M10.8 17.2a1.6 1.6 0 0 1 2.4 0',
  internet: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z',
  hotspot: 'M4.9 16.1C1 12.2 1 5.8 4.9 1.9M7.8 13.3a6.1 6.1 0 0 1 0-8.6M16.2 4.7a6.1 6.1 0 0 1 0 8.6M19.1 1.9c3.9 3.9 3.9 10.3 0 14.2M12 11a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM8 22l4-11 4 11M9.5 18h5',
  link: 'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71',
  refresh: 'M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8M21 3v5h-5M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16M8 16H3v5',
  sun: 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41',
  moon: 'M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z',
  monitor: 'M20 3H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zM8 21h8M12 17v4',
  image: 'M19 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zM9 11a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM21 15l-3.09-3.09a2 2 0 0 0-2.82 0L6 21',
  video: 'm16 13 5.22 3.48a.5.5 0 0 0 .78-.42V7.87a.5.5 0 0 0-.75-.43L16 10.5M4 6h10a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z',
  audio: 'M9 18V5l12-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM21 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z',
  archive: 'M21 8v13H3V8M1 3h22v5H1zM10 12h4',
  document: 'M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7ZM14 2v4a2 2 0 0 0 2 2h4M16 13H8M16 17H8M10 9H8',
  file: 'M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7ZM14 2v4a2 2 0 0 0 2 2h4',
  alert: 'm21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3ZM12 9v4M12 17h.01',
  done: 'M22 11.08V12a10 10 0 1 1-5.93-9.14M22 4 12 14.01l-3-3',
  chevron: 'm6 9 6 6 6-6',
  incoming: 'M17 7 7 17M17 17H7V7',
  outgoing: 'M7 17 17 7M7 7h10v10',
  pause: 'M14 4h4v16h-4zM6 4h4v16H6z',
  power: 'M12 2v10M18.4 6.6a9 9 0 1 1-12.77.04',
  lock: 'M19 11H5a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2zM7 11V7a5 5 0 0 1 10 0v4',
  terminal: 'm4 17 6-6-6-6M12 19h8',
  scan: 'M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2M7 12h10',
  palette: 'M12 22a10 10 0 1 1 10-10c0 2.5-2 3.5-4 3.5h-2.5a2 2 0 0 0-1.5 3.3c.6.7.4 3.2-2 3.2zM7.5 10.5h.01M10.5 7h.01M15 7.5h.01M17 11h.01',
  info: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 16v-4M12 8h.01',
};
const icon = (name, extra = '') => `<svg class="icon ${extra}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${ICONS[name] || ICONS.file}"/></svg>`;
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
function icons(root = document) { root.querySelectorAll('[data-icon]').forEach(e => { e.innerHTML = icon(e.dataset.icon); }); }
function formatSize(bytes) {
  const units = t('units');
  if (bytes < 1000) return `${bytes} ${units[0]}`;
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1000)), units.length - 1);
  return `${(bytes / 1000 ** i).toLocaleString(lang, { maximumFractionDigits: bytes / 1000 ** i < 10 ? 1 : 0 })} ${units[i]}`;
}
const formatTime = time => new Intl.DateTimeFormat(lang, { hour:'numeric', minute:'2-digit' }).format(time);
function dayLabel(time) {
  const day = new Date(time); day.setHours(0, 0, 0, 0);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diff = Math.round((today - day) / 86400000);
  if (diff === 0) return t('inbox.today');
  if (diff === 1) return t('inbox.yesterday');
  return new Intl.DateTimeFormat(lang, { weekday: diff < 7 ? 'long' : undefined, day:'numeric', month:'long', year: day.getFullYear() === today.getFullYear() ? undefined : 'numeric' }).format(day);
}
function fileKind(name) {
  const ext = String(name).split('.').pop().toLowerCase();
  if (/^(png|jpe?g|webp|gif|heic|heif|avif|bmp|svg|tiff?)$/.test(ext)) return 'image';
  if (/^(mp4|mov|m4v|mkv|webm|avi|3gp)$/.test(ext)) return 'video';
  if (/^(mp3|m4a|aac|wav|flac|ogg|opus)$/.test(ext)) return 'audio';
  if (/^(zip|rar|7z|tar|gz|tgz|xz|bz2)$/.test(ext)) return 'archive';
  if (/^(pdf|docx?|odt|txt|md|rtf|xlsx?|ods|csv|pptx?|odp|pages|key|numbers|epub)$/.test(ext)) return 'document';
  return 'file';
}
function kindTile(name, extra = '') { const kind = fileKind(name); return `<span class="kind-tile kind-${kind} ${extra}">${icon(kind)}</span>`; }
function progressBar(value, label) {
  return `<progress class="progress" max="100" value="${Math.max(0, Math.min(100, Math.floor(value)))}" aria-label="${escape(label)}"></progress>`;
}
function percentOf(bytes, size) { return size ? Math.min(100, Math.floor(bytes / size * 100)) : 0; }
function toast(message, kind = 'info') {
  const el = document.createElement('div');
  el.className = `toast toast-${kind}`;
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  el.innerHTML = `${icon(kind === 'error' ? 'alert' : 'done')}<span>${escape(message)}</span>`;
  $('#toasts').append(el);
  setTimeout(() => { el.classList.add('leaving'); setTimeout(() => el.remove(), 300); }, kind === 'error' ? 7000 : 3800);
}
function openDialog(title, html, { wide = false, className = '' } = {}) {
  const dialog = $('#dialog');
  dialog.className = `modal ${wide ? 'wide' : ''} ${className}`;
  $('#dialog-title').textContent = title;
  $('#dialog-body').innerHTML = html;
  if (!dialog.open) dialog.showModal();
  return dialog;
}
function closeDialog() { if ($('#dialog').open) $('#dialog').close(); }
function emptyState(glyph, title, text) {
  return `<div class="empty"><span class="empty-art">${icon(glyph)}</span><strong>${escape(title)}</strong><p>${escape(text)}</p></div>`;
}
function breezeLines() {
  return `<svg class="breeze" viewBox="0 0 1200 400" preserveAspectRatio="none" aria-hidden="true"><path d="M-60 250 C 140 170, 300 330, 520 250 S 880 140, 1260 230"/><path d="M-60 300 C 180 230, 360 360, 600 290 S 940 210, 1260 300"/><path d="M-60 180 C 200 120, 380 240, 640 170 S 1000 90, 1260 160"/></svg>`;
}
document.addEventListener('click', event => {
  if (event.target.closest('[data-close]')) closeDialog();
});
document.addEventListener('DOMContentLoaded', () => {
  translate(); icons();
  const dialog = $('#dialog');
  dialog?.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const r = dialog.getBoundingClientRect();
    if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) dialog.close();
  });
});
document.addEventListener('error', event => {
  const img = event.target;
  if (img instanceof HTMLImageElement && img.classList.contains('thumb')) {
    const tile = document.createElement('span');
    tile.innerHTML = kindTile(img.dataset.name || '', 'thumb-fallback');
    img.replaceWith(tile.firstElementChild);
  }
}, true);
