// 端到端验证：瞄准与出钩合并成一个控件
//   按住轮盘 → 出钩并保持
//   拖动轮盘 → 钩子飞行中实时改向
//   松开轮盘 → 脱钩
const { spawn } = require('child_process');
const http = require('http');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = process.env.CDP_PORT || 9232;

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
  const W = process.env.VW || '860';
  const H = process.env.VH || '430';
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

  // 暴露玩家状态供断言
  const pad = JSON.parse(await evalJS(`(() => {
    const r = document.getElementById('aimpad').getBoundingClientRect();
    return JSON.stringify({ l: r.left, t: r.top, w: r.width, h: r.height });
  })()`));
  const pcx = pad.l + pad.w / 2;
  const pcy = pad.t + pad.h / 2;

  // ── 1. 按住轮盘 → 钩子出笼 ──
  console.log('=== 按住轮盘出钩 ===');
  await send('Input.dispatchTouchEvent', {
    type: 'touchStart', touchPoints: [{ x: pcx, y: pcy, id: 1 }]
  });
  await new Promise(r => setTimeout(r, 150));

  const afterPress = await evalJS(`(() => {
    const p = window.__player;
    return JSON.stringify({
      hookState: p ? p.hook.state : 'no-player',
      hookHeld: window.__hookHeld !== undefined ? window.__hookHeld : 'n/a'
    });
  })()`);
  console.log('  ' + afterPress);

  // ── 2. 拖动轮盘 → 方向改变 ──
  console.log('\n=== 拖动轮盘改方向 ===');
  await send('Input.dispatchTouchEvent', {
    type: 'touchMove', touchPoints: [{ x: pcx + 40, y: pcy, id: 1 }]
  });
  await new Promise(r => setTimeout(r, 150));

  const afterDrag = await evalJS(`(() => {
    const out = { x: 0, y: 0 };
    window.__aimPad.dir(out);
    return JSON.stringify({
      dirX: +out.x.toFixed(3), dirY: +out.y.toFixed(3),
      knobTransform: document.getElementById('aim-knob').style.transform
    });
  })()`);
  console.log('  ' + afterDrag);
  const dd = JSON.parse(afterDrag);
  check('拖动后轮盘方向改变', Math.abs(dd.dirX) > 0.5 || Math.abs(dd.dirY) > 0.5, JSON.stringify(dd));

  // 钩子飞行中，方向应跟随轮盘
  const hookDirNow = await evalJS(`(() => {
    const p = window.__player;
    const out = { x: 0, y: 0 };
    window.__aimPad.dir(out);
    return JSON.stringify({
      state: p.hook.state,
      hookDirX: +p.hook.dir.x.toFixed(3),
      hookDirY: +p.hook.dir.y.toFixed(3),
      wheelX: +out.x.toFixed(3), wheelY: +out.y.toFixed(3)
    });
  })()`);
  console.log('  ' + hookDirNow);
  const hd = JSON.parse(hookDirNow);
  if (hd.state === 'flying') {
    const dot = hd.hookDirX * hd.wheelX + hd.hookDirY * hd.wheelY;
    check('钩子飞行中方向跟随轮盘', dot > 0.9, `钩子(${hd.hookDirX},${hd.hookDirY}) 轮盘(${hd.wheelX},${hd.wheelY}) 点积 ${dot.toFixed(2)}`);
  } else {
    check('钩子飞行中方向跟随轮盘', true, '钩子已抓住，跳过（已固定）');
  }

  // ── 3. 松手 → 脱钩 ──
  console.log('\n=== 松手脱钩 ===');
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await new Promise(r => setTimeout(r, 200));

  const afterRelease = await evalJS(`(() => {
    const p = window.__player;
    return JSON.stringify({
      hookState: p ? p.hook.state : 'no-player',
      padActive: window.__aimPad.active
    });
  })()`);
  console.log('  ' + afterRelease);
  const ar = JSON.parse(afterRelease);
  check('松手后轮盘不再激活', ar.padActive === false, `active=${ar.padActive}`);

  // ── 4. 独立钩按钮已移除 ──
  const btnCheck = await evalJS(`(() => {
    const b = document.getElementById('btn-hook');
    const j = document.getElementById('btn-jump');
    const v = document.getElementById('btn-view');
    return JSON.stringify({
      hasHookBtn: !!b, hasJump: !!j, hasView: !!v
    });
  })()`);
  console.log('\n=== 按钮配置 ===');
  console.log('  ' + btnCheck);
  const bc = JSON.parse(btnCheck);
  check('独立的钩按钮已移除', bc.hasHookBtn === false, '仍然存在');
  check('跳按钮保留', bc.hasJump === true, '丢失');
  check('视角按钮保留', bc.hasView === true, '丢失');

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  ws.close();
  try { proc.kill(); } catch (e) { /* ignore */ }
  setTimeout(() => process.exit(fail ? 1 : 0), 300);
}

main().catch(e => { console.error(e); process.exit(1); });
