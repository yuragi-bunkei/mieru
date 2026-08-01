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

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.localClippingEnabled = true;
wrap.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a1d21);

// 3Dプリントの慣習に合わせZ-up
const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 5000);
camera.up.set(0, 0, 1);
camera.position.set(160, -160, 120);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0, 20);
controls.addEventListener('change', render);

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
plate.add(new THREE.AxesHelper(20));
scene.add(plate);

const entries = new Map(); // path -> {mesh, material, visible, color, mtime, error}
let clipPlane = null;
let colorIdx = 0;
let hasFit = false;
const loader = new STLLoader();

// オンデマンド描画（rAF連続ループは使わない。Browserペインのバックグラウンド凍結対策）
function render() { renderer.render(scene, camera); }

function resize() {
  const w = wrap.clientWidth, h = wrap.clientHeight;
  renderer.setSize(w, h);
  renderer.setPixelRatio(window.devicePixelRatio);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
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

function fitView() {
  const box = visibleBBox();
  if (!box) return;
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const radius = Math.max(size.x, size.y, size.z, 10);
  const dir = camera.position.clone().sub(controls.target).normalize();
  camera.position.copy(center.clone().add(dir.multiplyScalar(radius * 2.2)));
  controls.target.copy(center);
  controls.update();
  render();
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
    sw.style.background = '#' + e.color.toString(16).padStart(6, '0');
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
        color: e.color, roughness: 0.6, metalness: 0.05, side: THREE.DoubleSide,
        wireframe: document.getElementById('wire').checked,
        clippingPlanes: clipPlane ? [clipPlane] : [],
      });
    }
    e.mesh = new THREE.Mesh(geo, e.material);
    e.mesh.visible = e.visible;
    scene.add(e.mesh);
    e.error = null;
    if (!hasFit) { hasFit = true; fitView(); }
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
// 自動回転: ONの間だけrAFループを回す（通常はオンデマンド描画を維持）。
// Browserペインがバックグラウンドの間はrAFが止まり回転も止まる（仕様）。
document.getElementById('autorot').onchange = (ev) => {
  controls.autoRotate = ev.target.checked;
  if (controls.autoRotate) {
    const loop = () => {
      if (!controls.autoRotate) return;
      controls.update();   // autoRotateが視点を進め、changeイベント経由でrenderされる
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }
};
clipAxisSel.onchange = applyClip;
clipPosInput.oninput = applyClip;

resize();
connect();
