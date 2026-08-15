// 描き込みオーバーレイ: 3Dビューの上にペン・矢印・文字を描く。
// 描いた内容はスクリーンショットに写るので、Claudeがそのまま指示として読める。
(function () {
  const wrap = document.getElementById('canvas-wrap');
  const cv = document.getElementById('anno');
  const ctx = cv.getContext('2d');
  const modeCb = document.getElementById('anno-mode');
  const toolSel = document.getElementById('anno-tool');
  const clearBtn = document.getElementById('anno-clear');
  const listEl = document.getElementById('anno-list');
  const copyBtn = document.getElementById('anno-copy');
  const COLOR = '#ff5252';
  // shapes: {type:'pen',pts} | {type:'arrow',a,b} | {type:'text',p,str}
  // 指摘リスト用に各要素へ id/label/memo/checked を付与する（commitShapeで付与）
  const shapes = [];
  let cur = null;
  let nextId = 1;
  let seq = 0; // ペン/矢印の連番（「指摘1」等）
  let onChangeCb = null; // viewer.jsの状態保存へ変更を通知する
  function notifyChange() { if (onChangeCb) onChangeCb(); }

  function typeLabel(t) {
    return t === 'pen' ? 'ペン' : t === 'arrow' ? '矢印' : 'テキスト';
  }

  // 確定した注釈にリスト用メタデータを付けてshapesへ追加する
  function commitShape(s) {
    s.id = nextId++;
    s.memo = '';
    s.checked = false;
    if (s.type === 'text') {
      s.label = s.str;
    } else {
      seq += 1;
      s.label = '指摘' + seq;
    }
    shapes.push(s);
    redraw();
    renderList();
    notifyChange();
  }

  function renderList() {
    if (!listEl) return;
    listEl.innerHTML = '';
    if (shapes.length === 0) {
      const empty = document.createElement('div');
      empty.id = 'anno-empty';
      empty.textContent = '（まだ指摘はありません）';
      listEl.appendChild(empty);
      if (copyBtn) copyBtn.disabled = true;
      return;
    }
    if (copyBtn) copyBtn.disabled = false;
    shapes.forEach((s, i) => {
      const row = document.createElement('div');
      row.className = 'anno-item' + (s.checked ? ' done' : '');
      row.dataset.id = s.id;

      const head = document.createElement('div');
      head.className = 'anno-item-head';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!s.checked;
      cb.onchange = () => {
        s.checked = cb.checked;
        row.classList.toggle('done', cb.checked);
        notifyChange();
      };
      const labelSpan = document.createElement('span');
      labelSpan.className = 'anno-label';
      labelSpan.textContent = `${i + 1}. ${s.label}（${typeLabel(s.type)}）`;
      head.append(cb, labelSpan);

      const memoInput = document.createElement('input');
      memoInput.type = 'text';
      memoInput.className = 'anno-memo';
      memoInput.placeholder = 'メモ（任意）';
      memoInput.value = s.memo || '';
      memoInput.oninput = () => { s.memo = memoInput.value; notifyChange(); };

      row.append(head, memoInput);
      listEl.appendChild(row);
    });
  }

  function toMarkdown() {
    return shapes.map((s) => {
      const box = s.checked ? '[x]' : '[ ]';
      const memo = s.memo && s.memo.trim() ? ` — ${s.memo.trim()}` : '';
      return `- ${box} ${s.label}（${typeLabel(s.type)}）${memo}`;
    }).join('\n');
  }

  if (copyBtn) {
    copyBtn.onclick = async () => {
      const md = toMarkdown();
      if (!md) return;
      try {
        await navigator.clipboard.writeText(md);
      } catch {
        const ta = document.createElement('textarea');
        ta.value = md;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); } catch {}
        ta.remove();
      }
      const orig = copyBtn.textContent;
      copyBtn.textContent = 'コピーしました';
      setTimeout(() => { copyBtn.textContent = orig; }, 1500);
    };
  }

  function resize() {
    cv.width = wrap.clientWidth * devicePixelRatio;
    cv.height = wrap.clientHeight * devicePixelRatio;
    cv.style.width = wrap.clientWidth + 'px';
    cv.style.height = wrap.clientHeight + 'px';
    ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    redraw();
  }
  window.addEventListener('resize', resize);

  function drawShape(s) {
    ctx.strokeStyle = COLOR;
    ctx.fillStyle = COLOR;
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (s.type === 'pen') {
      ctx.beginPath();
      s.pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.stroke();
    } else if (s.type === 'arrow') {
      const [ax, ay] = s.a, [bx, by] = s.b;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();
      const ang = Math.atan2(by - ay, bx - ax);
      ctx.beginPath();
      ctx.moveTo(bx, by);
      ctx.lineTo(bx - 12 * Math.cos(ang - 0.45), by - 12 * Math.sin(ang - 0.45));
      ctx.lineTo(bx - 12 * Math.cos(ang + 0.45), by - 12 * Math.sin(ang + 0.45));
      ctx.closePath();
      ctx.fill();
    } else if (s.type === 'text') {
      ctx.font = '15px -apple-system, "Hiragino Sans", sans-serif';
      ctx.fillText(s.str, s.p[0], s.p[1]);
    }
  }

  function redraw() {
    ctx.clearRect(0, 0, cv.width, cv.height);
    shapes.forEach(drawShape);
    if (cur) drawShape(cur);
  }

  function pos(e) {
    const r = cv.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  // どのビューに描いているかを枠で示す（複数ビューのときだけ）
  let lockedView = null;
  function viewAt(e) {
    for (const v of document.querySelectorAll('.view')) {
      const r = v.getBoundingClientRect();
      if (e.clientX >= r.left && e.clientX <= r.right &&
          e.clientY >= r.top && e.clientY <= r.bottom) return v;
    }
    return null;
  }
  function highlight(v) {
    const all = document.querySelectorAll('.view');
    const target = all.length > 1 ? v : null;
    for (const el of all) el.classList.toggle('drawing', el === target);
  }

  function placeTextInput(p) {
    const input = document.createElement('input');
    input.className = 'anno-input';
    input.style.left = p[0] + 'px';
    input.style.top = (p[1] - 12) + 'px';
    wrap.appendChild(input);
    input.focus();
    let done = false;
    const commit = () => {
      if (done) return;
      done = true;
      const val = input.value.trim();
      input.remove();
      if (val) commitShape({ type: 'text', p: [p[0], p[1] + 4], str: val });
      else redraw();
    };
    input.onkeydown = (ev) => {
      if (ev.key === 'Enter') commit();
      if (ev.key === 'Escape') { done = true; input.remove(); }
    };
    input.onblur = commit;
  }

  cv.addEventListener('pointerdown', (e) => {
    const p = pos(e);
    lockedView = viewAt(e);
    highlight(lockedView);
    if (toolSel.value === 'text') { placeTextInput(p); return; }
    cur = toolSel.value === 'pen' ? { type: 'pen', pts: [p] } : { type: 'arrow', a: p, b: p };
    try { cv.setPointerCapture(e.pointerId); } catch {}
  });
  cv.addEventListener('pointermove', (e) => {
    if (!cur) { highlight(viewAt(e)); return; }   // 未描画時はホバー中のビューを枠表示
    const p = pos(e);
    if (cur.type === 'pen') cur.pts.push(p);
    else cur.b = p;
    redraw();
  });
  cv.addEventListener('pointerup', (e) => {
    lockedView = null;
    highlight(viewAt(e));
    if (!cur) return;
    commitShape(cur);
    cur = null;
  });
  cv.addEventListener('pointerleave', () => { if (!cur) highlight(null); });

  modeCb.onchange = () => {
    cv.classList.toggle('active', modeCb.checked);
    if (!modeCb.checked) highlight(null);
  };
  clearBtn.onclick = () => {
    shapes.length = 0;
    seq = 0;
    redraw();
    renderList();
    notifyChange();
  };

  // 描き込み状態の保存・復元フック（viewer.jsのUI状態永続化から使う）。
  // 座標はCSSピクセルなので、保存時のキャンバスサイズも持ち、復元時に比率で合わせる。
  window.__annoState = {
    get() {
      return { shapes, nextId, seq, size: [wrap.clientWidth, wrap.clientHeight] };
    },
    set(data) {
      if (!data || !Array.isArray(data.shapes)) return;
      const [ow, oh] = Array.isArray(data.size) ? data.size : [];
      const sx = ow > 0 ? wrap.clientWidth / ow : 1;
      const sy = oh > 0 ? wrap.clientHeight / oh : 1;
      shapes.length = 0;
      for (const s of data.shapes) {
        let c;
        try { c = JSON.parse(JSON.stringify(s)); } catch { continue; }
        if (!c || typeof c !== 'object') continue;
        if (c.type === 'pen' && Array.isArray(c.pts)) {
          c.pts = c.pts.map(([x, y]) => [x * sx, y * sy]);
        } else if (c.type === 'arrow' && Array.isArray(c.a) && Array.isArray(c.b)) {
          c.a = [c.a[0] * sx, c.a[1] * sy];
          c.b = [c.b[0] * sx, c.b[1] * sy];
        } else if (c.type === 'text' && Array.isArray(c.p)) {
          c.p = [c.p[0] * sx, c.p[1] * sy];
        } else {
          continue;
        }
        shapes.push(c);
      }
      nextId = Number(data.nextId) || shapes.length + 1;
      seq = Number(data.seq) || 0;
      redraw();
      renderList();
    },
    onChange(cb) { onChangeCb = cb; },
  };

  renderList();
  resize();
})();
