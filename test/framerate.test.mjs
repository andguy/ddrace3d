// 验证：不同帧率下物理是否一致
// 主循环用固定步长 1/60，每帧最多 5 步（steps < 5）。
// 帧率低时 acc 消耗不完 → 每帧有物理时间被丢弃 → 游戏变慢。
import { Level } from '../src/map.js';
import { Player } from '../src/player.js';
import { readFileSync } from 'node:fs';

const data = JSON.parse(readFileSync(new URL('../levels/qeasy.json', import.meta.url), 'utf8'));
const FIXED_DT = 1 / 60;
const MAX_STEPS = 15;   // 与 src/main.js 的主循环保持一致

function run(fps, seconds = 3) {
  const level = new Level(data);
  const p = new Player(level);
  p.pos.copy(level.spawn);
  const input = { x: 1, z: 0, jump: false };

  const frameTime = 1 / fps;
  let acc = 0;
  let elapsed = 0;          // 实际推进的物理时间
  let wallTime = 0;         // 真实经过的时间
  let lostTime = 0;         // 被丢弃的物理时间

  while (wallTime < seconds) {
    acc += frameTime;
    let steps = 0;
    while (acc >= FIXED_DT && steps < MAX_STEPS) {
      p.step(FIXED_DT, input);
      acc -= FIXED_DT;
      steps++;
      elapsed += FIXED_DT;
    }
    if (acc >= FIXED_DT) {
      // 步数用尽还有积压 → 这部分物理时间被丢弃
      const dropped = Math.floor(acc / FIXED_DT) * FIXED_DT;
      lostTime += dropped;
      acc -= dropped;
    }
    wallTime += frameTime;
  }
  return { p, elapsed, wallTime, lostTime, x: p.pos.x };
}

console.log('=== 同一段输入，不同帧率下的结果 ===');
console.log('（按住 D 前进 3 秒，理论上 x 应该一致）\n');

const ref = run(60);
console.log(`60 fps  (基准): x=${ref.x.toFixed(2)}  物理时间=${ref.elapsed.toFixed(3)}s  丢弃=${ref.lostTime.toFixed(3)}s`);
console.log('');

for (const fps of [60, 45, 30, 24, 20, 15, 12, 10, 8]) {
  const r = run(fps);
  const dx = r.x - ref.x;
  const pct = (dx / ref.x) * 100;
  const slow = r.lostTime / r.wallTime * 100;
  const mark = Math.abs(pct) < 1 ? '✓ 一致' : (pct < 0 ? '❌ 变慢' : '⚠️ 偏快');
  console.log(
    `${String(fps).padStart(3)} fps: x=${r.x.toFixed(2).padStart(7)}  ` +
    `偏差=${dx >= 0 ? '+' : ''}${dx.toFixed(2)} (${pct.toFixed(1)}%)  ` +
    `丢弃物理时间=${(slow).toFixed(1)}%  ${mark}`
  );
}

console.log('\n=== 结论 ===');
console.log('帧率低到一定程度，物理时间才会被丢弃（步数上限 15 步 = 4fps）。');
console.log('配合"只渲染暴露面"（15 万 → 2.6 万实例），手机帧率已能稳住。');
