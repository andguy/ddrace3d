// 在物理层直接测跳跃高度 —— 不受渲染帧率、时序、测量基准影响
// 对比：不同"输入注入方式"是否产生相同结果
import { Level } from '../src/map.js';
import { Player } from '../src/player.js';
import { readFileSync } from 'node:fs';

const data = JSON.parse(readFileSync(new URL('../levels/qeasy.json', import.meta.url), 'utf8'));
const FIXED_DT = 1 / 60;

function measureJump(trigger, label) {
  const level = new Level(data);
  const p = new Player(level);
  // 找一段平整地面
  p.pos.set(4, 1.4375, 0);
  p.vel.set(0, 0, 0);
  p.grounded = true;

  // 先稳定 30 帧
  for (let i = 0; i < 30; i++) p.step(FIXED_DT, { x: 0, z: 0, jump: false });

  const y0 = p.pos.y;
  let peak = y0;
  let jumps = 0;
  let prevVy = p.vel.y;
  let jumpFrames = 0;

  for (let i = 0; i < 120; i++) {
    const inp = trigger(i);
    p.step(FIXED_DT, inp);
    if (p.vel.y - prevVy > 5) jumps++;
    prevVy = p.vel.y;
    if (p.vel.y > 0) jumpFrames++;
    if (p.pos.y > peak) peak = p.pos.y;
  }
  return { label, height: peak - y0, jumps, jumpFrames };
}

console.log('=== 物理层跳跃高度对比 ===\n');

// 电脑端：空格 —— keydown 一次，jump=true 持续 1 帧
const desk = measureJump((i) => ({ x: 0, z: 0, jump: i === 0 }), '电脑（空格：1帧）');

// 手机端：按钮 —— pointerdown 一次，理论上也是 1 帧
const mob = measureJump((i) => ({ x: 0, z: 0, jump: i === 0 }), '手机（按钮：1帧）');

// 如果手机端"按住不放"会持续 jump=true
const mobHold = measureJump((i) => ({ x: 0, z: 0, jump: true }), '手机（按钮：持续按住）');

// 看看 input.jump 持续为 true 时会发生什么
console.log(`  ${desk.label}:   高度 ${desk.height.toFixed(3)} 格, 冲动次数 ${desk.jumps}`);
console.log(`  ${mob.label}:   高度 ${mob.height.toFixed(3)} 格, 冲动次数 ${mob.jumps}`);
console.log(`  ${mobHold.label}: 高度 ${mobHold.height.toFixed(3)} 格, 冲动次数 ${mobHold.jumps}`);
console.log('');

// 分析：jump 持续为 true 时，第一帧起跳后 grounded=false，
// 第二帧 jumpAvail 还是 true → 触发二段跳！这就是手机跳更高的原因。
console.log('=== 分析 ===');
console.log('player.js 的跳跃逻辑：');
console.log('  if (grounded) { vel.y = JUMP_GROUND; jumpAvail = true; }');
console.log('  else if (jumpAvail) { vel.y = JUMP_AIR; jumpAvail = false; }');
console.log('');
console.log('如果 inp.jump 连续多帧为 true：');
console.log('  帧1: grounded → 起跳 vel.y=20.625, jumpAvail=true');
console.log('  帧2: 已离地(grounded=false) 但 jumpAvail=true → 触发二段跳 vel.y=18.75');
console.log('  → 高度叠加，这就是"手机跳更高"');
console.log('');

// 验证：只给 1 帧 true 就不会二段跳
const single = measureJump((i) => ({ x: 0, z: 0, jump: i === 0 }), '只给1帧');
console.log(`  只给 1 帧 true: 高度 ${single.height.toFixed(3)} 格, 冲动 ${single.jumps} 次`);

console.log('\n=== 结论 ===');
console.log(single.height < 2.5
  ? '  ✓ 1 帧输入 → 正常跳跃高度（与 DDNet 一致）'
  : '  ❌ 仍有异常');
