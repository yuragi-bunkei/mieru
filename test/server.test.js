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

test('watch endpoint reports and switches the watched directory', async (t) => {
  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'mieru-a-'));
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'mieru-b-'));
  // stateFileを渡さないと本物の .last-watch を上書きしてしまう
  const app = start({ watchDir: dirA, port: 0, stateFile: path.join(dirA, 'state.txt') });
  t.after(() => app.close());
  await new Promise((r) => app.server.on('listening', r));
  const port = app.port();

  // 現在の監視先を返す
  const cur = await get(port, '/watch');
  assert.strictEqual(cur.status, 200);
  assert.strictEqual(JSON.parse(cur.body).dir, path.resolve(dirA));

  // 存在しないディレクトリは400、監視先は変わらない
  const bad = await get(port, '/watch?dir=' + encodeURIComponent('/no/such/dir-mieru'));
  assert.strictEqual(bad.status, 400);
  assert.strictEqual(JSON.parse((await get(port, '/watch')).body).dir, path.resolve(dirA));

  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  t.after(() => ws.close());
  const messages = [];
  ws.on('message', (data) => messages.push(JSON.parse(data)));
  await new Promise((r) => ws.on('open', r));

  // 切替成功
  const ok = await get(port, '/watch?dir=' + encodeURIComponent(dirB));
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(JSON.parse(ok.body).dir, path.resolve(dirB));

  // 新監視先のSTLがリストに現れ、/files で配信される
  fs.writeFileSync(path.join(dirB, 'b.stl'), emptyStl());
  await waitFor(() => messages.some((m) => m.files.some((f) => f.path === 'b.stl')));
  assert.strictEqual((await get(port, '/files/b.stl')).status, 200);

  // 旧監視先への書き込みは無視される
  fs.writeFileSync(path.join(dirA, 'a.stl'), emptyStl());
  await new Promise((r) => setTimeout(r, 600));
  assert.ok(!messages.some((m) => m.files.some((f) => f.path === 'a.stl')));
});

function post(port, urlPath, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: urlPath, method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    // 巨大ボディの途中でサーバーが応答を返した場合のEPIPE等は失敗にしない
    req.on('error', (e) => setImmediate(() => reject(e)));
    req.end(body);
  });
}

test('ui state round-trips and is keyed per watch directory', async (t) => {
  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'mieru-ua-'));
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'mieru-ub-'));
  const uiStateDir = path.join(dirA, 'ui-state');
  const app = start({ watchDir: dirA, port: 0, stateFile: path.join(dirA, 'state.txt'), uiStateDir });
  t.after(() => app.close());
  await new Promise((r) => app.server.on('listening', r));
  const port = app.port();

  // 初期状態はnull
  const empty = await get(port, '/state');
  assert.strictEqual(empty.status, 200);
  assert.deepStrictEqual(JSON.parse(empty.body), { dir: path.resolve(dirA), state: null });

  // 保存 → 取得で往復する
  const stateA = { viewcount: 2, wire: true };
  const saved = await post(port, '/state', JSON.stringify(stateA));
  assert.strictEqual(saved.status, 200);
  assert.deepStrictEqual(JSON.parse((await get(port, '/state')).body).state, stateA);

  // 監視先を切り替えると別キーになる（Aの状態はBに漏れない）
  await get(port, '/watch?dir=' + encodeURIComponent(dirB));
  assert.strictEqual(JSON.parse((await get(port, '/state')).body).state, null);
  const stateB = { viewcount: 4 };
  await post(port, '/state', JSON.stringify(stateB));

  // Aへ戻るとAの状態が残っている
  await get(port, '/watch?dir=' + encodeURIComponent(dirA));
  assert.deepStrictEqual(JSON.parse((await get(port, '/state')).body).state, stateA);
});

test('ui state survives a server restart via the ui state dir', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mieru-ur-'));
  const uiStateDir = path.join(dir, 'ui-state');
  const stateFile = path.join(dir, 'state.txt');

  const app1 = start({ watchDir: dir, port: 0, stateFile, uiStateDir });
  await new Promise((r) => app1.server.on('listening', r));
  const state = { viewcount: 4, clip: { axis: 'z', pos: 40 } };
  await post(app1.port(), '/state', JSON.stringify(state));
  // 書き込みは非同期なので、GETで読めるまで待つ
  await waitFor(() => fs.existsSync(uiStateDir) && fs.readdirSync(uiStateDir).some((f) => f.endsWith('.json')));
  await app1.close();

  const app2 = start({ watchDir: dir, port: 0, stateFile, uiStateDir });
  t.after(() => app2.close());
  await new Promise((r) => app2.server.on('listening', r));
  assert.deepStrictEqual(JSON.parse((await get(app2.port(), '/state')).body).state, state);
});

// 並行PJシナリオ: 別ディレクトリを監視する2つのサーバーインスタンスが
// 同じ保存先を共有しても、互いの状態を消さない
test('two concurrent instances on different projects do not clobber each other', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mieru-cc-'));
  const dirA = path.join(base, 'projA');
  const dirB = path.join(base, 'projB');
  fs.mkdirSync(dirA);
  fs.mkdirSync(dirB);
  const uiStateDir = path.join(base, 'ui-state');

  const appA = start({ watchDir: dirA, port: 0, stateFile: path.join(base, 'sa.txt'), uiStateDir });
  const appB = start({ watchDir: dirB, port: 0, stateFile: path.join(base, 'sb.txt'), uiStateDir });
  t.after(() => appA.close());
  t.after(() => appB.close());
  // listeningは待ち始める前に発火しうるので、リスナーを先に両方登録してから待つ
  const readyA = new Promise((r) => appA.server.on('listening', r));
  const readyB = new Promise((r) => appB.server.on('listening', r));
  await readyA;
  await readyB;

  // A→B→Aの順で保存を交錯させる（旧実装ではBの丸ごと書き戻しがAのキーを潰した）
  const stateA1 = { viewcount: 2, wire: true };
  const stateB = { viewcount: 4, clip: { axis: 'x', pos: 10 } };
  const stateA2 = { viewcount: 2, wire: false };
  await post(appA.port(), '/state', JSON.stringify(stateA1));
  await post(appB.port(), '/state', JSON.stringify(stateB));
  await post(appA.port(), '/state', JSON.stringify(stateA2));
  await new Promise((r) => setTimeout(r, 200));

  // 双方が自分の最新状態を保持している
  assert.deepStrictEqual(JSON.parse((await get(appA.port(), '/state')).body).state, stateA2);
  assert.deepStrictEqual(JSON.parse((await get(appB.port(), '/state')).body).state, stateB);

  // 片方を再起動しても（＝ディスクから読み直しても）両方残っている
  await appA.close();
  const appA2 = start({ watchDir: dirA, port: 0, stateFile: path.join(base, 'sa.txt'), uiStateDir });
  t.after(() => appA2.close());
  await new Promise((r) => appA2.server.on('listening', r));
  assert.deepStrictEqual(JSON.parse((await get(appA2.port(), '/state')).body).state, stateA2);
  assert.deepStrictEqual(JSON.parse((await get(appB.port(), '/state')).body).state, stateB);
});

test('ui state rejects invalid or oversized bodies without dying', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mieru-ui-'));
  const app = start({ watchDir: dir, port: 0, stateFile: path.join(dir, 'state.txt'), uiStateDir: path.join(dir, 'ui-state') });
  t.after(() => app.close());
  await new Promise((r) => app.server.on('listening', r));
  const port = app.port();

  const bad = await post(port, '/state', 'not-json{');
  assert.strictEqual(bad.status, 400);

  const huge = await post(port, '/state', JSON.stringify({ blob: 'x'.repeat(6 * 1024 * 1024) }));
  assert.ok(huge.status === 413 || huge.status === 400);

  // サーバーは生きている
  assert.strictEqual((await get(port, '/')).status, 200);
});

test('watch switch persists the directory to the state file', async (t) => {
  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'mieru-sa-'));
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'mieru-sb-'));
  const stateFile = path.join(dirA, 'state.txt');
  const app = start({ watchDir: dirA, port: 0, stateFile });
  t.after(() => app.close());
  await new Promise((r) => app.server.on('listening', r));
  const port = app.port();

  const ok = await get(port, '/watch?dir=' + encodeURIComponent(dirB));
  assert.strictEqual(ok.status, 200);
  await waitFor(() => {
    try { return fs.readFileSync(stateFile, 'utf8').trim() === path.resolve(dirB); }
    catch { return false; }
  });
});
