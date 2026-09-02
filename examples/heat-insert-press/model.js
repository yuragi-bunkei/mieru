#!/usr/bin/env node
// ヒートインサート圧入治具 — スクリプト→STL出力（mieruで表示確認する想定）
//
//   node model.js             … 印刷用パーツ一式を stl/ に出力
//   node model.js --assembly  … 組立プレビュー1体を stl/ に出力（印刷不可・確認用）
//
// 構成:
//   frame    … ベースプレート + 角柱レール（一体）
//   carriage … 608ZZベアリング6個で角柱を転がるスリーブ。はんだごてを割りリングで保持
//   axle     … ベアリング軸（⌀8、M8ボルトでも代用可） ×4
//   cap      … 軸の抜け止めキャップ ×4
//   bushing  … 偏心ブッシュ（背面軸用、回してガタ取り） ×4
// 樹脂同士の摺動はスティックスリップ（カクつき）が出るため、案内は転がり
// （608ベアリング）とし、摺動摩擦に頼らない設計にしている。
//
// 市販部品: 608ZZベアリング ×6、M4ボルト30mm+ナット ×2（こてクランプ用）

const fs = require('node:fs')
const path = require('node:path')
const { cuboid, cylinder } = require('@jscad/modeling').primitives
const { subtract, union } = require('@jscad/modeling').booleans
const { translate, rotateY } = require('@jscad/modeling').transforms

const stlSerializer = require('@jscad/stl-serializer')

// ---- パラメータ（mm） -------------------------------------------------
const P = {
  ironDiameter: 22.0, // はんだごてのグリップ/バレル外径（要実測）
  ringWall: 4,        // クランプリングの肉厚
  slitW: 3,           // 割りスリット幅
  boltHole: 4.4,      // M4ボルト通し穴径
  nutFlats: 7.3,      // M4ナット二面幅+遊び
  nutDepth: 3.6,      // ナットポケット深さ

  baseW: 150, baseD: 130, baseT: 8, // ベースプレート
  towerW: 40, towerD: 30, towerH: 220, // 角柱レール

  brgOD: 22, brgW: 7, brgBore: 8, // 608ZZ
  axleHole: 8.3,      // 軸の通し穴径（軸⌀8.0）
  bushHole: 12.2,     // 偏心ブッシュの通し穴径（ブッシュ外径12.0）
  bushOffset: 0.75,   // 偏心量（回すと背面ベアリングが±0.75mm動く）

  carriageH: 80,      // キャリッジ高さ
  wallT: 6,           // スリーブ側壁の厚み
  padGap: 0.25,       // 横ガイドパッドと角柱側面のクリアランス
  mountHole: 4.5,     // ベース固定穴
}

// ---- 導出値 -----------------------------------------------------------
const yFace = 30                        // 角柱前面のY座標（前面ベアリングの転がり面）
const yBack = yFace + P.towerD          // 角柱背面（背面ベアリングの転がり面）
const brgR = P.brgOD / 2
const yAxleF = yFace - brgR             // 前面ベアリング軸のY（=19）
const yAxleB = yBack + brgR             // 背面ベアリング軸のY（=71）
const H = P.carriageH
const zBrg = [15, H - 15]               // ベアリング軸の高さ（キャリッジ座標）
const xBrgF = 13                        // 前面ベアリングのX位置（±）
const cavityHalfX = P.towerW / 2 + 1    // スリーブ内幅の半分（角柱+片側1mm）
const wallOuterX = cavityHalfX + P.wallT
const plateD = 6                        // 前面プレート厚（y: 0..6）
const yWallEnd = yAxleB + brgR + 2 + P.wallT // 側壁の後端
const Ri = P.ironDiameter / 2
const Ro = Ri + P.ringWall
const yC = 0 - Ro + 2                   // リング中心（前面プレートと2mm重ねて結合）

// ---- フレーム（ベース+角柱レール一体） --------------------------------
function buildFrame () {
  const base = cuboid({ size: [P.baseW, P.baseD, P.baseT], center: [0, 0, P.baseT / 2] })
  const tower = cuboid({
    size: [P.towerW, P.towerD, P.towerH],
    center: [0, yFace + P.towerD / 2, P.baseT + P.towerH / 2],
  })
  // 柱上部の周回溝: 輪ゴムをここに巻き、キャリッジ側ペグと結ぶと、
  // 未使用時にキャリッジが上で保持され、圧入時は滑らかな戻り抵抗になる。
  // 凹みなのでキャリッジを上から通すときに干渉しない
  const yMid = yFace + P.towerD / 2
  const zGroove = P.baseT + P.towerH - 18
  const grooveCut = subtract(
    cuboid({ size: [P.towerW + 2, P.towerD + 2, 8], center: [0, yMid, zGroove] }),
    cuboid({ size: [P.towerW - 6, P.towerD - 6, 10], center: [0, yMid, zGroove] }),
  )
  const mountHoles = [[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([sx, sy]) =>
    cylinder({
      radius: P.mountHole / 2, height: P.baseT + 2, segments: 32,
      center: [sx * (P.baseW / 2 - 9), sy * (P.baseD / 2 - 9), P.baseT / 2],
    }))
  return subtract(union(base, tower), grooveCut, ...mountHoles)
}

// ---- キャリッジ（ベアリングスリーブ+こてクランプ） --------------------
function buildCarriage () {
  const frontPlate = cuboid({ size: [2 * wallOuterX, plateD, H], center: [0, plateD / 2, H / 2] })
  const walls = [-1, 1].map(s => cuboid({
    size: [P.wallT, yWallEnd, H],
    center: [s * (cavityHalfX + P.wallT / 2), yWallEnd / 2, H / 2],
  }))
  const backWall = cuboid({
    size: [2 * wallOuterX, P.wallT, H],
    center: [0, yWallEnd - P.wallT / 2, H / 2],
  })
  // 横ガイドパッド: 角柱側面に軽く沿わせ、ヨー（左右の首振り）を止める
  const padT = 1 - P.padGap
  const pads = []
  for (const s of [-1, 1]) {
    for (const yc of [yFace + 8, yBack - 8]) {
      pads.push(cuboid({
        size: [padT, 6, H],
        center: [s * (cavityHalfX - padT / 2), yc, H / 2],
      }))
    }
  }
  // こてクランプ（割りリング+ボルト耳）
  const ringOuter = cylinder({ radius: Ro, height: H, segments: 96, center: [0, yC, H / 2] })
  const web = cuboid({
    size: [Math.min(2 * wallOuterX - 8, 2 * Ro), plateD - yC, H],
    center: [0, (plateD + yC) / 2, H / 2],
  })
  const earW = 10, earD = 15
  const ears = [-1, 1].map(s => cuboid({
    size: [earW, earD, H],
    center: [s * (P.slitW / 2 + earW / 2), yC - 5 - earD / 2, H / 2],
  }))
  // 輪ゴム掛けペグ（右側壁の外面、フレーム上部のペグと対になる）
  const peg = translate([wallOuterX - 2, yWallEnd / 2, H - 12],
    rotateY(Math.PI / 2, union(
      cylinder({ radius: 3, height: 10, segments: 32, center: [0, 0, 5] }),
      cylinder({ radius: 4.5, height: 2, segments: 32, center: [0, 0, 9] }),
    )))
  const solid = union(frontPlate, ...walls, backWall, ...pads, ringOuter, web, ...ears, peg)

  const bore = cylinder({ radius: Ri, height: H + 4, segments: 96, center: [0, yC, H / 2] })
  const slit = cuboid({ size: [P.slitW, 2 * Ro, H + 4], center: [0, yC - Ro, H / 2] })
  const yBolt = yC - 14.7
  const zBolt = [20, H - 20]
  const clampBolts = zBolt.map(z => translate([0, yBolt, z],
    rotateY(Math.PI / 2, cylinder({ radius: P.boltHole / 2, height: 40, segments: 32 }))))
  const nutR = P.nutFlats / Math.sqrt(3)
  const earOuterX = P.slitW / 2 + earW
  const nuts = zBolt.map(z => translate([earOuterX - P.nutDepth / 2 + 0.5, yBolt, z],
    rotateY(Math.PI / 2, cylinder({ radius: nutR, height: P.nutDepth + 1, segments: 6 }))))
  // ベアリング軸穴（前面: ⌀8軸を直接、背面: ⌀12偏心ブッシュ経由）
  const axleHoles = zBrg.map(z => translate([0, yAxleF, z],
    rotateY(Math.PI / 2, cylinder({ radius: P.axleHole / 2, height: 2 * wallOuterX + 2, segments: 48 }))))
  const bushHoles = zBrg.map(z => translate([0, yAxleB, z],
    rotateY(Math.PI / 2, cylinder({ radius: P.bushHole / 2, height: 2 * wallOuterX + 2, segments: 48 }))))
  return subtract(solid, bore, slit, ...clampBolts, ...nuts, ...axleHoles, ...bushHoles)
}

// ---- 軸・キャップ・偏心ブッシュ ---------------------------------------
function buildAxle () {
  // 頭付き⌀8軸。垂直（頭を下）に印刷。強度が欲しければM8×70ボルトで代用可
  // 長さは背面軸（偏心ブッシュのフランジ2.5mm×2を挟む）に合わせ、前後で共用
  const shaftLen = 2 * wallOuterX + 2 * 2.5 + 4
  const head = cylinder({ radius: 6, height: 3, segments: 48, center: [0, 0, 1.5] })
  const shaft = cylinder({ radius: 4.0, height: shaftLen, segments: 48, center: [0, 0, 3 + shaftLen / 2] })
  return union(head, shaft)
}

function buildCap () {
  // 軸端に押し込む抜け止め（⌀7.8貫通穴で軽圧入。軸の突き出し量に関わらず使える）
  const body = cylinder({ radius: 6, height: 8, segments: 48, center: [0, 0, 4] })
  const hole = cylinder({ radius: 3.9, height: 10, segments: 48, center: [0, 0, 4] })
  return subtract(body, hole)
}

function buildBushing () {
  // 背面軸用の偏心ブッシュ。六角フランジをつまんで回すとガタ取りできる
  const flange = cylinder({ radius: 9, height: 2.5, segments: 6, center: [0, 0, 1.25] })
  const body = cylinder({ radius: 5.95, height: P.wallT + 2.5, segments: 48, center: [0, 0, (P.wallT + 2.5) / 2] })
  const bore = cylinder({
    radius: P.axleHole / 2, height: P.wallT + 4.5, segments: 48,
    center: [P.bushOffset, 0, (P.wallT + 2.5) / 2],
  })
  return subtract(union(flange, body), bore)
}

function bearingDummy () {
  return subtract(
    rotateY(Math.PI / 2, cylinder({ radius: brgR, height: P.brgW, segments: 48 })),
    rotateY(Math.PI / 2, cylinder({ radius: P.brgBore / 2, height: P.brgW + 2, segments: 32 })),
  )
}

// ---- 出力 -------------------------------------------------------------
function writeStl (file, geom) {
  const data = stlSerializer.serialize({ binary: true }, geom)
  fs.writeFileSync(file, Buffer.concat(data.map(d => Buffer.from(d))))
  console.log('wrote', file)
}

const outDir = path.join(__dirname, 'stl')
fs.mkdirSync(outDir, { recursive: true })
for (const f of fs.readdirSync(outDir)) {
  if (f.endsWith('.stl')) fs.unlinkSync(path.join(outDir, f))
}

if (process.argv.includes('--assembly')) {
  // 組立状態のプレビュー: キャリッジをレール中程に置き、ベアリングとこてを配置
  const zC = 110
  const parts = [buildFrame(), translate([0, 0, zC], buildCarriage())]
  for (const z of zBrg) {
    for (const x of [-xBrgF, xBrgF]) parts.push(translate([x, yAxleF, zC + z], bearingDummy()))
    parts.push(translate([0, yAxleB, zC + z], bearingDummy()))
  }
  const iron = cylinder({
    radius: Ri - 0.5, height: 140, segments: 64,
    center: [0, yC, zC + H / 2 + 30],
  })
  const tip = cylinder({ radius: 2.5, height: 40, segments: 32, center: [0, yC, zC - 20] })
  writeStl(path.join(outDir, 'assembly.stl'), union(...parts, iron, tip))
} else {
  writeStl(path.join(outDir, 'frame.stl'), buildFrame())
  // 印刷用は横に並べて出力（そのまま印刷向きで自立する配置）
  writeStl(path.join(outDir, 'carriage.stl'), translate([130, 0, 0], buildCarriage()))
  const small = []
  ;[0, 1, 2, 3].forEach(i => {
    small.push(translate([-110 + i * 20, -40, 0], buildAxle()))
    small.push(translate([-110 + i * 20, -70, 0], buildCap()))
    small.push(translate([-110 + i * 20, -95, 0], buildBushing()))
  })
  writeStl(path.join(outDir, 'small-parts.stl'), union(...small))
}
