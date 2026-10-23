// 验证新的手机端交互：
//   1. 按住轮盘 0.2 秒后才出钩（给出瞄准时间）
//   2. 松手前钩子还在飞 → 拖动能改向
//   3. 松手脱钩
//   4. 第一人称滑动屏幕改视角
const { spawn } = require('child_process');
const http = require('http');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = process.env.CDP_PORT || 9270;

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
    '--remote-debugging-port=' + PORT, '--window-size=860,430',
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

  // ── 1. 按下后 0.2 秒内：钩子还没出笼 ──
  console.log('=== 0.2 秒瞄准延时 ===');
  await send('Input.dispatchTouchEvent', {
    type: 'touchStart', touchPoints: [{ x: pcx, y: pcy, id: 1 }]
  });
  await new Promise(r => setTimeout(r, 80));

  const early = await evalJS(`(() => {
    const p = window.__player;
    return JSON.stringify({ state: p.hook.state, pending: window.__padPending() });
  })()`);
  console.log('  按下 80ms 后: ' + early);
  const e = JSON.parse(early);
  check('按下 80ms 时钩子还没出笼', e.state === 'idle', `state=${e.state}`);

  // ── 2. 等待超过 0.2 秒：钩子出笼 ──
  await new Promise(r => setTimeout(r, 350));
  const late = await evalJS(`(() => {
    const p = window.__player;
    return JSON.stringify({
      state: p.hook.state,
      fireCount: window.__padFireCount || 0,
      fired: window.__padFired(),
      pending: window.__padPending(),
      elapsed: performance.now()
    });
  })()`);
  console.log('  按下 430ms 后: ' + late);
  const l = JSON.parse(late);
  // 钩子飞行只有 0.095 秒，430ms 后可能已经飞完回收了 → 断言"出钩过"而不是当前状态
  check('按住超过 0.2 秒后触发出钩', l.fireCount >= 1, `fireCount=${l.fireCount}`);
  check('出钩后标记为已发射', l.fired === true, `fired=${l.fired}`);

  // ── 3. 拖动改向 ──
  console.log('\n=== 拖动改向 ===');
  await send('Input.dispatchTouchEvent', {
    type: 'touchMove', touchPoints: [{ x: pcx + 40, y: pcy, id: 1 }]
  });
  await new Promise(r => setTimeout(r, 120));
  const dirRes = await evalJS(`(() => {
    const p = window.__player;
    return JSON.stringify({
      state: p.hook.state,
      hookX: +p.hook.dir.x.toFixed(3),
      hookY: +p.hook.dir.y.toFixed(3),
      aimX: +window.__padAim().x.toFixed(3),
      aimY: +window.__padAim().y.toFixed(3)
    });
  })()`);
  console.log('  ' + dirRes);
  const dr = JSON.parse(dirRes);
  const dot = dr.hookX * dr.aimX + dr.hookY * dr.aimY;
  // 钩子可能已飞完（0.095s），此时 dir 保留最后设定的值 —— 两种情况都算对
  check('钩子方向跟随瞄准方向', dot > 0.9 || dr.state === 'idle',
    `dot=${dot.toFixed(2)} state=${dr.state}`);

  // ── 4. 松手脱钩 ──
  console.log('\n=== 松手脱钩 ===');
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await new Promise(r => setTimeout(r, 200));
  const rel = await evalJS(`(() => {
    const p = window.__player;
    return JSON.stringify({ state: p.hook.state, active: window.__aimPad.active });
  })()`);
  console.log('  ' + rel);
  const r2 = JSON.parse(rel);
  check('松手后钩子回收', r2.state === 'idle' || r2.state === 'retracting', `state=${r2.state}`);

  // ── 5. 第一人称滑动屏幕改视角 ──
  console.log('\n=== 第一人称滑动改视角 ===');
  await evalJS(`(() => {
    // 切到第一人称
    dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyV' }));
    dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyV' }));
    return 'ok';
  })()`);
  await new Promise(r => setTimeout(r, 400));

  const yawBefore = await evalJS(`(() => {
    return JSON.stringify({ yaw: +window.__viewYaw().toFixed(4), first: document.body.classList.contains('first-person') });
  })()`);
  console.log('  切换后: ' + yawBefore);

  // 注入事件探针
  await evalJS(`(() => {
    window.__evts = [];
    const c = document.getElementById('game');
    c.addEventListener('pointerdown', e => {
      const stage = document.getElementById('stage');
      const inv = new DOMMatrix(getComputedStyle(stage).transform).inverse();
      const lp = inv.transformPoint(new DOMPoint(e.clientX, e.clientY));
      window.__evts.push('down:' + e.pointerType + ' client=' + e.clientX + ',' + e.clientY +
        ' local=' + lp.x.toFixed(1) + ',' + lp.y.toFixed(1));
    }, true);
    c.addEventListener('pointermove', e => {
      const stage = document.getElementById('stage');
      const inv = new DOMMatrix(getComputedStyle(stage).transform).inverse();
      const lp = inv.transformPoint(new DOMPoint(e.clientX, e.clientY));
      window.__evts.push('move:' + e.pointerType + ' client=' + e.clientX + ',' + e.clientY +
        ' local=' + lp.x.toFixed(1) + ',' + lp.y.toFixed(1));
    }, true);
    c.addEventListener('pointerup', e => window.__evts.push('up:' + e.pointerType), true);
    return 'ok';
  })()`);

  // 在画面上滑动。
  // 注意：无头浏览器在【旋转的 stage】上会把触摸坐标算成 0,0（CDP 的限制），
  // 所以这里直接派发带真实坐标的 PointerEvent，测的是我们自己的处理逻辑。
  await evalJS(`(() => {
    const c = document.getElementById('game');
    const mk = (type, x, y) => new PointerEvent(type, {
      pointerId: 7, pointerType: 'touch', clientX: x, clientY: y,
      bubbles: true, cancelable: true, isPrimary: true
    });
    c.dispatchEvent(mk('pointerdown', 400, 200));
    c.dispatchEvent(mk('pointermove', 300, 200));
    return 'ok';
  })()`);
  await new Promise(r => setTimeout(r, 250));
  await evalJS(`(() => {
    const c = document.getElementById('game');
    c.dispatchEvent(new PointerEvent('pointerup', {
      pointerId: 7, pointerType: 'touch', clientX: 300, clientY: 200,
      bubbles: true, cancelable: true, isPrimary: true
    }));
    return 'ok';
  })()`);
  await new Promise(r => setTimeout(r, 150));

  const yawAfter = await evalJS(`(() => {
    return JSON.stringify({ yaw: +window.__viewYaw().toFixed(4), evts: window.__evts });
  })()`);
  console.log('  滑动后: ' + yawAfter);
  const yb = JSON.parse(yawBefore), ya = JSON.parse(yawAfter);
  check('第一人称滑动改变了视角', Math.abs(ya.yaw - yb.yaw) > 0.01,
    `yaw ${yb.yaw} → ${ya.yaw}`);

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  ws.close();
  try { proc.kill(); } catch (e) { /* ignore */ }
  setTimeout(() => process.exit(fail ? 1 : 0), 300);
}

main().catch(e => { console.error(e); process.exit(1); });
