const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');
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

// 生TCPでWebSocketハンドシェイクだけ行い、直後に不正なフレームを送って
// 唐突にソケットを破壊するクライアントを模擬する。
function performRawUpgrade(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      const key = crypto.randomBytes(16).toString('base64');
      const req =
        `GET / HTTP/1.1\r\n` +
        `Host: 127.0.0.1:${port}\r\n` +
        `Upgrade: websocket\r\n` +
        `Connection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\n` +
        `Sec-WebSocket-Version: 13\r\n\r\n`;
      socket.write(req);
    });
    socket.on('error', () => {}); // クライアント側の後始末エラーは無視してよい
    let gotUpgrade = false;
    socket.on('data', (chunk) => {
      if (!gotUpgrade && chunk.toString('utf8').includes('101')) {
        gotUpgrade = true;
        resolve(socket);
      }
    });
    socket.on('close', () => {
      if (!gotUpgrade) reject(new Error('socket closed before upgrade completed'));
    });
  });
}

test('survives a malformed websocket frame followed by an abrupt disconnect', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mieru-'));
  const app = start({ watchDir: dir, port: 0 });
  t.after(() => app.close());
  await new Promise((r) => app.server.on('listening', r));
  const port = app.port();

  const socket = await performRawUpgrade(port);

  // 不正なWebSocketフレーム（RSV2/RSV3ビットが立った不正ヘッダ）を送りつけ、
  // サーバー側でプロトコルエラーを起こしたあと、応答を待たずに唐突に破壊する。
  const garbage = Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
  socket.write(garbage);
  await new Promise((r) => setTimeout(r, 50));
  socket.destroy(new Error('boom-raw'));

  // サーバーが異常切断を処理する猶予を与える
  await new Promise((r) => setTimeout(r, 300));

  // サーバーは生きていて、通常のリクエストに応答し続けなければならない
  const index = await get(port, '/');
  assert.strictEqual(index.status, 200);
  assert.match(index.body, /mieru/);

  // 新しいクライアントも接続でき、リストを受け取れる
  const ws2 = new WebSocket(`ws://127.0.0.1:${port}`);
  t.after(() => ws2.close());
  const messages2 = [];
  ws2.on('message', (data) => messages2.push(JSON.parse(data)));
  await new Promise((resolve, reject) => {
    ws2.once('open', resolve);
    ws2.once('error', reject);
  });
  await waitFor(() => messages2.length >= 1);
  assert.strictEqual(messages2[0].type, 'list');
});
