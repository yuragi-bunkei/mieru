// showreel — 60秒の映像を、フレームごとに数式だけで描く。
// 画像・動画・3Dモデルなどの素材ファイルは使わない（文字はシステムフォント）。
// すべての場面は時刻 t の純関数なので、任意のフレームを単独で再現できる。
// 使い方: window.renderFrame(frameIndex) を呼ぶと #gl にそのフレームが描かれる。
(() => {
'use strict';

const W = 1920, H = 1080, FPS = 30, DURATION = 60;
const N_PARTICLES = 400000;
const JULIA_ITER = 300;
const LORENZ_TRAJ = 150, LORENZ_STEPS = 5000, LORENZ_DT = 0.004, LORENZ_SPREAD = 0.01;

const canvas = document.getElementById('gl');
const gl = canvas.getContext('webgl2', {
  antialias: false, alpha: false, preserveDrawingBuffer: true, powerPreference: 'high-performance',
});
if (!gl) throw new Error('WebGL2 が使えません');
if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('EXT_color_buffer_float が必要です');
gl.getExtension('OES_texture_float_linear');

// ---------------------------------------------------------------- GLSL 共通部
const VS_FULL = `#version 300 es
void main(){ vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2); gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }`;

const FS_HEAD = `#version 300 es
precision highp float;
uniform vec2 uRes;
uniform float uT, uL, uKick;
uniform vec2 uJ;                       // サブピクセルのずらし量（アンチエイリアス用）
out vec4 o;
#define FC (gl_FragCoord.xy + uJ)
#define PI 3.14159265
#define TAU 6.2831853
float hash11(float p){ p = fract(p * .1031); p *= p + 33.33; p *= p + p; return fract(p); }
float hash21(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec3 hash32(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973)); p3 += dot(p3, p3.yxz + 33.33); return fract((p3.xxy + p3.yzz) * p3.zyx); }
float vnoise(vec2 x){ vec2 i = floor(x), f = fract(x); f = f * f * (3. - 2. * f);
  return mix(mix(hash21(i), hash21(i + vec2(1, 0)), f.x), mix(hash21(i + vec2(0, 1)), hash21(i + vec2(1, 1)), f.x), f.y); }
vec3 pal(float t, vec3 a, vec3 b, vec3 c, vec3 d){ return a + b * cos(TAU * (c * t + d)); }
mat2 rot(float a){ float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }
// シアン→マゼンタ→ゴールドを巡る配色
vec3 tri(float h){ h = fract(h) * 3.; vec3 a = vec3(.12, .72, 1.), b = vec3(1., .22, .62), c = vec3(1., .70, .22);
  return h < 1. ? mix(a, b, smoothstep(0., 1., h)) : h < 2. ? mix(b, c, smoothstep(0., 1., h - 1.)) : mix(c, a, smoothstep(0., 1., h - 2.)); }
`;

// ---------------------------------------------------------------- 00 起動画面の背景
const FS_BOOT = FS_HEAD + `
void main(){
  vec2 uv = FC / uRes;
  vec2 p = (FC - .5 * uRes) / uRes.y;
  vec2 g = abs(fract(p * 12. + vec2(0., uL * .15)) - .5);
  float line = smoothstep(.49, .5, max(g.x, g.y));
  vec3 col = vec3(.010, .014, .024) + vec3(.02, .05, .09) * line * (1. - length(p) * .9);
  col += vec3(.02, .04, .07) * exp(-3. * length(p - vec2(-.2, .1)));
  float ramp = smoothstep(2.6, 4., uL);            // 4秒の衝撃に向けて中心が光る
  col += vec3(.5, .8, 1.) * ramp * ramp * exp(-9. * length(p)) * 2.5;
  col *= 1. - .25 * step(.5, fract(gl_FragCoord.y * .25)) * .3;
  o = vec4(col, 1.);
}`;

// ---------------------------------------------------------------- 01 粒子
// 位置は頂点シェーダで「粒子番号と時刻」から直接計算する（状態を持たない）。
const VS_PART = `#version 300 es
precision highp float;
uniform vec2 uRes;
uniform float uT, uL, uKick, uMode, uCount;
uniform vec2 uJ;
out vec3 vCol;
#define PI 3.14159265
#define TAU 6.2831853
uint pcg(uint v){ uint s = v * 747796405u + 2891336453u; uint w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u; return (w >> 22u) ^ w; }
float rnd(uint id, uint k){ return float(pcg(id * 7u + k * 2654435761u)) / 4294967295.0; }
vec3 tri(float h){ h = fract(h) * 3.; vec3 a = vec3(.12, .72, 1.), b = vec3(1., .22, .62), c = vec3(1., .70, .22);
  return h < 1. ? mix(a, b, smoothstep(0., 1., h)) : h < 2. ? mix(b, c, smoothstep(0., 1., h - 1.)) : mix(c, a, smoothstep(0., 1., h - 2.)); }
vec3 rdir(uint id){ float z = rnd(id, 1u) * 2. - 1., a = rnd(id, 2u) * TAU, r = sqrt(1. - z * z); return vec3(r * cos(a), z, r * sin(a)); }
float gauss(uint id, uint k){ return sqrt(-2. * log(max(rnd(id, k), 1e-6))) * cos(TAU * rnd(id, k + 1u)); }

vec3 shapeCloud(uint id, float t){
  vec3 d = rdir(id); float r = pow(rnd(id, 3u), .45) * 2.6;
  vec3 p = d * r;
  p += .22 * vec3(sin(p.y * 2.1 + t * 1.3), sin(p.z * 1.7 + t * 1.1), sin(p.x * 1.9 + t * .9));
  return p;
}
vec3 shapeSphere(uint id, float t){
  float u = (float(id) + .5) / uCount;
  float y = 1. - 2. * u, r = sqrt(max(0., 1. - y * y)), ph = float(id) * 2.39996323;
  vec3 d = vec3(r * cos(ph), y, r * sin(ph));
  float wave = .07 * sin(d.y * 9. + t * 3.) + .05 * sin(d.x * 7. - t * 2.2) * sin(d.z * 6. + t * 1.4);
  return d * (1.35 + wave + .02 * rnd(id, 4u));
}
vec3 knot(float s){ float r = 2. + cos(3. * s); return vec3(r * cos(2. * s), r * sin(2. * s), sin(3. * s)) * .58; }
vec3 shapeKnot(uint id, float t){
  float s = rnd(id, 5u) * TAU + t * .22;
  vec3 c = knot(s), tg = normalize(knot(s + .01) - c);
  vec3 n = normalize(cross(tg, vec3(0, 0, 1))), b = cross(tg, n);
  float a = rnd(id, 6u) * TAU + s * 6., rr = .17 * sqrt(rnd(id, 7u));
  return c + (n * cos(a) + b * sin(a)) * rr;
}
vec3 shapeGalaxy(uint id, float t){
  float bulge = step(rnd(id, 8u), .16);
  float r = mix(pow(rnd(id, 9u), .7) * 2.5 + .08, abs(gauss(id, 10u)) * .22, bulge);
  float arm = floor(rnd(id, 12u) * 3.) * TAU / 3.;
  float a = arm + r * 2.3 + gauss(id, 13u) * (.28 / (r + .35)) + t * .35 / (r + .5);
  float y = gauss(id, 15u) * mix(.035, .16, bulge) * (1. + .0 * r);
  return vec3(r * cos(a), y, r * sin(a));
}
float ease(float x){ x = clamp(x, 0., 1.); return x * x * (3. - 2. * x); }

void main(){
  uint id = uint(gl_VertexID);
  float t = uL;
  float delay = rnd(id, 20u) * .35;
  vec3 p; float hue; float gain = 1.;
  if (uMode > .5) {
    // 結びの背景：ゆっくり回る銀河
    p = shapeGalaxy(id, t * .5 + 9.) * 1.25;
    hue = .02 + length(p) * .09;
    gain = .5;
  } else {
    vec3 a = shapeCloud(id, t), b = shapeSphere(id, t), c = shapeKnot(id, t), d = shapeGalaxy(id, t);
    float m1 = ease((t - 2.0 - delay) / .65), m2 = ease((t - 4.0 - delay) / .65), m3 = ease((t - 6.0 - delay) / .65);
    p = mix(mix(mix(a, b, m1), c, m2), d, m3);
    // 変形の途中だけ渦を足す
    float tr = (m1 * (1. - m1) + m2 * (1. - m2) + m3 * (1. - m3)) * 4.;
    p += tr * .45 * vec3(sin(p.y * 3. + float(id) * .001), sin(p.z * 3. + t), sin(p.x * 3. - t));
    // 冒頭は中心から爆発、最後は一点に収束
    float burst = 1. - exp(-t * 5.5);
    float implode = 1. - ease((t - 7.45) / .55);
    p *= burst * implode * (1. + .05 * uKick);
    // 形ごとに色の付け方と明るさを変える（密な形ほど暗くして白飛びを防ぐ）
    float hA = .55 + a.y * .10 + length(a) * .10;
    float hB = .30 + b.y * .22;
    float hC = .05 + rnd(id, 5u) * 1. + t * .03;
    float hD = .0 + length(d) * .13;
    hue = mix(mix(mix(hA, hB, m1), hC, m2), hD, m3);
    gain = mix(mix(mix(.85, .34, m1), .26, m2), .62, m3);
  }
  // カメラ
  float ca = (uMode > .5 ? .25 + t * .06 : t * .30 + .6);
  float ce = (uMode > .5 ? .62 : .38 + .18 * sin(t * .5));
  float cd = (uMode > .5 ? 5.2 : 5.3 - .8 * ease(t / 8.));
  vec3 ro = cd * vec3(cos(ce) * sin(ca), sin(ce), cos(ce) * cos(ca));
  vec3 fw = normalize(-ro), rt = normalize(cross(fw, vec3(0, 1, 0))), up = cross(rt, fw);
  vec3 q = p - ro;
  vec3 v = vec3(dot(q, rt), dot(q, up), dot(q, fw));
  float f = 1.9;
  vec2 ndc = v.xy * f / v.z; ndc.x *= uRes.y / uRes.x;
  gl_Position = vec4(ndc + uJ * 2. / uRes, 0., 1.);
  if (v.z < .1) gl_Position = vec4(2., 2., 2., 1.);
  // 被写界深度ふう：ピント面から離れるほど大きく・薄く
  float coc = abs(v.z - cd) * 1.3;
  float size = 1.6 + coc * 2.4 + 2.2 / v.z;
  gl_PointSize = size;
  vec3 col = tri(hue + (rnd(id, 30u) - .5) * .12);
  col = mix(col, vec3(1.), .10);
  vCol = col * gain * 1.15 / (size * size) * (.6 + .8 * rnd(id, 31u));
}`;
const FS_PART = `#version 300 es
precision highp float;
in vec3 vCol; out vec4 o;
void main(){ vec2 d = gl_PointCoord - .5; float a = smoothstep(.5, .15, length(d)); o = vec4(vCol * a, 1.); }`;

// 粒子・軌道の下に敷く暗い背景
const FS_SPACE = FS_HEAD + `
uniform vec3 uTint;
void main(){
  vec2 p = (FC - .5 * uRes) / uRes.y;
  vec3 col = uTint * (.05 * exp(-1.6 * length(p)) + .012);
  vec2 g = floor(FC / 3.);
  float st = step(.9985, hash21(g));
  col += st * vec3(.5, .6, .8) * hash21(g + 7.) * .35;
  o = vec4(col, 1.);
}`;

// ---------------------------------------------------------------- 02 ローレンツ・アトラクタ
// 軌道はJS側で数値積分し、線として描く。初期値がわずかに違う複数の軌道を同時に走らせる。
const VS_LOR = `#version 300 es
precision highp float;
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec2 aInfo;   // x: 軌道番号(0..1), y: 進行度(0..1)
uniform vec2 uRes, uJit;
uniform float uL, uHead, uGain;
out vec3 vCol;
#define TAU 6.2831853
void main(){
  vec3 p = aPos;
  float t = uL;
  float ca = .5 + t * .2, ce = .18 + .1 * sin(t * .4), cd = 3.1 - .45 * smoothstep(0., 8., t);
  vec3 ro = cd * vec3(cos(ce) * sin(ca), sin(ce), cos(ce) * cos(ca));
  vec3 fw = normalize(-ro), rt = normalize(cross(fw, vec3(0, 1, 0))), up = cross(rt, fw);
  vec3 q = p - ro; vec3 v = vec3(dot(q, rt), dot(q, up), dot(q, fw));
  vec2 ndc = v.xy * 1.8 / v.z; ndc.x *= uRes.y / uRes.x;
  gl_Position = vec4(ndc + uJit, 0., 1.);
  float age = uHead - aInfo.y;                 // 0 = 先頭
  float vis = step(0., age);
  age = max(age, 0.);                          // まだ描かれていない部分で指数関数があふれないように
  float head = exp(-age * 260.);
  float tail = exp(-age * 5.) * .6 + .32;
  float h = .98 + p.x * .26 + p.y * .12 + (aInfo.x - .5) * .10;
  h = fract(h) * 3.;
  vec3 c1 = vec3(.12, .72, 1.), c2 = vec3(1., .22, .62), c3 = vec3(1., .70, .22);
  vec3 col = h < 1. ? mix(c1, c2, smoothstep(0., 1., h)) : h < 2. ? mix(c2, c3, smoothstep(0., 1., h - 1.)) : mix(c3, c1, smoothstep(0., 1., h - 2.));
  col = mix(col, vec3(1., .95, .9), head * .7);
  vCol = col * vis * (tail * .034 + head * .30) * uGain;
}`;
const FS_LOR = `#version 300 es
precision highp float;
in vec3 vCol; out vec4 o;
void main(){ o = vec4(vCol, 1.); }`;

// ---------------------------------------------------------------- 03 ジュリア集合
const FS_JULIA = FS_HEAD + `
#define ITER ${JULIA_ITER}
vec3 shade(vec2 p, vec2 c){
  vec2 z = p; float n = 0.; float trap = 1e9; float m = 0.;
  for (int k = 0; k < ITER; k++) {
    z = vec2(z.x * z.x - z.y * z.y, 2. * z.x * z.y) + c;
    m = dot(z, z);
    trap = min(trap, abs(z.x) + abs(z.y) * .6);
    if (m > 400.) break;
    n += 1.;
  }
  if (n >= float(ITER)) {
    return vec3(.02, .01, .05) + vec3(.9, .35, .15) * exp(-trap * 9.) * .7;
  }
  float sm = n - log2(log2(m)) + 4.;
  float v = sqrt(sm) * .21;
  vec3 col = pal(v + uL * .05, vec3(.5), vec3(.5), vec3(1., 1., 1.), vec3(.0, .12, .25));
  col *= .03 + .62 * smoothstep(2., 46., sm);        // 集合から遠いほど暗く
  col += vec3(1., .62, .28) * exp(-trap * 16.) * .45;
  return col;
}
void main(){
  float t = uL;
  float ang = 2.52 + .085 * t + .06 * sin(t * .8);
  vec2 c = .7885 * vec2(cos(ang), sin(ang));
  float zoom = 1.25 * exp(-.085 * t) * (1. - .025 * uKick);
  vec3 col = vec3(0.);
  for (int s = 0; s < 4; s++) {
    vec2 off = vec2(float(s & 1), float(s >> 1)) * .5 - .25;
    vec2 p = (FC + off - .5 * uRes) / uRes.y;
    p = rot(t * .07 + .3) * p * 2. * zoom;
    col += shade(p, c);
  }
  col *= .25;
  col *= 1. + .22 * uKick;
  o = vec4(col, 1.);
}`;

// ---------------------------------------------------------------- 04 マンデルバルブ
const FS_BULB = FS_HEAD + `
uniform float uPow;
float de(vec3 p, out vec4 trap){
  vec3 z = p; float dr = 1., r = 0.; trap = vec4(1e9);
  for (int i = 0; i < 7; i++) {
    r = length(z); if (r > 2.2) break;
    float th = acos(clamp(z.y / r, -1., 1.)) * uPow, ph = atan(z.z, z.x) * uPow;
    float zr = pow(r, uPow); dr = pow(r, uPow - 1.) * uPow * dr + 1.;
    z = zr * vec3(sin(th) * cos(ph), cos(th), sin(th) * sin(ph)) + p;
    trap = min(trap, vec4(abs(z), dot(z, z)));
  }
  return .5 * log(r) * r / dr;
}
float de1(vec3 p){ vec4 t; return de(p, t); }
void main(){
  vec2 p = (FC - .5 * uRes) / uRes.y;
  float t = uL;
  float ca = .4 + t * .16, ce = .32 + .12 * sin(t * .3), cd = 4.7 - 1.0 * smoothstep(0., 8., t);
  vec3 ro = cd * vec3(cos(ce) * sin(ca), sin(ce), cos(ce) * cos(ca));
  vec3 fw = normalize(-ro), rt = normalize(cross(fw, vec3(0, 1, 0))), up = cross(rt, fw);
  vec3 rd = normalize(fw * 1.35 + rt * p.x + up * p.y);
  float d = 0., h = 1.; vec4 trap = vec4(1e9); float steps = 0.; bool hit = false;
  for (int i = 0; i < 110; i++) {
    h = de(ro + rd * d, trap);
    if (h < .0007 * d) { hit = true; break; }
    d += h; steps += 1.;
    if (d > 9.) break;
  }
  vec3 bg = vec3(.012, .016, .035) + vec3(.10, .05, .16) * exp(-2.2 * length(p));
  vec3 col = bg;
  if (hit) {
    vec3 pos = ro + rd * d;
    vec2 e = vec2(1., -1.) * .0006 * d;
    vec3 n = normalize(e.xyy * de1(pos + e.xyy) + e.yyx * de1(pos + e.yyx) + e.yxy * de1(pos + e.yxy) + e.xxx * de1(pos + e.xxx));
    vec3 l1 = normalize(vec3(.6, .8, .3)), l2 = normalize(vec3(-.7, .1, -.6));
    float ao = clamp(1. - steps / 95., 0., 1.); ao = ao * ao;
    float occ = clamp(pow(trap.w, .6) * 1.35, 0., 1.);
    vec3 base = mix(vec3(.03, .17, .40), vec3(.95, .46, .09), smoothstep(.0, .45, trap.y));
    base = mix(base, vec3(.78, .07, .30), smoothstep(.05, .5, trap.x) * .7);
    base = mix(base, vec3(.95, .85, .62), smoothstep(.1, .6, trap.z) * .35);
    // 簡易ソフトシャドウ
    float sh = 1., sd = .02;
    for (int i = 0; i < 20; i++) { float hh = de1(pos + l1 * sd); sh = min(sh, 9. * hh / sd); sd += clamp(hh, .01, .2); if (hh < .0005 || sd > 2.) break; }
    sh = clamp(sh, 0., 1.);
    float dif = max(dot(n, l1), 0.) * sh, bak = max(dot(n, l2), 0.);
    float fre = pow(1. - max(dot(n, -rd), 0.), 3.);
    float spe = pow(max(dot(reflect(rd, n), l1), 0.), 24.) * sh;
    col = base * (dif * vec3(1.25, 1.08, .92) * 1.15 + vec3(.07, .10, .22) * occ + bak * vec3(.5, .2, .7) * .55);
    col *= mix(.25, 1., ao) * mix(.35, 1., occ);
    col += spe * vec3(1., .9, .8) * .7 + fre * vec3(.35, .55, 1.) * .45 * ao;
    col = mix(col, bg, smoothstep(6., 9., d));
  } else {
    col += vec3(.25, .4, 1.) * pow(steps / 110., 2.2) * .9;   // 縁の発光
  }
  o = vec4(col, 1.);
}`;

// ---------------------------------------------------------------- 05 風景
const FS_LAND = FS_HEAD + `
const mat2 M2 = mat2(.8, -.6, .6, .8);
vec3 noised(vec2 x){
  vec2 p = floor(x), f = fract(x); vec2 u = f * f * (3. - 2. * f), du = 6. * f * (1. - f);
  float a = hash21(p), b = hash21(p + vec2(1, 0)), c = hash21(p + vec2(0, 1)), d = hash21(p + vec2(1, 1));
  return vec3(a + (b - a) * u.x + (c - a) * u.y + (a - b - c + d) * u.x * u.y, du * (vec2(b - a, c - a) + (a - b - c + d) * u.yx));
}
float terr(vec2 x, int oct){
  vec2 p = x * .0032; float a = 0., b = 1.; vec2 d = vec2(0.);
  for (int i = 0; i < oct; i++) { vec3 n = noised(p); d += n.yz; a += b * n.x / (1. + dot(d, d)); b *= .5; p = M2 * p * 2.; }
  // 進行方向（x=0付近）に谷を通す
  float valley = smoothstep(0., 260., abs(x.x + 60. * sin(x.y * .004)));
  return 150. * a * mix(.28, 1., valley);
}
const float WATER = 44.;
vec3 SUN = normalize(vec3(.18, .16, 1.));
vec3 sky(vec3 rd){
  float sd = max(dot(rd, SUN), 0.);
  vec3 col = mix(vec3(.95, .55, .32), vec3(.16, .26, .52), smoothstep(-.02, .42, rd.y));
  col = mix(col, vec3(.05, .09, .26), smoothstep(.3, 1., rd.y));
  col += vec3(1., .55, .25) * pow(sd, 6.) * .55 + vec3(1., .8, .5) * pow(sd, 90.) * 1.2 + vec3(1., .95, .8) * smoothstep(.9994, .9998, sd) * 30.;
  // 雲
  if (rd.y > .01) {
    vec2 cp = rd.xz / rd.y * 1.2 + vec2(0., uL * .02);
    float cl = 0., am = .5; vec2 q = cp;
    for (int i = 0; i < 4; i++) { cl += am * vnoise(q); q = M2 * q * 2.1; am *= .5; }
    cl = smoothstep(.5, .85, cl) * smoothstep(.01, .16, rd.y);
    col = mix(col, vec3(1., .68, .5) + vec3(.6, .3, .1) * pow(sd, 4.), cl * .6);
  }
  return col;
}
float march(vec3 ro, vec3 rd, float tmax){   // 地形と水面をまとめて1つの面として探す
  float t = 1.;
  for (int i = 0; i < 150; i++) {
    vec3 p = ro + rd * t;
    float h = p.y - max(terr(p.xz, 5), WATER);
    if (h < .0015 * t) return t;
    t += max(h * .5, .0025 * t);
    if (t > tmax) return -1.;
  }
  return t;                                   // 回数切れは地表すれすれ＝命中とみなす
}
vec3 shadeLand(vec3 ro, vec3 rd, float t){
  vec3 p = ro + rd * t;
  float e = .0025 * t + .15;
  vec3 n = normalize(vec3(terr(p.xz - vec2(e, 0), 9) - terr(p.xz + vec2(e, 0), 9), 2. * e, terr(p.xz - vec2(0, e), 9) - terr(p.xz + vec2(0, e), 9)));
  float hgt = p.y;
  vec3 rock = mix(vec3(.11, .09, .08), vec3(.20, .15, .11), vnoise(p.xz * .5));
  // 草地：乾いた色のむら・濃い茂みの斑点・細かい粒
  vec3 grass = mix(vec3(.055, .125, .03), vec3(.16, .15, .05), smoothstep(.35, .75, vnoise(p.xz * .013)));
  float bush = smoothstep(.52, .62, vnoise(p.xz * .09) * .65 + vnoise(p.xz * .45) * .35);
  grass = mix(grass, vec3(.018, .05, .018), bush * .8);
  grass *= .75 + .5 * vnoise(p.xz * 2.3);
  vec3 col = mix(rock, grass, smoothstep(.72, .92, n.y) * (1. - smoothstep(60., 82., hgt)));
  float snow = smoothstep(72., 92., hgt + 18. * vnoise(p.xz * .02)) * smoothstep(.55, .8, n.y);
  col = mix(col, vec3(.75, .78, .85), snow);
  // 影
  float sh = 1., st = 2.;
  for (int i = 0; i < 24; i++) { vec3 sp = p + SUN * st; float h = sp.y - terr(sp.xz, 4); sh = min(sh, 14. * h / st); st += max(h, 3.); if (sh < .01 || st > 500.) break; }
  sh = clamp(sh, 0., 1.);
  float dif = max(dot(n, SUN), 0.) * sh;
  float amb = .5 + .5 * n.y;
  vec3 lit = col * (dif * vec3(1.6, 1.0, .6) * 2.6 + amb * vec3(.18, .26, .46) * .9 + max(dot(n, -SUN * vec3(1, 0, 1)), 0.) * vec3(.3, .2, .15) * .3);
  return lit;
}
vec3 fogged(vec3 col, vec3 rd, float t){
  float sd = max(dot(rd, SUN), 0.);
  vec3 fc = mix(vec3(.30, .36, .52), vec3(1., .62, .34), pow(sd, 5.));
  float f = 1. - exp(-t * .00095);
  return mix(col, fc, f);
}
void main(){
  vec2 p = (FC - .5 * uRes) / uRes.y;
  float t = uL;
  float z = 300. + t * 62.;
  float x = -60. * sin(z * .004);
  float gh = max(terr(vec2(x, z), 3), WATER);
  float gh2 = max(terr(vec2(-60. * sin((z + 60.) * .004), z + 60.), 3), WATER);
  vec3 ro = vec3(x, max(gh, gh2) + 15. + 3. * sin(t * .7), z);
  vec3 ta = ro + vec3(-60. * (sin((z + 120.) * .004) - sin(z * .004)), -6. + 2. * sin(t * .5), 120.);
  vec3 fw = normalize(ta - ro);
  float roll = .06 * sin(t * .6);
  vec3 rt = normalize(cross(fw, vec3(sin(roll), cos(roll), 0))), up = cross(rt, fw);
  vec3 rd = normalize(fw * 1.55 + rt * p.x + up * p.y);
  vec3 col;
  float tmax = 2600.;
  float th = march(ro, rd, tmax);
  if (th > 0.) {
    vec3 hp = ro + rd * th;
    float depth = WATER - terr(hp.xz, 5);
    if (depth > 0.) {
      // 水面：さざ波の法線で空と山を映す。浅いところは地面の色を混ぜる
      vec2 wv = hp.xz * .35 + vec2(uL * .6, uL * .4);
      vec3 wn = normalize(vec3((vnoise(wv) - .5) * .07 + (vnoise(wv * 2.7) - .5) * .04, 1., (vnoise(wv + 31.) - .5) * .07 + (vnoise(wv * 2.7 + 9.) - .5) * .04));
      vec3 rr = reflect(rd, wn); rr.y = abs(rr.y);
      float tr = march(hp + vec3(0, .2, 0), rr, 1400.);
      vec3 refl = tr > 0. ? fogged(shadeLand(hp, rr, tr), rr, tr) : sky(rr);
      float fr = .04 + .96 * pow(1. - max(dot(-rd, wn), 0.), 5.);
      col = mix(vec3(.015, .04, .06), refl, clamp(fr + .25, 0., 1.));
      float shore = smoothstep(0., 1.2, depth);
      if (shore < 1.) col = mix(shadeLand(ro, rd, th) * .55, col, shore);
    } else {
      col = shadeLand(ro, rd, th);
    }
    col = fogged(col, rd, th);
  } else {
    col = sky(rd);
  }
  o = vec4(col * .92, 1.);
}`;

// ---------------------------------------------------------------- 06 無限都市
const FS_CITY = FS_HEAD + `
const float S = 4.;
float bh(vec2 c){ float h = hash21(c); float road = step(abs(c.x + .5), 1.); return (1.2 + 9. * h * h * h + 2.5 * step(.93, h) * 4.) * (1. - road); }
float gSurf;
float sdBox(vec3 p, vec3 b){ vec3 q = abs(p) - b; return length(max(q, 0.)) + min(max(q.x, max(q.y, q.z)), 0.); }
float map(vec3 p){
  vec2 c = floor(p.xz / S); vec2 q = p.xz - (c + .5) * S;
  float h = bh(c);
  float d = h > 0. ? sdBox(vec3(q.x, p.y - h * .5, q.y), vec3(S * .36, h * .5, S * .36)) - .03 : 1e3;
  vec2 b = S * .5 - abs(q);                 // セル境界までの距離（隣の建物を飛び越えない）
  gSurf = min(d, p.y);                      // 実際の面までの距離（命中判定はこちらで行う）
  return min(gSurf, min(b.x, b.y) + .12);
}
vec3 emis(vec3 p, vec3 n){
  vec2 c = floor(p.xz / S); float h = bh(c);
  vec3 hue = pal(hash21(c + 3.) * .35 + .55 + uT * .02, vec3(.5), vec3(.5), vec3(1.), vec3(.0, .33, .67));
  vec3 e = vec3(0.);
  if (p.y < .01) {
    // 道路：走査線とビート波
    vec2 g = abs(fract(p.xz * .5) - .5);
    float ln = smoothstep(.47, .5, max(g.x, g.y));
    float wave = exp(-8. * fract(p.z * .03 - uT * 2.));
    e += vec3(.1, .5, 1.) * ln * (.35 + 2.2 * wave);
    float lane = smoothstep(.06, .0, abs(abs(p.x + 2.) - 1.2)) * step(.5, fract(p.z * .25));
    e += vec3(1., .3, .7) * lane * 1.2;
  } else if (h > 0.) {
    vec2 q = p.xz - (c + .5) * S;
    float side = abs(n.x) > .5 ? q.y : q.x;
    vec2 w = vec2(side * 3.1, p.y * 2.6);
    vec2 wi = floor(w), wf = fract(w);
    float on = step(.62, hash21(wi + c * 17.3));
    float win = smoothstep(.14, .22, wf.x) * smoothstep(.86, .78, wf.x) * smoothstep(.2, .3, wf.y) * smoothstep(.85, .75, wf.y);
    e += mix(hue, vec3(1., .8, .5), step(.8, hash21(wi * 1.7 + c))) * win * on * (.5 + 1.3 * hash21(wi + c)) * step(abs(n.y), .5);
    // 屋上の縁と縦のネオン
    float rim = smoothstep(S * .36 - .16, S * .36 - .06, max(abs(q.x), abs(q.y)));
    float edge = smoothstep(.14, .0, h - p.y) * mix(rim, 1., step(abs(n.y), .5));
    e += hue.zxy * edge * (2. + 3. * uKick);
  }
  return e;
}
vec3 skyc(vec3 rd){
  vec3 col = mix(vec3(.45, .08, .38), vec3(.01, .01, .05), smoothstep(-.05, .45, rd.y));
  col += vec3(1., .35, .25) * exp(-max(rd.y, 0.) * 14.) * .55;
  // 地平線の太陽
  vec2 sp = vec2(rd.x, rd.y - .13) / max(rd.z, .01);
  float sun = smoothstep(.15, .145, length(sp)) * step(0., rd.z);
  float bands = step(.4, fract(sp.y * 22. - uT * .5)) + step(.03, sp.y);
  col += mix(vec3(1., .2, .5), vec3(1., .75, .2), smoothstep(-.15, .15, sp.y)) * sun * clamp(bands, 0., 1.) * 1.5;
  return col;
}
float trace(vec3 ro, vec3 rd, float tmax){
  float t = .02;
  for (int i = 0; i < 140; i++) { float d = map(ro + rd * t); if (gSurf < .0015 * t + .001) return t; t += d; if (t > tmax) break; }
  return -1.;
}
vec3 nrm(vec3 p){ vec2 e = vec2(.004, 0.); return normalize(vec3(map(p + e.xyy) - map(p - e.xyy), map(p + e.yxy) - map(p - e.yxy), map(p + e.yyx) - map(p - e.yyx))); }
vec3 render1(vec3 ro, vec3 rd, out float tt, out vec3 pos, out vec3 n){
  tt = trace(ro, rd, 170.);
  if (tt < 0.) { pos = ro + rd * 170.; n = vec3(0, 1, 0); return skyc(rd); }
  pos = ro + rd * tt; n = pos.y < .01 ? vec3(0, 1, 0) : nrm(pos);
  vec3 col = vec3(.012, .014, .03) * (.5 + .5 * n.y) + emis(pos, n);
  float f = 1. - exp(-tt * .016);
  return mix(col, skyc(rd) * .8 + vec3(.2, .04, .18) * .3, f);
}
void main(){
  vec2 p = (FC - .5 * uRes) / uRes.y;
  float t = uL;
  float z = t * 34. + t * t * 1.2;
  float lift = smoothstep(5.2, 8., t);
  vec3 ro = vec3(-2. + .9 * sin(t * .9), 1.3 + .5 * sin(t * 1.3) + 22. * lift * lift, z);
  vec3 ta = ro + vec3(.6 * sin(t * .7 + 1.), -.18 + .9 * lift, 10.);
  vec3 fw = normalize(ta - ro);
  float roll = .22 * sin(t * .8) * (1. - lift);
  vec3 rt = normalize(cross(fw, vec3(sin(roll), cos(roll), 0))), up = cross(rt, fw);
  vec3 rd = normalize(fw * (1.05 - .08 * uKick) + rt * p.x + up * p.y);
  float tt; vec3 pos, n;
  vec3 col = render1(ro, rd, tt, pos, n);
  if (tt > 0.) {
    // 濡れた路面と壁の反射
    float refl = pos.y < .01 ? .55 : .18;
    vec3 rr = reflect(rd, n);
    if (pos.y < .01) rr = normalize(rr + (hash32(FC) - .5) * .006);
    float t2; vec3 p2, n2;
    vec3 rc = render1(pos + n * .01, rr, t2, p2, n2);
    float fr = refl * (.25 + .75 * pow(1. - max(dot(-rd, n), 0.), 3.));
    col += rc * fr * exp(-tt * .016);
  }
  o = vec4(col, 1.);
}`;

// ---------------------------------------------------------------- 後処理
const FS_BLIT = FS_HEAD + `
uniform sampler2D uTex; uniform float uGain;
void main(){ o = texture(uTex, gl_FragCoord.xy / uRes) * uGain; }`;

const FS_PREFILTER = FS_HEAD + `
uniform sampler2D uTex, uText; uniform vec2 uTexel;
vec3 pre(vec2 uv){ vec3 c = min(texture(uTex, uv).rgb, vec3(40.)); vec4 tx = texture(uText, uv); c = c * (1. - tx.a) + tx.rgb; float br = max(c.r, max(c.g, c.b)); float k = max(br - .78, 0.); return c * k / (br + 1e-4) * (1. / (1. + .08 * br)); }
void main(){
  vec2 uv = gl_FragCoord.xy / uRes;
  vec3 c = pre(uv) * .25;
  c += (pre(uv + uTexel * vec2(-1, -1)) + pre(uv + uTexel * vec2(1, -1)) + pre(uv + uTexel * vec2(-1, 1)) + pre(uv + uTexel * vec2(1, 1))) * .1875;
  o = vec4(c, 1.);
}`;
const FS_DOWN = FS_HEAD + `
uniform sampler2D uTex; uniform vec2 uTexel;
void main(){
  vec2 uv = gl_FragCoord.xy / uRes;
  vec3 c = texture(uTex, uv).rgb * .25;
  c += (texture(uTex, uv + uTexel * vec2(-1, -1)).rgb + texture(uTex, uv + uTexel * vec2(1, -1)).rgb + texture(uTex, uv + uTexel * vec2(-1, 1)).rgb + texture(uTex, uv + uTexel * vec2(1, 1)).rgb) * .1875;
  o = vec4(c, 1.);
}`;
const FS_UP = FS_HEAD + `
uniform sampler2D uTex; uniform vec2 uTexel; uniform float uW;
void main(){
  vec2 uv = gl_FragCoord.xy / uRes; vec2 d = uTexel;
  vec3 c = texture(uTex, uv).rgb * 4.;
  c += (texture(uTex, uv + vec2(d.x, 0)).rgb + texture(uTex, uv - vec2(d.x, 0)).rgb + texture(uTex, uv + vec2(0, d.y)).rgb + texture(uTex, uv - vec2(0, d.y)).rgb) * 2.;
  c += texture(uTex, uv + d).rgb + texture(uTex, uv - d).rgb + texture(uTex, uv + vec2(d.x, -d.y)).rgb + texture(uTex, uv + vec2(-d.x, d.y)).rgb;
  o = vec4(c / 16. * uW, 1.);
}`;
const FS_FINAL = FS_HEAD + `
uniform sampler2D uScene, uBloomTex, uText;
uniform float uBloom, uFlash, uFade, uCA, uSeed;
vec3 aces(vec3 x){ return clamp((x * (2.51 * x + .03)) / (x * (2.43 * x + .59) + .14), 0., 1.); }
void main(){
  vec2 uv = gl_FragCoord.xy / uRes; vec2 d = uv - .5;
  float ca = uCA * dot(d, d);
  vec3 c = min(vec3(texture(uScene, uv + d * ca).r, texture(uScene, uv).g, texture(uScene, uv - d * ca).b), vec3(40.));
  vec4 tx = texture(uText, uv);                 // 文字は色ずれさせずに重ねる
  c = c * (1. - tx.a) + tx.rgb;
  vec3 b = vec3(texture(uBloomTex, uv + d * ca).r, texture(uBloomTex, uv).g, texture(uBloomTex, uv - d * ca).b);
  c += b * uBloom;
  c *= 1. - .42 * smoothstep(.25, .95, length(d * vec2(1.1, 1.25)) * 1.25);
  c *= 1. + 5. * uFlash;                         // 場面転換の閃光：露出を上げてから白を足す
  c += uFlash * uFlash * vec3(1., .96, .92) * 1.3;
  c = aces(c * 1.05);
  c = pow(c, vec3(1. / 2.2));
  c *= uFade;
  c += (hash21(gl_FragCoord.xy + uSeed) - .5) * .012;      // 階調の縞を防ぐための微小ノイズ
  o = vec4(c, 1.);
}`;

// ---------------------------------------------------------------- GL ユーティリティ
function compile(type, src, name) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src); gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    throw new Error(`[${name}] ${gl.getShaderInfoLog(s)}`);
  }
  return s;
}
function program(vs, fs, name) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl.VERTEX_SHADER, vs, name + ':vs'));
  gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs, name + ':fs'));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`[${name}] ${gl.getProgramInfoLog(p)}`);
  const u = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) { const info = gl.getActiveUniform(p, i); u[info.name] = gl.getUniformLocation(p, info.name); }
  return { p, u, name };
}
function target(w, h) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  return { tex, fbo, w, h };
}
function bind(t) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, t ? t.fbo : null);
  gl.viewport(0, 0, t ? t.w : W, t ? t.h : H);
}
const emptyVAO = gl.createVertexArray();
let cur = null;
function use(pr, t, uniforms) {
  gl.useProgram(pr.p); cur = pr;
  if (pr.u.uRes) gl.uniform2f(pr.u.uRes, t ? t.w : W, t ? t.h : H);
  for (const k in uniforms) {
    const loc = pr.u[k]; if (!loc) continue;
    const v = uniforms[k];
    if (typeof v === 'number') gl.uniform1f(loc, v);
    else if (v.length === 2) gl.uniform2f(loc, v[0], v[1]);
    else if (v.length === 3) gl.uniform3f(loc, v[0], v[1], v[2]);
  }
}
function tex(unit, name, texture) {
  gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, texture);
  if (cur.u[name]) gl.uniform1i(cur.u[name], unit);
}
function fullscreen() { gl.bindVertexArray(emptyVAO); gl.drawArrays(gl.TRIANGLES, 0, 3); }

const P = {
  boot: program(VS_FULL, FS_BOOT, 'boot'),
  space: program(VS_FULL, FS_SPACE, 'space'),
  part: program(VS_PART, FS_PART, 'part'),
  lor: program(VS_LOR, FS_LOR, 'lor'),
  julia: program(VS_FULL, FS_JULIA, 'julia'),
  bulb: program(VS_FULL, FS_BULB, 'bulb'),
  land: program(VS_FULL, FS_LAND, 'land'),
  city: program(VS_FULL, FS_CITY, 'city'),
  blit: program(VS_FULL, FS_BLIT, 'blit'),
  pre: program(VS_FULL, FS_PREFILTER, 'pre'),
  down: program(VS_FULL, FS_DOWN, 'down'),
  up: program(VS_FULL, FS_UP, 'up'),
  final: program(VS_FULL, FS_FINAL, 'final'),
};

const sceneRT = target(W, H);
const accumRT = target(W, H);
const lowRT = {};                               // 重い場面は低解像度で描いて拡大する
function lowTarget(scale) {
  const k = String(scale);
  if (!lowRT[k]) lowRT[k] = target(Math.round(W * scale), Math.round(H * scale));
  return lowRT[k];
}
const BLOOM_LEVELS = 6;
const bloomRT = [];
for (let i = 0; i < BLOOM_LEVELS; i++) bloomRT.push(target(Math.max(2, W >> (i + 1)), Math.max(2, H >> (i + 1))));
const bloomUp = [];
for (let i = 0; i < BLOOM_LEVELS - 1; i++) bloomUp.push(target(bloomRT[i].w, bloomRT[i].h));

// ---------------------------------------------------------------- ローレンツ軌道（JSで数値積分）
function buildLorenz() {
  const sigma = 10, rho = 28, beta = 8 / 3;
  const n = LORENZ_TRAJ, steps = LORENZ_STEPS, dt = LORENZ_DT;
  const data = new Float32Array(n * (steps - 1) * 2 * 5);   // GL_LINES 用（線分ごとに2頂点）
  let seed = 12345;
  const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const f = (x, y, z) => [sigma * (y - x), x * (rho - z) - y, x * y - beta * z];
  let k = 0;
  for (let j = 0; j < n; j++) {
    // 各座標のずれは ±LORENZ_SPREAD/2（どの2本を比べても差は LORENZ_SPREAD 以内）
    let x = 1.0 + (rand() - 0.5) * LORENZ_SPREAD;
    let y = 1.0 + (rand() - 0.5) * LORENZ_SPREAD;
    let z = 20.0 + (rand() - 0.5) * LORENZ_SPREAD;
    let px = 0, py = 0, pz = 0;
    for (let i = 0; i < steps; i++) {
      // 4次のルンゲ＝クッタ法
      const k1 = f(x, y, z);
      const k2 = f(x + k1[0] * dt / 2, y + k1[1] * dt / 2, z + k1[2] * dt / 2);
      const k3 = f(x + k2[0] * dt / 2, y + k2[1] * dt / 2, z + k2[2] * dt / 2);
      const k4 = f(x + k3[0] * dt, y + k3[1] * dt, z + k3[2] * dt);
      x += dt / 6 * (k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0]);
      y += dt / 6 * (k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1]);
      z += dt / 6 * (k1[2] + 2 * k2[2] + 2 * k3[2] + k4[2]);
      const wx = x / 24, wy = (z - 25) / 24, wz = y / 24;
      if (i > 0) {
        data[k++] = px; data[k++] = py; data[k++] = pz; data[k++] = j / n; data[k++] = (i - 1) / steps;
        data[k++] = wx; data[k++] = wy; data[k++] = wz; data[k++] = j / n; data[k++] = i / steps;
      }
      px = wx; py = wy; pz = wz;
    }
  }
  const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
  const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 20, 0);
  gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 20, 12);
  gl.bindVertexArray(null);
  return { vao, count: n * (steps - 1) * 2 };
}
const lorenz = buildLorenz();

// ---------------------------------------------------------------- 時間構成
const SCENES = [
  { id: 'boot', start: 0, end: 4 },
  { id: 'particles', start: 4, end: 12 },
  { id: 'lorenz', start: 12, end: 20 },
  { id: 'julia', start: 20, end: 28 },
  { id: 'bulb', start: 28, end: 36 },
  { id: 'land', start: 36, end: 44 },
  { id: 'city', start: 44, end: 52 },
  { id: 'outro', start: 52, end: 60 },
];
const FLASHES = [[4, 1.0], [12, 0.45], [20, 0.45], [28, 0.35], [36, 1.0], [44, 0.55], [52, 0.8]];
const CAPTIONS = {
  particles: ['01', 'PARTICLES', `${N_PARTICLES.toLocaleString('en-US')}個の粒子の位置を、毎フレーム数式から計算`],
  lorenz: ['02', 'LORENZ ATTRACTOR', `初期値のずれは${LORENZ_SPREAD}以内。${LORENZ_TRAJ}本の軌道がやがて別々の道をたどる（カオス）`],
  julia: ['03', 'JULIA SET', `z → z² + c を、画素ごとに最大${JULIA_ITER}回くり返して色を決める`],
  bulb: ['04', 'MANDELBULB', '3Dモデルのデータは無し。光線を少しずつ進めて表面を探すフラクタル'],
  land: ['05', 'PROCEDURAL LANDSCAPE', '山も水面も雲も、乱数ノイズを重ねた数式から生まれる'],
  city: ['06', 'INFINITE CITY', '1棟ぶんの数式を、空間をくり返して無限に並べる'],
};
function kickEnv(t) {
  const on = (t >= 12 && t < 28) || (t >= 36 && t < 52);
  if (!on) return 0;
  return Math.exp(-5.5 * ((t * 2) % 1));
}
const clamp01 = (x) => Math.min(1, Math.max(0, x));
const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };

// ---------------------------------------------------------------- 文字レイヤー（Canvas 2D）
const tcv = document.getElementById('text');
const ctx = tcv.getContext('2d');
const FONT_EN = '"Inter", "IPAPGothic", sans-serif';
const FONT_JP = '"IPAPGothic", "IPAGothic", sans-serif';
const FONT_MONO = '"JetBrains Mono", "IPAGothic", monospace';
const textTex = gl.createTexture();
gl.bindTexture(gl.TEXTURE_2D, textTex);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

function drawCaption(sc, l) {
  const cap = CAPTIONS[sc.id]; if (!cap) return;
  const len = sc.end - sc.start;
  const a = smooth(0.35, 0.95, l) * (1 - smooth(len - 0.6, len - 0.1, l));
  if (a <= 0) return;
  const slide = (1 - smooth(0.35, 1.1, l)) * 28;
  const x = 110, y = H - 150;
  ctx.save();
  ctx.globalAlpha = a;
  ctx.shadowColor = 'rgba(0,0,0,0.85)'; ctx.shadowBlur = 18;
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#7fe3ff';
  ctx.font = `500 26px ${FONT_MONO}`; ctx.letterSpacing = '2px';
  ctx.fillText(cap[0], x + slide, y - 62);
  ctx.fillRect(x + slide + 50, y - 72, 70 * smooth(0.5, 1.3, l), 2);
  ctx.fillStyle = '#ffffff';
  ctx.font = `600 54px ${FONT_EN}`; ctx.letterSpacing = '7px';
  ctx.fillText(cap[1], x + slide * 1.4, y);
  ctx.fillStyle = 'rgba(255,255,255,0.86)';
  ctx.font = `30px ${FONT_JP}`; ctx.letterSpacing = '1.5px';
  ctx.fillText(cap[2], x + slide * 1.8, y + 54);
  ctx.restore();
}
// 文字の下に敷く暗幕（明るい場面でも読めるように）
function drawScrim(sc, l) {
  if (sc.id === 'boot' || sc.id === 'outro') return;
  const len = sc.end - sc.start;
  const a = smooth(0.2, 0.9, l) * (1 - smooth(len - 0.6, len - 0.1, l));
  let g = ctx.createLinearGradient(0, H - 380, 0, H);
  g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(0.55, `rgba(0,0,0,${0.5 * a})`); g.addColorStop(1, `rgba(0,0,0,${0.82 * a})`);
  ctx.fillStyle = g; ctx.fillRect(0, H - 380, W, 380);
  g = ctx.createLinearGradient(0, 0, 0, 170);
  g.addColorStop(0, 'rgba(0,0,0,0.5)'); g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, 170);
}
function drawCounter(frame, t) {
  ctx.save();
  const a = 0.5 * (1 - smooth(57.5, 58.8, t));
  ctx.globalAlpha = a;
  ctx.fillStyle = '#ffffff';
  ctx.font = `400 20px ${FONT_MONO}`; ctx.letterSpacing = '2px';
  ctx.textAlign = 'right';
  ctx.shadowColor = 'rgba(0,0,0,0.8)'; ctx.shadowBlur = 10;
  ctx.fillText(`FRAME ${String(frame + 1).padStart(4, '0')} / ${FPS * DURATION}`, W - 80, 78);
  ctx.textAlign = 'left';
  ctx.fillText('RENDERED BY CODE', 80, 78);
  ctx.restore();
}
const BOOT_CMD = '$ claude "最強の動画を作って"';
const BOOT_T0 = 0.35, BOOT_CPS = 16;                 // 打鍵の開始時刻と速度（audio.js と同じ値）
function drawBootText(l) {
  ctx.save();
  const x = 300, y = 440;
  const a = 1 - smooth(3.55, 3.95, l);
  ctx.globalAlpha = a;
  ctx.textBaseline = 'alphabetic';
  const nch = Math.max(0, Math.min(BOOT_CMD.length, Math.floor((l - BOOT_T0) * BOOT_CPS)));
  ctx.font = `500 60px ${FONT_MONO}`; ctx.letterSpacing = '0px';
  ctx.fillStyle = '#eaf6ff';
  const shown = BOOT_CMD.slice(0, nch);
  ctx.fillText(shown, x, y);
  const cw = ctx.measureText(shown).width;
  const typing = nch < BOOT_CMD.length && l > BOOT_T0;
  if (typing || Math.floor(l * 2.5) % 2 === 0) { ctx.fillStyle = '#7fe3ff'; ctx.fillRect(x + cw + 6, y - 52, 30, 62); }
  const lines = [
    [1.95, 'images: 0    footage: 0    audio samples: 0', '#7fe3ff', `400 34px ${FONT_MONO}`],
    [2.75, '→ 映像も音も、すべてコードから生成します', '#ffffff', `36px ${FONT_JP}`],
  ];
  lines.forEach(([t0, s, color, font], i) => {
    const la = smooth(t0, t0 + 0.25, l);
    if (la <= 0) return;
    ctx.globalAlpha = a * la;
    ctx.fillStyle = color; ctx.font = font; ctx.letterSpacing = '1px';
    ctx.fillText(s, x, y + 100 + i * 74);
  });
  ctx.restore();
}
function drawOutroText(l) {
  ctx.save();
  ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  ctx.shadowColor = 'rgba(0,0,0,0.9)'; ctx.shadowBlur = 30;
  const cx = W / 2;
  const a1 = smooth(0.5, 1.3, l);
  ctx.globalAlpha = a1; ctx.fillStyle = '#ffffff';
  ctx.font = `700 150px ${FONT_EN}`; ctx.letterSpacing = `${18 + 16 * smooth(0.5, 7.5, l)}px`;
  ctx.fillText('ALL CODE.', cx + 12, 460);
  const a2 = smooth(1.7, 2.4, l);
  ctx.globalAlpha = a2; ctx.fillStyle = '#7fe3ff';
  ctx.font = `500 40px ${FONT_MONO}`; ctx.letterSpacing = '3px';
  ctx.fillText('images 0   /   footage 0   /   audio samples 0', cx, 570);
  const a3 = smooth(2.7, 3.4, l);
  ctx.globalAlpha = a3; ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.font = `38px ${FONT_JP}`; ctx.letterSpacing = '3px';
  ctx.fillText(`${(FPS * DURATION).toLocaleString('en-US')}フレームの映像も、音楽も、プログラムだけで生成`, cx, 660);
  const a4 = smooth(3.9, 4.6, l);
  ctx.globalAlpha = a4 * 0.75; ctx.fillStyle = '#ffffff';
  ctx.font = `500 28px ${FONT_EN}`; ctx.letterSpacing = '8px';
  ctx.fillText('GENERATED WITH CLAUDE CODE', cx, 790);
  ctx.restore();
}

// ---------------------------------------------------------------- 場面の描画
function drawFullscreenScene(pr, uni, scale) {
  if (scale && scale < 1) {
    const lt = lowTarget(scale);
    bind(lt); use(pr, lt, uni); fullscreen();
    bind(sceneRT); use(P.blit, sceneRT, { uGain: 1 }); tex(0, 'uTex', lt.tex); fullscreen();
  } else {
    bind(sceneRT); use(pr, sceneRT, uni); fullscreen();
  }
}
function drawParticles(uni, mode) {
  bind(sceneRT);
  gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
  use(P.part, sceneRT, Object.assign({}, uni, { uMode: mode, uCount: N_PARTICLES }));
  gl.bindVertexArray(emptyVAO);
  gl.drawArrays(gl.POINTS, 0, N_PARTICLES);
  gl.disable(gl.BLEND);
}
const JITTER = [[0.125, 0.375], [-0.375, 0.125], [0.375, -0.125], [-0.125, -0.375]];
const SHUTTER = 0.5;                              // 露光時間（1フレームの半分）＝モーションブラーの長さ
function drawLorenz(uni, l) {
  bind(sceneRT);
  gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
  gl.bindVertexArray(lorenz.vao);
  JITTER.forEach((j, k) => {                      // 位置と時刻を少しずつずらして重ね、線のギザギザを消す
    const lk = l + (k / JITTER.length) * SHUTTER / FPS;
    // 最初はゆっくり1本に見え、後半で一気に広がる
    const head = 0.02 + 0.98 * Math.pow(clamp01(lk / 7.6), 1.55);
    // 序盤は150本がほぼ重なるので、その分だけ1本あたりを暗くする
    const gain = 0.08 + 0.92 * smooth(0.24, 0.62, head);
    use(P.lor, sceneRT, Object.assign({}, uni, { uL: lk, uHead: head, uGain: gain, uJit: [j[0] * 2 / W, j[1] * 2 / H] }));
    gl.drawArrays(gl.LINES, 0, lorenz.count);
  });
  gl.disable(gl.BLEND);
}

const QUALITY = { bulb: 1, land: 0.75, city: 1 }; // 重い場面の内部解像度（1 = フルHD、0.75 = 1440×810で描いて拡大）

// 1フレームを何回に分けて描くか（時刻と画素位置を少しずつずらして平均する）
const SUBFRAMES = { boot: 1, particles: 2, lorenz: 1, julia: 1, bulb: 2, land: 2, city: 3, outro: 2 };
const POST = {
  boot: { bloom: 0.7, ca: 0.012 }, particles: { bloom: 1.1, ca: 0.012 }, lorenz: { bloom: 1.2, ca: 0.012 },
  julia: { bloom: 0.42, ca: 0.016 }, bulb: { bloom: 0.55, ca: 0.012 }, land: { bloom: 0.42, ca: 0.008 },
  city: { bloom: 0.8, ca: 0.018 }, outro: { bloom: 0.9, ca: 0.012 },
};
function drawScene(sc, t, jit) {
  const l = t - sc.start;
  const uni = { uT: t, uL: l, uKick: kickEnv(t), uJ: jit };
  gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST);
  switch (sc.id) {
    case 'boot':
      drawFullscreenScene(P.boot, uni); break;
    case 'particles':
      drawFullscreenScene(P.space, Object.assign({ uTint: [0.35, 0.5, 1.0] }, uni));
      drawParticles(uni, 0); break;
    case 'lorenz':
      drawFullscreenScene(P.space, Object.assign({ uTint: [0.7, 0.35, 0.9] }, uni));
      drawLorenz(uni, l); break;
    case 'julia':
      drawFullscreenScene(P.julia, uni); break;
    case 'bulb':
      drawFullscreenScene(P.bulb, Object.assign({ uPow: 8.0 + 1.0 * Math.sin(l * 0.5 - 0.6) }, uni), QUALITY.bulb); break;
    case 'land':
      drawFullscreenScene(P.land, uni, QUALITY.land); break;
    case 'city':
      drawFullscreenScene(P.city, uni, QUALITY.city); break;
    case 'outro':
      drawFullscreenScene(P.space, Object.assign({ uTint: [0.3, 0.5, 1.0] }, uni));
      drawParticles(uni, 1); break;
  }
}
const SUBJIT = [[0, 0], [0.5, 0.33], [-0.25, -0.33], [0.25, 0.11]];

function renderFrame(frame) {
  const t = frame / FPS;
  const sc = SCENES.find((s) => t >= s.start && t < s.end) || SCENES[SCENES.length - 1];
  const l = t - sc.start;
  const { bloom, ca } = POST[sc.id];

  const n = Math.max(1, Math.round(SUBFRAMES[sc.id] * (window.FILM.subframeScale || 1)));
  let scene = sceneRT;
  if (n === 1) {
    drawScene(sc, t, [0, 0]);
  } else {
    for (let k = 0; k < n; k++) {
      const tk = Math.min(t + (k / n) * SHUTTER / FPS, sc.end - 1e-4);
      drawScene(sc, tk, SUBJIT[k % SUBJIT.length]);
      bind(accumRT);
      if (k > 0) { gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE); }
      use(P.blit, accumRT, { uGain: 1 / n }); tex(0, 'uTex', sceneRT.tex); fullscreen();
      gl.disable(gl.BLEND);
    }
    scene = accumRT;
  }

  // 文字レイヤー（Canvas 2D → テクスチャ）
  ctx.clearRect(0, 0, W, H);
  drawScrim(sc, l);
  if (sc.id === 'boot') drawBootText(l);
  else if (sc.id === 'outro') drawOutroText(l);
  else drawCaption(sc, l);
  drawCounter(frame, t);
  gl.activeTexture(gl.TEXTURE2);
  gl.bindTexture(gl.TEXTURE_2D, textTex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, tcv);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);

  // ブルーム（明るい部分のにじみ）
  bind(bloomRT[0]); use(P.pre, bloomRT[0], { uTexel: [1 / W, 1 / H] }); tex(0, 'uTex', scene.tex); tex(2, 'uText', textTex); fullscreen();
  for (let i = 1; i < BLOOM_LEVELS; i++) {
    bind(bloomRT[i]); use(P.down, bloomRT[i], { uTexel: [1 / bloomRT[i - 1].w, 1 / bloomRT[i - 1].h] });
    tex(0, 'uTex', bloomRT[i - 1].tex); fullscreen();
  }
  let src = bloomRT[BLOOM_LEVELS - 1];
  for (let i = BLOOM_LEVELS - 2; i >= 0; i--) {
    const dst = bloomUp[i];
    bind(dst); use(P.blit, dst, { uGain: 1 }); tex(0, 'uTex', bloomRT[i].tex); fullscreen();
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
    use(P.up, dst, { uTexel: [1 / src.w, 1 / src.h], uW: 0.85 }); tex(0, 'uTex', src.tex); fullscreen();
    gl.disable(gl.BLEND);
    src = dst;
  }

  // 合成
  let flash = 0;
  for (const [ft, fs] of FLASHES) if (t >= ft) flash += fs * Math.exp(-(t - ft) * 5.5);
  if (flash < 0.004) flash = 0;
  const fade = smooth(0, 0.4, t) * (1 - smooth(58.4, 59.7, t));
  bind(null);
  use(P.final, null, { uBloom: bloom, uFlash: flash, uFade: fade, uCA: ca, uSeed: frame * 17.13 });
  tex(0, 'uScene', scene.tex); tex(1, 'uBloomTex', src.tex); tex(2, 'uText', textTex);
  fullscreen();
  gl.finish();
}

window.FILM = { W, H, FPS, DURATION, FRAMES: FPS * DURATION, SCENES, QUALITY, BOOT_CMD, BOOT_T0, BOOT_CPS };
window.renderFrame = renderFrame;
window.filmReady = document.fonts.ready.then(() => Promise.all([
  document.fonts.load(`600 54px ${FONT_EN}`), document.fonts.load(`500 60px ${FONT_MONO}`), document.fonts.load(`30px ${FONT_JP}`),
])).then(() => true);
})();
