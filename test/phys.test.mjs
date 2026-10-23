import * as THREE from '../vendor/three.module.js';
import { Level } from '../src/map.js';
import { Player } from '../src/player.js';

// 期望值全部由本机 DDNet 源码换算（tuning.h + gamecore.cpp，50Hz，1 tile = 32px）
const DT = 1 / 60;
const IDLE = { x: 0, z: 0, jump: false };
const level = new Level();

function run(p, ticks, input) {
  for (let i = 0; i < ticks; i++) p.step(DT, input);
  return p;
}

function report(name, actual, expect, ok) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  actual=${actual}  expect=${expect}`);
  if (!ok) process.exitCode = 1;
}

let p;

// 1. 静置落地（R = 14px/32 = 0.4375）
p = new Player(level);
run(p, 120, IDLE);
report('静置后站在地面', `y=${p.pos.y.toFixed(3)} grounded=${p.grounded}`,
  'y≈1.4375 grounded=true', Math.abs(p.pos.y - 1.4375) < 0.02 && p.grounded && p.deaths === 0);

// 2. 单跳高度：13.2²/(2·0.5) px = 174.24px = 5.445 tile
p = new Player(level);
run(p, 60, IDLE);
const baseY = p.pos.y;
let apex = baseY;
p.step(DT, { ...IDLE, jump: true });
for (let i = 0; i < 140; i++) { p.step(DT, IDLE); apex = Math.max(apex, p.pos.y); }
report('单跳高度', `${(apex - baseY).toFixed(2)} tile`, '5.2 < h < 5.7', apex - baseY > 5.2 && apex - baseY < 5.7);

// 3. 二段跳（air_jump_impulse 12.0 → 18.75 tile/s）
p = new Player(level);
run(p, 60, IDLE);
const b2 = p.pos.y;
let apex2 = b2;
p.step(DT, { ...IDLE, jump: true });
run(p, 20, IDLE);
p.step(DT, { ...IDLE, jump: true });
for (let i = 0; i < 140; i++) { p.step(DT, IDLE); apex2 = Math.max(apex2, p.pos.y); }
report('二段跳高度', `${(apex2 - b2).toFixed(2)} tile`, '8.0 < h < 10.5', apex2 - b2 > 8.0 && apex2 - b2 < 10.5);

// 4. 松手立刻停：ground_friction 是乘法 0.5/tick，不是线性减速
p = new Player(level);
run(p, 60, IDLE);
run(p, 60, { ...IDLE, x: 1 });
const vRun = p.vel.x;
run(p, 10, IDLE);
report('松手 0.17s 后剩余速度', `vx=${p.vel.x.toFixed(3)} (跑动时 ${vRun.toFixed(1)})`,
  '< 0.5 tile/s（乘法摩擦，几乎瞬停）', p.vel.x < 0.5 && vRun > 15);

// 5. 平地跳距 ≈ 16.5 tile（49~70 是地图上最长的一段平地，注意墙在 45~49）
p = new Player(level);
p.pos.set(50, 1.4375, 0);
run(p, 60, IDLE);
run(p, 12, { ...IDLE, x: 1 });
const jumpX0 = p.pos.x;
p.step(DT, { ...IDLE, x: 1, jump: true });
let landX = jumpX0;
for (let i = 0; i < 140; i++) {
  p.step(DT, { ...IDLE, x: 1 });
  if (p.grounded && i > 10) { landX = p.pos.x; break; }
}
report('平地跳距', `${(landX - jumpX0).toFixed(1)} tile`, '15 < d < 18（14 格坑可过）', landX - jumpX0 > 15 && landX - jumpX0 < 18);

// 6. 左边界不穿墙
p = new Player(level);
run(p, 400, { ...IDLE, x: -1 });
report('左墙阻挡', `x=${p.pos.x.toFixed(3)}`, 'x≈1.4375', Math.abs(p.pos.x - 1.4375) < 0.05);

// 7. 死亡坑 + 重生
p = new Player(level);
p.pos.set(27, 1.5, 0);
run(p, 120, IDLE);
report('死亡坑 + 重生', `deaths=${p.deaths} x=${p.pos.x.toFixed(2)}`, 'deaths=1 x≈5', p.deaths === 1 && Math.abs(p.pos.x - 5) < 0.2);

// 8. 钩子是飞行物：以 125 tile/s 飞出去
p = new Player(level);
p.pos.set(43.5, 1.5, 0);
p.vel.set(0, 0, 0);
const hookStart = p.pos.clone();
p.fireHook(new THREE.Vector3(0, 1, 0));      // 朝正上方，前面没东西
run(p, 6, IDLE);                              // 0.1s
const flew = p.hook.pos.distanceTo(hookStart);
report('钩子有飞行速度', `0.1s 飞了 ${flew.toFixed(1)} tile`, '11~14 tile（125 tile/s）', flew > 11 && flew < 14);

// 9. 够不到东西也会出钩，然后缩回
p = new Player(level);
p.pos.set(55, 1.5, 0);
p.vel.set(0, 0, 0);
p.fireHook(new THREE.Vector3(0, 1, 0));       // 朝上，头顶空旷
report('够不到也出钩', `state=${p.hook.state}`, 'flying', p.hook.state === 'flying');
run(p, 60, IDLE);
const stateAfterMax = p.hook.state;
run(p, 60, IDLE);
report('飞满长度后自动缩回', `${stateAfterMax} → ${p.hook.state}`, '最终回到 idle', p.hook.state === 'idle');

// 10. 钩到墙能被拉上去
p = new Player(level);
p.pos.set(43.5, 1.5, 0);
p.vel.set(0, 0, 0);
p.fireHook(new THREE.Vector3(2, 10.5, 0));
run(p, 30, IDLE);
const grabbed = p.hook.state === 'grabbed';
run(p, 240, IDLE);
report('钩中后拉上高墙', `grabbed=${grabbed} y=${p.pos.y.toFixed(2)}`, 'grabbed 且 y > 6', grabbed && p.pos.y > 6);

// 10. 窄门：中间车道可过
p = new Player(level);
p.pos.set(92, 1.5, 0);
run(p, 120, { ...IDLE, x: 1 });
report('窄门中间可通行', `x=${p.pos.x.toFixed(2)}`, 'x>95', p.pos.x > 95);

// 11. 窄门：外侧车道被挡
p = new Player(level);
p.pos.set(92, 1.5, 2);
run(p, 120, { ...IDLE, x: 1 });
report('窄门外侧被挡', `x=${p.pos.x.toFixed(2)}`, 'x<94', p.pos.x < 94);

// 12. 终点判定
p = new Player(level);
run(p, 30, IDLE);
p.pos.set(112, 12, 0);
run(p, 30, IDLE);
report('终点判定', `finished=${p.finished}`, 'finished=true', p.finished === true);

// 13. 站在方块边缘不侧滑（球体碰撞会因为斜向推出而滑落，方盒不会）
p = new Player(level);
p.pos.set(34.2, 1.4375, 0);      // 地面左边缘，只有 0.2 格搭在方块上
p.vel.set(0, 0, 0);
run(p, 180, IDLE);
report('站在棱角不侧滑', `x=${p.pos.x.toFixed(2)} y=${p.pos.y.toFixed(2)} grounded=${p.grounded}`,
  'x 不漂移 且 站着', Math.abs(p.pos.x - 34.2) < 0.02 && p.grounded);
