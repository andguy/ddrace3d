// 在真实浏览器里验证：竖屏旋转后，触摸坐标换算是否正确
// 用 CDP 的 Input.dispatchTouchEvent 模拟真实触摸
const { spawn } = require('child_process');
const http = require('http');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9224;

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
  const proc = spawn(EDGE, [
    '--headless=new',
    '--enable-unsafe-swiftshader',
    '--use-angle=swiftshader',
    '--remote-debugging-port=' + PORT,
    '--window-size=430,860',
    'http://127.0.0.1:8117/index.html?touch=1'
  ], { stdio: 'ignore', detached: true });

  await new Promise(r => setTimeout(r, 3500));

  const targets = await getJSON(`http://127.0.0.1:${PORT}/json/list`);
  const page = targets.find(t => t.type === 'page');
  if (!page) { console.error('no page target'); process.exit(1); }

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
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) {
      return { error: r.result.exceptionDetails.text };
    }
    return r.result?.result?.value;
  }

  await new Promise(r => setTimeout(r, 2500));

  // 1) 检查基本状态
  const state = await evalJS(`(() => {
    const stage = document.getElementById('stage');
    const pad = document.getElementById('aimpad');
    const pr = pad.getBoundingClientRect();
    return JSON.stringify({
      rotated: document.body.classList.contains('rotated'),
      innerW: innerWidth, innerH: innerHeight,
      stageOffset: { w: stage.offsetWidth, h: stage.offsetHeight },
      padScreenRect: { l: pr.left, t: pr.top, w: pr.width, h: pr.height },
      padLocalSize: { w: pad.offsetWidth, h: pad.offsetHeight },
      canvasBuffer: { w: document.getElementById('game').width, h: document.getElementById('game').height }
    });
  })()`);
  console.log('=== 初始状态 ===');
  console.log(state);

  const st = JSON.parse(state);

  // 2) 测试坐标换算：轮盘中心 + 偏移，验证换算后落点正确
  console.log('\n=== 坐标换算验证（轮盘中心附近）===');
  const test = await evalJS(`(() => {
    const pad = document.getElementById('aimpad');
    const r = pad.getBoundingClientRect();
    const cx = r.left + r.width/2;
    const cy = r.top + r.height/2;
    // 屏幕右下角偏移 30px
    const sx = cx + 30, sy = cy + 30;
    // 用页面里的 screenToStage（通过 import 不方便，改用 stage 的矩阵手算同样的公式）
    const stage = document.getElementById('stage');
    const m = new DOMMatrix(getComputedStyle(stage).transform);
    const inv = m.inverse();
    const p = inv.transformPoint(new DOMPoint(sx, sy));
    const c = inv.transformPoint(new DOMPoint(cx, cy));
    return JSON.stringify({
      screen: { x: sx, y: sy },
      localPoint: { x: p.x, y: p.y },
      localCenter: { x: c.x, y: c.y },
      delta: { x: p.x - c.x, y: p.y - c.y },
      // 期望：屏幕向右下 30px → 局部坐标里应该是某个确定方向
      // 旋转 90° 后，屏幕右 = 局部下（y+），屏幕下 = 局部左（x-）
      expected: { x: -30, y: 30 }
    });
  })()`);
  console.log(test);

  // 3) 模拟真实触摸：按住轮盘中心再往右拖，验证 knob 的 transform
  console.log('\n=== 模拟触摸轮盘 ===');
  const pr = st.padScreenRect;
  const pcx = pr.l + pr.w / 2;
  const pcy = pr.t + pr.h / 2;

  await send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: pcx, y: pcy, id: 1 }]
  });
  await new Promise(r => setTimeout(r, 120));
  await send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ x: pcx + 40, y: pcy, id: 1 }]
  });
  await new Promise(r => setTimeout(r, 250));

  const afterTouch = await evalJS(`(() => {
    const knob = document.getElementById('aim-knob');
    const st = document.getElementById('aimpad');
    return JSON.stringify({
      knobTransform: knob.style.transform,
      // 轮盘把手应该跟随手指（在旋转后的屏幕上）
      knobRect: (() => { const r = knob.getBoundingClientRect(); return {l:Math.round(r.left), t:Math.round(r.top), w:r.width}; })(),
      padRect: (() => { const r = st.getBoundingClientRect(); return {l:Math.round(r.left), t:Math.round(r.top), w:r.width}; })()
    });
  })()`);
  console.log(afterTouch);

  await send('Input.dispatchTouchEvent', {
    type: 'touchEnd',
    touchPoints: []
  });

  ws.close();
  try { proc.kill(); } catch (e) { /* ignore */ }
  setTimeout(() => process.exit(0), 300);
}

main().catch(e => { console.error(e); process.exit(1); });
