import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';

const PALETTE = [0x4f8ef7, 0xf7a84f, 0x5ec46b, 0xd96bc4, 0x50c8c8, 0xc4c45e, 0x9a7ff7, 0xf76b6b];

const wrap = document.getElementById('canvas-wrap');
const dimsEl = document.getElementById('dims');
const statusEl = document.getElementById('status');
const filelistEl = document.getElementById('filelist');
const clipAxisSel = document.getElementById('clip-axis');
const clipPosInput = document.getElementById('clip-pos');

const viewsEl = document.getElementById('views');

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.localClippingEnabled = true;
renderer.domElement.id = 'gl';
renderer.setClearColor(0x3a3f46);   // ビュー間の隙間＝区切り線の色
wrap.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a1d21);

scene.add(new THREE.AmbientLight(0xffffff, 0.45));
const keyLight = new THREE.DirectionalLight(0xffffff, 1.0);
keyLight.position.set(1, -1, 2);
scene.add(keyLight);
const fillLight = new THREE.DirectionalLight(0xffffff, 0.4);
fillLight.position.set(-1, 1, 0.5);
scene.add(fillLight);

// ビルドプレート 180×180（XY平面・原点中心）
const plate = new THREE.Group();
const grid = new THREE.GridHelper(180, 18, 0x555b63, 0x33383f);
grid.rotation.x = Math.PI / 2;
plate.add(grid);
scene.add(plate);

// 座標軸: 原点を両方向に貫く直線（X赤・Y緑・Z青。Zは上下に貫通）
const axes = new THREE.Group();
function axisLine(dx, dy, dz, from, to, color) {
  const geo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(dx * from, dy * from, dz * from),
    new THREE.Vector3(dx * to, dy * to, dz * to),
  ]);
  return new THREE.Line(geo, new THREE.LineBasicMaterial({ color }));
}
axes.add(axisLine(1, 0, 0, -100, 100, 0xe05555));
axes.add(axisLine(0, 1, 0, -100, 100, 0x55b060));
axes.add(axisLine(0, 0, 1, -40, 150, 0x4f8ef7));
scene.add(axes);

const entries = new Map(); // path -> {mesh, material, visible, color, mtime, error}
// 単体表示は白、複数を並行表示するときだけパレット色で塗り分ける
const SINGLE_COLOR = 0xf2f2f2;
function effColor(e) {
  return entries.size === 1 ? SINGLE_COLOR : e.color;
}
function applyColors() {
  for (const e of entries.values()) {
    if (e.material) e.material.color.setHex(effColor(e));
  }
}
let clipPlane = null;
let colorIdx = 0;
let hasFit = false;
const loader = new STLLoader();

// マルチビュー: 1枚のキャンバスをシザーで分割し、視点ごとに描画する。
// 複数アングルが1枚のスクリーンショットに収まるので、各ビューに描き込んだ
// 指示をまとめてClaudeへ渡せる。
// ラベルは「ビュー1…」の通し番号。各ビューは自由に回せるので、
// 方角名にすると回した時点で嘘になる（初期の向きだけをdirで決める）。
const PRESETS = {
  iso: { dir: [1, -1, 0.8], up: [0, 0, 1] },
  front: { dir: [0, -1, 0], up: [0, 0, 1] },
  right: { dir: [1, 0, 0], up: [0, 0, 1] },
  top: { dir: [0, 0, 1], up: [0, 1, 0] },
};
const LAYOUTS = { 1: ['iso'], 2: ['iso', 'front'], 4: ['iso', 'front', 'right', 'top'] };
const views = [];
window.__views = views;   // 検証用フック

// オンデマンド描画（rAF連続ループは使わない。Browserペインのバックグラウンド凍結対策）
function render() {
  const wrapRect = wrap.getBoundingClientRect();
  renderer.setScissorTest(false);
  renderer.clear();                 // 隙間を区切り線の色で塗る
  renderer.setScissorTest(true);
  for (const v of views) {
    const r = v.el.getBoundingClientRect();
    const w = Math.floor(r.width), h = Math.floor(r.height);
    if (w <= 0 || h <= 0) continue;
    const left = Math.floor(r.left - wrapRect.left);
    const bottom = Math.floor(wrapRect.bottom - r.bottom);   // WebGLは左下原点
    renderer.setViewport(left, bottom, w, h);
    renderer.setScissor(left, bottom, w, h);
    v.camera.aspect = w / h;
    v.camera.updateProjectionMatrix();
    renderer.render(scene, v.camera);
  }
}

// OrbitControlsの回転・パン量は domElement.clientHeight で正規化されるため、
// 分割してペインが小さくなるほど過敏になる（4分割だと2倍速で、少し引くだけで
// 極を越えて上下左右が反転して見える）。ビュー全体の高さを基準に正規化し直し、
// 分割数によらず1画面と同じ操作感にする。
function tuneControls() {
  const ref = wrap.clientHeight || 800;
  for (const v of views) {
    const h = v.el.clientHeight || ref;
    v.controls.rotateSpeed = h / ref;
    v.controls.panSpeed = h / ref;
    // 真上・真下（極）に張り付くと方位角が退化して操作不能になるので少し手前で止める
    v.controls.minPolarAngle = 0.05;
    v.controls.maxPolarAngle = Math.PI - 0.05;
  }
}

function resize() {
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(wrap.clientWidth, wrap.clientHeight);
  tuneControls();
  render();
}
window.addEventListener('resize', resize);

function visibleBBox() {
  const box = new THREE.Box3();
  let any = false;
  for (const e of entries.values()) {
    if (e.mesh && e.visible) { box.expandByObject(e.mesh); any = true; }
  }
  return any ? box : null;
}

function updateDims() {
  const box = visibleBBox();
  if (!box) { dimsEl.textContent = '—'; return; }
  const s = box.getSize(new THREE.Vector3());
  dimsEl.textContent = `${s.x.toFixed(1)} × ${s.y.toFixed(1)} × ${s.z.toFixed(1)} mm`;
}

function frame(v, dir) {
  const box = visibleBBox();
  const center = box ? box.getCenter(new THREE.Vector3()) : new THREE.Vector3(0, 0, 20);
  const radius = box
    ? Math.max(...box.getSize(new THREE.Vector3()).toArray(), 10)
    : 60;
  v.camera.position.copy(center.clone().add(dir.clone().normalize().multiplyScalar(radius * 2.2)));
  v.controls.target.copy(center);
  v.controls.update();
}

// 全体表示: 各ビューの向きは保ったまま、モデル全体が入るように寄り引きする
function fitView() {
  for (const v of views) {
    frame(v, v.camera.position.clone().sub(v.controls.target));
  }
  render();
}

// 視点リセット: 各ビューをプリセット（斜め/正面/右/上）の向きに戻す
function resetViews() {
  for (const v of views) {
    const p = PRESETS[v.key];
    v.camera.up.set(...p.up);
    frame(v, new THREE.Vector3(...p.dir));
  }
  render();
}

function buildViews(n) {
  for (const v of views) v.controls.dispose();
  views.length = 0;
  viewsEl.textContent = '';
  viewsEl.className = 'n' + n;
  const autoRot = document.getElementById('autorot').checked;
  LAYOUTS[n].forEach((key, i) => {
    const el = document.createElement('div');
    el.className = 'view';
    const lab = document.createElement('div');
    lab.className = 'view-label';
    lab.textContent = 'ビュー' + (i + 1);
    el.appendChild(lab);
    viewsEl.appendChild(el);
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 5000);
    const controls = new OrbitControls(camera, el);
    controls.autoRotate = autoRot;
    controls.addEventListener('change', render);
    views.push({ el, camera, controls, key });
  });
  tuneControls();
  resetViews();
}

function applyClip() {
  const axis = clipAxisSel.value;
  if (!axis) {
    clipPlane = null;
  } else {
    const box = visibleBBox() || new THREE.Box3(new THREE.Vector3(-90, -90, 0), new THREE.Vector3(90, 90, 180));
    const t = Number(clipPosInput.value) / 100;
    const pos = box.min[axis] + (box.max[axis] - box.min[axis]) * t;
    const normal = { x: new THREE.Vector3(-1, 0, 0), y: new THREE.Vector3(0, -1, 0), z: new THREE.Vector3(0, 0, -1) }[axis];
    clipPlane = new THREE.Plane(normal, pos);
  }
  for (const e of entries.values()) {
    if (e.material) e.material.clippingPlanes = clipPlane ? [clipPlane] : [];
  }
  render();
}

function renderSidebar() {
  applyColors();
  filelistEl.textContent = '';
  if (entries.size === 0) { filelistEl.textContent = '（STL待機中…）'; return; }
  for (const [p, e] of [...entries.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = e.visible;
    cb.onchange = () => {
      e.visible = cb.checked;
      if (e.mesh) e.mesh.visible = e.visible;
      updateDims();
      applyClip();
    };
    const sw = document.createElement('span');
    sw.className = 'swatch';
    sw.style.background = '#' + effColor(e).toString(16).padStart(6, '0');
    label.append(cb, sw, document.createTextNode(p + (e.error ? ' ⚠' : '')));
    if (e.error) { label.classList.add('err'); label.title = e.error; }
    filelistEl.append(label);
  }
}

async function loadFile(f) {
  const e = entries.get(f.path);
  e.mtime = f.mtime;
  try {
    const url = '/files/' + f.path.split('/').map(encodeURIComponent).join('/') + '?t=' + f.mtime;
    const res = await fetch(url);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const geo = loader.parse(await res.arrayBuffer());
    geo.computeVertexNormals();
    if (e.mesh) { scene.remove(e.mesh); e.mesh.geometry.dispose(); }
    if (!e.material) {
      e.material = new THREE.MeshStandardMaterial({
        color: effColor(e), roughness: 0.6, metalness: 0.05, side: THREE.DoubleSide,
        wireframe: document.getElementById('wire').checked,
        clippingPlanes: clipPlane ? [clipPlane] : [],
      });
    }
    e.mesh = new THREE.Mesh(geo, e.material);
    e.mesh.visible = e.visible;
    scene.add(e.mesh);
    e.error = null;
    if (!hasFit) { hasFit = true; resetViews(); }
  } catch (err) {
    // パース失敗（書き込み競合等）: 旧メッシュは残し、次のリスト受信で再試行
    e.error = String((err && err.message) || err);
    e.mtime = -1;
  }
  renderSidebar();
  updateDims();
  render();
}

function handleList(files) {
  const seen = new Set();
  for (const f of files) {
    seen.add(f.path);
    let e = entries.get(f.path);
    if (!e) {
      e = { mesh: null, material: null, visible: true, color: PALETTE[colorIdx++ % PALETTE.length], mtime: -2, error: null };
      entries.set(f.path, e);
    }
    if (f.mtime !== e.mtime) loadFile(f);
  }
  for (const [p, e] of entries) {
    if (!seen.has(p)) {
      if (e.mesh) { scene.remove(e.mesh); e.mesh.geometry.dispose(); }
      if (e.material) e.material.dispose();
      entries.delete(p);
    }
  }
  renderSidebar();
  updateDims();
  render();
}

function connect() {
  const ws = new WebSocket(`ws://${location.host}`);
  ws.onopen = () => { statusEl.textContent = '監視中'; };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'list') handleList(msg.files);
  };
  ws.onclose = () => {
    statusEl.textContent = '切断 — 再接続中…';
    setTimeout(connect, 2000);
  };
}

document.getElementById('fit').onclick = fitView;
document.getElementById('resetview').onclick = resetViews;
document.getElementById('viewcount').onchange = (ev) => buildViews(Number(ev.target.value));
document.getElementById('wire').onchange = (ev) => {
  for (const e of entries.values()) {
    if (e.material) e.material.wireframe = ev.target.checked;
  }
  render();
};
document.getElementById('plate').onchange = (ev) => {
  plate.visible = ev.target.checked;
  render();
};
document.getElementById('axes').onchange = (ev) => {
  axes.visible = ev.target.checked;
  render();
};
// 自動回転: ONの間だけrAFループを回す（通常はオンデマンド描画を維持）。
// Browserペインがバックグラウンドの間はrAFが止まり回転も止まる（仕様）。
document.getElementById('autorot').onchange = (ev) => {
  const on = ev.target.checked;
  for (const v of views) v.controls.autoRotate = on;
  if (on) {
    const loop = () => {
      if (!views.some((v) => v.controls.autoRotate)) return;
      for (const v of views) v.controls.update();   // autoRotateが視点を進める
      render();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }
};
clipAxisSel.onchange = applyClip;
clipPosInput.oninput = applyClip;

buildViews(Number(document.getElementById('viewcount').value));
resize();
connect();
