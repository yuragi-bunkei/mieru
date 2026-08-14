// desk-drawer — PCデスクの天板に引っ掛けて使う後付け引き出し
//
// 以前のスマホスタンドと同じ「天板の縁にC字フックで掛ける」固定方式。
// パーツ構成:
//   - bracket_left / bracket_right … フック付きレール（左右対称）
//   - drawer                      … 引き出し本体（45°Vリブでレールに載る）
//   - tie_bar                     … 左右レールの間隔を固定する後方の梁
//
// 実行: node generate.mjs
// 出力: stl/assembly/*.stl（組立位置） と stl/print/*.stl（印刷向き）

import Module from 'manifold-3d'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// ---------------------------------------------------------------------------
// パラメータ（mm）
// ---------------------------------------------------------------------------

export const params = {
  deskThickness: 25, // ★ 天板の厚み。必ず実測して合わせること
  gripPlay: 0.5,     // フック開口の上下あそび（きつい場合は増やす）

  hookDepth: 45,     // 天板の上に載る腕の奥行き
  hookWidth: 30,     // フック部の幅
  railLen: 170,      // 天板下レールの長さ（≦ビルド範囲）

  drawerW: 150,      // 引き出し本体の外幅
  drawerDepth: 154,  // 前面パネル背面〜本体後端
  drawerHeight: 45,  // 側壁の高さ
  wall: 2.5,         // 側壁の厚み
  bottomT: 3,        // 底の厚み

  panelW: 170,       // 前面パネルの幅（レール全体を隠す）
  panelT: 3,         // 前面パネルの厚み

  slideGap: 0.3,     // レールとリブの摺動クリアランス（垂直方向）
  buildMax: 180,     // A1 mini のビルド範囲
}

// --- 内部寸法（座標系: 天板の下面 = Z0、天板の前縁 = Y0、左右中心 = X0） ---
const T = params.deskThickness
const halfW = params.drawerW / 2            // 75  … 本体側壁の外面
const ribW = 4.5                            // Vリブの張り出し量
const ribTop = -5                           // リブ上面 = 側壁上端
const ribBot = -11                          // リブ下端（壁面側）
const webIn = halfW + ribW + 1.0            // 80.5 … レール側板の内面
const webT = 3                              // レール側板の厚み
const webOut = webIn + webT                 // 83.5
const webBot = -14                          // レール側板の下端
const flangeIn = webIn - 4                  // 76.5 … 受けフランジの内端
// リブ下面は 45°斜面: z = x - (halfW + 11)。受けフランジ上面は slideGap ぶん下の平行面。
const planeAt = (x) => x - (halfW + 11)
const upperFlange = { z0: -4, z1: -1 }      // 浮き上がり防止の上フランジ
const tieNotch = { y0: 163, y1: 166.4, depth: 10 } // タイバー用の切り欠き

// ---------------------------------------------------------------------------

const wasm = await Module()
wasm.setup()
const { Manifold } = wasm

/** min/max順不同で指定できる直方体 */
function box(x0, x1, y0, y1, z0, z1) {
  const [xa, xb] = x0 < x1 ? [x0, x1] : [x1, x0]
  const [ya, yb] = y0 < y1 ? [y0, y1] : [y1, y0]
  const [za, zb] = z0 < z1 ? [z0, z1] : [z1, z0]
  return Manifold.cube([xb - xa, yb - ya, zb - za], false).translate([xa, ya, za])
}

/** XZ断面ポリゴンをY方向 [y0,y1] に押し出す（sで左右反転） */
function extrudeXZ(pts, y0, y1, s = 1) {
  const p = pts.map(([x, z]) => [s * x, z])
  if (s < 0) p.reverse()
  return Manifold.extrude([p], y1 - y0)
    .rotate([90, 0, 0])
    .translate([0, y1, 0])
}

// --- ブラケット（s=+1で右、-1で左） --------------------------------------
function bracket(s) {
  const parts = [
    // レール側板
    box(s * webIn, s * webOut, 0, params.railLen, webBot, 0),
    // 受けフランジ（上面はリブ下面と平行な45°斜面、slideGapぶん下げる）
    extrudeXZ(
      [
        [flangeIn, webBot],
        [webIn, webBot],
        [webIn, planeAt(webIn) - params.slideGap],
        [flangeIn, planeAt(flangeIn) - params.slideGap],
      ],
      0, params.railLen, s,
    ),
    // 上フランジ（引き出しが前傾したときの浮き上がりを受ける）
    box(s * flangeIn, s * webIn, 0, params.railLen, upperFlange.z0, upperFlange.z1),
    // 前柱（側板とフックをつなぐ）
    box(s * webIn, s * webOut, -4, 0, webBot, T + 4),
    // 前面プレート（天板の縁を覆う）
    box(s * (webOut - params.hookWidth), s * webOut, -4, 0, 0, T + 4),
    // 天板上の腕
    box(s * (webOut - params.hookWidth), s * webOut, 0, params.hookDepth,
      T + params.gripPlay, T + 4),
    // 抜け落ち防止の戻り止め（フランジ斜面上の丸バンプ、強めに引くと乗り越える）
    Manifold.cylinder(6, 1.5, 1.5, 24, true)
      .rotate([0, s * 45, 0])
      .translate([s * (webIn - 2 + 0.7), 8, planeAt(webIn - 2) - params.slideGap - 1.0]),
  ]
  const solid = parts.reduce((a, b) => a.add(b))
  // タイバー用の切り欠き（側板の後方上端。フランジごと貫通させる —
  // 引き出しの可動域より後方なので摺動には影響しない）
  return solid.subtract(
    box(s * (flangeIn - 0.5), s * (webOut + 0.5), tieNotch.y0, tieNotch.y1,
      -tieNotch.depth, 1),
  )
}

// --- 引き出し本体 ----------------------------------------------------------
function drawer() {
  const D = params.drawerDepth
  const yFront = -4                      // 本体前端（ブラケット前柱の前面に一致）
  const yBack = yFront + D               // 150
  const zTop = ribTop                    // -5
  const zBot = zTop - params.drawerHeight // -50
  const halfP = params.panelW / 2

  const shell = box(-halfW, halfW, yFront, yBack, zBot, zTop).subtract(
    box(-halfW + params.wall, halfW - params.wall,
      yFront + params.wall, yBack - params.wall,
      zBot + params.bottomT, zTop + 1),
  )

  // 前面パネル（下端は本体底面と面一 → そのまま底面を下にして印刷できる）
  const panel = box(-halfP, halfP, -7, yFront, zBot, -2)

  // ハンドル（前方に張り出すリップ。下面は45°ガセットでサポートレス）
  const lip = box(-40, 40, -22, -7, -8, -2)
  const gusset = Manifold.hull([
    box(-40, 40, -7.1, -7, -23, -8),
    box(-40, 40, -22, -21.9, -8.1, -8),
  ])

  // 左右のVリブ（下面45° → 直立印刷でサポート不要）
  const ribPts = [
    [halfW, ribBot],
    [halfW + ribW, planeAt(halfW + ribW)],
    [halfW + ribW, ribTop],
    [halfW, ribTop],
  ]
  const ribR = extrudeXZ(ribPts, yFront, yBack, 1)
  const ribL = extrudeXZ(ribPts, yFront, yBack, -1)

  return [shell, panel, lip, gusset, ribR, ribL].reduce((a, b) => a.add(b))
}

// --- タイバー（後方で左右レールの間隔を固定） ------------------------------
function tieBar() {
  const y0 = tieNotch.y0 + 0.2
  const y1 = tieNotch.y1 - 0.2
  const body = box(-webOut - 3, webOut + 3, y0, y1, -tieNotch.depth + 0.2, -0.2)
  const capR = box(webOut + 0.5, webOut + 3, y0, y1, webBot, -0.2)
  const capL = box(-webOut - 3, -webOut - 0.5, y0, y1, webBot, -0.2)
  return body.add(capR).add(capL)
}

// ---------------------------------------------------------------------------
// STL書き出しと検証
// ---------------------------------------------------------------------------

function toBinaryStl(manifold) {
  const mesh = manifold.getMesh()
  const nTri = mesh.triVerts.length / 3
  const buf = Buffer.alloc(84 + nTri * 50)
  buf.write('mieru desk-drawer', 0, 'ascii')
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
  const fits = dims.every((d) => d <= params.buildMax + 1e-6)
  const vol = typeof m.volume === 'function' ? m.volume() : m.getProperties().volume
  console.log(
    `${name.padEnd(14)} ${dims.map((d) => d.toFixed(1)).join(' x ')} mm  ` +
    `vol ${(vol / 1000).toFixed(1)} cm3  genus ${m.genus()}  ` +
    (fits ? 'OK' : `*** OVER ${params.buildMax}mm ***`),
  )
  if (!fits) process.exitCode = 1
  return m
}

const here = dirname(fileURLToPath(import.meta.url))
function emit(dir, name, m) {
  mkdirSync(join(here, 'stl', dir), { recursive: true })
  writeFileSync(join(here, 'stl', dir, `${name}.stl`), toBinaryStl(m))
}

console.log(`deskThickness = ${T}mm（フック開口 ${T + params.gripPlay}mm）\n-- 組立位置 --`)
const right = report('bracket_right', bracket(1))
const left = report('bracket_left', bracket(-1))
const drw = report('drawer', drawer())
const tie = report('tie_bar', tieBar())

emit('assembly', 'bracket_right', right)
emit('assembly', 'bracket_left', left)
emit('assembly', 'drawer', drw)
emit('assembly', 'tie_bar', tie)

// 印刷向き: ブラケットは外側面を下にして横倒し、引き出しは底面、タイバーは平置き。
// 全パーツをビューで重ならない位置に並べる（スライサーでは1個ずつ配置し直す想定）
console.log('-- 印刷向き --')
const printRight = right.rotate([0, 90, 0]).translate([105, 0, webOut])
const printLeft = left.rotate([0, -90, 0]).translate([-105, 0, webOut])
const printDrawer = drw.translate([0, 0, -(ribTop - params.drawerHeight)])
const printTie = tie.rotate([90, 0, 0]).translate([0, -45 - 0.2, -tieNotch.y0 - 0.2])
report('bracket_right', printRight)
report('bracket_left', printLeft)
report('drawer', printDrawer)
report('tie_bar', printTie)
emit('print', 'bracket_right', printRight)
emit('print', 'bracket_left', printLeft)
emit('print', 'drawer', printDrawer)
emit('print', 'tie_bar', printTie)

console.log('stl/assembly/ と stl/print/ に出力しました')
