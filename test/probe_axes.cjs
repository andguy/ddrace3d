// 精确验证局部坐标系的方向语义
// 问题：竖屏旋转 90° 后，舞台局部坐标的 x/y 轴分别对应屏幕的哪个方向？
// 这决定了轮盘方向、摇杆方向的符号，必须实测不能靠推理。
const { spawn } = require('child_process');
const http = require('http');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9225;

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
    if (r.result?.exceptionDetails) {
      return 'EXCEPTION: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 600);
    }
    return r.result?.result?.value;
  }

  await new Promise(r => setTimeout(r, 2500));

  const probe = await evalJS(`(() => {
    const stage = document.getElementById('stage');
    const mat = new DOMMatrix(getComputedStyle(stage).transform);
    const invM = mat.inverse();
    const c = { x: innerWidth/2, y: innerHeight/2 };
    const toLocal = (sx, sy) => { const p = invM.transformPoint(new DOMPoint(sx, sy)); return { x: p.x, y: p.y }; };

    // 从中心向四个屏幕方向各走 50px，看局部坐标怎么变
    const base = toLocal(c.x, c.y);
    const right = toLocal(c.x + 50, c.y);
    const down  = toLocal(c.x, c.y + 50);
    const left  = toLocal(c.x - 50, c.y);
    const up    = toLocal(c.x, c.y - 50);

    const d = (a, b) => ({ x: +(a.x-b.x).toFixed(2), y: +(a.y-b.y).toFixed(2) });

    // 直接验证矩阵语义
    const mat2 = new DOMMatrix(getComputedStyle(stage).transform);
    const inv2 = mat2.inverse();
    const originLocal = { x: 100, y: 100 };
    const o = mat2.transformPoint(new DOMPoint(originLocal.x, originLocal.y));
    const oPlusX = mat2.transformPoint(new DOMPoint(originLocal.x + 50, originLocal.y));
    const oPlusY = mat2.transformPoint(new DOMPoint(originLocal.x, originLocal.y + 50));

    const OUT = JSON.stringify({
      rotated: document.body.classList.contains('rotated'),
      transform: getComputedStyle(stage).transform,
      matrixElements: { a: mat2.a, b: mat2.b, c: mat2.c, d: mat2.d, e: mat2.e, f: mat2.f },
      inverseElements: { a: inv2.a, b: inv2.b, c: inv2.c, d: inv2.d, e: inv2.e, f: inv2.f },
      // 局部 +50x → 屏幕 ?
      localPlusX_toScreen: { dx: +(oPlusX.x-o.x).toFixed(2), dy: +(oPlusX.y-o.y).toFixed(2) },
      localPlusY_toScreen: { dx: +(oPlusY.x-o.x).toFixed(2), dy: +(oPlusY.y-o.y).toFixed(2) },
      // 屏幕右 → 局部什么方向
      screenRight: d(right, base),
      screenDown:  d(down, base),
      screenLeft:  d(left, base),
      screenUp:    d(up, base)
    }, null, 1);
    return OUT;
  })()`);
  console.log('=== 屏幕方向 → 局部方向 ===');
  console.log(probe);

  ws.close();
  try { proc.kill(); } catch (e) { /* ignore */ }
  setTimeout(() => process.exit(0), 300);
}

main().catch(e => { console.error(e); process.exit(1); });
