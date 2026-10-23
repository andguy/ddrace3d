// 第一人称输入方向测试：直接引用 src/input.js 的真实实现
import { firstPersonInput, thirdPersonInput } from '../src/input.js';

const out = { x: 0, z: 0 };
let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + '  →  ' + detail); }
}

// 相机前向 = (-sin yaw, 0, -cos yaw)，右向 = (cos yaw, 0, -sin yaw)
function basis(viewYaw) {
  return {
    fx: -Math.sin(viewYaw), fz: -Math.cos(viewYaw),
    rx: Math.cos(viewYaw), rz: -Math.sin(viewYaw)
  };
}

console.log('=== 第一人称方向映射 ===');
const YAW = -Math.PI / 2;   // 默认看向 +x
const { fx, fz, rx, rz } = basis(YAW);
console.log(`  相机前向 = (${fx.toFixed(2)}, ${fz.toFixed(2)})，右向 = (${rx.toFixed(2)}, ${rz.toFixed(2)})\n`);

const w = firstPersonInput(YAW, 1, 0, out);
check('W = 前进（沿相机前向）', w.x * fx + w.z * fz > 0.99,
  `W→(${w.x.toFixed(2)},${w.z.toFixed(2)}) 点积 ${(w.x * fx + w.z * fz).toFixed(2)}`);

const s = firstPersonInput(YAW, -1, 0, out);
check('S = 后退（逆相机前向）', s.x * fx + s.z * fz < -0.99,
  `S→(${s.x.toFixed(2)},${s.z.toFixed(2)})`);

const d = firstPersonInput(YAW, 0, 1, out);
check('D = 右移（沿相机右向）', d.x * rx + d.z * rz > 0.99,
  `D→(${d.x.toFixed(2)},${d.z.toFixed(2)})`);

const a = firstPersonInput(YAW, 0, -1, out);
check('A = 左移（逆相机右向）', a.x * rx + a.z * rz < -0.99,
  `A→(${a.x.toFixed(2)},${a.z.toFixed(2)})`);

const wd = firstPersonInput(YAW, 1, 1, out);
check('W+D = 斜前右',
  wd.x * fx + wd.z * fz > 0.99 && wd.x * rx + wd.z * rz > 0.99,
  `WD→(${wd.x.toFixed(2)},${wd.z.toFixed(2)})`);

// 转向 180° 后 W 应指向新前向
const YAW2 = Math.PI / 2;
const b2 = basis(YAW2);
const w2 = firstPersonInput(YAW2, 1, 0, out);
check('转向后 W 仍沿新前向', w2.x * b2.fx + w2.z * b2.fz > 0.99,
  `W→(${w2.x.toFixed(2)},${w2.z.toFixed(2)})`);

// 斜视 45°
const YAW3 = -Math.PI / 4;
const b3 = basis(YAW3);
const w3 = firstPersonInput(YAW3, 1, 0, out);
check('斜视 45° 时 W 仍沿前向', w3.x * b3.fx + w3.z * b3.fz > 0.99,
  `W→(${w3.x.toFixed(2)},${w3.z.toFixed(2)})`);

// 摇杆：向上推（tz 为负）= 前进
const stickUp = firstPersonInput(YAW, 0 - (-1), 0, out);   // kForward = -tz，tz=-1
check('摇杆向上推 = 前进', stickUp.x * fx + stickUp.z * fz > 0.99,
  `stickUp→(${stickUp.x.toFixed(2)},${stickUp.z.toFixed(2)})`);

console.log('\n=== 第三人称方向映射 ===');
const t = thirdPersonInput(1, -1, out);
check('A/D → 关卡前后（x）', t.x === 1, `x=${t.x}`);
check('W/S → 管道深度（z）', t.z === -1, `z=${t.z}`);

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
