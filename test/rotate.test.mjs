// 旋转后的坐标换算验证
// stage 旋转 90° 后，屏幕坐标 ≠ 舞台局部坐标。
// 触摸事件必须反算回局部坐标，否则摇杆/轮盘会错位。

// ── 复刻 viewport.js 的换算逻辑（与实现保持一致）──
// stage 用 transform: translate(-50%,-50%) rotate(90deg)
// rotate(90deg) 顺时针：局部 +x → 屏幕 +y（向下），局部 +y → 屏幕 -x（向左）

function makeView(vw, vh, rotated, angle) {
  // 舞台矩形（屏幕坐标下的轴对齐包围盒）
  let rect;
  if (rotated) {
    // 旋转 90°：舞台宽高对调，且以视口中心为中心
    const sw = vh, sh = vw;
    rect = {
      left: (vw - sw) / 2,
      top: (vh - sh) / 2,
      width: sw,
      height: sh
    };
  } else {
    rect = { left: 0, top: 0, width: vw, height: vh };
  }
  return { vw, vh, rotated, angle, rect };
}

// 屏幕坐标 → 舞台局部坐标
function screenToStage(v, clientX, clientY) {
  if (!v.rotated) return { x: clientX, y: clientY };
  // rotate(90deg)：局部 x 轴向下，局部 y 轴向左
  // 屏幕点 (cx,cy) 相对舞台中心 → 局部
  const cx = v.rect.left + v.rect.width / 2;
  const cy = v.rect.top + v.rect.height / 2;
  const sx = clientX - cx;
  const sy = clientY - cy;
  // 顺时针 90°：屏幕 (sx,sy) → 局部 (-sy, sx)
  if (v.angle === 90) {
    return { x: -sy + v.rect.width / 2, y: sx + v.rect.height / 2 };
  }
  // 逆时针 90°（-90）：屏幕 (sx,sy) → 局部 (sy, -sx)
  return { x: sy + v.rect.width / 2, y: -sx + v.rect.height / 2 };
}

// 局部坐标 → 屏幕坐标（正向，用于验证）
function stageToScreen(v, lx, ly) {
  if (!v.rotated) return { x: lx, y: ly };
  const cx = v.rect.left + v.rect.width / 2;
  const cy = v.rect.top + v.rect.height / 2;
  const sx = lx - v.rect.width / 2;
  const sy = ly - v.rect.height / 2;
  if (v.angle === 90) {
    return { x: cx + -sy, y: cy + sx };
  }
  return { x: cx + sy, y: cy + -sx };
}

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + '  →  ' + detail); }
}

const VW = 430, VH = 860;   // 竖屏手机

console.log('=== 竖屏 + 顺时针 90° ===');
const v90 = makeView(VW, VH, true, 90);
console.log(`  舞台包围盒: ${JSON.stringify(v90.rect)}`);

// 舞台四角必须能正反映射回自身
const corners = [
  [0, 0], [v90.rect.width, 0],
  [0, v90.rect.height], [v90.rect.width, v90.rect.height]
];
let cornerOk = true, cornerDetail = '';
for (const [lx, ly] of corners) {
  const s = stageToScreen(v90, lx, ly);
  const back = screenToStage(v90, s.x, s.y);
  const err = Math.hypot(back.x - lx, back.y - ly);
  if (err > 0.001) {
    cornerOk = false;
    cornerDetail += ` 局部(${lx},${ly}) → 屏幕(${s.x.toFixed(1)},${s.y.toFixed(1)}) → 局部(${back.x.toFixed(2)},${back.y.toFixed(2)}) 误差 ${err.toFixed(4)}\n`;
  }
}
check('四角正反映射误差 < 0.001', cornerOk, cornerDetail);

// 旋转后舞台尺寸 = 视口尺寸交换
check('舞台宽 = 视口高', v90.rect.width === VH, `width=${v90.rect.width}`);
check('舞台高 = 视口宽', v90.rect.height === VW, `height=${v90.rect.height}`);

console.log('\n=== 竖屏 + 逆时针 90° ===');
const vm90 = makeView(VW, VH, true, -90);
let cornerOk2 = true, d2 = '';
for (const [lx, ly] of corners) {
  const s = stageToScreen(vm90, lx, ly);
  const back = screenToStage(vm90, s.x, s.y);
  const err = Math.hypot(back.x - lx, back.y - ly);
  if (err > 0.001) { cornerOk2 = false; d2 += ` 误差 ${err.toFixed(4)}\n`; }
}
check('四角正反映射误差 < 0.001', cornerOk2, d2);

console.log('\n=== 横屏（不旋转）===');
const vl = makeView(860, 430, false, 90);
const p0 = screenToStage(vl, 100, 200);
check('横屏时坐标直通', p0.x === 100 && p0.y === 200, `(${p0.x},${p0.y})`);

console.log('\n=== 局部方向语义 ===');
// 局部 +y（向上，屏幕上方）应映射到屏幕某个确定方向
const upLocal = stageToScreen(v90, v90.rect.width / 2, 0);   // 顶部中点
const downLocal = stageToScreen(v90, v90.rect.width / 2, v90.rect.height);
console.log(`  局部顶部中点 → 屏幕 (${upLocal.x.toFixed(1)}, ${upLocal.y.toFixed(1)})`);
console.log(`  局部底部中点 → 屏幕 (${downLocal.x.toFixed(1)}, ${downLocal.y.toFixed(1)})`);
check('局部上/下映射到不同的屏幕点', upLocal.x !== downLocal.x || upLocal.y !== downLocal.y, '重合了');

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
