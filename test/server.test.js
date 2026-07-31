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
