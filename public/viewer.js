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

// UI状態復元用: 復元直後はメッシュ未ロードで断面位置を計算できないため、
// 最初のSTLロード後に一度だけapplyClipし直す
let clipRestorePending = false;
// 復元したファイル別表示状態（エントリ生成時に参照）
let savedFileVisibility = null;

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

// 十字ボタン: 押している間だけそのビューの視点が回る。マウスドラッグより
// 狙った角度に合わせやすい。回転はOrbitControlsと同じ球面座標系で行い、
// 極（真上・真下）の手前でクランプして反転を防ぐ。
const DPAD_SPEED = 1.4;   // rad/s
function rotateView(v, dTheta, dPhi) {
  const offset = v.camera.position.clone().sub(v.controls.target);
  // camera.up を Y+ に合わせる座標系で球面座標に変換（OrbitControlsと同じ手法）
  const quat = new THREE.Quaternion().setFromUnitVectors(v.camera.up, new THREE.Vector3(0, 1, 0));
  offset.applyQuaternion(quat);
  const sph = new THREE.Spherical().setFromVector3(offset);
  sph.theta += dTheta;
  sph.phi = Math.max(0.05, Math.min(Math.PI - 0.05, sph.phi + dPhi));
  offset.setFromSpherical(sph);
  offset.applyQuaternion(quat.clone().invert());
  v.camera.position.copy(v.controls.target).add(offset);
  v.camera.lookAt(v.controls.target);
  v.controls.update();
  scheduleSave();
}

function makeDpad(v) {
  const pad = document.createElement('div');
  pad.className = 'dpad';
  // [表示, グリッド列, 行, theta方向, phi方向]
  const DIRS = [
    ['▲', 2, 1, 0, -1],
    ['◀', 1, 2, +1, 0],
    ['▶', 3, 2, -1, 0],
    ['▼', 2, 3, 0, +1],
  ];
  for (const [glyph, col, row, dt, dp] of DIRS) {
    const b = document.createElement('button');
    b.textContent = glyph;
    b.style.gridColumn = col;
    b.style.gridRow = row;
    b.addEventListener('pointerdown', (ev) => {
      // OrbitControlsのドラッグ開始に化けないよう遮断
      ev.stopPropagation();
      ev.preventDefault();
      try { b.setPointerCapture(ev.pointerId); } catch { /* 合成イベント等でIDが無効でも回転は動かす */ }
      let active = true;
      let last = performance.now();
      const stop = () => { active = false; };
      b.addEventListener('pointerup', stop, { once: true });
      b.addEventListener('pointercancel', stop, { once: true });
      const loop = (now) => {
        if (!active) return;
        const dtSec = Math.min((now - last) / 1000, 0.05);
        last = now;
        rotateView(v, dt * DPAD_SPEED * dtSec, dp * DPAD_SPEED * dtSec);
        render();
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    });
    pad.appendChild(b);
  }
  return pad;
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
    controls.addEventListener('change', scheduleSave);
    const v = { el, camera, controls, key };
    el.appendChild(makeDpad(v));
    views.push(v);
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
      scheduleSave();
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
    if (clipRestorePending) { clipRestorePending = false; applyClip(); }
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
      const vis = savedFileVisibility && f.path in savedFileVisibility
        ? !!savedFileVisibility[f.path] : true;
      e = { mesh: null, material: null, visible: vis, color: PALETTE[colorIdx++ % PALETTE.length], mtime: -2, error: null };
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

// ---- UI状態の保存・復元 ----
// カメラ・ビュー分割・表示設定・描き込みをサーバーへ自動保存（デバウンス）し、
// ページを開いたときに自動復元する。セッション中断でBrowserペインが閉じても、
// 次に開けば見ていた状態に戻る。保存先は監視ディレクトリ別（server.jsの/state）。

function captureState() {
  return {
    viewcount: Number(document.getElementById('viewcount').value),
    cameras: views.map((v) => ({
      pos: v.camera.position.toArray(),
      target: v.controls.target.toArray(),
      up: v.camera.up.toArray(),
    })),
    files: Object.fromEntries([...entries].map(([p, e]) => [p, e.visible])),
    wire: document.getElementById('wire').checked,
    plate: document.getElementById('plate').checked,
    axes: document.getElementById('axes').checked,
    autorot: document.getElementById('autorot').checked,
    clip: { axis: clipAxisSel.value, pos: Number(clipPosInput.value) },
    anno: window.__annoState ? window.__annoState.get() : null,
  };
}

let saveTimer = null;
let restoring = false;
function scheduleSave() {
  if (restoring) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fetch('/state', { method: 'POST', body: JSON.stringify(captureState()) }).catch(() => {});
  }, 500);
}
// ペイン閉鎖・タブ切替時はデバウンスを待たずに送る（sendBeaconはアンロード中も届く）
function flushSave() {
  if (restoring) return;
  clearTimeout(saveTimer);
  try { navigator.sendBeacon('/state', JSON.stringify(captureState())); } catch {}
}
window.addEventListener('pagehide', flushSave);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushSave();
});

for (const id of ['viewcount', 'wire', 'plate', 'axes', 'autorot', 'clip-axis']) {
  document.getElementById(id).addEventListener('change', scheduleSave);
}
clipPosInput.addEventListener('input', scheduleSave);
if (window.__annoState) window.__annoState.onChange(scheduleSave);

async function restoreState() {
  const res = await fetch('/state');
  const { state } = await res.json();
  if (!state || typeof state !== 'object') return false;
  restoring = true;
  try {
    // チェックボックス類（buildViewsがautorotを読むため先に反映）
    for (const id of ['wire', 'plate', 'axes', 'autorot']) {
      if (typeof state[id] === 'boolean') document.getElementById(id).checked = state[id];
    }
    plate.visible = document.getElementById('plate').checked;
    axes.visible = document.getElementById('axes').checked;

    // ビュー分割とカメラ
    const n = LAYOUTS[state.viewcount] ? state.viewcount : 1;
    document.getElementById('viewcount').value = String(n);
    buildViews(n);
    const cams = Array.isArray(state.cameras) ? state.cameras : [];
    cams.forEach((c, i) => {
      const v = views[i];
      if (!v || !c) return;
      if (Array.isArray(c.up)) v.camera.up.fromArray(c.up);
      if (Array.isArray(c.pos)) v.camera.position.fromArray(c.pos);
      if (Array.isArray(c.target)) v.controls.target.fromArray(c.target);
      v.camera.lookAt(v.controls.target);
      v.controls.update();
    });
    // 復元したカメラを初回STLロードのresetViewsで潰さない
    if (cams.length > 0) hasFit = true;

    // ファイル別表示（エントリはWebSocketのリスト受信時に作られるので参照用に保持）
    if (state.files && typeof state.files === 'object') savedFileVisibility = state.files;

    // 断面（位置はメッシュのバウンディングボックス依存なので初回ロード後に適用）
    if (state.clip && typeof state.clip === 'object') {
      clipAxisSel.value = ['x', 'y', 'z'].includes(state.clip.axis) ? state.clip.axis : '';
      const pos = Number(state.clip.pos);
      if (Number.isFinite(pos)) clipPosInput.value = String(Math.max(0, Math.min(100, pos)));
      if (clipAxisSel.value) clipRestorePending = true;
    }

    // 描き込み・指摘リスト
    if (state.anno && window.__annoState) window.__annoState.set(state.anno);
  } finally {
    restoring = false;
  }
  // 自動回転はrAFループの起動が要るので既存ハンドラを発火させる
  if (document.getElementById('autorot').checked) {
    document.getElementById('autorot').dispatchEvent(new Event('change'));
  }
  render();
  return true;
}

(async () => {
  let restored = false;
  try { restored = await restoreState(); } catch {}
  if (!restored) buildViews(Number(document.getElementById('viewcount').value));
  resize();
  connect();
})();
