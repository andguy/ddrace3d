// 对比：手机（触屏 UI）与电脑（键鼠）执行相同操作后的物理状态
// 找出两条输入路径的差异
const { spawn } = require('child_process');
const http = require('http');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

function getJSON(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let d = '';
      res.on('data', (c) => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

async function launch(port, query) {
  const proc = spawn(EDGE, [
    '--headless=new', '--enable-unsafe-swiftshader', '--use-angle=swiftshader',
    '--remote-debugging-port=' + port, '--window-size=860,430',
    'http://127.0.0.1:8117/index.html' + query
  ], { stdio: 'ignore', detached: true });
  await new Promise(r => setTimeout(r, 3500));
  const targets = await getJSON(`http://127.0.0.1:${port}/json/list`);
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
  return { proc, send, evalJS };
}

async function main() {
  let pass = 0, fail = 0;
  function check(name, cond, detail) {
    if (cond) { pass++; console.log('  PASS  ' + name); }
    else { fail++; console.log('  FAIL  ' + name + '  →  ' + detail); }
  }

  // ── 电脑端：按住 D 键 1.5 秒 ──
  console.log('=== 电脑端（键盘 D 前进）===');
  const desk = await launch(9250, '');
  // 直接往页面的 keys 集合里塞 KeyD（CDP 的 keyDown 在无头浏览器里不一定能持续按住）
  await desk.evalJS(`(() => {
    window.__forceKey = true;
    const orig = window.__keyHandler;
    // 找到 main.js 里的 keys 集合：通过模拟真实 keydown 事件
    dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyD' }));
    return 'ok';
  })()`);
  await new Promise(r => setTimeout(r, 1500));
  await desk.evalJS(`(() => {
    dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyD' }));
    return 'ok';
  })()`);
  await new Promise(r => setTimeout(r, 300));
  const deskState = await desk.evalJS(`(() => {
    const p = window.__player;
    return JSON.stringify({
      x: +p.pos.x.toFixed(3), y: +p.pos.y.toFixed(3), z: +p.pos.z.toFixed(3),
      vx: +p.vel.x.toFixed(3), vy: +p.vel.y.toFixed(3),
      grounded: p.grounded
    });
  })()`);
  console.log('  ' + deskState);
  try { desk.proc.kill(); } catch (e) {}

  await new Promise(r => setTimeout(r, 800));

  // ── 手机端：摇杆推满 1.5 秒 ──
  console.log('\n=== 手机端（摇杆推满）===');
  const mob = await launch(9251, '?touch=1');
  const stick = JSON.parse(await mob.evalJS(`(() => {
    const r = document.getElementById('stick').getBoundingClientRect();
    return JSON.stringify({ l: r.left, t: r.top, w: r.width, h: r.height });
  })()`));
  const scx = stick.l + stick.w / 2;
  const scy = stick.t + stick.h / 2;

  await mob.send('Input.dispatchTouchEvent', {
    type: 'touchStart', touchPoints: [{ x: scx, y: scy, id: 1 }]
  });
  await new Promise(r => setTimeout(r, 100));
  // 推到最右（半径 46px）
  await mob.send('Input.dispatchTouchEvent', {
    type: 'touchMove', touchPoints: [{ x: scx + 46, y: scy, id: 1 }]
  });
  await new Promise(r => setTimeout(r, 1400));
  await mob.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await new Promise(r => setTimeout(r, 300));

  const mobState = await mob.evalJS(`(() => {
    const p = window.__player;
    return JSON.stringify({
      x: +p.pos.x.toFixed(3), y: +p.pos.y.toFixed(3), z: +p.pos.z.toFixed(3),
      vx: +p.vel.x.toFixed(3), vy: +p.vel.y.toFixed(3),
      grounded: p.grounded
    });
  })()`);
  console.log('  ' + mobState);
  try { mob.proc.kill(); } catch (e) {}

  // ── 对比 ──
  console.log('\n=== 对比 ===');
  const d = JSON.parse(deskState);
  const m = JSON.parse(mobState);
  const dx = Math.abs(d.x - m.x);
  const dvx = Math.abs(d.vx - m.vx);
  console.log(`  位置差 |Δx| = ${dx.toFixed(3)} 格`);
  console.log(`  速度差 |Δvx| = ${dvx.toFixed(3)}`);
  check('位移基本一致（< 3 格）', dx < 3, `差 ${dx.toFixed(3)}`);
  check('末速度基本一致（< 2）', dvx < 2, `差 ${dvx.toFixed(3)}`);

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  setTimeout(() => process.exit(fail ? 1 : 0), 300);
}

main().catch(e => { console.error(e); process.exit(1); });
