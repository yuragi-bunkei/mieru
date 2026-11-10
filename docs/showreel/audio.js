#!/usr/bin/env node
// showreel の音楽を、発振器（のこぎり波・正弦波）と乱数ノイズだけから合成して WAV に書き出す。
// 録音済みの音源（サンプル）は一切使わない。外部ライブラリも不要。
//   node audio.js <出力.wav>
// 120 BPM・1小節=2秒。場面の切り替わり（film.js の SCENES）と小節の頭が一致する。
'use strict';
const fs = require('fs');

const SR = 48000, DUR = 60, N = SR * DUR;
const BEAT = 0.5, BAR = 2, STEP = 0.125;           // 1拍・1小節・16分音符の長さ（秒）
// 起動画面の打鍵タイミング（film.js の BOOT_CMD / BOOT_T0 / BOOT_CPS と同じ値にすること）
const BOOT_CMD = '$ claude "最強の動画を作って"', BOOT_T0 = 0.35, BOOT_CPS = 16;

// ------------------------------------------------------------ 基本部品
const bus = () => ({ L: new Float32Array(N), R: new Float32Array(N) });
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
const clamp01 = (x) => Math.min(1, Math.max(0, x));
const lerp = (a, b, x) => a + (b - a) * clamp01(x);
const xlerp = (a, b, x) => a * Math.pow(b / a, clamp01(x));     // 指数補間（周波数向け）
function rng(seed) {                                             // 再現可能な乱数（mulberry32）
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const rand = rng(20261110);
const noise = () => rand() * 2 - 1;
function blep(t, dt) {                                           // のこぎり波の折り返し雑音を抑える補正
  if (t < dt) { t /= dt; return t + t - t * t - 1; }
  if (t > 1 - dt) { t = (t - 1) / dt; return t * t + t + t + 1; }
  return 0;
}
class SVF {                                                      // 状態変数フィルタ（低域/帯域/高域を同時に得る）
  constructor() { this.a = 0; this.b = 0; this.set(1000, 0.7); }
  set(fc, q) {
    const g = Math.tan(Math.PI * Math.min(Math.max(fc, 20), SR * 0.45) / SR); this.k = 1 / q;
    this.a1 = 1 / (1 + g * (g + this.k)); this.a2 = g * this.a1; this.a3 = g * this.a2;
  }
  run(x) {
    const v3 = x - this.b, v1 = this.a1 * this.a + this.a2 * v3, v2 = this.b + this.a2 * this.a + this.a3 * v3;
    this.a = 2 * v1 - this.a; this.b = 2 * v2 - this.b;
    this.bp = v1; this.hp = x - this.k * v1 - v2; this.lp = v2;
    return v2;
  }
}
const idx = (t) => Math.round(t * SR);

// ------------------------------------------------------------ 楽器
function kick(b, t0, amp) {
  const n0 = idx(t0), len = idx(0.45); let ph = 0;
  for (let i = 0; i < len && n0 + i < N; i++) {
    const t = i / SR, f = 46 + 125 * Math.exp(-t * 32);
    ph += 2 * Math.PI * f / SR;
    const env = Math.exp(-t * 7.5) * Math.min(1, t / 0.0015) * Math.min(1, (0.45 - t) / 0.02);
    const click = t < 0.004 ? noise() * 0.35 * (1 - t / 0.004) : 0;
    const s = Math.tanh((Math.sin(ph) * env + click) * 1.9) * amp;
    b.L[n0 + i] += s; b.R[n0 + i] += s;
  }
}
// ベース：のこぎり波＋正弦波を、すばやく閉じる低域フィルタに通す
function bass(b, t0, dur, midi, amp, pluck) {
  const n0 = idx(t0), len = idx(dur + 0.06), f = mtof(midi), flt = new SVF();
  let p1 = rand(), p2 = rand(), ps = 0;
  for (let i = 0; i < len && n0 + i < N; i++) {
    const t = i / SR;
    if ((i & 15) === 0) flt.set(pluck ? 130 + 1100 * Math.exp(-t * 11) : 110 + 260 * clamp01(t / 0.8), 1.3);
    const d1 = f / SR, d2 = 2 * f / SR;
    p1 += d1; if (p1 >= 1) p1 -= 1; p2 += d2; if (p2 >= 1) p2 -= 1; ps += 2 * Math.PI * f / SR;
    const raw = (2 * p1 - 1 - blep(p1, d1)) * 0.6 + (2 * p2 - 1 - blep(p2, d2)) * 0.22;
    const att = pluck ? 0.004 : 0.25;
    const env = Math.min(1, t / att) * Math.min(1, (dur + 0.06 - t) / 0.05) * (pluck ? 0.55 + 0.45 * Math.exp(-t * 6) : 1);
    const s = (flt.run(raw) + Math.sin(ps) * 0.75) * env * amp;
    b.L[n0 + i] += s; b.R[n0 + i] += s;
  }
}
// パッド：少しずつ音程をずらしたのこぎり波を重ねる（フィルタは後でバス全体にかける）
function pad(b, t0, dur, notes, amp, attack, release) {
  const n0 = idx(t0), len = idx(dur + release);
  const DET = [-13, -6, 0, 7, 14];
  for (const m of notes) {
    for (let v = 0; v < DET.length; v++) {
      const f = mtof(m + DET[v] / 100), d = f / SR; let p = rand();
      const pan = (v / (DET.length - 1)) * 2 - 1, gl = Math.sqrt(0.5 * (1 - pan * 0.8)), gr = Math.sqrt(0.5 * (1 + pan * 0.8));
      for (let i = 0; i < len && n0 + i < N; i++) {
        const t = i / SR;
        p += d; if (p >= 1) p -= 1;
        const env = Math.min(1, t / attack) * (t > dur ? Math.max(0, 1 - (t - dur) / release) : 1);
        const s = (2 * p - 1 - blep(p, d)) * env * amp * 0.11;
        b.L[n0 + i] += s * gl; b.R[n0 + i] += s * gr;
      }
    }
  }
}
// アルペジオの1音：はじくような短い音
function pluck(b, t0, midi, amp, bright, pan) {
  const n0 = idx(t0), len = idx(0.32), f = mtof(midi), d = f / SR, flt = new SVF();
  let p = rand(), p2 = rand();
  const gl = Math.sqrt(0.5 * (1 - pan)), gr = Math.sqrt(0.5 * (1 + pan));
  for (let i = 0; i < len && n0 + i < N; i++) {
    const t = i / SR;
    if ((i & 15) === 0) flt.set(350 + 5200 * bright * Math.exp(-t * 20), 1.6);
    p += d; if (p >= 1) p -= 1; p2 += d * 1.006; if (p2 >= 1) p2 -= 1;
    const raw = (2 * p - 1 - blep(p, d)) * 0.6 + (p2 < 0.5 ? 0.3 : -0.3);
    const env = Math.exp(-t * 10) * Math.min(1, t / 0.002) * Math.min(1, (0.32 - t) / 0.02);
    const s = flt.run(raw) * env * amp;
    b.L[n0 + i] += s * gl; b.R[n0 + i] += s * gr;
  }
}
// リード（主旋律）：3本ののこぎり波＋ビブラート
function lead(b, t0, dur, midi, amp) {
  const n0 = idx(t0), len = idx(dur + 0.12), flt = new SVF(), DET = [-9, 0, 9];
  const ph = DET.map(() => rand());
  for (let i = 0; i < len && n0 + i < N; i++) {
    const t = i / SR;
    const vib = 1 + 0.0045 * clamp01((t - 0.18) / 0.25) * Math.sin(2 * Math.PI * 5.6 * t);
    if ((i & 15) === 0) flt.set(900 + 3200 * (0.45 + 0.55 * Math.exp(-t * 5)), 1.1);
    let raw = 0;
    for (let v = 0; v < 3; v++) {
      const d = mtof(midi + DET[v] / 100) * vib / SR;
      ph[v] += d; if (ph[v] >= 1) ph[v] -= 1;
      raw += (2 * ph[v] - 1 - blep(ph[v], d)) * 0.33;
    }
    const env = Math.min(1, t / 0.012) * (t > dur ? Math.max(0, 1 - (t - dur) / 0.12) : 1);
    const s = flt.run(raw) * env * amp;
    b.L[n0 + i] += s; b.R[n0 + i] += s;
  }
}
// ノイズ系の打楽器（ハイハット・クラップ・スネア）
function hat(b, t0, amp, decay, pan) {
  const n0 = idx(t0), len = idx(Math.min(0.4, 6 / decay)), flt = new SVF(); flt.set(8500, 0.8);
  const gl = Math.sqrt(0.5 * (1 - pan)), gr = Math.sqrt(0.5 * (1 + pan));
  for (let i = 0; i < len && n0 + i < N; i++) {
    const t = i / SR; flt.run(noise());
    const s = flt.hp * Math.exp(-t * decay) * Math.min(1, t / 0.001) * amp;
    b.L[n0 + i] += s * gl; b.R[n0 + i] += s * gr;
  }
}
function clap(b, t0, amp) {
  const n0 = idx(t0), len = idx(0.35), fl = new SVF(), fr = new SVF(); fl.set(1500, 1.4); fr.set(1650, 1.4);
  for (let i = 0; i < len && n0 + i < N; i++) {
    const t = i / SR;
    let env = 0;
    for (const tb of [0, 0.011, 0.022]) if (t >= tb && t < tb + 0.011) env = Math.exp(-(t - tb) * 260);
    if (t >= 0.03) env = Math.exp(-(t - 0.03) * 20) * 0.9;
    fl.run(noise()); fr.run(noise());
    b.L[n0 + i] += fl.bp * env * amp; b.R[n0 + i] += fr.bp * env * amp;
  }
}
function snare(b, t0, amp, tone) {
  const n0 = idx(t0), len = idx(0.2), flt = new SVF(); flt.set(2400 * tone, 0.9); let ph = 0;
  for (let i = 0; i < len && n0 + i < N; i++) {
    const t = i / SR;
    ph += 2 * Math.PI * (175 + 70 * Math.exp(-t * 40)) * tone / SR;
    flt.run(noise());
    const s = ((flt.bp + flt.hp * 0.5) * Math.exp(-t * 30) * 0.8 + Math.sin(ph) * Math.exp(-t * 38) * 0.6) * amp * Math.min(1, t / 0.001);
    b.L[n0 + i] += s; b.R[n0 + i] += s;
  }
}
// ライザー：帯域フィルタを上げていくノイズ（盛り上がりの前に入れる）
function riser(b, t0, t1, amp) {
  const n0 = idx(t0), len = idx(t1 - t0), fl = new SVF(), fr = new SVF(); let ph = 0;
  for (let i = 0; i < len && n0 + i < N; i++) {
    const x = i / len;
    if ((i & 31) === 0) { const fc = xlerp(260, 9000, x); fl.set(fc, 2.2); fr.set(fc * 1.07, 2.2); }
    ph += 2 * Math.PI * xlerp(110, 880, x) / SR;
    const env = Math.pow(x, 2.2) * Math.min(1, (len - i) / (0.004 * SR));
    const tone = Math.sin(ph) * 0.12;
    fl.run(noise()); fr.run(noise());
    b.L[n0 + i] += (fl.bp * 0.9 + tone) * env * amp; b.R[n0 + i] += (fr.bp * 0.9 + tone) * env * amp;
  }
}
// インパクト：低い「ドン」と、長く尾を引くノイズ
function impact(b, t0, amp) {
  const n0 = idx(t0), len = idx(3.2), fl = new SVF(), fr = new SVF(); fl.set(2600, 0.7); fr.set(3000, 0.7); let ph = 0;
  for (let i = 0; i < len && n0 + i < N; i++) {
    const t = i / SR;
    ph += 2 * Math.PI * (34 + 70 * Math.exp(-t * 7)) / SR;
    const boom = Math.tanh(Math.sin(ph) * 1.6) * Math.exp(-t * 2.6) * Math.min(1, t / 0.002) * 0.9;
    fl.run(noise()); fr.run(noise());
    const ce = Math.exp(-t * 2.3) * Math.min(1, t / 0.003) * 0.28;
    const fade = Math.min(1, (3.2 - t) / 0.3);
    b.L[n0 + i] += (boom + fl.hp * ce) * amp * fade; b.R[n0 + i] += (boom + fr.hp * ce) * amp * fade;
  }
}
function blip(b, t0, freq, amp, dur, pan) {
  const n0 = idx(t0), len = idx(dur);
  const gl = Math.sqrt(0.5 * (1 - pan)), gr = Math.sqrt(0.5 * (1 + pan));
  for (let i = 0; i < len && n0 + i < N; i++) {
    const t = i / SR, env = Math.exp(-t * 5 / dur) * Math.min(1, t / 0.001) * Math.min(1, (dur - t) / 0.002);
    const s = (Math.sin(2 * Math.PI * freq * t) + 0.3 * Math.sin(4 * Math.PI * freq * t)) * env * amp;
    b.L[n0 + i] += s * gl; b.R[n0 + i] += s * gr;
  }
}

// ------------------------------------------------------------ エフェクト
function filterBus(b, cutoffAt, q) {                              // バス全体に、時間で変わる低域フィルタ
  const fl = new SVF(), fr = new SVF();
  for (let i = 0; i < N; i++) {
    if ((i & 63) === 0) { const fc = cutoffAt(i / SR); fl.set(fc, q); fr.set(fc, q); }
    b.L[i] = fl.run(b.L[i]); b.R[i] = fr.run(b.R[i]);
  }
}
function pingPong(src, time, fb, out, gain) {                     // 左右に跳ねるディレイ
  const D = idx(time), lL = new Float32Array(N), lR = new Float32Array(N); let lpL = 0, lpR = 0;
  for (let i = 0; i < N; i++) {
    const dl = i >= D ? lL[i - D] : 0, dr = i >= D ? lR[i - D] : 0;
    lpL += (dr - lpL) * 0.45; lpR += (dl - lpR) * 0.45;           // くり返すたびに少しこもらせる
    lL[i] = (src.L[i] + src.R[i]) * 0.5 + lpL * fb;
    lR[i] = lpR;
    out.L[i] += dl * gain; out.R[i] += dr * gain;
  }
}
function reverb(src, out, room, damp, gain) {                     // 残響（櫛形フィルタ8本＋オールパス4本×左右）
  const sc = SR / 44100, combT = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617], apT = [556, 441, 341, 225];
  for (let ch = 0; ch < 2; ch++) {
    const spread = ch ? 23 : 0, o = ch ? out.R : out.L;
    const combs = combT.map((t) => ({ buf: new Float32Array(Math.round((t + spread) * sc)), i: 0, st: 0 }));
    const aps = apT.map((t) => ({ buf: new Float32Array(Math.round((t + spread) * sc)), i: 0 }));
    for (let n = 0; n < N; n++) {
      const x = (src.L[n] + src.R[n]) * 0.5 * 0.03;
      let y = 0;
      for (const c of combs) {
        const v = c.buf[c.i]; c.st = v * (1 - damp) + c.st * damp; c.buf[c.i] = x + c.st * room;
        if (++c.i >= c.buf.length) c.i = 0; y += v;
      }
      for (const a of aps) {
        const v = a.buf[a.i], z = -y + v; a.buf[a.i] = y + v * 0.5;
        if (++a.i >= a.buf.length) a.i = 0; y = z;
      }
      o[n] += y * gain;
    }
  }
}
function mixInto(dst, src, gain, env) {
  for (let i = 0; i < N; i++) { const g = env ? gain * env[i] : gain; dst.L[i] += src.L[i] * g; dst.R[i] += src.R[i] * g; }
}

// ------------------------------------------------------------ 曲の設計
// 和音（パッドの構成音, ベースの根音）。イ短調： Am → F → C → G
const CH = {
  Am: { pad: [57, 60, 64, 67], bass: 33 }, F: { pad: [53, 57, 60, 64], bass: 29 },
  C: { pad: [55, 60, 64, 67], bass: 36 }, G: { pad: [55, 59, 62, 69], bass: 31 },
  E: { pad: [52, 56, 59, 62], bass: 28 },
};
const PROG = [
  'Am', 'Am',                 //  0〜 4秒  起動画面
  'Am', 'F', 'C', 'G',        //  4〜12秒  A: 粒子（ドラムなし）
  'Am', 'F', 'C', 'G',        // 12〜20秒  B: 軌道（キックが入る）
  'Am', 'F', 'C', 'G',        // 20〜28秒  C: ジュリア集合（主旋律が入る）
  'F', 'G', 'Am', 'E',        // 28〜36秒  D: マンデルバルブ（静かになって溜める）
  'Am', 'F', 'C', 'G',        // 36〜44秒  E: 風景（全部入り）
  'Am', 'F', 'C', 'E',        // 44〜52秒  E: 都市
  'Am', 'Am', 'Am', 'Am',     // 52〜60秒  結び
].map((k) => CH[k]);
const inDrums = (t) => (t >= 12 && t < 28) || (t >= 36 && t < 52);   // film.js の kickEnv と同じ区間
const GAP0 = 35.875, GAP1 = 36;                                      // 盛り上がり直前の無音

const B = { kick: bus(), bass: bus(), pad: bus(), arp: bus(), lead: bus(), perc: bus(), fx: bus(), ui: bus() };

// キックと、それに合わせて他の音を引っ込める包絡（サイドチェイン）
const duck = new Float32Array(N).fill(1);
for (let t = 0; t < DUR - 0.01; t += BEAT) {
  if (!inDrums(t)) continue;
  kick(B.kick, t, 0.95);
  const n0 = idx(t), len = idx(0.42);
  for (let i = 0; i < len && n0 + i < N; i++) { const x = i / len; duck[n0 + i] = Math.min(duck[n0 + i], 1 - 0.78 * (1 - x) * (1 - x)); }
}

// パッド
pad(B.pad, 0, 4, CH.Am.pad, 0.75, 2.6, 0.5);
for (let bar = 2; bar < 26; bar++) pad(B.pad, bar * BAR, BAR, PROG[bar].pad, 1, 0.12, 0.55);
pad(B.pad, 52, 6.6, [57, 60, 64, 67, 71], 1, 0.05, 1.2);
filterBus(B.pad, (t) => {
  if (t < 4) return lerp(280, 800, t / 4);
  if (t < 12) return xlerp(700, 2400, (t - 4) / 8);
  if (t < 20) return 2300;
  if (t < 28) return 3200;
  if (t < 36) return xlerp(380, 5200, Math.pow((t - 28) / 8, 1.4));
  if (t < 52) return 5200;
  return xlerp(4200, 320, (t - 52) / 7.5);
}, 0.9);

// ベース
for (let bar = 0; bar < 30; bar++) {
  const t0 = bar * BAR, root = PROG[bar].bass;
  if (bar < 2) { if (bar === 0) bass(B.bass, 0.3, 3.6, 33, 0.35, false); continue; }
  if (t0 >= 52) { if (bar === 26) bass(B.bass, 52, 6.5, 33, 0.4, false); continue; }
  if (!inDrums(t0)) { bass(B.bass, t0, t0 + BAR > GAP0 && t0 < GAP0 ? GAP0 - t0 - 0.02 : BAR - 0.03, root, t0 < 12 ? 0.42 : 0.4, false); continue; }
  for (let beat = 0; beat < 4; beat++) {
    const tb = t0 + beat * BEAT;
    if (t0 >= 36) { for (const k of [1, 2, 3]) bass(B.bass, tb + k * STEP, 0.085, root + (k === 2 ? 12 : 0), 0.8, true); }   // 16分で転がす
    else bass(B.bass, tb + 0.25, 0.19, root, 0.9, true);                                                                   // 裏拍
  }
}

// アルペジオ
const ARP_PAT = [0, 2, 4, 2, 1, 3, 5, 3, 0, 2, 4, 2, 1, 3, 4, 5];
for (let s = 0; s < DUR / STEP; s++) {
  const t = s * STEP; if (t < 4 || t >= 58) continue;
  if (t >= GAP0 && t < GAP1) continue;
  const ch = PROG[Math.floor(t / BAR)].pad;
  const tones = [ch[0] + 12, ch[1] + 12, ch[2] + 12, ch[3] + 12, ch[0] + 24, ch[1] + 24];
  let amp = 1, bright = 1, every = 1;
  if (t < 12) { amp = lerp(0.45, 1, (t - 4) / 8); bright = lerp(0.3, 0.85, (t - 4) / 8); }
  else if (t < 20) { bright = 1.0; }
  else if (t < 28) { bright = 1.15; }
  else if (t < 32) { amp = 0.6; bright = 0.4; every = 2; }
  else if (t < 36) { amp = lerp(0.6, 1, (t - 32) / 4); bright = lerp(0.5, 1.3, (t - 32) / 4); }
  else if (t < 52) { bright = 1.3; }
  else { amp = 0.85 * Math.exp(-(t - 52) * 0.55); bright = lerp(0.7, 0.25, (t - 52) / 6); every = 2; }
  if (s % every) continue;
  const accent = s % 4 === 0 ? 1 : 0.72;
  pluck(B.arp, t, tones[ARP_PAT[s % 16]], 0.5 * amp * accent, bright, (s % 2 ? 0.45 : -0.45));
}

// 主旋律（[拍位置, 長さ(拍), 音]）
const MEL1 = [
  [0, 1.5, 76], [1.5, 0.5, 74], [2, 1, 72], [3, 0.5, 71], [3.5, 0.5, 72],
  [4, 1.5, 69], [5.5, 0.5, 72], [6, 1, 77], [7, 1, 76],
  [8, 1.5, 79], [9.5, 0.5, 76], [10, 1, 72], [11, 0.5, 74], [11.5, 0.5, 76],
  [12, 2, 74], [14, 1, 71], [15, 1, 74],
];
const MEL2 = [
  [0, 1.5, 76], [1.5, 0.5, 74], [2, 1, 72], [3, 0.5, 76], [3.5, 0.5, 81],
  [4, 1.5, 81], [5.5, 0.5, 79], [6, 1, 77], [7, 1, 76],
  [8, 1.5, 79], [9.5, 0.5, 76], [10, 1, 84], [11, 1, 83],
  [12, 2, 83], [14, 1, 80], [15, 0.75, 83],
];
const playMel = (mel, t0, amp) => { for (const [b, d, m] of mel) lead(B.lead, t0 + b * BEAT, d * BEAT - 0.03, m, amp); };
playMel(MEL1, 20, 0.6); playMel(MEL1, 36, 1); playMel(MEL2, 44, 1);

// ハイハット・クラップ・フィル
for (let s = 0; s < DUR / STEP; s++) {
  const t = s * STEP, k = s % 4;
  if (t >= 8 && t < 12 && s % 2 === 0) hat(B.perc, t, 0.10 + 0.08 * (t - 8) / 4, 70, 0.2);
  if (inDrums(t)) {
    if (k === 2) hat(B.perc, t, 0.26, 16, -0.15);                               // 裏拍のオープンハット
    hat(B.perc, t, [0.16, 0.07, 0.0, 0.09][k] * (t < 20 ? 0.6 : 1), 80, 0.25);   // 16分のクローズドハット
    if (t >= 20 && s % 8 === 4) clap(B.perc, t, 0.55);                           // 2拍・4拍のクラップ
  }
}
const roll = (t0, t1, step, a0, a1) => { for (let t = t0; t < t1 - 1e-6; t += step) { const x = (t - t0) / (t1 - t0); snare(B.perc, t, lerp(a0, a1, x), 1 + 0.25 * x); } };
roll(11.5, 12, STEP, 0.2, 0.5); roll(19.5, 20, STEP, 0.25, 0.5); roll(27.5, 28, STEP, 0.25, 0.55); roll(43.5, 44, STEP, 0.3, 0.55);
roll(34, 35, 0.25, 0.18, 0.35); roll(35, 35.5, STEP, 0.35, 0.5); roll(35.5, GAP0, STEP / 2, 0.5, 0.75);
roll(51, 51.5, STEP, 0.3, 0.45); roll(51.5, 52, STEP / 2, 0.45, 0.7);

// 効果音：ライザー・インパクト・打鍵音
riser(B.fx, 2.2, 4, 0.5); riser(B.fx, 10, 12, 0.3); riser(B.fx, 26.5, 28, 0.22); riser(B.fx, 32, GAP0, 0.6); riser(B.fx, 50, 52, 0.4);
for (const [t, a] of [[4, 1], [12, 0.5], [20, 0.45], [28, 0.55], [36, 1], [44, 0.6], [52, 0.95]]) impact(B.fx, t, a);
for (let i = 0; i < BOOT_CMD.length; i++) {
  if (BOOT_CMD[i] === ' ') continue;
  blip(B.ui, BOOT_T0 + (i + 1) / BOOT_CPS, 1700 + 900 * rand(), 0.16, 0.022, (rand() - 0.5) * 0.5);
}
blip(B.ui, 1.95, mtof(88), 0.2, 0.16, -0.2); blip(B.ui, 2.75, mtof(93), 0.22, 0.22, 0.2);

// ------------------------------------------------------------ ミックス
const gate = new Float32Array(N).fill(1);                       // 36秒直前の「一瞬の無音」
for (let i = idx(GAP0 - 0.006); i < idx(GAP1); i++) gate[i] = Math.max(0, 1 - (i - idx(GAP0 - 0.006)) / (0.006 * SR));
const duckSoft = duck.map((d) => 0.45 + 0.55 * d);
const duckGate = duck.map((d, i) => d * gate[i]), duckSoftGate = duckSoft.map((d, i) => d * gate[i]);

const mix = bus(), sendRev = bus(), sendDly = bus();
mixInto(mix, B.kick, 0.85);
mixInto(mix, B.bass, 0.62, duckGate);
mixInto(mix, B.pad, 0.75, duckGate);
mixInto(mix, B.arp, 1.10, duckSoftGate);
mixInto(mix, B.lead, 0.42, duckSoftGate);
mixInto(mix, B.perc, 1.25, gate);
mixInto(mix, B.fx, 0.70);
mixInto(mix, B.ui, 0.9);
mixInto(sendDly, B.arp, 0.9, gate); mixInto(sendDly, B.lead, 0.45, gate); mixInto(sendDly, B.ui, 0.5);
mixInto(sendRev, B.pad, 0.5, duckGate); mixInto(sendRev, B.arp, 0.8, gate); mixInto(sendRev, B.lead, 0.5, gate);
mixInto(sendRev, B.perc, 0.5, gate); mixInto(sendRev, B.fx, 0.45); mixInto(sendRev, B.ui, 0.8);
const dly = bus(); pingPong(sendDly, 0.375, 0.42, dly, 1);       // 付点8分のディレイ
mixInto(mix, dly, 0.5); mixInto(sendRev, dly, 0.35);
reverb(sendRev, mix, 0.86, 0.3, 1.0);

// 仕上げ：やわらかく頭を抑え、最大音量をそろえ、最後をフェードアウト
const DRIVE = 0.55, PEAK = 0.78;                                // この設定で全体の音量は約 -14 LUFS になる
let peak = 0;
for (let i = 0; i < N; i++) {
  const t = i / SR, fade = Math.min(1, t / 0.01) * clamp01((59.8 - t) / 1.6);
  mix.L[i] = Math.tanh(mix.L[i] * DRIVE) * fade; mix.R[i] = Math.tanh(mix.R[i] * DRIVE) * fade;
  peak = Math.max(peak, Math.abs(mix.L[i]), Math.abs(mix.R[i]));
}
const norm = PEAK / peak;

const out = process.argv[2] || 'showreel.wav';
const data = Buffer.alloc(N * 4);
for (let i = 0; i < N; i++) {
  data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, mix.L[i] * norm)) * 32767), i * 4);
  data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, mix.R[i] * norm)) * 32767), i * 4 + 2);
}
const head = Buffer.alloc(44);
head.write('RIFF', 0); head.writeUInt32LE(36 + data.length, 4); head.write('WAVEfmt ', 8);
head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(2, 22); head.writeUInt32LE(SR, 24);
head.writeUInt32LE(SR * 4, 28); head.writeUInt16LE(4, 32); head.writeUInt16LE(16, 34);
head.write('data', 36); head.writeUInt32LE(data.length, 40);
fs.writeFileSync(out, Buffer.concat([head, data]));
console.log(`${out}: ${DUR}秒 / ${SR}Hz ステレオ / peak ${peak.toFixed(3)}`);
