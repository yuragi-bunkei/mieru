// clamp-spacer — 幕板裏に貼るかさ上げスペーサー（木材カットサービスの代替）
//
// 市販クランプ式トレイのクランプ下顎が幕板の下端に面で当たるように、
// 幕板の裏に貼ってかさ上げするブロック。木材の 横200×奥行き40×高さ53 の代替。
//
// 全長200mmはA1 miniのビルド範囲(180mm)を超えるため、100mm×2個を
// アリ継ぎ（蟻ホゾ）で連結する。クランプ1箇所につきA+Bの1組、
// クランプ2箇所なら2組（計4個）印刷する。
//
//   spacer_a(オス) ▶◀ spacer_b(メス) → 連結して200mm
//
// 実行: node generate.mjs → stl/ に出力

import Module from 'manifold-3d'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// ---------------------------------------------------------------------------
// パラメータ（mm）
// ---------------------------------------------------------------------------

export const params = {
  totalLen: 200,   // 連結後の全長（＝木材案の「横」）
  depth: 40,       // 奥行き（幕板の裏から後方への出っ張り）
  height: 53,      // ★ 高さ。「天板の下面〜幕板の下端」の実測に合わせる
  tabDepth: 8,     // アリ継ぎの差し込み深さ
  tabRoot: 12,     // アリ継ぎの根元幅
  tabTip: 18,      // アリ継ぎの先端幅（根元より広い＝抜け止め）
  fit: 0.2,        // 継ぎ手のはめあいクリアランス（片側）
  buildMax: 180,
}

const P = params
const segLen = P.totalLen / 2

const wasm = await Module()
wasm.setup()
const { Manifold } = wasm

function box(x0, x1, y0, y1, z0, z1) {
  const [xa, xb] = x0 < x1 ? [x0, x1] : [x1, x0]
  const [ya, yb] = y0 < y1 ? [y0, y1] : [y1, y0]
  const [za, zb] = z0 < z1 ? [z0, z1] : [z1, z0]
  return Manifold.cube([xb - xa, yb - ya, zb - za], false).translate([xa, ya, za])
}

/** アリ継ぎの断面（XY平面・X+方向に差さる台形）を全高に押し出す */
function dovetail(grow) {
  const yc = P.depth / 2
  const root = P.tabRoot / 2 + grow
  const tip = P.tabTip / 2 + grow
  const poly = [
    [0, yc - root],
    [P.tabDepth + grow, yc - tip],
    [P.tabDepth + grow, yc + tip],
    [0, yc + root],
  ]
  return Manifold.extrude([poly], P.height)
}

// A: 本体 + 右端にオスのアリホゾ
const spacerA = box(0, segLen, 0, P.depth, 0, P.height)
  .add(dovetail(0).translate([segLen, 0, 0]))

// B: 本体 - 左端にメスの受け（クリアランス分大きく彫る）
const spacerB = box(0, segLen, 0, P.depth, 0, P.height)
  .subtract(dovetail(P.fit).translate([0, 0, 0]))

// ---------------------------------------------------------------------------

function toBinaryStl(manifold) {
  const mesh = manifold.getMesh()
  const nTri = mesh.triVerts.length / 3
  const buf = Buffer.alloc(84 + nTri * 50)
  buf.write('mieru clamp-spacer', 0, 'ascii')
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

function report(name, m) {
  const bb = m.boundingBox()
  const dims = [bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]]
  const fits = dims.every((d) => d <= P.buildMax + 1e-6)
  const vol = typeof m.volume === 'function' ? m.volume() : m.getProperties().volume
  console.log(
    `${name.padEnd(10)} ${dims.map((d) => d.toFixed(1)).join(' x ')} mm  ` +
    `vol ${(vol / 1000).toFixed(1)} cm3  genus ${m.genus()}  ` +
    (fits ? 'OK' : `*** OVER ${P.buildMax}mm ***`),
  )
  if (!fits) process.exitCode = 1
  return m
}

const here = dirname(fileURLToPath(import.meta.url))
mkdirSync(join(here, 'stl'), { recursive: true })

console.log(`連結後 ${P.totalLen}×${P.depth}×${P.height}mm（クランプ1箇所につきA+Bで1組）`)
const a = report('spacer_a', spacerA)
const b = report('spacer_b', spacerB)
writeFileSync(join(here, 'stl', 'spacer_a.stl'), toBinaryStl(a))
writeFileSync(join(here, 'stl', 'spacer_b.stl'), toBinaryStl(b))

// 検証: 連結状態で干渉なし・全長どおりか
const joined = a.add(b.translate([segLen, 0, 0]))
const overlap = a.intersect(b.translate([segLen, 0, 0]))
const oVol = typeof overlap.volume === 'function' ? overlap.volume() : overlap.getProperties().volume
const jb = joined.boundingBox()
console.log(`連結検証: 全長 ${(jb.max[0] - jb.min[0]).toFixed(1)}mm, 継ぎ手の干渉 ${oVol.toFixed(3)}mm3（0が正常）`)
if (oVol > 1e-6) process.exitCode = 1
console.log('stl/spacer_a.stl, stl/spacer_b.stl に出力しました')
