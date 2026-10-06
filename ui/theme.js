'use strict';
(() => {
  let choice = 'system';
  try { choice = localStorage.getItem('brise-theme') || 'system'; } catch {}
  const dark = choice === 'dark' || (choice === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
})();
