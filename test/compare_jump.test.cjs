// 对比：电脑端（空格）与手机端（跳按钮）的跳跃高度
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

// 在页面里装一个跳跃高度测量器
// 只测「离地后」的峰值高度：
// 记录起跳瞬间的 y（离地前最后一次 grounded 的位置），再追踪之后的最高点。
const INSTRUMENT = `(() => {
  const p = window.__player;
  window.__jumpPeak = { y0: p.pos.y, peak: p.pos.y, launched: false };
  window.__jumpTimer = setInterval(() => {
    const q = window.__player;
    if (!window.__jumpPeak.launched) {
      // 还没离地：持续更新基准点
      if (q.grounded) { window.__jumpPeak.y0 = q.pos.y; window.__jumpPeak.peak = q.pos.y; }
      else {
        // 刚刚离地
        window.__jumpPeak.launched = true;
        window.__jumpPeak.peak = q.pos.y;
      }
    } else if (!window.__jumpPeak.done) {
      if (q.pos.y > window.__jumpPeak.peak) window.__jumpPeak.peak = q.pos.y;
      // 落地不结束测量（要等落地后的稳定），只标记
      if (q.grounded && window.__jumpPeak.peak > window.__jumpPeak.y0 + 0.5) {
        window.__jumpPeak.done = true;
      }
    }
  }, 8);
  return 'armed';
})()`;

async function measureJump(label, port, query, trigger) {
  const b = await launch(port, query);
  // 用出生点（真实地面），不要硬编码坐标
  await b.evalJS(`(() => {
    const p = window.__player;
    p.respawn();
    p.vel.set(0,0,0);
    p.grounded = true;
    return 'reset';
  })()`);
  // 等角色站稳（grounded 且速度归零）
  for (let i = 0; i < 30; i++) {
    const st = await b.evalJS(`(() => {
      const p = window.__player;
      return JSON.stringify({ g: p.grounded, y: +p.pos.y.toFixed(3) });
    })()`);
    const sd = JSON.parse(st);
    if (sd.g) break;
    await new Promise(r => setTimeout(r, 60));
  }
  await b.evalJS(INSTRUMENT);
  // 记录 vel.y 的正向跳变次数（每次起跳/二段跳都会产生一次）
  await b.evalJS(`(() => {
    const p = window.__player;
    window.__vyJumps = [];
    window.__jumpTrueCount = 0;
    window.__stepCount = 0;
    let prev = p.vel.y;
    const orig = p.step.bind(p);
    p.step = function(dt, inp) {
      window.__stepCount++;
      if (inp.jump) window.__jumpTrueCount++;
      const before = p.vel.y;
      orig(dt, inp);
      if (p.vel.y - before > 5) window.__vyJumps.push({ vy: +p.vel.y.toFixed(2), g: p.grounded });
    };
    return 'patched';
  })()`);
  await new Promise(r => setTimeout(r, 150));
  await trigger(b);
  await new Promise(r => setTimeout(r, 1200));
  const res = await b.evalJS(`(() => {
    clearInterval(window.__jumpTimer);
    const j = window.__jumpPeak;
    return JSON.stringify({
      y0: +j.y0.toFixed(3), peak: +j.peak.toFixed(3),
      height: +(j.peak - j.y0).toFixed(3),
      launched: j.launched, done: !!j.done,
      vyJumps: window.__vyJumps,
      jumpTrueCount: window.__jumpTrueCount,
      stepCount: window.__stepCount
    });
  })()`);
  try { b.proc.kill(); } catch (e) {}
  await new Promise(r => setTimeout(r, 600));
  const d = JSON.parse(res);
  console.log(`  ${label}: 高度 = ${d.height} 格  (起跳 y=${d.y0} → 峰值 ${d.peak})`);
  console.log(`      vel.y 跳变: ${JSON.stringify(d.vyJumps)}  (JUMP_GROUND=20.625, JUMP_AIR=18.75)`);
  console.log(`      inp.jump=true 的帧数: ${d.jumpTrueCount} / 总 step 帧数: ${d.stepCount}`);
  return d;
}

async function main() {
  console.log('=== 跳跃高度对比 ===\n');

  // 电脑端：空格
  const desk = await measureJump('电脑端（空格）', 9260, '', async (b) => {
    await b.evalJS(`(() => { dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' })); return 'ok'; })()`);
  });

  // 手机端：跳按钮
  const mob = await measureJump('手机端（跳按钮）', 9261, '?touch=1', async (b) => {
    const btn = JSON.parse(await b.evalJS(`(() => {
      const r = document.getElementById('btn-jump').getBoundingClientRect();
      return JSON.stringify({ l: r.left, t: r.top, w: r.width, h: r.height });
    })()`));
    const x = btn.l + btn.w / 2, y = btn.t + btn.h / 2;
    await b.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
    await new Promise(r => setTimeout(r, 60));
    await b.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  });

  console.log('\n=== 对比 ===');
  const diff = Math.abs(desk.height - mob.height);
  console.log(`  电脑 ${desk.height} 格 vs 手机 ${mob.height} 格，差 ${diff.toFixed(3)} 格`);
  console.log(diff < 0.3 ? '  ✓ 基本一致' : '  ❌ 高度不同');

  setTimeout(() => process.exit(0), 300);
}

main().catch(e => { console.error(e); process.exit(1); });
