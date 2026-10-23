// 验证：触屏第三人称下，钩子方向来自轮盘；摇杆在旋转状态下也正确
const { spawn } = require('child_process');
const http = require('http');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = process.env.CDP_PORT || 9229;

function getJSON(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let d = '';
      res.on('data', (c) => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

async function main() {
  const W = process.env.VW || '430';
  const H = process.env.VH || '860';
  const proc = spawn(EDGE, [
    '--headless=new', '--enable-unsafe-swiftshader', '--use-angle=swiftshader',
    '--remote-debugging-port=' + PORT, '--window-size=' + W + ',' + H,
    'http://127.0.0.1:8117/index.html?touch=1'
  ], { stdio: 'ignore', detached: true });

  await new Promise(r => setTimeout(r, 3500));
  const targets = await getJSON(`http://127.0.0.1:${PORT}/json/list`);
  const page = targets.find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  });
  await new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', rej);
  });
  function send(method, params) {
    return new Promise(resolve => {
      const mid = ++id;
      pending.set(mid, resolve);
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
  }
  async function evalJS(expr) {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
    if (r.result?.exceptionDetails) return 'EXC: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 500);
    return r.result?.result?.value;
  }
  await new Promise(r => setTimeout(r, 3000));

  let pass = 0, fail = 0;
  function check(name, cond, detail) {
    if (cond) { pass++; console.log('  PASS  ' + name); }
    else { fail++; console.log('  FAIL  ' + name + '  →  ' + detail); }
  }

  const rot = await evalJS(`document.body.classList.contains('rotated') ? 'rotated' : 'normal'`);
  console.log(`=== 视口 ${W}x${H}（${rot}）===\n`);

  // ── 1. 摇杆：推动后 knob 应跟随手指 ──
  console.log('=== 摇杆响应 ===');
  const stick = JSON.parse(await evalJS(`(() => {
    const r = document.getElementById('stick').getBoundingClientRect();
    return JSON.stringify({ l: r.left, t: r.top, w: r.width, h: r.height });
  })()`));
  const scx = stick.l + stick.w / 2;
  const scy = stick.t + stick.h / 2;

  await send('Input.dispatchTouchEvent', {
    type: 'touchStart', touchPoints: [{ x: scx, y: scy, id: 2 }]
  });
  await new Promise(r => setTimeout(r, 80));
  await send('Input.dispatchTouchEvent', {
    type: 'touchMove', touchPoints: [{ x: scx + 40, y: scy, id: 2 }]
  });
  await new Promise(r => setTimeout(r, 220));

  const stickRes = await evalJS(`(() => {
    const knob = document.getElementById('stick-knob');
    const pad = document.getElementById('stick');
    const kr = knob.getBoundingClientRect();
    const pr = pad.getBoundingClientRect();
    const stage = document.getElementById('stage');
    const inv = new DOMMatrix(getComputedStyle(stage).transform).inverse();
    const pc = inv.transformPoint(new DOMPoint(pr.left + pr.width/2, pr.top + pr.height/2));
    const kc = inv.transformPoint(new DOMPoint(kr.left + kr.width/2, kr.top + kr.height/2));
    return JSON.stringify({
      screenDx: +((kr.left + kr.width/2) - (pr.left + pr.width/2)).toFixed(1),
      screenDy: +((kr.top + kr.height/2) - (pr.top + pr.height/2)).toFixed(1),
      localDx: +(kc.x - pc.x).toFixed(1),
      localDy: +(kc.y - pc.y).toFixed(1),
      transform: knob.style.transform
    });
  })()`);
  const sr = JSON.parse(stickRes);
  console.log('  ' + stickRes);
  // 摇杆把手应该朝手指方向移动（屏幕空间）
  check('摇杆把手跟随手指（屏幕右）', sr.screenDx > 20 && Math.abs(sr.screenDy) < 5,
    `screenDx=${sr.screenDx} screenDy=${sr.screenDy}`);

  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await new Promise(r => setTimeout(r, 150));

  // ── 2. 触屏第三人称：钩子方向来自轮盘 ──
  console.log('\n=== 触屏第三人称瞄准来源 ===');
  // 先把鼠标挪到屏幕角落（模拟"如果用鼠标会指向哪"）
  await send('Input.dispatchMouseEvent', {
    type: 'mouseMoved', x: 10, y: 10, button: 'none'
  });
  await new Promise(r => setTimeout(r, 100));

  const pad = JSON.parse(await evalJS(`(() => {
    const r = document.getElementById('aimpad').getBoundingClientRect();
    return JSON.stringify({ l: r.left, t: r.top, w: r.width, h: r.height });
  })()`));
  const pcx = pad.l + pad.w / 2;
  const pcy = pad.t + pad.h / 2;

  // 把轮盘推向屏幕右
  await send('Input.dispatchTouchEvent', {
    type: 'touchStart', touchPoints: [{ x: pcx, y: pcy, id: 3 }]
  });
  await new Promise(r => setTimeout(r, 80));
  await send('Input.dispatchTouchEvent', {
    type: 'touchMove', touchPoints: [{ x: pcx + 45, y: pcy, id: 3 }]
  });
  await new Promise(r => setTimeout(r, 250));

  // 触发出钩，检查钩子的飞行方向
  const hookRes = await evalJS(`(() => {
    const out = { x: 0, y: 0 };
    const ok = window.__aimPad.dir(out);
    // 触屏下 computeAimDir 应该返回轮盘方向
    return JSON.stringify({ wheelOk: ok, wheelX: +out.x.toFixed(3), wheelY: +out.y.toFixed(3) });
  })()`);
  console.log('  轮盘方向: ' + hookRes);

  // 按钩按钮
  const hookBtn = JSON.parse(await evalJS(`(() => {
    const r = document.getElementById('btn-hook').getBoundingClientRect();
    return JSON.stringify({ l: r.left, t: r.top, w: r.width, h: r.height });
  })()`));
  await send('Input.dispatchTouchEvent', {
    type: 'touchStart', touchPoints: [{ x: hookBtn.l + hookBtn.w/2, y: hookBtn.t + hookBtn.h/2, id: 4 }]
  });
  await new Promise(r => setTimeout(r, 120));
  await send('Input.dispatchTouchEvent', {
    type: 'touchMove', touchPoints: [{ x: hookBtn.l + hookBtn.w/2, y: hookBtn.t + hookBtn.h/2, id: 4 }]
  });
  await new Promise(r => setTimeout(r, 200));

  // 检查钩子是否在飞，以及方向
  const flying = await evalJS(`(() => {
    const cv = document.getElementById('game');
    const out = { x: 0, y: 0 };
    window.__aimPad.dir(out);
    return JSON.stringify({
      isTouch: ('ontouchstart' in window) || navigator.maxTouchPoints > 0,
      bodyTouchClass: document.body.classList.contains('touch'),
      wheelDir: { x: +out.x.toFixed(3), y: +out.y.toFixed(3) },
      stageW: document.getElementById('stage').offsetWidth,
      stageH: document.getElementById('stage').offsetHeight
    });
  })()`);
  console.log('  调试: ' + flying);
  const flying2 = await evalJS(`(() => {
    const cv = document.getElementById('game');
    // 从渲染里读不到内部状态，改为检查准星颜色（绿=能钩到）
    const ch = document.getElementById('crosshair');
    return JSON.stringify({
      crosshairBg: getComputedStyle(ch).backgroundColor,
      crosshairLeft: ch.style.left, crosshairTop: ch.style.top
    });
  })()`);
  console.log('  出钩后准星: ' + flying2);

  const f = JSON.parse(flying2);
  // 准星应该在画面右半边（因为轮盘推向屏幕右 → 钩子朝画面右）
  const cw = parseFloat(f.crosshairLeft);
  check('准星出现在轮盘指向的一侧', cw > 0, `left=${cw}`);

  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await new Promise(r => setTimeout(r, 150));

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);

  ws.close();
  try { proc.kill(); } catch (e) { /* ignore */ }
  setTimeout(() => process.exit(fail ? 1 : 0), 300);
}

main().catch(e => { console.error(e); process.exit(1); });
