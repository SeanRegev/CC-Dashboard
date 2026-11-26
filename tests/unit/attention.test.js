// @ts-check
'use strict';
// main/attention.js: the needs-you count on the taskbar / dock / launcher, the window flash, the
// generated badge PNG, and notification options per kind. Electron objects are faked.
const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('zlib');
const { createAttention, notificationFor, badgePng, badgeText, badgeDataUrl, crc32 } = require('../../packages/app/src/main/attention.js');

function fakeWindow({ focused = false } = {}) {
  const calls = [];
  return {
    calls,
    focused,
    isDestroyed: () => false,
    isFocused() { return this.focused; },
    setOverlayIcon: (img, desc) => calls.push(['overlay', img, desc]),
    flashFrame: (on) => calls.push(['flash', on]),
    once: (ev, fn) => calls.push(['once', ev, fn]),
  };
}
const fakeImage = { createFromDataURL: (url) => ({ url }) };

test('Windows: overlay badge with the count, flash when it goes up in the background, clear at 0', () => {
  const win = fakeWindow();
  const a = createAttention({ platform: 'win32', getWindow: () => win, app: {}, nativeImage: fakeImage });
  assert.deepEqual(a.set(2), { count: 2, flashed: true });
  const [, img, desc] = win.calls.find((c) => c[0] === 'overlay');
  assert.match(img.url, /^data:image\/png;base64,/);
  assert.equal(desc, '2 need you');
  assert.deepEqual(win.calls.filter((c) => c[0] === 'flash'), [['flash', true]]);
  // focusing the window stops the flash
  const once = win.calls.find((c) => c[0] === 'once');
  assert.equal(once[1], 'focus');
  once[2]();
  assert.deepEqual(win.calls.at(-1), ['flash', false]);
  // going down does not flash; neither does going up while the window is focused
  win.calls.length = 0;
  assert.equal(a.set(1).flashed, false);
  win.focused = true;
  assert.equal(a.set(3).flashed, false);
  assert.ok(!win.calls.some((c) => c[0] === 'flash' && c[1] === true));
  // 0 clears the badge and the flash
  win.calls.length = 0;
  a.set(0);
  assert.deepEqual(win.calls, [['overlay', null, ''], ['flash', false]]);
});

test('macOS dock badge, Linux badge count; no window is fine; bad counts become 0', () => {
  const dock = [];
  const mac = createAttention({ platform: 'darwin', getWindow: () => null, app: { dock: { setBadge: (s) => dock.push(s) } }, nativeImage: fakeImage });
  mac.set(4); mac.set(12); mac.set(0);
  assert.deepEqual(dock, ['4', '9+', '']);
  const counts = [];
  const linux = createAttention({ platform: 'linux', getWindow: () => null, app: { setBadgeCount: (n) => { counts.push(n); return false; } }, nativeImage: fakeImage });
  linux.set(3); linux.set('x'); linux.set(-5); linux.set(2.7);
  assert.deepEqual(counts, [3, 0, 0, 2]);
});

test('badge PNG: valid signature, chunks with correct CRCs, 32x32 RGBA, digits drawn', () => {
  for (const n of [1, 7, 42]) {
    const png = badgePng(n);
    assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    let off = 8;
    /** @type {Record<string, Buffer>} */
    const chunks = {};
    while (off < png.length) {
      const len = png.readUInt32BE(off);
      const type = png.subarray(off + 4, off + 8).toString('ascii');
      const data = png.subarray(off + 8, off + 8 + len);
      assert.equal(png.readUInt32BE(off + 8 + len), crc32(png.subarray(off + 4, off + 8 + len)), type);
      chunks[type] = data;
      off += 12 + len;
    }
    assert.equal(chunks.IHDR.readUInt32BE(0), 32);
    assert.equal(chunks.IHDR.readUInt32BE(4), 32);
    assert.equal(chunks.IHDR[9], 6);
    const raw = zlib.inflateSync(chunks.IDAT);
    assert.equal(raw.length, 32 * (32 * 4 + 1));
    let dark = 0;
    for (let i = 0; i < raw.length; i += 4) if (raw[i] === 0x1B && raw[i + 1] === 0x12) dark++;
    assert.ok(dark > 10, `digits drawn for ${n}`);
  }
  assert.notEqual(badgeDataUrl(1), badgeDataUrl(2));
  assert.equal(badgeText(0), '0');
  assert.equal(badgeText(9), '9');
  assert.equal(badgeText(10), '9+');
  assert.equal(crc32(Buffer.from('IEND')), 0xAE426082);
});

test('notifications: kind sets urgency; needs_you stays until dealt with; unknown kind is info', () => {
  const needs = notificationFor({ title: 'a needs you', body: 'Wants to use Bash', agentId: 'a', kind: 'needs_you' });
  assert.equal(needs.agentId, 'a');
  assert.equal(needs.kind, 'needs_you');
  assert.deepEqual(needs.options, { title: 'a needs you', body: 'Wants to use Bash', silent: false, urgency: 'critical', timeoutType: 'never' });
  // The renderer plays its own chime (Settings → Sound), so it asks for silent OS notifications.
  assert.equal(notificationFor({ title: 't', kind: 'needs_you', silent: true }).options.silent, true);
  assert.equal(notificationFor({ title: 't', silent: 'yes' }).options.silent, false, 'only a real true silences');
  assert.equal(notificationFor({ title: 't', kind: 'done' }).options.urgency, 'normal');
  const odd = notificationFor({ title: 'x'.repeat(300), kind: 'weird', agentId: 5 });
  assert.equal(odd.kind, 'info');
  assert.equal(odd.agentId, null);
  assert.equal(odd.title.length, 200);
  assert.equal(notificationFor(null).title, 'CC-Dashboard');
});
