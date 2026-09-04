#!/usr/bin/env -S uv run --with trimesh --with numpy --with networkx --with scipy --with rtree python
# 積み上げ寸法の独立検算 — model.js の式ではなく stl/ の実測と「設計意図の数値」を突き合わせる
#
#   npm run build && ./verify.py
#
# 個々の穴径が合っていても、部品を一列に並べた合計が内幅と同寸なら組めない。
# ここでは「壁厚・内幅・ブッシュ長・スペーサー長・軸長」をSTLから測り、
# 組立に効く積み上げ（遊び・掛かり代）と造形サイズを検算する。
import sys
import numpy as np
import trimesh

STL = 'stl'
BUILD = 180.0          # A1 mini
BRG_W = 7.0            # 608ZZ 幅（市販品・公称）
INSERT_L = 4.0         # M3インサート長
SCREW = 20.0           # M3×20（頭下）
HEAD_H = 2.0           # なべ頭高さ

ok_all = True
def check(name, cond, detail):
    global ok_all
    ok_all &= bool(cond)
    print(('OK  ' if cond else 'NG  ') + f'{name}: {detail}')

def hits(m, o, d):
    locs, _, _ = m.ray.intersects_location(np.array([o], float), np.array([d], float))
    ax = int(np.argmax(np.abs(d)))
    return sorted(round(float(l[ax]), 2) for l in locs)

def bodies(m):
    return m.split(only_watertight=False)

def heights(parts):
    return sorted(round(float(p.bounds[1][2] - p.bounds[0][2]), 2) for p in parts)

# ---- 造形サイズと連結体数 ------------------------------------------------
expect = {'base.stl': 1, 'tower.stl': 1, 'carriage.stl': 1, 'axles.stl': 4,
          'caps.stl': 4, 'bushings.stl': 4, 'spacers.stl': 10, 'knobs.stl': 2}
meshes = {}
for f, n in expect.items():
    m = trimesh.load(f'{STL}/{f}'); meshes[f] = m
    ext = m.bounds[1] - m.bounds[0]
    check(f'{f} 造形サイズ', (ext <= BUILD + 1e-6).all(), f'{ext.round(1)} ≤ {BUILD}')
    check(f'{f} 連結体数', len(bodies(m)) == n, f'{len(bodies(m))} (expect {n})')

c = meshes['carriage.stl'].copy(); c.apply_translation([-130, 0, 0])

# ---- 壁厚・内幅（前軸の穴を外した高さで測る） ----------------------------
xs = hits(c, [-60, 19, 27], [1, 0, 0])
wallT, inner, outer = xs[1] - xs[0], xs[-2] - xs[1], xs[-1] - xs[0]
print(f'    壁厚 {wallT} / 内幅 {inner} / 外幅 {outer}')

# ---- ブッシュ: フランジ厚と、フランジ先の胴の長さ --------------------------
p = sorted(bodies(meshes['bushings.stl']), key=lambda q: q.bounds[0][0])[0]
cx = (p.bounds[0][0] + p.bounds[1][0]) / 2; cy = (p.bounds[0][1] + p.bounds[1][1]) / 2
fl = hits(p, [cx - 7.5, cy, -5], [0, 0, 1]); bd = hits(p, [cx + 5.5, cy, -5], [0, 0, 1])
flangeT = fl[1] - fl[0]; bodyBeyond = bd[-1] - fl[1]; protrude = bodyBeyond - wallT
check('ブッシュ胴 = 壁厚（内側に出ない）', abs(protrude) < 0.05, f'胴 {bodyBeyond} vs 壁 {wallT}')

# ---- スペーサー列の遊び ---------------------------------------------------
sp = heights(bodies(meshes['spacers.stl']))
short, mid, long_ = sp[0], sp[4], sp[-1]
front = short + BRG_W + long_ + BRG_W + short
back = mid + BRG_W + mid
check('前軸 遊び 0.8〜2.0', 0.8 <= inner - front <= 2.0, f'内幅 {inner} − 列 {front} = {round(inner - front, 2)}')
check('後軸 遊び 0.8〜2.0', 0.8 <= inner - 2 * protrude - back <= 2.0,
      f'内幅 {inner} − 突出 {round(2 * protrude, 2)} − 列 {back} = {round(inner - 2 * protrude - back, 2)}')

# ---- 軸長とキャップの掛かり ----------------------------------------------
axle = heights(bodies(meshes['axles.stl']))[0]; cap = heights(bodies(meshes['caps.stl']))[0]
shaft = axle - 3.0
check('キャップ掛かり（前軸）≥ 4', shaft - outer >= 4, f'{round(shaft - outer, 2)} mm / キャップ {cap}')
check('キャップ掛かり（後軸）≥ 4', shaft - outer - 2 * flangeT >= 4, f'{round(shaft - outer - 2 * flangeT, 2)} mm / キャップ {cap}')

# ---- クランプねじ: 座繰り底 → インサート外端 vs M3×20 -----------------------
# ねじ軸(y=-29.5,z=50)から3mm外した線: 座繰り(r4.6)は空洞なので最初の面が座繰り底、
# バカ穴(r1.7)・下穴(r2.35)は外れるので右耳の外面まで面として拾える
xs2 = hits(c, [-60, -29.5, 53], [1, 0, 0])
cbore_bottom, ear_outer = xs2[0], xs2[-1]
insert_start = ear_outer - INSERT_L
engage = min(cbore_bottom + SCREW, ear_outer) - insert_start
check('クランプねじ インサート掛かり ≥ 3.5', engage >= 3.5,
      f'座繰り底 x={cbore_bottom} + 20 = {cbore_bottom + SCREW}; インサート x={insert_start}..{ear_outer} → {round(engage, 2)} mm')

# ---- ツマミ: 軸長 = 座繰り深さ、袋穴 ≥ 頭高さ ------------------------------
k = sorted(bodies(meshes['knobs.stl']), key=lambda q: q.bounds[0][0])[0]
kx = (k.bounds[0][0] + k.bounds[1][0]) / 2; ky = (k.bounds[0][1] + k.bounds[1][1]) / 2
disc = hits(k, [kx - 7.5, ky, -5], [0, 0, 1]); stem = hits(k, [kx + 3.5, ky, -5], [0, 0, 1])
pocket = hits(k, [kx + 1.5, ky + 1.5, 20], [0, 0, -1])   # 袋穴の中（突起の腕を外した位置）を上から
stemL = stem[-1] - disc[-1]
pocket_floor = max(h for h in pocket if h < stem[-1] - 0.01)  # 軸先端より下で最初に当たる面 = 袋穴の底
pocketD = stem[-1] - pocket_floor
ear_left_outer = hits(c, [-60, -29.5, 50 + 6], [1, 0, 0])[0]  # 座繰り(r4.6)の外 → 左耳の外面
cbore_d = cbore_bottom - ear_left_outer
check('ツマミ軸長 = 座繰り深さ', abs(stemL - cbore_d) < 0.05, f'軸 {round(stemL, 2)} / 座繰り {round(cbore_d, 2)}')
check('ツマミ袋穴 ≥ 頭高さ + 0.5', pocketD >= HEAD_H + 0.5, f'袋穴 {round(pocketD, 2)} / 頭 {HEAD_H}')

# ---- 柱固定ねじ: 座繰り底 → 柱の逃げ穴底 vs M3×20 ---------------------------
b = meshes['base.stl']; t = meshes['tower.stl']
zb = hits(b, [12, 45 + 7 + 2.4, -5], [0, 0, 1])       # 座繰り(r3.25)の中、バカ穴(r1.7)の外 → 座繰り底
zp = hits(b, [0, 45, -5], [0, 0, 1])                  # ポケット底
cbore_base = zb[0]; pocket_floor = zp[-1]
xt = hits(t, [-5, -7, 8 + 2.0], [1, 0, 0])            # 柱の穴: 下穴(r2.35)の中、逃げ(r1.7)の外 → 下穴底 / 逃げ底は軸上
xt_axis = hits(t, [-5, -7, 8], [1, 0, 0])
relief_depth = xt_axis[0]
tip = cbore_base + SCREW - pocket_floor               # 柱への侵入
check('柱固定ねじ 侵入 < 逃げ深さ', tip < relief_depth, f'侵入 {round(tip, 2)} / 逃げ {relief_depth}')
check('柱固定ねじ インサート掛かり ≥ 3.5', tip >= INSERT_L, f'侵入 {round(tip, 2)} ≥ インサート {INSERT_L}')

print('\nALL OK' if ok_all else '\nSOME CHECKS FAILED')
sys.exit(0 if ok_all else 1)
