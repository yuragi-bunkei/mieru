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

test('rejects null byte in path without crashing the server', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mieru-'));
  const app = start({ watchDir: dir, port: 0 });
  t.after(() => app.close());
  await new Promise((r) => app.server.on('listening', r));
  const port = app.port();

  const evil = await get(port, '/files/%00foo.stl');
  assert.ok(evil.status === 400 || evil.status === 404);

  // Server must still be alive and answering normal requests.
  const index = await get(port, '/');
  assert.strictEqual(index.status, 200);
  assert.match(index.body, /mieru/);
});

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

  // 非.stlファイルはリストに現れない
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'not an stl');

  // STL追加 → リストに現れる
  fs.writeFileSync(path.join(dir, 'part.stl'), emptyStl());
  await waitFor(() => messages.some((m) => m.files.some((f) => f.path === 'part.stl')));
  const listWithFile = messages[messages.length - 1];
  const withFile = listWithFile.files.find((f) => f.path === 'part.stl');
  assert.strictEqual(withFile.size, 84);
  assert.ok(withFile.mtime > 0);
  assert.ok(!listWithFile.files.some((f) => f.path === 'notes.txt'));

  // STL削除 → リストから消える
  fs.unlinkSync(path.join(dir, 'part.stl'));
  await waitFor(() => messages[messages.length - 1].files.length === 0);
});
