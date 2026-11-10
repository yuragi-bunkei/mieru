#!/usr/bin/env node
// film.html をヘッドレスChromiumで1フレームずつ描画し、PNG連番として保存する。
//   node render.js --out <dir> [--from 0] [--to 1800] [--workers 4] [--step 1]
//   node render.js --out <dir> --times 1.5,8,14      … 指定秒だけ描く（確認用）
// 必要なもの: playwright（Chromium同梱）。GPUがなくてもソフトウェア描画で動く。
'use strict';
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { chromium } = require('playwright');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}

async function main() {
  const out = arg('out');
  if (!out) { console.error('--out <dir> が必要です'); process.exit(1); }
  fs.mkdirSync(out, { recursive: true });
  const FPS = 30, TOTAL = 1800;
  let frames;
  const times = arg('times');
  if (times) frames = times.split(',').map((s) => Math.round(parseFloat(s) * FPS));
  else {
    const from = parseInt(arg('from', '0'), 10), to = parseInt(arg('to', String(TOTAL)), 10), step = parseInt(arg('step', '1'), 10);
    frames = []; for (let f = from; f < to; f += step) frames.push(f);
  }
  frames = frames.filter((f) => !fs.existsSync(path.join(out, name(f))) || arg('force'));
  const workers = Math.min(parseInt(arg('workers', '4'), 10), Math.max(1, frames.length));
  const quality = arg('quality');                     // 例: "bulb=0.5,land=0.5"（確認用の低解像度）
  const url = pathToFileURL(path.join(__dirname, 'film.html')).href;
  let next = 0, done = 0; const t0 = Date.now();
  const perScene = {};

  async function worker() {
    const browser = await chromium.launch({ args: ['--ignore-gpu-blocklist', '--disable-gpu-watchdog'] });
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
    page.on('pageerror', (e) => { console.error('page error:', e.message); process.exit(1); });
    page.on('console', (m) => { if (m.type() === 'error') console.error('console:', m.text()); });
    await page.goto(url);
    await page.evaluate(() => window.filmReady);
    if (arg('fast')) {                                // 確認用：低解像度・サブフレームなし
      await page.evaluate(() => { const F = window.FILM; F.QUALITY.bulb = F.QUALITY.land = F.QUALITY.city = 0.4; F.subframeScale = 0.3; });
    }
    if (quality) {
      await page.evaluate((q) => { for (const kv of q.split(',')) { const [k, v] = kv.split('='); window.FILM.QUALITY[k] = parseFloat(v); } }, quality);
    }
    while (next < frames.length) {
      const f = frames[next++];
      const ts = Date.now();
      const b64 = await page.evaluate(async (frame) => {
        window.renderFrame(frame);
        const blob = await new Promise((r) => document.getElementById('gl').toBlob(r, 'image/png'));
        const buf = new Uint8Array(await blob.arrayBuffer());
        let s = ''; const CH = 0x8000;
        for (let i = 0; i < buf.length; i += CH) s += String.fromCharCode.apply(null, buf.subarray(i, i + CH));
        return btoa(s);
      }, f);
      const tmp = path.join(out, name(f) + '.tmp');
      fs.writeFileSync(tmp, Buffer.from(b64, 'base64'));
      fs.renameSync(tmp, path.join(out, name(f)));
      const sec = Math.floor(f / FPS / 4);
      (perScene[sec] = perScene[sec] || []).push((Date.now() - ts) / 1000);
      done++;
      if (done % 20 === 0 || done === frames.length) {
        const el = (Date.now() - t0) / 1000;
        console.log(`${done}/${frames.length} frames  ${el.toFixed(0)}s  (${(el / done).toFixed(2)} s/frame, 残り約${((frames.length - done) * el / done / 60).toFixed(1)}分)`);
      }
    }
    await browser.close();
  }
  await Promise.all(Array.from({ length: workers }, worker));
  if (arg('timing')) {
    for (const k of Object.keys(perScene)) {
      const a = perScene[k]; console.log(`t=${k * 4}s〜: 平均 ${(a.reduce((x, y) => x + y, 0) / a.length).toFixed(2)} s/frame`);
    }
  }
}
function name(f) { return `f${String(f).padStart(5, '0')}.png`; }

main().catch((e) => { console.error(e); process.exit(1); });
