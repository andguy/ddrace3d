// 验证中键轨道视角：按下 → 拖动 → 松开，确认 orbiting 状态能正确复位
const { spawn } = require('child_process');
const http = require('http');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = process.env.CDP_PORT || 9231;

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
    'http://127.0.0.1:8117/index.html'
  ], { stdio: 'ignore', detached: true });

  await new Promise(r => setTimeout(r, 3500));
  const targets = await getJSON(`http://127.0.0.1:${PORT}/json/list`);
  const page = targets.find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const events = [];
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    else if (msg.method === 'Runtime.consoleAPICalled') {
      events.push(msg.params.args.map(a => a.value).join(' '));
    }
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

  // 注入事件探针：记录 pointerdown/up 的 button
  await evalJS(`(() => {
    window.__evts = [];
    addEventListener('pointerdown', e => window.__evts.push('down:' + e.button), true);
    addEventListener('pointerup',   e => window.__evts.push('up:' + e.button), true);
    addEventListener('pointercancel', e => window.__evts.push('cancel:' + e.button), true);
    return 'ok';
  })()`);

  let pass = 0, fail = 0;
  function check(name, cond, detail) {
    if (cond) { pass++; console.log('  PASS  ' + name); }
    else { fail++; console.log('  FAIL  ' + name + '  →  ' + detail); }
  }

  console.log('=== 中键轨道视角 ===');

  // 1. 中键按下
  await send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: 400, y: 200, button: 'middle', buttons: 4, clickCount: 1
  });
  await new Promise(r => setTimeout(r, 150));

  let st = await evalJS(`JSON.stringify({
    orbiting: document.body.classList.contains('orbiting'),
    evts: window.__evts.slice()
  })`);
  let d = JSON.parse(st);
  console.log('  按下后: ' + st);
  check('中键按下进入 orbit 状态', d.orbiting === true, `orbiting=${d.orbiting}`);

  // 2. 拖动
  await send('Input.dispatchMouseEvent', {
    type: 'mouseMoved', x: 500, y: 220, button: 'middle', buttons: 4
  });
  await new Promise(r => setTimeout(r, 150));

  // 3. 松开
  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: 500, y: 220, button: 'middle', buttons: 0, clickCount: 1
  });
  await new Promise(r => setTimeout(r, 200));

  st = await evalJS(`JSON.stringify({
    orbiting: document.body.classList.contains('orbiting'),
    evts: window.__evts.slice()
  })`);
  d = JSON.parse(st);
  console.log('  松开后: ' + st);
  check('中键松开退出 orbit 状态', d.orbiting === false, `orbiting=${d.orbiting}`);
  check('收到了 pointerup(button=1)', d.evts.some(e => e === 'up:1'), JSON.stringify(d.evts));

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  ws.close();
  try { proc.kill(); } catch (e) { /* ignore */ }
  setTimeout(() => process.exit(fail ? 1 : 0), 300);
}

main().catch(e => { console.error(e); process.exit(1); });
