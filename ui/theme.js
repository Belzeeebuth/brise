'use strict';
const WALLPAPERS = {
  brume: { light: '#35718f', dark: '#86b9d2' },
  dunes: { light: '#b25a2a', dark: '#e3a373' },
  maree: { light: '#177a86', dark: '#68c9d4' },
  nuit: { light: '#5d63b0', dark: '#e3c276' },
  aurore: { light: '#bb4f74', dark: '#f29ab7' },
  prairie: { light: '#3f7f3b', dark: '#86cf80' },
  papier: { light: '#2f5aa0', dark: '#9bb9f0' },
  carreaux: { light: '#c0472e', dark: '#ff9d78' },
};
const DEFAULT_ACCENT = WALLPAPERS.brume;
function applyLook(look, dark) {
  const root = document.documentElement;
  const known = look && (WALLPAPERS[look.id] || (look.id === 'custom' && look.image));
  const id = known ? look.id : 'none';
  root.dataset.wallpaper = id;
  const url = id === 'custom' ? `url("${look.image}")` : id === 'none' ? 'none' : `url("wallpapers/${id}-${dark ? 'dark' : 'light'}.svg")`;
  root.style.setProperty('--wallpaper', url);
  const accent = (id === 'custom' && look.accent) || WALLPAPERS[id] || DEFAULT_ACCENT;
  root.style.setProperty('--accent', dark ? accent.dark : accent.light);
  root.style.setProperty('--accent-ink', dark ? '#0f1a22' : '#ffffff');
}
(() => {
  const desktop = document.documentElement.dataset.app === 'desktop';
  let choice = 'system', look = null;
  try { choice = localStorage.getItem('brise-theme') || 'system'; look = JSON.parse(localStorage.getItem('brise-look')); } catch {}
  const dark = (desktop && choice === 'dark') || ((!desktop || choice === 'system') && matchMedia('(prefers-color-scheme: dark)').matches);
  if (desktop) document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  applyLook(look || { id: 'brume' }, dark);
})();
