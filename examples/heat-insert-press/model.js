#!/usr/bin/env node
// ヒートインサート圧入治具 — スクリプト→STL出力（mieruで表示確認する想定）
//
//   node model.js             … 印刷用パーツ一式を stl/ に出力
//   node model.js --assembly  … 組立プレビュー1体を stl/ に出力（印刷不可・確認用）
//
// 構成:
//   base     … ベースプレート（柱を受けるポケット付き。柱は裏からM3ねじ4本で固定）
//   tower    … 角柱レール（横倒しで印刷。転がり面が側壁になり積層線が進行方向に沿う）
//   carriage … 608ZZベアリング6個で角柱を転がるスリーブ。はんだごてを割りリングで保持
//   axle     … ベアリング軸（⌀7.85、M8ボルトでも代用可） ×4
//   cap      … 軸の抜け止めキャップ ×4
//   bushing  … 偏心ブッシュ（背面軸用、回してガタ取り） ×4
//   spacer   … ベアリングの軸方向位置決め管 ×10
//   knob     … こてクランプ用ツマミ（なべ頭M3を内蔵、工具なしで着脱） ×2
// 樹脂同士の摺動はスティックスリップ（カクつき）が出るため、案内は転がり
// （608ベアリング）とし、摺動摩擦に頼らない設計にしている。
//
// 対象プリンタ: Bambu A1 mini（180×180×180）。柱は横倒しで168mm（ペグ込み178mm）。
// こては YIHUA 928D-III（2026-09-02 実測: グリップ最太部⌀22、直胴47.5mm、
// その先5mmに操作ボタン）。リング高さ40mmは直胴区間に収めるための上限。
// 締結はすべて M3×20ねじ + 熱圧入インサート（下穴φ4.6×6.0の較正標準値。
// 水平穴は垂れる分を見てφ4.7）
//
// 市販部品: 608ZZベアリング ×6、M3×20なべ小ねじ ×6、M3インサート(外径5.0×L4.0) ×6

const fs = require('node:fs')
const path = require('node:path')
const { cuboid, cylinder } = require('@jscad/modeling').primitives
const { subtract, union } = require('@jscad/modeling').booleans
const { translate, rotateY } = require('@jscad/modeling').transforms

const stlSerializer = require('@jscad/stl-serializer')

// ---- パラメータ（mm） -------------------------------------------------
const P = {
  ironDiameter: 22.2,      // 928D-III グリップ最太部（ゴム部。実測22.0〜22.2の最大値、2026-09-02）
  ironFrontDiameter: 22.2, // 前方プラスチック部の直径（実測でゴム部と同じ22.0〜22.2。段付きなし）
  frontLen: 15,            // リング下端から前方プラ部が占める長さ（47.5−32.6）
  clampClear: 0.3,         // ボアの片側クリアランス（挿入用。割りを締めて詰める）
  ringWall: 4,             // クランプリングの肉厚
  ringH: 40,               // リング高さ（直胴47.5mm・ボタン手前5mmに収める上限）
  slitW: 3,                // 割りスリット幅
  screwClear: 3.4,         // M3通し穴径（較正標準のバカ穴）
  insertPilot: 4.6,        // M3インサート下穴径（垂直穴・較正標準）
  insertPilotH: 4.7,       // 同・水平穴（印刷で上側が垂れる分を足す）
  insertDepth: 6.0,        // インサート下穴深さ（較正標準）
  headCbore: 6.5,          // なべ頭の座繰り径（ベース裏。頭が直接座る）
  headCboreD: 4,           // 座繰り深さ
  knobStemHole: 9.2,       // クランプ左耳の座繰り径（ツマミの軸⌀8.5を受ける。水平穴なので0.35/側）
  knobD: 20, knobT: 5,     // ツマミ円盤の径・厚み
  knobStemD: 8.5,          // ツマミ軸の径（座繰り深さ4mmぶん入る）
  headPocketD: 5.9,        // なべ頭M3（⌀5.5×高さ2.0）の袋穴径
  headPocketDepth: 2.6,    // 袋穴深さ（頭2.0 + プラス溝に入る突起の余地）

  baseW: 150, baseD: 130, baseT: 10, // ベースプレート
  pocketD: 2, pocketClear: 0.3,      // 柱を受けるポケットの深さ・片側クリアランス
  towerW: 40, towerD: 30, towerH: 168, // 角柱レール（横倒し印刷。天面ペグ10mm込みで178≤180）
  towerScrewX: 12, towerScrewY: 7,   // 柱下端面のインサート位置（±）

  brgOD: 22, brgW: 7, brgBore: 8, // 608ZZ
  axleD: 7.85,        // 軸径（608内径8.000に入る印刷寸法）
  axleHole: 8.3,      // 軸の通し穴径（静止嵌合）
  capHole: 7.6,       // キャップの圧入穴径
  bushHole: 12.6,     // 偏心ブッシュの通し穴径（ブッシュ外径11.9、回すので片側0.35）
  bushOffset: 0.75,   // 偏心量（回すと背面ベアリングが±0.75mm動く）
  spacerOD: 11,       // スペーサー管の外径（608内輪だけに当たる）

  carriageH: 80,      // キャリッジ高さ
  wallT: 6,           // スリーブ側壁の厚み
  padGap: 0.25,       // 横ガイドパッドと角柱側面のクリアランス
  mountHole: 4.5,     // ベース固定穴
}

// ---- 導出値 -----------------------------------------------------------
const yFace = 30                        // 角柱前面のY座標（前面ベアリングの転がり面）
const yBack = yFace + P.towerD          // 角柱背面（背面ベアリングの転がり面）
const yMid = yFace + P.towerD / 2
const zTower0 = P.baseT - P.pocketD     // 柱下端のZ（ポケット底）
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
const Ri = P.ironDiameter / 2 + P.clampClear
const RiFront = P.ironFrontDiameter / 2 + P.clampClear
const Ro = Ri + P.ringWall
const yC = 0 - Ro + 2                   // リング中心（前面プレートと2mm重ねて結合）
const RH = P.ringH
const zRing0 = H - RH                   // リングはキャリッジ上端揃え（ワーク高さの余裕が最大になる）
const bushFlange = 2.5
const flangeIn = 2.5                    // ブッシュ胴のスリーブ内への突き出し

// ---- ベース（柱ポケット + 裏からのねじ止め） --------------------------
function buildBase () {
  const base = cuboid({ size: [P.baseW, P.baseD, P.baseT], center: [0, 0, P.baseT / 2] })
  const pocket = cuboid({
    size: [P.towerW + 2 * P.pocketClear, P.towerD + 2 * P.pocketClear, P.pocketD + 1],
    center: [0, yMid, P.baseT - P.pocketD / 2 + 0.5],
  })
  const mountHoles = [[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([sx, sy]) =>
    cylinder({
      radius: P.mountHole / 2, height: P.baseT + 2, segments: 32,
      center: [sx * (P.baseW / 2 - 9), sy * (P.baseD / 2 - 9), P.baseT / 2],
    }))
  // 柱固定ねじ: 裏面から座繰り（頭を沈めてベースが平らに据わる）+ バカ穴
  const towerScrews = []
  for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    const x = sx * P.towerScrewX, y = yMid + sy * P.towerScrewY
    towerScrews.push(cylinder({ radius: P.screwClear / 2, height: P.baseT + 2, segments: 32, center: [x, y, P.baseT / 2] }))
    towerScrews.push(cylinder({ radius: P.headCbore / 2, height: P.headCboreD + 1, segments: 32, center: [x, y, P.headCboreD / 2 - 0.5] }))
  }
  return subtract(base, pocket, ...mountHoles, ...towerScrews)
}

// ---- 角柱レール（ローカル座標: 断面中心が原点、z: 0..towerH 直立） -------
function buildTower () {
  const body = cuboid({ size: [P.towerW, P.towerD, P.towerH], center: [0, 0, P.towerH / 2] })
  // 下端面のインサート下穴 + ねじ先端の逃げ
  // M3×20: 頭は座繰り底(z=4)、柱下端はポケット底(z=8) → 柱へ 20−(8−4) = 16mm 侵入
  const reliefD = 20 - (P.baseT - P.headCboreD - P.pocketD) + 1
  const holes = []
  for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    const x = sx * P.towerScrewX, y = sy * P.towerScrewY
    holes.push(cylinder({ radius: P.insertPilotH / 2, height: P.insertDepth + 1, segments: 32, center: [x, y, P.insertDepth / 2 - 0.5] }))
    holes.push(cylinder({ radius: P.screwClear / 2, height: reliefD + 1, segments: 32, center: [x, y, reliefD / 2 - 0.5] }))
  }
  // 天面の輪ゴム掛けペグ: 走行路（前後面）の外なのでベアリングと干渉しない。
  // 輪ゴムは待機時のパーキング専用（圧入は自重で行う）
  const peg = translate([P.towerScrewX, 0, P.towerH], union(
    cylinder({ radius: 3, height: 8, segments: 32, center: [0, 0, 4] }),
    cylinder({ radius: 4.5, height: 2, segments: 32, center: [0, 0, 9] }),
  ))
  return union(subtract(body, ...holes), peg)
}

// 印刷向き: X面（30mm幅の面）を下にして横倒し。前後の転がり面が側壁になる
function towerForPrint () {
  return translate([0, 0, P.towerW / 2], rotateY(Math.PI / 2, buildTower()))
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
  // こてクランプ（割りリング+ねじ耳）。キャリッジ上端に高さRH
  const zRc = zRing0 + RH / 2
  const ringOuter = cylinder({ radius: Ro, height: RH, segments: 96, center: [0, yC, zRc] })
  const web = cuboid({
    size: [Math.min(2 * wallOuterX - 8, 2 * Ro), plateD - yC, RH],
    center: [0, (plateD + yC) / 2, zRc],
  })
  const earW = 10, earD = 20             // 耳の奥行き20: ⌀9.2座繰りの前後に4mm以上の肉を残す
  const ears = [-1, 1].map(s => cuboid({
    size: [earW, earD, RH],
    center: [s * (P.slitW / 2 + earW / 2), yC - 5 - earD / 2, zRc],
  }))
  // 輪ゴム掛けペグ（右側壁の外面・下寄り。柱天面のペグから吊る）
  const peg = translate([wallOuterX - 2, yWallEnd / 2, 20],
    rotateY(Math.PI / 2, union(
      cylinder({ radius: 3, height: 10, segments: 32, center: [0, 0, 5] }),
      cylinder({ radius: 4.5, height: 2, segments: 32, center: [0, 0, 9] }),
    )))
  const solid = union(frontPlate, ...walls, backWall, ...pads, ringOuter, web, ...ears, peg)

  // ボア: 上側（ゴム部）と下側（前方プラ部）で径を分ける。同径なら1本の穴と同じ
  const boreTop = cylinder({ radius: Ri, height: RH - P.frontLen + 2, segments: 96, center: [0, yC, zRing0 + P.frontLen + (RH - P.frontLen) / 2 + 1] })
  const boreFront = cylinder({ radius: RiFront, height: P.frontLen + 2, segments: 96, center: [0, yC, zRing0 + P.frontLen / 2 - 1] })
  const slit = cuboid({ size: [P.slitW, 2 * Ro, RH + 4], center: [0, yC - Ro, zRc] })
  // M3×20 + 熱圧入インサート: -X耳=座繰り+バカ穴、+X耳=外面からインサート下穴。
  // 座繰り4mmにツマミの軸（頭を内蔵）が入り、頭は座繰り底に座る。
  // ねじ先端がインサート(+X耳外面側の4mm)を全長掴む
  const yBolt = yC - 16                  // 座繰りがボアに抜けず、耳の前縁にも肉が残る位置
  const zBolt = [zRing0 + 10, zRing0 + RH - 10]
  const earOuterX = P.slitW / 2 + earW
  const clampBolts = zBolt.map(z => translate([0, yBolt, z],
    rotateY(Math.PI / 2, cylinder({ radius: P.screwClear / 2, height: 40, segments: 32 }))))
  const cbores = zBolt.map(z => translate([-earOuterX + P.headCboreD / 2 - 0.5, yBolt, z],
    rotateY(Math.PI / 2, cylinder({ radius: P.knobStemHole / 2, height: P.headCboreD + 1, segments: 48 }))))
  const pilots = zBolt.map(z => translate([earOuterX - P.insertDepth / 2 + 0.5, yBolt, z],
    rotateY(Math.PI / 2, cylinder({ radius: P.insertPilotH / 2, height: P.insertDepth + 1, segments: 32 }))))
  // ベアリング軸穴（前面: ⌀8軸を直接、背面: ⌀12偏心ブッシュ経由）
  const axleHoles = zBrg.map(z => translate([0, yAxleF, z],
    rotateY(Math.PI / 2, cylinder({ radius: P.axleHole / 2, height: 2 * wallOuterX + 2, segments: 48 }))))
  const bushHoles = zBrg.map(z => translate([0, yAxleB, z],
    rotateY(Math.PI / 2, cylinder({ radius: P.bushHole / 2, height: 2 * wallOuterX + 2, segments: 48 }))))
  return subtract(solid, boreTop, boreFront, slit, ...clampBolts, ...cbores, ...pilots, ...axleHoles, ...bushHoles)
}

// ---- 軸・キャップ・偏心ブッシュ・スペーサー ---------------------------
function buildAxle () {
  // 頭付き軸。垂直（頭を下）に印刷。強度が欲しければM8×70ボルトで代用可
  // 長さは背面軸（偏心ブッシュのフランジ2.5mm×2を挟む）に合わせ、前後で共用
  const shaftLen = 2 * wallOuterX + 2 * bushFlange + 4
  const head = cylinder({ radius: 6, height: 3, segments: 48, center: [0, 0, 1.5] })
  const shaft = cylinder({ radius: P.axleD / 2, height: shaftLen, segments: 48, center: [0, 0, 3 + shaftLen / 2] })
  return union(head, shaft)
}

function buildCap () {
  // 軸端に押し込む抜け止め（貫通穴で軽圧入。軸の突き出し量に関わらず使える）
  const body = cylinder({ radius: 6, height: 8, segments: 48, center: [0, 0, 4] })
  const hole = cylinder({ radius: P.capHole / 2, height: 10, segments: 48, center: [0, 0, 4] })
  return subtract(body, hole)
}

function buildBushing () {
  // 背面軸用の偏心ブッシュ。六角フランジをつまんで回すとガタ取りできる。
  // フランジの切り欠きが偏心方向（穴がずれている側）。左右の壁で同じ向きに揃える
  const flange = cylinder({ radius: 9, height: bushFlange, segments: 6, center: [0, 0, bushFlange / 2] })
  const bodyH = P.wallT + flangeIn
  const body = cylinder({ radius: 5.95, height: bodyH, segments: 48, center: [0, 0, bodyH / 2] })
  const bore = cylinder({
    radius: P.axleHole / 2, height: bodyH + 2, segments: 48,
    center: [P.bushOffset, 0, bodyH / 2],
  })
  const mark = cylinder({ radius: 1.2, height: bushFlange + 2, segments: 24, center: [9, 0, bushFlange / 2] })
  return subtract(union(flange, body), bore, mark)
}

function buildKnob () {
  // こてクランプ用ツマミ。なべ頭M3を軸先端の袋穴に収め、底の「+」突起がプラス溝に
  // 噛んで回転を伝える（貫通穴なし。頭は耳の座繰り底に直接座る）。
  // 円盤を下にして印刷すると袋穴が上を向き、突起はサポートなしで立つ
  const stemH = P.headCboreD
  const disc = cylinder({ radius: P.knobD / 2, height: P.knobT, segments: 96, center: [0, 0, P.knobT / 2] })
  const stem = cylinder({ radius: P.knobStemD / 2, height: stemH + 0.5, segments: 64, center: [0, 0, P.knobT + (stemH + 0.5) / 2 - 0.5] })
  const scallops = Array.from({ length: 6 }, (_, i) => {
    const a = (i / 6) * 2 * Math.PI
    return cylinder({ radius: 3, height: P.knobT + 2, segments: 32, center: [Math.cos(a) * (P.knobD / 2 + 1.5), Math.sin(a) * (P.knobD / 2 + 1.5), P.knobT / 2] })
  })
  const zTop = P.knobT + stemH
  const pocket = cylinder({ radius: P.headPocketD / 2, height: P.headPocketDepth + 1, segments: 48, center: [0, 0, zTop - P.headPocketDepth / 2 + 0.5] })
  const ridgeZ = zTop - P.headPocketDepth
  const ridge = union(
    cuboid({ size: [3.2, 0.9, 1.0], center: [0, 0, ridgeZ + 0.5] }),
    cuboid({ size: [0.9, 3.2, 1.0], center: [0, 0, ridgeZ + 0.5] }),
  )
  return union(subtract(union(disc, stem), ...scallops, pocket), ridge)
}

function buildSpacer (len) {
  const body = cylinder({ radius: P.spacerOD / 2, height: len, segments: 48, center: [0, 0, len / 2] })
  const hole = cylinder({ radius: P.axleHole / 2, height: len + 2, segments: 48, center: [0, 0, len / 2] })
  return subtract(body, hole)
}

// スペーサー長: 前面=壁内面〜ベアリング / ベアリング間、背面=ブッシュ突き出し〜ベアリング。
// 部品列の合計がスリーブ内幅と同じだと組めない（遊びゼロ＋印刷縮み）ので、
// 壁側のスペーサーを片側 axialSlack/2 ずつ短くして計 axialSlack の遊びを作る
const axialSlack = 1.0
const spacerFrontOuter = cavityHalfX - (xBrgF + P.brgW / 2) - axialSlack / 2   // 4.0
const spacerFrontInner = 2 * (xBrgF - P.brgW / 2)                              // 19
const spacerBack = cavityHalfX - flangeIn - P.brgW / 2 - axialSlack / 2         // 14.5

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
// 自分のモードが書くファイルだけ消す（build と assembly の出力を共存させる）
const isAssembly = process.argv.includes('--assembly')
for (const f of fs.readdirSync(outDir)) {
  if (f.endsWith('.stl') && (f === 'assembly.stl') === isAssembly) {
    fs.unlinkSync(path.join(outDir, f))
  }
}

if (isAssembly) {
  // 組立状態のプレビュー: キャリッジをレール中程に置き、ベアリングとこてを配置
  const zC = 60
  const parts = [
    buildBase(),
    translate([0, yMid, zTower0], buildTower()),
    translate([0, 0, zC], buildCarriage()),
  ]
  for (const z of zBrg) {
    for (const x of [-xBrgF, xBrgF]) parts.push(translate([x, yAxleF, zC + z], bearingDummy()))
    parts.push(translate([0, yAxleB, zC + z], bearingDummy()))
  }
  const iron = cylinder({
    radius: Ri - 0.5, height: 120, segments: 64,
    center: [0, yC, zC + zRing0 + 60],
  })
  const tip = cylinder({ radius: 2.5, height: 60, segments: 32, center: [0, yC, zC + zRing0 - 30] })
  writeStl(path.join(outDir, 'assembly.stl'), union(...parts, iron, tip))
} else {
  writeStl(path.join(outDir, 'base.stl'), buildBase())
  writeStl(path.join(outDir, 'tower.stl'), towerForPrint())
  writeStl(path.join(outDir, 'carriage.stl'), translate([130, 0, 0], buildCarriage()))
  // 小物は種類ごとに1ファイル（同じ部品をまとめて印刷できる）
  const row = (n, pitch, build) => union(...Array.from({ length: n }, (_, i) => translate([i * pitch, 0, 0], build(i))))
  writeStl(path.join(outDir, 'axles.stl'), row(4, 20, () => buildAxle()))
  writeStl(path.join(outDir, 'caps.stl'), row(4, 20, () => buildCap()))
  writeStl(path.join(outDir, 'bushings.stl'), row(4, 24, () => buildBushing()))
  const spacerLens = [
    ...Array(4).fill(spacerFrontOuter), // 前面・壁側 4.5
    ...Array(2).fill(spacerFrontInner), // 前面・ベアリング間 19
    ...Array(4).fill(spacerBack),       // 背面 15
  ]
  writeStl(path.join(outDir, 'spacers.stl'), row(spacerLens.length, 16, i => buildSpacer(spacerLens[i])))
  writeStl(path.join(outDir, 'knobs.stl'), row(2, 26, () => buildKnob()))
}
