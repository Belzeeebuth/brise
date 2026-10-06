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
const formatSize = bytes => { if (bytes < 1000) return `${bytes} o`; const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1000)), 3); return `${(bytes / 1000 ** i).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} ${['o','Ko','Mo','Go'][i]}`; };
const formatDate = time => new Intl.DateTimeFormat('fr-FR', { day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' }).format(time);
function fileType(name) { return /\.(png|jpe?g|webp|gif|heic|avif|svg)$/i.test(name) ? 'image' : /\.(mp4|mov|mkv|webm|m4v)$/i.test(name) ? 'video' : 'file'; }
function toast(message, error = false) {
  const el = document.createElement('div'); el.className = `toast${error ? ' error' : ''}`;
  el.innerHTML = `${icon(error ? 'alert' : 'check-circle')}<span>${escape(message)}</span>`;
  $('#toasts').append(el); setTimeout(() => el.remove(), error ? 8500 : 4500);
}
function empty(title, description, glyph = 'folder') {
  return `<div class="empty-files"><span class="empty-icon">${icon(glyph)}</span><div><strong>${escape(title)}</strong><p>${escape(description)}</p></div></div>`;
}
function dialog(title, html) {
  $('#dialog-title').textContent = title; $('#dialog-body').innerHTML = html;
  if (!$('#dialog').open) $('#dialog').showModal();
}
function modeLabel(mode) { return { local: 'Réseau local', internet: 'Internet', hotspot: 'Point d’accès Wi-Fi' }[mode] || 'Réseau local'; }
function transferRow(item, caption, cancellable = false) {
  const percentage = item.size ? Math.min(100, Math.floor(item.bytes / item.size * 100)) : 0;
  return `<div class="file-row transfer-row"><span class="file-icon">${icon(item.direction === 'download' ? 'download' : 'upload')}</span><div class="transfer-body"><div class="transfer-line"><span>${escape(item.name)}</span><span>${percentage} %</span></div><progress value="${percentage}" max="100" aria-label="Progression de ${escape(item.name)}"></progress><div class="transfer-caption">${escape(caption)} · ${formatSize(item.bytes)} / ${formatSize(item.size)}</div></div>${cancellable ? `<button class="icon-button" data-cancel="${item.id}" aria-label="Annuler l’envoi de ${escape(item.name)}">${icon('x')}</button>` : ''}</div>`;
}
document.addEventListener('click', event => {
  if (event.target.closest('[data-action="close-dialog"]')) $('#dialog').close();
});
document.addEventListener('DOMContentLoaded', () => {
  icons();
  $('#dialog').addEventListener('click', event => {
    if (event.target !== $('#dialog')) return;
    const r = $('#dialog').getBoundingClientRect();
    if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) $('#dialog').close();
  });
});
