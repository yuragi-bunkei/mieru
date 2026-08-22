// 引き出しをスライドさせながらブラケット+タイバーとの交差体積を確認するチェッカー。
// 戻り止めバンプとの微小な干渉（左右2箇所・計約0.5mm3）以外はゼロが正常。
import Module from 'manifold-3d'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const wasm = await Module()
wasm.setup()
const { Manifold, Mesh } = wasm
const dir = join(dirname(fileURLToPath(import.meta.url)), 'stl', 'assembly')

function loadStl(path) {
  const b = readFileSync(path)
  const n = b.readUInt32LE(80)
  const tris = new Uint32Array(n * 3)
  const map = new Map()
  const pos = []
  let count = 0
  for (let t = 0; t < n; t++) {
    const o = 84 + t * 50 + 12
    for (let k = 0; k < 3; k++) {
      const x = b.readFloatLE(o + k * 12)
      const y = b.readFloatLE(o + k * 12 + 4)
      const z = b.readFloatLE(o + k * 12 + 8)
      const key = `${x},${y},${z}`
      let idx = map.get(key)
      if (idx === undefined) {
        idx = count++
        map.set(key, idx)
        pos.push(x, y, z)
      }
      tris[t * 3 + k] = idx
    }
  }
  return new Manifold(
    new Mesh({ numProp: 3, vertProperties: new Float32Array(pos), triVerts: tris }),
  )
}

const vol = (m) => (typeof m.volume === 'function' ? m.volume() : m.getProperties().volume)

const fixed = ['bracket_left.stl', 'bracket_right.stl', 'tie_bar.stl']
  .map((f) => loadStl(join(dir, f)))
  .reduce((a, b) => a.add(b))
const drawer = loadStl(join(dir, 'drawer.stl'))

let ok = true
for (const dy of [0, -30, -70, -110, -140]) {
  const hit = drawer.translate([0, dy, 0]).intersect(fixed)
  const v = vol(hit)
  const pass = v < 1.0 // 戻り止めバンプの意図的な干渉のみ許容
  if (!pass) ok = false
  console.log(`slide ${String(dy).padStart(4)} mm: 交差体積 ${v.toFixed(3)} mm3 ${pass ? 'OK' : 'NG'}`)
}
// バンプ乗り越え時（1mm弱の浮き上がり）に上フランジへ当たらないこと
const lifted = vol(drawer.translate([0, -20, 0.9]).intersect(fixed))
console.log(`lift +0.9mm: ${lifted.toFixed(3)} mm3 ${lifted === 0 ? 'OK' : 'NG'}`)
if (lifted !== 0) ok = false
process.exitCode = ok ? 0 : 1
