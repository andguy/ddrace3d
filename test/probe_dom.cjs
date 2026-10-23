// 在真实浏览器里测 DOM 变换矩阵与坐标换算
// 用 Edge 的 CDP：启动 --remote-debugging-port，用内置 WebSocket 发 Runtime.evaluate
const { spawn } = require('child_process');
const http = require('http');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9223;

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
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
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

  await new Promise(r => setTimeout(r, 3000));

  const expr = `(() => {
    const stage = document.getElementById('stage');
    const cs = getComputedStyle(stage);
    const r = stage.getBoundingClientRect();
    const pad = document.getElementById('aimpad');
    const pr = pad.getBoundingClientRect();
    const cv = document.getElementById('game');
    return JSON.stringify({
      innerW: innerWidth, innerH: innerHeight,
      rotated: document.body.classList.contains('rotated'),
      transform: cs.transform,
      stageRect: { left: r.left, top: r.top, width: r.width, height: r.height },
      stageOffset: { w: stage.offsetWidth, h: stage.offsetHeight },
      padRect: { left: pr.left, top: pr.top, width: pr.width, height: pr.height },
      padOffset: { w: pad.offsetWidth, h: pad.offsetHeight },
      canvasBuffer: { w: cv.width, h: cv.height },
      canvasCss: { w: cv.clientWidth, h: cv.clientHeight }
    }, null, 1);
  })()`;

  const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
  console.log(res.result?.result?.value || JSON.stringify(res.result));
  console.log('--- probe done ---');

  ws.close();
  try { proc.kill(); } catch (e) { /* ignore */ }
  setTimeout(() => process.exit(0), 300);
}

main().catch(e => { console.error(e); process.exit(1); });
