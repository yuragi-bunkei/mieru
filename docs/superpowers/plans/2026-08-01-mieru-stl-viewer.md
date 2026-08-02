# mieru STLライブビューア Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 監視ディレクトリ内のSTLを常時表示し、更新の瞬間に自動リロードするローカルWebビューアを作る。

**Architecture:** 素の `node:http` + `ws` + `chokidar` の単一サーバー（`server.js`）が、静的ページ・three.js（node_modulesを `/vendor/three/` で配信）・監視ディレクトリのSTL（`/files/`）を配信し、ファイル変更をWebSocketで全クライアントに通知する。クライアントは three.js の1ページ（`public/`）で、オンデマンド描画（rAF連続ループなし）。ビルドレス・importmap方式。

**Tech Stack:** Node.js (CommonJS, node:test), ws, chokidar, three (STLLoader / OrbitControls, ES Modules + importmap)

**規約:** 仕様は `docs/superpowers/specs/2026-08-01-mieru-stl-viewer-design.md`。ポートは5301デフォルト。日本語UI。

---

### Task 1: プロジェクト雛形と依存導入

**Files:**
- Create: `package.json`
- Create: `.gitignore`

- [ ] **Step 1: package.json を作成**

```json
{
  "name": "mieru",
  "version": "0.1.0",
  "private": true,
  "description": "STL live viewer for 3D print modeling with Claude Code",
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "test": "node --test test/"
  }
}
```

- [ ] **Step 2: .gitignore を作成**

```
node_modules/
```

- [ ] **Step 3: 依存をインストール**

Run: `cd ~/dev/mieru && npm install ws chokidar three`
Expected: `package.json` に dependencies が追記され、`package-lock.json` が生成される。エラーなし。

- [ ] **Step 4: three の配信対象ファイルの存在確認**

Run: `ls node_modules/three/build/three.module.js node_modules/three/examples/jsm/loaders/STLLoader.js node_modules/three/examples/jsm/controls/OrbitControls.js`
Expected: 3ファイルとも存在する（importmapのパスの前提）。

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json .gitignore
git commit -m "chore: scaffold mieru with ws/chokidar/three deps"
```

---

### Task 2: 静的配信サーバー（トラバーサル遮断つき）

**Files:**
- Create: `server.js`
- Create: `public/index.html`（仮ページ。Task 4で置換）
- Test: `test/server.test.js`

- [ ] **Step 1: 失敗するテストを書く**

`test/server.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { start, safeJoin } = require('../server.js');

function get(port, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('safeJoin blocks path traversal', () => {
  assert.strictEqual(safeJoin('/tmp/root', '../etc/passwd'), null);
  assert.strictEqual(safeJoin('/tmp/root', 'a/../../etc/passwd'), null);
  assert.ok(safeJoin('/tmp/root', 'a/b.stl'));
});

test('serves index, vendor three, and blocks traversal', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mieru-'));
  const app = start({ watchDir: dir, port: 0 });
  t.after(() => app.close());
  await new Promise((r) => app.server.on('listening', r));
  const port = app.port();

  const index = await get(port, '/');
  assert.strictEqual(index.status, 200);
  assert.match(index.body, /mieru/);

  const three = await get(port, '/vendor/three/build/three.module.js');
  assert.strictEqual(three.status, 200);

  const evil = await get(port, '/files/..%2fpackage.json');
  assert.strictEqual(evil.status, 404);

  const evil2 = await get(port, '/vendor/three/..%2f..%2fpackage.json');
  assert.strictEqual(evil2.status, 404);
});

test('start throws on missing watch dir', () => {
  assert.throws(() => start({ watchDir: '/no/such/dir/mieru-xyz', port: 0 }));
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `npm test`
Expected: FAIL（`Cannot find module '../server.js'`）

- [ ] **Step 3: 仮の public/index.html を作成**

```html
<!doctype html>
<html lang="ja">
<head><meta charset="utf-8"><title>mieru — STLライブビューア</title></head>
<body>mieru（仮ページ。Task 4で置換）</body>
</html>
```

- [ ] **Step 4: server.js を実装（この時点では静的配信のみ。監視はTask 3）**

`server.js`:

```js
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC_DIR = path.join(__dirname, 'public');
const THREE_DIR = path.join(__dirname, 'node_modules', 'three');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.stl': 'application/octet-stream',
};

// rootDir配下に解決されるパスだけ返す（トラバーサル遮断）
function safeJoin(rootDir, relPath) {
  const root = path.resolve(rootDir);
  const resolved = path.resolve(root, relPath);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  return resolved;
}

function sendFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(data);
  });
}

function start({ watchDir, port = 5301 }) {
  const root = path.resolve(watchDir);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error(`監視ディレクトリが存在しません: ${root}`);
  }

  const server = http.createServer((req, res) => {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch {
      res.writeHead(400); return res.end('bad request');
    }
    if (pathname === '/') return sendFile(res, path.join(PUBLIC_DIR, 'index.html'));
    if (pathname.startsWith('/vendor/three/')) {
      const p = safeJoin(THREE_DIR, pathname.slice('/vendor/three/'.length));
      if (!p) { res.writeHead(404); return res.end('not found'); }
      return sendFile(res, p);
    }
    if (pathname.startsWith('/files/')) {
      const p = safeJoin(root, pathname.slice('/files/'.length));
      if (!p) { res.writeHead(404); return res.end('not found'); }
      return sendFile(res, p);
    }
    const p = safeJoin(PUBLIC_DIR, pathname.slice(1));
    if (!p) { res.writeHead(404); return res.end('not found'); }
    return sendFile(res, p);
  });

  server.listen(port);
  return {
    server,
    port: () => server.address().port,
    close: async () => { server.close(); },
  };
}

module.exports = { start, safeJoin };

if (require.main === module) {
  const args = process.argv.slice(2);
  let watchDir = process.cwd();
  let port = 5301;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port') { port = Number(args[++i]); }
    else { watchDir = args[i]; }
  }
  const app = start({ watchDir, port });
  app.server.on('listening', () => {
    console.log(`mieru: http://localhost:${app.port()} で ${path.resolve(watchDir)} を監視中`);
  });
}
```

- [ ] **Step 5: テストを実行して成功を確認**

Run: `npm test`
Expected: PASS（3テストすべて）

- [ ] **Step 6: Commit**

```bash
git add server.js public/index.html test/server.test.js
git commit -m "feat: static server with path traversal protection"
```

---

### Task 3: STL監視とWebSocket通知

**Files:**
- Modify: `server.js`（`start()` に watcher と WebSocket を追加）
- Test: `test/server.test.js`（テスト追加）

- [ ] **Step 1: 失敗するテストを追加**

`test/server.test.js` の末尾に追加:

```js
const WebSocket = require('ws');

// 空のバイナリSTL（80byteヘッダ＋三角形数0）
function emptyStl() {
  const buf = Buffer.alloc(84);
  buf.write('mieru test', 0);
  buf.writeUInt32LE(0, 80);
  return buf;
}

async function waitFor(cond, timeoutMs = 5000) {
  const startT = Date.now();
  while (!cond()) {
    if (Date.now() - startT > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 50));
  }
}

test('watches stl files and pushes list over websocket', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mieru-'));
  const app = start({ watchDir: dir, port: 0 });
  t.after(() => app.close());
  await new Promise((r) => app.server.on('listening', r));

  const ws = new WebSocket(`ws://127.0.0.1:${app.port()}`);
  t.after(() => ws.close());
  const messages = [];
  ws.on('message', (data) => messages.push(JSON.parse(data)));
  await new Promise((r) => ws.on('open', r));

  // 接続直後に（空の）リストが届く
  await waitFor(() => messages.length >= 1);
  assert.strictEqual(messages[0].type, 'list');

  // STL追加 → リストに現れる
  fs.writeFileSync(path.join(dir, 'part.stl'), emptyStl());
  await waitFor(() => messages.some((m) => m.files.some((f) => f.path === 'part.stl')));
  const withFile = messages[messages.length - 1].files.find((f) => f.path === 'part.stl');
  assert.strictEqual(withFile.size, 84);
  assert.ok(withFile.mtime > 0);

  // STL削除 → リストから消える
  fs.unlinkSync(path.join(dir, 'part.stl'));
  await waitFor(() => messages[messages.length - 1].files.length === 0);
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `npm test`
Expected: 新テストがFAIL（WebSocket接続がエラー、またはtimeout）。既存テストはPASSのまま。

- [ ] **Step 3: server.js に watcher と WebSocket を実装**

`server.js` の先頭の require 群に追加:

```js
const { WebSocketServer } = require('ws');
const chokidar = require('chokidar');
```

`start()` 内、`server.listen(port);` の**直前**に追加:

```js
  const files = new Map(); // relPath -> {path, size, mtime}
  const wss = new WebSocketServer({ server });

  function fileList() {
    return [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
  }
  function broadcast() {
    const msg = JSON.stringify({ type: 'list', files: fileList() });
    for (const client of wss.clients) {
      if (client.readyState === 1) client.send(msg);
    }
  }

  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ type: 'list', files: fileList() }));
  });

  const watcher = chokidar.watch('**/*.stl', {
    cwd: root,
    ignoreInitial: false,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
  });
  function upsert(relPath) {
    fs.stat(path.join(root, relPath), (err, st) => {
      if (err) return;
      files.set(relPath, {
        path: relPath.split(path.sep).join('/'),
        size: st.size,
        mtime: st.mtimeMs,
      });
      broadcast();
    });
  }
  watcher.on('add', upsert);
  watcher.on('change', upsert);
  watcher.on('unlink', (relPath) => { files.delete(relPath); broadcast(); });
```

同じく `start()` の return を差し替え:

```js
  return {
    server,
    port: () => server.address().port,
    close: async () => {
      await watcher.close();
      wss.close();
      server.close();
    },
  };
```

- [ ] **Step 4: テストを実行して成功を確認**

Run: `npm test`
Expected: PASS（4テストすべて）

- [ ] **Step 5: Commit**

```bash
git add server.js test/server.test.js
git commit -m "feat: watch stl files and push file list over websocket"
```

---

### Task 4: ビューアページ（three.js・日本語UI・オンデマンド描画）

**Files:**
- Modify: `public/index.html`（仮ページを本実装で置換）
- Create: `public/viewer.js`

自動テストなし（見た目はTask 5でBrowserペイン検証）。ただし既存の `npm test` が通ること（index.html に「mieru」を含み続けること）。

- [ ] **Step 1: public/index.html を本実装で置換**

```html
<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<title>mieru — STLライブビューア</title>
<style>
  html, body { margin: 0; height: 100%; background: #1a1d21; color: #e8e8e8; font-family: -apple-system, "Hiragino Sans", sans-serif; }
  #app { display: flex; height: 100%; }
  #sidebar { width: 230px; flex: none; background: #23272d; padding: 12px; overflow-y: auto; font-size: 13px; box-sizing: border-box; }
  #sidebar h1 { font-size: 14px; margin: 0 0 10px; }
  #filelist label { display: flex; align-items: center; gap: 6px; padding: 3px 0; cursor: pointer; word-break: break-all; }
  .swatch { width: 10px; height: 10px; border-radius: 2px; flex: none; }
  .err { color: #ffb454; }
  #canvas-wrap { flex: 1; position: relative; min-width: 0; }
  canvas { display: block; }
  #dims { position: absolute; left: 10px; bottom: 10px; background: rgba(0,0,0,.55); padding: 6px 10px; border-radius: 6px; font-size: 13px; pointer-events: none; }
  #status { position: absolute; right: 10px; top: 10px; font-size: 12px; color: #9aa0a6; pointer-events: none; }
  .ctl { margin-top: 14px; border-top: 1px solid #3a3f46; padding-top: 10px; }
  .ctl label { display: flex; align-items: center; gap: 6px; margin: 6px 0; }
  button { background: #3a3f46; color: #e8e8e8; border: 0; border-radius: 5px; padding: 6px 10px; cursor: pointer; }
  select, input[type=range] { width: 100%; }
</style>
<script type="importmap">
{ "imports": {
  "three": "/vendor/three/build/three.module.js",
  "three/addons/": "/vendor/three/examples/jsm/"
} }
</script>
</head>
<body>
<div id="app">
  <div id="sidebar">
    <h1>mieru</h1>
    <div id="filelist">（STL待機中…）</div>
    <div class="ctl">
      <button id="fit">全体表示</button>
      <label><input type="checkbox" id="wire"> ワイヤーフレーム</label>
      <label><input type="checkbox" id="plate" checked> ビルドプレート (180mm)</label>
    </div>
    <div class="ctl">
      <div>断面</div>
      <select id="clip-axis">
        <option value="">なし</option>
        <option value="x">X</option>
        <option value="y">Y</option>
        <option value="z">Z</option>
      </select>
      <input type="range" id="clip-pos" min="0" max="100" value="100">
    </div>
  </div>
  <div id="canvas-wrap">
    <div id="dims">—</div>
    <div id="status">接続中…</div>
  </div>
</div>
<script type="module" src="/viewer.js"></script>
</body>
</html>
```

- [ ] **Step 2: public/viewer.js を作成**

```js
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
clipAxisSel.onchange = applyClip;
clipPosInput.oninput = applyClip;

resize();
connect();
```

- [ ] **Step 3: 既存テストが通ることを確認**

Run: `npm test`
Expected: PASS（index.html は引き続き「mieru」を含むため）

- [ ] **Step 4: Commit**

```bash
git add public/index.html public/viewer.js
git commit -m "feat: three.js viewer page with live reload, build plate, dims, clipping"
```

---

### Task 5: README とライブ動作検証

**Files:**
- Create: `README.md`

- [ ] **Step 1: README.md を作成**

````markdown
# mieru — STLライブビューア

Claude Codeで3Dプリント用モデリング（Pythonスクリプト→STL等）をするとき、
出力STLを常時表示し、ファイル更新の瞬間に自動リロードするローカルビューア。
Claude CodeデスクトップアプリのBrowserペインに表示して使う。

## 起動

```bash
node ~/dev/mieru/server.js <監視ディレクトリ> [--port 5301]
```

- 監視ディレクトリ省略時はカレントディレクトリ
- ブラウザで http://localhost:5301 を開く
- ローカル専用（外部に公開しない）

## 機能

- 監視ディレクトリ以下の `**/*.stl` を自動表示・変更の瞬間に自動リロード（視点は保持）
- A1 mini想定のビルドプレート 180×180mm グリッド（Z-up・原点中心）
- 表示中メッシュ全体のバウンディングボックス寸法（mm）を常時表示
- ファイル別の表示切替（色分け）、ワイヤーフレーム、断面スライダー（X/Y/Z軸）
- 「全体表示」ボタンでカメラフィット

## Claude Codeからの使い方（典型フロー）

1. サーバーをバックグラウンド起動（監視先＝案件の出力ディレクトリ）
2. Browserペインで http://localhost:5301 を開く
3. モデリングコードを修正 → STL再生成 → ビューアが自動更新

注意: Browserペインはバックグラウンド時に描画が止まることがある。
Claudeがスクリーンショット検証する際は
`window.dispatchEvent(new Event('resize'))` で再描画を強制するとよい。
````

- [ ] **Step 2: サンプルSTLを用意してサーバーを起動**

```bash
mkdir -p /tmp/mieru-demo
cd /tmp/mieru-demo && ~/.local/bin/uv run --with trimesh python -c "
import trimesh
trimesh.creation.box(extents=[40, 30, 20]).export('box.stl')
print('box.stl written')
"
node ~/dev/mieru/server.js /tmp/mieru-demo &
```

Expected: `mieru: http://localhost:5301 で /tmp/mieru-demo を監視中`

- [ ] **Step 3: ブラウザで表示確認（スクリーンショット）**

http://localhost:5301 を開き、スクリーンショットで以下を確認:
- 直方体が表示され、寸法表示が `40.0 × 30.0 × 20.0 mm`
- サイドバーに `box.stl`、ステータスが「監視中」
- ビルドプレートのグリッドが見える

- [ ] **Step 4: 自動リロードのライブ検証**

```bash
cd /tmp/mieru-demo && ~/.local/bin/uv run --with trimesh python -c "
import trimesh
trimesh.creation.cylinder(radius=25, height=60).export('box.stl')
print('replaced with cylinder')
"
```

ページをリロード**せず**にスクリーンショットを取り、円柱に変わっていること・寸法表示が `50.0 × 50.0 × 60.0 mm` に変わっていることを確認。
（Browserペインで描画が止まって見える場合は `window.dispatchEvent(new Event('resize'))` を実行してから確認）

- [ ] **Step 5: サーバー停止と後片付け**

```bash
kill %1
rm -rf /tmp/mieru-demo
```

- [ ] **Step 6: Commit**

```bash
git add README.md
git commit -m "docs: add README with usage and Claude Code workflow"
```
