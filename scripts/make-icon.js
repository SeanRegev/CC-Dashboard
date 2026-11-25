#!/usr/bin/env node
// @ts-check
// Renders build/icon.svg to build/icon.png (1024x1024) and build/icon.ico (16..256, multi-size).
//
//   node scripts/make-icon.js       uses Playwright's headless Chromium (playwright-core, or
//                                   /opt/node-tools/node_modules/playwright as a fallback)
//   npx electron scripts/make-icon.js   uses Electron's own Chromium (works on Windows dev machines;
//                                   on Linux it needs a display, e.g. `xvfb-run -a`)
//
// No downloads: the SVG is rasterised by the local Chromium, the ICO container is written here.
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SVG = path.join(ROOT, 'build', 'icon.svg');
const PNG_OUT = path.join(ROOT, 'build', 'icon.png');
const ICO_OUT = path.join(ROOT, 'build', 'icon.ico');
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const PNG_SIZE = 1024;

/**
 * Runs in the page: rasterises the SVG at each size. Returns base64 RGBA for each ICO size and a PNG
 * data URL for each size. Kept as a string so it can go through Playwright and Electron alike.
 */
const PAGE_FN = `async ({ svg, sizes }) => {
  const img = new Image();
  img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg)));
  await img.decode();
  const out = {};
  for (const size of sizes) {
    const c = document.createElement('canvas');
    c.width = size; c.height = size;
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, size, size);
    const rgba = ctx.getImageData(0, 0, size, size).data;
    let bin = '';
    for (let i = 0; i < rgba.length; i += 0x8000) bin += String.fromCharCode.apply(null, rgba.subarray(i, i + 0x8000));
    out[size] = { rgba: btoa(bin), png: c.toDataURL('image/png') };
  }
  return out;
}`;

/** @typedef {Record<number, {rgba: string, png: string}>} Rendered */

/** @returns {Promise<Rendered>} */
async function renderWithPlaywright(svg, sizes) {
  let pw;
  try { pw = require('playwright-core'); } catch (_) {
    pw = require('/opt/node-tools/node_modules/playwright');
  }
  const browser = await pw.chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<!doctype html><html><body></body></html>');
    // eslint-disable-next-line no-new-func
    return await page.evaluate(`(${PAGE_FN})(${JSON.stringify({ svg, sizes })})`);
  } finally {
    await browser.close();
  }
}

/** @returns {Promise<Rendered>} */
async function renderWithElectron(svg, sizes) {
  // eslint-disable-next-line import/no-extraneous-dependencies
  const { app, BrowserWindow } = require('electron');
  await app.whenReady();
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html,<!doctype html><html><body></body></html>');
  const result = await win.webContents.executeJavaScript(`(${PAGE_FN})(${JSON.stringify({ svg, sizes })})`);
  win.destroy();
  return result;
}

/** A 32-bit BMP (DIB) ICO entry: BITMAPINFOHEADER, bottom-up BGRA rows, then an all-zero AND mask. */
function bmpEntry(size, rgba) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8); // XOR + AND masks
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(0, 16); // BI_RGB
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const src = (y * size + x) * 4;
      const dst = ((size - 1 - y) * size + x) * 4;
      pixels[dst] = rgba[src + 2];
      pixels[dst + 1] = rgba[src + 1];
      pixels[dst + 2] = rgba[src];
      pixels[dst + 3] = rgba[src + 3];
    }
  }
  const maskRow = Math.ceil(size / 32) * 4;
  const mask = Buffer.alloc(maskRow * size);
  header.writeUInt32LE(pixels.length + mask.length, 20);
  return Buffer.concat([header, pixels, mask]);
}

/** Builds a multi-size .ico: BMP entries below 256 px (best compatibility), PNG for 256 px. */
function buildIco(rendered, sizes) {
  const images = sizes.map((size) => size >= 256
    ? Buffer.from(rendered[size].png.split(',')[1], 'base64')
    : bmpEntry(size, Buffer.from(rendered[size].rgba, 'base64')));
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2); // icon
  head.writeUInt16LE(sizes.length, 4);
  const dir = Buffer.alloc(16 * sizes.length);
  let offset = head.length + dir.length;
  sizes.forEach((size, i) => {
    const o = i * 16;
    dir.writeUInt8(size >= 256 ? 0 : size, o);
    dir.writeUInt8(size >= 256 ? 0 : size, o + 1);
    dir.writeUInt8(0, o + 2); // palette
    dir.writeUInt8(0, o + 3);
    dir.writeUInt16LE(1, o + 4); // planes
    dir.writeUInt16LE(32, o + 6); // bpp
    dir.writeUInt32LE(images[i].length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += images[i].length;
  });
  return Buffer.concat([head, dir, ...images]);
}

async function main() {
  const svg = fs.readFileSync(SVG, 'utf8');
  const sizes = [...ICO_SIZES, PNG_SIZE];
  const inElectron = Boolean(process.versions.electron);
  const rendered = inElectron ? await renderWithElectron(svg, sizes) : await renderWithPlaywright(svg, sizes);
  fs.writeFileSync(PNG_OUT, Buffer.from(rendered[PNG_SIZE].png.split(',')[1], 'base64'));
  fs.writeFileSync(ICO_OUT, buildIco(rendered, ICO_SIZES));
  console.log(`wrote ${path.relative(ROOT, PNG_OUT)} (${PNG_SIZE}px) and ${path.relative(ROOT, ICO_OUT)} (${ICO_SIZES.join(', ')} px)`);
  if (inElectron) require('electron').app.quit();
}

main().catch((err) => {
  console.error('make-icon failed:', err);
  process.exit(1);
});
