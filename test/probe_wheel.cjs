// 验证：轮盘方向向量是否与「手指在屏幕上的移动方向」一致
// 判据：dir() 的方向应该等于手指位移在【游戏画面】里的方向。
// 由于画面整体被旋转，最直接的验证是：
//   1. 手指往屏幕右移
//   2. knob 在屏幕上应该往右移（视觉上跟着手指）
//   3. dir() 给出的方向，应该对应「画面右上/右/右下」之一
// 用「把 dir 映射回屏幕，看是否与手指同向」来判定。
const { spawn } = require('child_process');
const http = require('http');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9226;

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
    '--headless=new', '--enable-unsafe-swiftshader', '--use-angle=swiftshader',
    '--remote-debugging-port=' + PORT, '--window-size=430,860',
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
    if (r.result?.exceptionDetails) return 'EXC: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 400);
    return r.result?.result?.value;
  }
  await new Promise(r => setTimeout(r, 2500));

  // 在页面里注入一个探针：读取 aimPad 的 dir() 结果（通过 DOM 暴露）
  const setup = await evalJS(`(() => {
    // 页面没有暴露 aimPad，这里通过模拟后再从 knob 位置反推
    return 'ok';
  })()`);

  const padRect = JSON.parse(await evalJS(`(() => {
    const r = document.getElementById('aimpad').getBoundingClientRect();
    return JSON.stringify({ l: r.left, t: r.top, w: r.width, h: r.height });
  })()`));

  const pcx = padRect.l + padRect.w / 2;
  const pcy = padRect.t + padRect.h / 2;

  const scenarios = [
    { name: '手指往屏幕右移', dx: 45, dy: 0 },
    { name: '手指往屏幕上移', dx: 0, dy: -45 },
    { name: '手指往屏幕下移', dx: 0, dy: 45 },
    { name: '手指往屏幕左移', dx: -45, dy: 0 },
  ];

  for (const sc of scenarios) {
    await send('Input.dispatchTouchEvent', {
      type: 'touchStart', touchPoints: [{ x: pcx, y: pcy, id: 1 }]
    });
    await new Promise(r => setTimeout(r, 80));
    await send('Input.dispatchTouchEvent', {
      type: 'touchMove', touchPoints: [{ x: pcx + sc.dx, y: pcy + sc.dy, id: 1 }]
    });
    await new Promise(r => setTimeout(r, 200));

    const res = await evalJS(`(() => {
      const knob = document.getElementById('aim-knob');
      const pad = document.getElementById('aimpad');
      const kr = knob.getBoundingClientRect();
      const pr = pad.getBoundingClientRect();
      // knob 相对 pad 中心的【屏幕】位移
      const kdx = (kr.left + kr.width/2) - (pr.left + pr.width/2);
      const kdy = (kr.top + kr.height/2) - (pr.top + pr.height/2);
      const stage = document.getElementById('stage');
      const inv = new DOMMatrix(getComputedStyle(stage).transform).inverse();
      // 把屏幕位移转成局部位移
      const pc = inv.transformPoint(new DOMPoint(pr.left + pr.width/2, pr.top + pr.height/2));
      const kc = inv.transformPoint(new DOMPoint(kr.left + kr.width/2, kr.top + kr.height/2));
      const ldx = kc.x - pc.x;
      const ldy = kc.y - pc.y;
      return JSON.stringify({
        knobScreenDelta: { x: +kdx.toFixed(1), y: +kdy.toFixed(1) },
        knobLocalDelta: { x: +ldx.toFixed(1), y: +ldy.toFixed(1) },
        knobTransform: knob.style.transform
      });
    })()`);
    console.log(sc.name.padEnd(18), res);

    await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await new Promise(r => setTimeout(r, 120));
  }

  ws.close();
  try { proc.kill(); } catch (e) { /* ignore */ }
  setTimeout(() => process.exit(0), 300);
}

main().catch(e => { console.error(e); process.exit(1); });
