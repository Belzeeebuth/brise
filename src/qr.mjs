import QRCode from '../vendor/qr-code/index.js';
import levels from '../vendor/qr-code/QRErrorCorrectLevel.js';

export function qrSvg(text) {
  const qr = new QRCode(-1, levels.M);
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  let path = '';
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    if (qr.isDark(y, x)) path += `M${x + 4},${y + 4}h1v1h-1z`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n + 8} ${n + 8}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><path d="${path}" fill="#101b18"/></svg>`;
}
