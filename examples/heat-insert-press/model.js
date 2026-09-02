#!/usr/bin/env node
// ヒートインサート圧入治具 — スクリプト→STL出力（mieruで表示確認する想定）
//
//   node model.js             … 印刷用パーツ（frame / carriage）を stl/ に出力
//   node model.js --assembly  … 組立プレビュー1体を stl/ に出力（印刷不可・確認用）
//
// 構成:
//   frame    … ベースプレート + 支柱 + オス側アリ溝レール（一体）
//   carriage … メス側アリ溝で上下にスライドし、はんだごてを割りリングで保持
// 使い方:
//   はんだごてを上からリングに差し込み、M4ボルト2本で締めて固定。
//   キャリッジごと押し下げてインサートナットを垂直に圧入する。

const fs = require('node:fs')
const path = require('node:path')
const { cuboid, cylinder, polygon } = require('@jscad/modeling').primitives
const { extrudeLinear } = require('@jscad/modeling').extrusions
const { subtract, union } = require('@jscad/modeling').booleans
const { translate, rotateY } = require('@jscad/modeling').transforms
const stlSerializer = require('@jscad/stl-serializer')

// ---- パラメータ（mm） -------------------------------------------------
const P = {
  ironDiameter: 22.0, // はんだごてのグリップ/バレル外径（要実測。FX-600のグリップ部なら実測値に変更）
  clearance: 0.3,     // アリ溝の摺動クリアランス（きつい場合は 0.4〜0.5 に）

  baseW: 150, baseD: 130, baseT: 8, // ベースプレート
  towerW: 44, towerD: 28, towerH: 220, // 支柱

  railRootHalf: 7,  // アリ溝レール根元の半幅
  railTipHalf: 10,  // アリ溝レール先端の半幅（根元より広い＝抜け止め）
  railDepth: 6,     // レールの突き出し量

  carriageH: 60,    // キャリッジ高さ
  bodyD: 12,        // キャリッジ本体の奥行（溝深さ+前壁）
  ringWall: 4,      // クランプリングの肉厚
  slitW: 3,         // 割りスリット幅
  boltHole: 4.4,    // M4ボルト通し穴径
  nutFlats: 7.3,    // M4ナット二面幅+遊び
  nutDepth: 3.6,    // ナットポケット深さ
  mountHole: 4.5,   // ベース固定穴（作業台にネジ止めする場合）
}

// ---- 導出値 -----------------------------------------------------------
const yF = 30                              // 支柱前面のY座標（レール根元）
const Ri = P.ironDiameter / 2              // リング内径（こて外径）
const Ro = Ri + P.ringWall                 // リング外径
const yB = yF - P.clearance                // キャリッジ背面（支柱前面との隙間）
const yFront = yB - P.bodyD                // キャリッジ前面
const yC = yFront - Ro + 2                 // リング中心（本体と2mm重ねて結合）
const zTop = P.baseT + P.towerH

// ---- フレーム（ベース+支柱+レール一体） -------------------------------
function buildFrame () {
  const base = cuboid({ size: [P.baseW, P.baseD, P.baseT], center: [0, 0, P.baseT / 2] })
  const tower = cuboid({
    size: [P.towerW, P.towerD, P.towerH],
    center: [0, yF + P.towerD / 2, P.baseT + P.towerH / 2],
  })
  // オス側アリ溝: 断面台形（根元が狭く先端が広い）を垂直に押し出す
  const rail = translate([0, 0, P.baseT], extrudeLinear({ height: P.towerH }, polygon({
    points: [
      [-P.railTipHalf, yF - P.railDepth],
      [P.railTipHalf, yF - P.railDepth],
      [P.railRootHalf, yF],
      [-P.railRootHalf, yF],
    ],
  })))
  const mountHoles = [[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([sx, sy]) =>
    cylinder({
      radius: P.mountHole / 2, height: P.baseT + 2, segments: 32,
      center: [sx * (P.baseW / 2 - 9), sy * (P.baseD / 2 - 9), P.baseT / 2],
    }))
  return subtract(union(base, tower, rail), ...mountHoles)
}

// ---- キャリッジ（メス溝+こてクランプ） --------------------------------
function buildCarriage () {
  const H = P.carriageH
  const body = cuboid({ size: [P.towerW, P.bodyD, H], center: [0, (yB + yFront) / 2, H / 2] })
  const ringOuter = cylinder({ radius: Ro, height: H, segments: 96, center: [0, yC, H / 2] })
  const web = cuboid({
    size: [Math.min(P.towerW - 8, 2 * Ro), yB - yC, H],
    center: [0, (yB + yC) / 2, H / 2],
  })
  // ボルト用の耳（スリットの左右）
  const earW = 10, earD = 15
  const ears = [-1, 1].map(s => cuboid({
    size: [earW, earD, H],
    center: [s * (P.slitW / 2 + earW / 2), yC - 5 - earD / 2, H / 2],
  }))
  const solid = union(body, ringOuter, web, ...ears)

  // メス側アリ溝: レール断面をクリアランス分広げて引き算（背面側は開放）
  const c = P.clearance
  const groove = translate([0, 0, -1], extrudeLinear({ height: H + 2 }, polygon({
    points: [
      [-(P.railTipHalf + c), yF - P.railDepth - c],
      [P.railTipHalf + c, yF - P.railDepth - c],
      [P.railTipHalf + c, yF - P.railDepth],
      [P.railRootHalf + c, yF],
      [P.railRootHalf + c, yF + 2],
      [-(P.railRootHalf + c), yF + 2],
      [-(P.railRootHalf + c), yF],
      [-(P.railTipHalf + c), yF - P.railDepth],
    ],
  })))
  const bore = cylinder({ radius: Ri, height: H + 4, segments: 96, center: [0, yC, H / 2] })
  const slit = cuboid({ size: [P.slitW, 2 * Ro, H + 4], center: [0, yC - Ro, H / 2] })
  const yBolt = yC - 14.7
  const bolts = [H * 0.25, H * 0.75].map(z => translate([0, yBolt, z],
    rotateY(Math.PI / 2, cylinder({ radius: P.boltHole / 2, height: 40, segments: 32 }))))
  const nutR = P.nutFlats / Math.sqrt(3) // 二面幅→外接円半径
  const earOuterX = P.slitW / 2 + earW
  const nuts = [H * 0.25, H * 0.75].map(z => translate([earOuterX - P.nutDepth / 2 + 0.5, yBolt, z],
    rotateY(Math.PI / 2, cylinder({ radius: nutR, height: P.nutDepth + 1, segments: 6 }))))
  return subtract(solid, groove, bore, slit, ...bolts, ...nuts)
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
  // 組立状態のプレビュー: キャリッジをレール中程に置き、ダミーのこてを挿す
  const carriageUp = translate([0, 0, 120], buildCarriage())
  const iron = cylinder({
    radius: Ri - 0.5, height: 140, segments: 64,
    center: [0, yC, 120 + P.carriageH / 2 + 30],
  })
  const tip = cylinder({ radius: 2.5, height: 40, segments: 32, center: [0, yC, 120 - 20] })
  writeStl(path.join(outDir, 'assembly.stl'), union(buildFrame(), carriageUp, iron, tip))
} else {
  writeStl(path.join(outDir, 'frame.stl'), buildFrame())
  // 印刷用は横に並べて出力（そのまま印刷向きで自立する配置）
  writeStl(path.join(outDir, 'carriage.stl'), translate([120, 0, 0], buildCarriage()))
}
