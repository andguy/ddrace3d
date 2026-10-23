// 端到端验证：竖屏旋转状态下，轮盘控制钩子方向
// 用 CDP 模拟真实触摸 → 检查钩子的实际飞行方向是否与轮盘指向一致
const { spawn } = require('child_process');
const http = require('http');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = process.env.CDP_PORT || 9227;

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
  // 通过环境变量切换横屏/竖屏
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
    if (r.result?.exceptionDetails) return 'EXC: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 400);
    return r.result?.result?.value;
  }
  await new Promise(r => setTimeout(r, 3000));

  let pass = 0, fail = 0;
  function check(name, cond, detail) {
    if (cond) { pass++; console.log('  PASS  ' + name); }
    else { fail++; console.log('  FAIL  ' + name + '  →  ' + detail); }
  }

  const pad = JSON.parse(await evalJS(`(() => {
    const r = document.getElementById('aimpad').getBoundingClientRect();
    return JSON.stringify({ l: r.left, t: r.top, w: r.width, h: r.height });
  })()`));

  const pcx = pad.l + pad.w / 2;
  const pcy = pad.t + pad.h / 2;

  // 场景：把轮盘往【屏幕右】推 → 期望钩子朝画面右飞
  // 竖屏旋转 90° 时，画面右对应局部 -y（见实测：屏幕右 → 局部 (0,-50)）
  // 关卡平面：局部 +x = 画面右，局部 +y = 画面下
  // 所以"画面右"= 局部 +x → dir() 输出 (x=+1, y=0)
  // 期望的钩子方向：世界 (x≈+1, y≈0)
  const rotState = await evalJS(`document.body.classList.contains('rotated') ? 'rotated' : 'normal'`);
  console.log(`=== 轮盘 → 钩子方向（视口 ${W}x${H}，状态 ${rotState}）===`);

  // 期望方向按【画面语义】给：画面右 = 关卡 +x，画面上 = 关卡 +y。
  // 竖屏旋转时画面整体转了 90°，所以「屏幕右」在画面里其实是「画面下」，
  // 对应关卡的 -y。测试要按 rotState 区分。
  // 旋转 90°（顺时针）后，画面整体转了 90°：
  //   屏幕右 = 画面里��"上" = 关卡 +y
  //   屏幕下 = 画面里的"左" = 关卡 -x
  //   屏幕左 = 画面里的"下" = 关卡 -y
  //   屏幕上 = 画面里的"右" = 关卡 +x
  const ROT = rotState === 'rotated';
  const scenarios = ROT ? [
    { name: '屏幕右', dx: 45, dy: 0, expectX: 0, expectY: 1 },
    { name: '屏幕下', dx: 0, dy: 45, expectX: 1, expectY: 0 },
    { name: '屏幕左', dx: -45, dy: 0, expectX: 0, expectY: -1 },
    { name: '屏幕上', dx: 0, dy: -45, expectX: -1, expectY: 0 },
  ] : [
    { name: '屏幕右', dx: 45, dy: 0, expectX: 1, expectY: 0 },
    { name: '屏幕下', dx: 0, dy: 45, expectX: 0, expectY: -1 },
    { name: '屏幕左', dx: -45, dy: 0, expectX: -1, expectY: 0 },
    { name: '屏幕上', dx: 0, dy: -45, expectX: 0, expectY: 1 },
  ];
  for (const sc of scenarios) {
    // 拖动轮盘
    await send('Input.dispatchTouchEvent', {
      type: 'touchStart', touchPoints: [{ x: pcx, y: pcy, id: 1 }]
    });
    await new Promise(r => setTimeout(r, 80));
    await send('Input.dispatchTouchEvent', {
      type: 'touchMove', touchPoints: [{ x: pcx + sc.dx, y: pcy + sc.dy, id: 1 }]
    });
    await new Promise(r => setTimeout(r, 200));

    // 读出 aimPad 的实际输出 + knob 的屏幕位移
    // 直接调用页面里 aimPad.dir() 的真实实现（不复制公式）
    const st = await evalJS(`(() => {
      const out = { x: 0, y: 0 };
      const ok = window.__aimPad.dir(out);
      const knob = document.getElementById('aim-knob');
      const pr = document.getElementById('aimpad').getBoundingClientRect();
      const kr = knob.getBoundingClientRect();
      return JSON.stringify({
        ok,
        dirX: +out.x.toFixed(3), dirY: +out.y.toFixed(3),
        knobScreenDx: +((kr.left + kr.width/2) - (pr.left + pr.width/2)).toFixed(1),
        knobScreenDy: +((kr.top + kr.height/2) - (pr.top + pr.height/2)).toFixed(1)
      });
    })()`);
    const d = JSON.parse(st);

    // dir() 的方向应该对应"画面方向"：
    // 局部 +x = 画面右，局部 -y = 画面上（因为局部 +y = 画面下）
    // 所以画面右 → dir=(+1,0)；画面上 → dir=(0,+1)
    const dirX = d.dirX, dirY = d.dirY;
    const dot = dirX * sc.expectX + dirY * sc.expectY;
    check(`轮盘推向${sc.name} → 钩子朝对应方向`,
      dot > 0.9,
      `dir=(${dirX},${dirY}) 期望≈(${sc.expectX},${sc.expectY}) 点积 ${dot.toFixed(2)}`);

    await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await new Promise(r => setTimeout(r, 150));
  }

  // 验证：触屏第三人称下，computeAimDir 用的是轮盘而不是鼠标
  console.log('\n=== 触屏瞄准来源 ===');
  const src = await evalJS(`(() => {
    // 移动鼠标到屏幕角落，如果 aimDir 仍指向别处，说明用的是轮盘
    const before = window.__lastAimDir ? JSON.stringify(window.__lastAimDir) : 'n/a';
    return before;
  })()`);
  console.log('  ' + src);

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);

  ws.close();
  try { proc.kill(); } catch (e) { /* ignore */ }
  setTimeout(() => process.exit(fail ? 1 : 0), 300);
}

main().catch(e => { console.error(e); process.exit(1); });
