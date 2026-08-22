// clamp-adapter — 市販クランプ式トレイを「厚い天板＋幕板」のデスクに付けるためのアダプタ
//
// 市販のキーボードトレイ等のC字クランプ（対応厚み〜44.4mm程度）は、
// 天板が厚い・天板下に幕板/フレームがあるデスクには掛けられない。
// このアダプタは天板の上→縁の前→幕板の下端までを抱え込むC字フックで、
// 前面に厚み20mmの「疑似天板（舌）」を突き出す。市販クランプはこの舌を挟む。
//
//        ┌── 天板上の腕 ──┐
//   ═════╪═══ 天板 ════════
//    舌→ ▬▬│   ├ 幕板 ┤
//   (ここを │
//    挟む)  └─ 幕板下に回り込む ─┘
//
// 実行: node generate.mjs
// 出力: stl/assembly/（組立位置＋デスク断面の参考モデル） と stl/print/（印刷向き）
// 同じものを2個印刷して、トレイの左右クランプ位置に取り付ける。

import Module from 'manifold-3d'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// ---------------------------------------------------------------------------
// パラメータ（mm）
// ---------------------------------------------------------------------------

export const params = {
  deskT: 45,         // ★ 天板の厚み（縁での実測値）
  wrapDrop: 110,     // ★ 天板の上面から幕板の下端までの距離（実測）
  apronSetback: 0,   // ★ 幕板の前面が天板の縁からどれだけ引っ込んでいるか（実測）
  play: 0.8,         // フック開口の上下あそび

  underlap: 20,      // 幕板の下に回り込む量。0にすると前から差し込めるが保持力が落ちる
  armT: 6,           // 腕・板の厚み
  topArmLen: 90,     // 天板の上に載る腕の長さ
  width: 90,         // アダプタの幅

  tongueT: 20,       // 舌（クランプが挟む疑似天板）の厚み
  tongueDepth: 70,   // 舌の突き出し量（クランプの喉の深さより大きく）
  tongueDrop: 8,     // 天板の下面から舌の上面までの距離
  ribSpan: 78,       // 舌上面のガイドリブ内寸（クランプの顎の幅より広く）

  buildMax: 180,     // A1 mini のビルド範囲
}

// 座標系: 天板の上面 = Z0、天板の縁（前面）= Y0（デスクは Y+ 側）、幅中心 = X0
const P = params
const halfW = P.width / 2
const slotBottom = -(P.wrapDrop + P.play)      // 下腕の上面
const tongueTop = -(P.deskT + P.tongueDrop)    // 舌の上面

const wasm = await Module()
wasm.setup()
const { Manifold } = wasm

function box(x0, x1, y0, y1, z0, z1) {
  const [xa, xb] = x0 < x1 ? [x0, x1] : [x1, x0]
  const [ya, yb] = y0 < y1 ? [y0, y1] : [y1, y0]
  const [za, zb] = z0 < z1 ? [z0, z1] : [z1, z0]
  return Manifold.cube([xb - xa, yb - ya, zb - za], false).translate([xa, ya, za])
}

function adapter() {
  const parts = [
    // 天板の上に載る腕
    box(-halfW, halfW, 0, P.topArmLen, 0, P.armT),
    // 前面プレート（天板の縁〜幕板の前を覆う）
    box(-halfW, halfW, -P.armT, 0, slotBottom, P.armT),
    // 幕板の下に回り込む下腕
    box(-halfW, halfW, -P.armT, P.apronSetback + P.underlap,
      slotBottom - P.armT, slotBottom),
    // 舌（市販クランプがここを挟む）
    box(-halfW, halfW, -P.armT - P.tongueDepth, -P.armT,
      tongueTop - P.tongueT, tongueTop),
  ]
  // 舌の両端の補強リブ兼クランプ位置ガイド（前方は斜めに落とす）
  const ribT = (P.width - P.ribSpan) / 2
  for (const s of [1, -1]) {
    const x0 = s * halfW
    const x1 = s * (halfW - ribT)
    const tall = box(x0, x1, -P.armT - 20, -P.armT, tongueTop, tongueTop + 22)
    const slope = Manifold.hull([
      box(x0, x1, -P.armT - 20.1, -P.armT - 20, tongueTop, tongueTop + 22),
      box(x0, x1, -P.armT - P.tongueDepth, -P.armT - P.tongueDepth + 0.1,
        tongueTop, tongueTop + 2),
    ])
    parts.push(tall, slope)
  }
  return parts.reduce((a, b) => a.add(b))
}

// 確認用: デスク断面（天板＋幕板）の参考モデル。印刷しない
function referenceDesk() {
  const top = box(-70, 70, 0, 120, -P.deskT, 0)
  const apron = box(-70, 70, P.apronSetback, P.apronSetback + 25,
    -P.wrapDrop, -P.deskT)
  return top.add(apron)
}

// ---------------------------------------------------------------------------

function toBinaryStl(manifold) {
  const mesh = manifold.getMesh()
  const nTri = mesh.triVerts.length / 3
  const buf = Buffer.alloc(84 + nTri * 50)
  buf.write('mieru clamp-adapter', 0, 'ascii')
  buf.writeUInt32LE(nTri, 80)
  const np = mesh.numProp
  const v = (i, k) => mesh.vertProperties[i * np + k]
  let o = 84
  for (let t = 0; t < nTri; t++) {
    const [a, b, c] = [mesh.triVerts[t * 3], mesh.triVerts[t * 3 + 1], mesh.triVerts[t * 3 + 2]]
    const ux = v(b, 0) - v(a, 0), uy = v(b, 1) - v(a, 1), uz = v(b, 2) - v(a, 2)
    const wx = v(c, 0) - v(a, 0), wy = v(c, 1) - v(a, 1), wz = v(c, 2) - v(a, 2)
    let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx
    const len = Math.hypot(nx, ny, nz) || 1
    nx /= len; ny /= len; nz /= len
    buf.writeFloatLE(nx, o); buf.writeFloatLE(ny, o + 4); buf.writeFloatLE(nz, o + 8)
    o += 12
    for (const i of [a, b, c]) {
      buf.writeFloatLE(v(i, 0), o)
      buf.writeFloatLE(v(i, 1), o + 4)
      buf.writeFloatLE(v(i, 2), o + 8)
      o += 12
    }
    buf.writeUInt16LE(0, o)
    o += 2
  }
  return buf
}

function report(name, m, { checkBuild = true } = {}) {
  const bb = m.boundingBox()
  const dims = [bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]]
  const fits = dims.every((d) => d <= P.buildMax + 1e-6)
  const vol = typeof m.volume === 'function' ? m.volume() : m.getProperties().volume
  console.log(
    `${name.padEnd(16)} ${dims.map((d) => d.toFixed(1)).join(' x ')} mm  ` +
    `vol ${(vol / 1000).toFixed(1)} cm3  genus ${m.genus()}  ` +
    (!checkBuild ? '(参考)' : fits ? 'OK' : `*** OVER ${P.buildMax}mm ***`),
  )
  if (checkBuild && !fits) process.exitCode = 1
  return m
}

const here = dirname(fileURLToPath(import.meta.url))
function emit(dir, name, m) {
  mkdirSync(join(here, 'stl', dir), { recursive: true })
  writeFileSync(join(here, 'stl', dir, `${name}.stl`), toBinaryStl(m))
}

console.log(
  `deskT=${P.deskT} wrapDrop=${P.wrapDrop} setback=${P.apronSetback} ` +
  `→ フック開口 ${P.wrapDrop + P.play}mm、舌の上面は天板上面から ${-tongueTop}mm 下`,
)
const a = report('adapter', adapter())
emit('assembly', 'adapter', a)
emit('assembly', '_reference_desk', report('_reference_desk', referenceDesk(), { checkBuild: false }))

// 印刷向き: 側面を下にして横倒し（全面サポート不要・積層方向が舌の曲げに強い向き）
const printA = report('adapter(print)', a.rotate([0, 90, 0]).translate([0, 0, halfW]))
emit('print', 'adapter', printA)
console.log('stl/assembly/ と stl/print/ に出力しました（2個印刷して使用）')
