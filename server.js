const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { WebSocketServer } = require('ws');
const chokidar = require('chokidar');

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

const DEFAULT_STATE_FILE = path.join(__dirname, '.last-watch');

function start({ watchDir, port = 5301, stateFile = DEFAULT_STATE_FILE }) {
  let root = path.resolve(watchDir);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error(`監視ディレクトリが存在しません: ${root}`);
  }

  const server = http.createServer((req, res) => {
    let url, pathname;
    try {
      url = new URL(req.url, 'http://localhost');
      pathname = decodeURIComponent(url.pathname);
    } catch {
      res.writeHead(400); return res.end('bad request');
    }
    if (pathname.includes('\0')) {
      res.writeHead(400); return res.end('bad request');
    }
    if (pathname === '/watch') {
      const dir = url.searchParams.get('dir');
      if (!dir) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ dir: root }));
      }
      const target = path.resolve(dir);
      let isDir = false;
      try { isDir = fs.statSync(target).isDirectory(); } catch {}
      if (!isDir) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: `監視ディレクトリが存在しません: ${target}` }));
      }
      switchWatch(target).then(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ dir: target }));
      }).catch((e) => {
        res.writeHead(500); res.end(String((e && e.message) || e));
      });
      return;
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

  wss.on('error', (e) => {
    console.error('mieru: websocket server error:', e.message);
  });

  wss.on('connection', (ws) => {
    ws.on('error', (e) => {
      console.error('mieru: client socket error:', e.message);
    });
    ws.send(JSON.stringify({ type: 'list', files: fileList() }));
  });

  function isStl(relPath) {
    return path.extname(relPath).toLowerCase() === '.stl';
  }
  function upsert(relPath) {
    if (!isStl(relPath)) return;
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

  // chokidar v5: globパターンは未サポートのため、rootディレクトリ自体を監視し
  // イベント側で拡張子 .stl（大小文字問わず）にフィルタする。
  function attachWatcher() {
    const w = chokidar.watch(root, {
      cwd: root,
      ignoreInitial: false,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
    });
    w.on('error', (e) => {
      console.error('mieru: watcher error:', e.message);
    });
    w.on('add', upsert);
    w.on('change', upsert);
    w.on('unlink', (relPath) => {
      if (!isStl(relPath)) return;
      files.delete(relPath);
      broadcast();
    });
    return w;
  }
  let watcher = attachWatcher();

  // 監視先の実行時切替（/watch?dir=... から呼ばれる）。次回起動の --last 用に永続化
  async function switchWatch(target) {
    await watcher.close();
    root = target;
    files.clear();
    broadcast();
    watcher = attachWatcher();
    fs.writeFile(stateFile, root, (err) => {
      if (err) console.error('mieru: 監視先の保存に失敗:', err.message);
    });
    console.log(`mieru: 監視先を切替: ${root}`);
  }

  server.listen(port);
  return {
    server,
    port: () => server.address().port,
    close: async () => {
      await watcher.close();
      wss.close();
      server.close();
    },
  };
}

module.exports = { start, safeJoin };

if (require.main === module) {
  const args = process.argv.slice(2);
  let watchDir = process.cwd();
  let port = Number(process.env.PORT) || 5301;
  let useLast = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port') { port = Number(args[++i]); }
    else if (args[i] === '--last') { useLast = true; }
    else { watchDir = args[i]; }
  }
  if (useLast) {
    // 前回 /watch で切り替えた監視先が生きていれば復元（なければ引数/カレント）
    try {
      const saved = fs.readFileSync(DEFAULT_STATE_FILE, 'utf8').trim();
      if (saved && fs.statSync(saved).isDirectory()) watchDir = saved;
    } catch {}
  }
  const app = start({ watchDir, port });
  app.server.on('listening', () => {
    console.log(`mieru: http://localhost:${app.port()} で ${path.resolve(watchDir)} を監視中`);
  });
}
