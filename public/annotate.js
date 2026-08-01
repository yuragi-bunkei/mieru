// 描き込みオーバーレイ: 3Dビューの上にペン・矢印・文字を描く。
// 描いた内容はスクリーンショットに写るので、Claudeがそのまま指示として読める。
(function () {
  const wrap = document.getElementById('canvas-wrap');
  const cv = document.getElementById('anno');
  const ctx = cv.getContext('2d');
  const modeCb = document.getElementById('anno-mode');
  const toolSel = document.getElementById('anno-tool');
  const clearBtn = document.getElementById('anno-clear');
  const COLOR = '#ff5252';
  const shapes = []; // {type:'pen',pts} | {type:'arrow',a,b} | {type:'text',p,str}
  let cur = null;

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
      if (input.value.trim()) shapes.push({ type: 'text', p: [p[0], p[1] + 4], str: input.value.trim() });
      input.remove();
      redraw();
    };
    input.onkeydown = (ev) => {
      if (ev.key === 'Enter') commit();
      if (ev.key === 'Escape') { done = true; input.remove(); }
    };
    input.onblur = commit;
  }

  cv.addEventListener('pointerdown', (e) => {
    const p = pos(e);
    if (toolSel.value === 'text') { placeTextInput(p); return; }
    cur = toolSel.value === 'pen' ? { type: 'pen', pts: [p] } : { type: 'arrow', a: p, b: p };
    cv.setPointerCapture(e.pointerId);
  });
  cv.addEventListener('pointermove', (e) => {
    if (!cur) return;
    const p = pos(e);
    if (cur.type === 'pen') cur.pts.push(p);
    else cur.b = p;
    redraw();
  });
  cv.addEventListener('pointerup', () => {
    if (!cur) return;
    shapes.push(cur);
    cur = null;
    redraw();
  });

  modeCb.onchange = () => cv.classList.toggle('active', modeCb.checked);
  clearBtn.onclick = () => { shapes.length = 0; redraw(); };

  resize();
})();
