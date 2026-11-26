// @ts-check
'use strict';
/**
 * Getting the user's attention: native notifications (click → focus the window and open the agent),
 * and how many agents need you: the Windows taskbar overlay badge, the macOS dock badge, the Linux
 * launcher count, and a window flash when the count goes up while the window is in the background.
 * Owner: the Approvals track. IPC: cc:notify { title, body, agentId?, kind? }, cc:setAttention { count }.
 *
 * Everything except register() is pure or takes its Electron objects as arguments (unit-tested).
 */
const zlib = require('zlib');

// ---- the badge: a small PNG drawn here (no image files, no native deps) ----

/** 3×5 pixel digits and "+". */
const GLYPHS = /** @type {Record<string, string[]>} */ ({
  0: ['111', '101', '101', '101', '111'], 1: ['010', '110', '010', '010', '111'], 2: ['111', '001', '111', '100', '111'],
  3: ['111', '001', '111', '001', '111'], 4: ['101', '101', '111', '001', '001'], 5: ['111', '100', '111', '001', '111'],
  6: ['111', '100', '111', '101', '111'], 7: ['111', '001', '001', '001', '001'], 8: ['111', '101', '111', '101', '111'],
  9: ['111', '101', '111', '001', '111'], '+': ['000', '010', '111', '010', '000'],
});

let crcTable = /** @type {Int32Array|null} */ (null);
/** @param {Buffer} buf */
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let c = -1;
  for (const b of buf) c = crcTable[(c ^ b) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** @param {string} type @param {Buffer} data */
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** The text on the badge: "1".."9", then "9+". @param {number} count */
function badgeText(count) {
  return count > 9 ? '9+' : String(Math.max(0, Math.floor(count)));
}

/**
 * A round amber badge with the count, as a PNG (RGBA).
 * @param {number} count @param {number} [size] pixels (square)
 * @returns {Buffer}
 */
function badgePng(count, size = 32) {
  const text = badgeText(count);
  const px = Buffer.alloc(size * size * 4);
  const r = size / 2;
  // Disc with a soft (anti-aliased) edge.
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x + 0.5 - r, y + 0.5 - r);
      const a = Math.max(0, Math.min(1, r - d));
      const i = (y * size + x) * 4;
      px[i] = 0xF0; px[i + 1] = 0xB4; px[i + 2] = 0x4C; px[i + 3] = Math.round(a * 255);
    }
  }
  // Digits, scaled to fit, centred.
  const cols = text.length * 3 + (text.length - 1);
  const scale = Math.max(1, Math.floor(Math.min((size * 0.7) / cols, (size * 0.62) / 5)));
  const x0 = Math.round((size - cols * scale) / 2);
  const y0 = Math.round((size - 5 * scale) / 2);
  [...text].forEach((ch, n) => {
    const g = GLYPHS[ch];
    for (let gy = 0; gy < 5; gy++) {
      for (let gx = 0; gx < 3; gx++) {
        if (g[gy][gx] !== '1') continue;
        for (let sy = 0; sy < scale; sy++) {
          for (let sx = 0; sx < scale; sx++) {
            const x = x0 + (n * 4 + gx) * scale + sx;
            const y = y0 + gy * scale + sy;
            if (x < 0 || y < 0 || x >= size || y >= size) continue;
            const i = (y * size + x) * 4;
            px[i] = 0x1B; px[i + 1] = 0x12; px[i + 2] = 0x10; px[i + 3] = 255;
          }
        }
      }
    }
  });
  // PNG: each row starts with filter type 0.
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** @param {number} count */
const badgeDataUrl = (count) => `data:image/png;base64,${badgePng(count).toString('base64')}`;

// ---- the count ----

/**
 * @param {{platform: string, getWindow: () => any, app: any, nativeImage: any}} deps
 * @returns {{set: (count: any) => {count: number, flashed: boolean}, count: () => number}}
 */
function createAttention(deps) {
  const { platform, getWindow, app, nativeImage } = deps;
  let last = 0;
  return {
    count: () => last,
    set(raw) {
      const n = Number(raw);
      const count = Number.isFinite(n) ? Math.max(0, Math.min(9999, Math.floor(n))) : 0;
      const wentUp = count > last;
      last = count;
      const w = getWindow();
      const win = w && !(typeof w.isDestroyed === 'function' && w.isDestroyed()) ? w : null;
      try {
        if (platform === 'win32') {
          if (win) win.setOverlayIcon(count ? nativeImage.createFromDataURL(badgeDataUrl(count)) : null, count ? `${count} need${count === 1 ? 's' : ''} you` : '');
        } else if (platform === 'darwin') {
          if (app && app.dock) app.dock.setBadge(count ? badgeText(count) : '');
        } else if (app && typeof app.setBadgeCount === 'function') {
          app.setBadgeCount(count); // Unity-style launchers; false elsewhere
        }
      } catch { /* a badge is a nicety */ }
      let flashed = false;
      if (win) {
        try {
          if (count === 0) {
            win.flashFrame(false);
          } else if (wentUp && !win.isFocused()) {
            win.flashFrame(true);
            flashed = true;
            if (typeof win.once === 'function') win.once('focus', () => { try { win.flashFrame(false); } catch { /* closed */ } });
          }
        } catch { /* window closing */ }
      }
      return { count, flashed };
    },
  };
}

/**
 * Notification options for a notify event. needs_you stays on screen until dealt with.
 * @param {any} msg @returns {{title: string, body: string, agentId: string|null, kind: string, options: Record<string, any>}}
 */
function notificationFor(msg) {
  const title = String((msg && msg.title) || 'CC-Dashboard').slice(0, 200);
  const body = String((msg && msg.body) || '').slice(0, 500);
  const agentId = msg && typeof msg.agentId === 'string' ? msg.agentId : null;
  const kind = msg && ['needs_you', 'done', 'exited', 'info'].includes(msg.kind) ? msg.kind : 'info';
  /** @type {Record<string, any>} */
  // The app plays its own chime when Settings → Sound is on, so the renderer asks for silent notifications;
  // otherwise Sound off would still beep, and Sound on would beep twice.
  const options = { title, body, silent: msg && msg.silent === true };
  if (kind === 'needs_you') { options.urgency = 'critical'; options.timeoutType = 'never'; }
  else if (kind === 'done') options.urgency = 'normal';
  else options.urgency = 'low';
  return { title, body, agentId, kind, options };
}

/** @param {{ipcMain: Electron.IpcMain, Notification: typeof Electron.Notification, getWindow: () => Electron.BrowserWindow|null, focusWindow: () => void, app?: any, nativeImage?: any}} deps */
function register(deps) {
  const { ipcMain, Notification, getWindow, focusWindow } = deps;
  const electron = deps.app && deps.nativeImage ? null : require('electron');
  const attention = createAttention({
    platform: process.platform, getWindow,
    app: deps.app || (electron && electron.app), nativeImage: deps.nativeImage || (electron && electron.nativeImage),
  });
  /** Keep shown notifications referenced, or they can be garbage-collected before a click. */
  const live = new Set();

  ipcMain.handle('cc:notify', (_e, /** @type {any} */ msg) => {
    if (!Notification.isSupported()) return false;
    const { agentId, options } = notificationFor(msg);
    const n = new Notification(options);
    live.add(n);
    n.on('click', () => {
      focusWindow();
      const win = getWindow();
      if (agentId && win) win.webContents.send('cc:select-agent', agentId);
      live.delete(n);
    });
    n.on('close', () => live.delete(n));
    n.show();
    return true;
  });

  ipcMain.handle('cc:setAttention', (_e, /** @type {any} */ msg) => attention.set(msg && msg.count).count);
}

module.exports = { register, createAttention, notificationFor, badgePng, badgeText, badgeDataUrl, crc32 };
