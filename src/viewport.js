// 视口与方向管理
// QQ 内置浏览器的坑：
//   1. screen.orientation 可能不存在或不可靠
//   2. orientationchange 事件常常不触发
//   3. resize 在部分机型上也不及时
// 所以这里不用事件，而是每帧轮询 innerWidth/innerHeight。
//
// 布局策略：画面始终是横屏的。
//   竖屏时把整个 #stage 旋转 90°，视觉上就是横屏；
//   用户把手机横过来后，视口变成横的，旋转自动撤掉 —— 两个方向都能正常玩。
//
// 触摸坐标：stage 旋转后，屏幕坐标不再等于舞台局部坐标。
// 关键点：getBoundingClientRect() 在旋转后返回的是【屏幕空间的包围盒】，
// 而元素自身的 offsetWidth/offsetHeight 才是【局部尺寸】。
// 所以换算必须基于变换矩阵，不能直接用 rect 的宽高。

export const view = {
  // 舞台的局部尺寸（未旋转时 = 视口尺寸；旋转时 = 交换后的尺寸）
  w: 0,
  h: 0,
  // 当前是否处于「旋转显示」状态
  rotated: false,
  // 旋转角度（度）：竖屏时 stage 转多少
  // 默认 +90（顺时针）：用户把手机逆时针转到横屏后，画面正好是正的
  angle: 90,
};

const stage = document.getElementById('stage');

/**
 * 检查视口是否变化，需要时更新布局。
 * 每帧调用；只在尺寸真的变了时才做重活。
 * @returns {boolean} 是否发生了布局变化
 */
export function pollViewport() {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const wantRotated = vh > vw;   // 竖屏 → 旋转成横屏

  if (view.w === vw && view.h === vh && view.rotated === wantRotated) {
    return false;
  }

  view.w = vw;
  view.h = vh;
  view.rotated = wantRotated;

  if (wantRotated) {
    // 旋转后 stage 的局部宽高要交换
    stage.style.width = vh + 'px';
    stage.style.height = vw + 'px';
    stage.style.setProperty('--rot', view.angle + 'deg');
    document.body.classList.add('rotated');
  } else {
    stage.style.width = vw + 'px';
    stage.style.height = vh + 'px';
    document.body.classList.remove('rotated');
  }
  refreshMatrix();
  return true;
}

// ── 变换矩阵 ──
// stage 的变换是 translate(-50%,-50%) rotate(θ)。
// 实测（Edge 无头，竖屏 496x767）：
//   computed transform = matrix(0, 1, -1, 0, -383.5, -248)
//   stageOffset = 767x496（局部），getBoundingClientRect = 496x767（屏幕包围盒）
// 直接从 computed style 读矩阵最可靠，不手算平移量。
let stageMatrix = null;   // DOMMatrix：局部 → 屏幕
let stageInverse = null;  // DOMMatrix：屏幕 → 局部

function refreshMatrix() {
  const cs = getComputedStyle(stage);
  const t = cs.transform;
  if (!t || t === 'none') {
    stageMatrix = new DOMMatrix();
    stageInverse = new DOMMatrix();
    return;
  }
  try {
    stageMatrix = new DOMMatrix(t);
    stageInverse = stageMatrix.inverse();
  } catch (e) {
    stageMatrix = new DOMMatrix();
    stageInverse = new DOMMatrix();
  }
}

/** 旋转角可能被用户切换过，需要时刷新矩阵 */
export function refreshTransform() {
  refreshMatrix();
}

/**
 * 屏幕坐标 → 舞台局部坐标。
 */
export function screenToStage(clientX, clientY) {
  if (!view.rotated) return { x: clientX, y: clientY };
  if (!stageInverse) refreshMatrix();
  const p = stageInverse.transformPoint(new DOMPoint(clientX, clientY));
  return { x: p.x, y: p.y };
}

/**
 * 舞台局部坐标 → 屏幕坐标（画 UI 时用，比如准星定位）。
 */
export function stageToScreen(lx, ly) {
  if (!view.rotated) return { x: lx, y: ly };
  if (!stageMatrix) refreshMatrix();
  const p = stageMatrix.transformPoint(new DOMPoint(lx, ly));
  return { x: p.x, y: p.y };
}

/** 旋转方向切换（竖屏显示方向反了时用） */
export function cycleRotation() {
  const order = [90, -90, 180];
  const i = order.indexOf(view.angle);
  view.angle = order[(i + 1) % order.length];
  if (view.rotated) {
    stage.style.setProperty('--rot', view.angle + 'deg');
    refreshMatrix();
  }
  return view.angle;
}

export function setRotation(deg) {
  view.angle = deg;
  if (view.rotated) {
    stage.style.setProperty('--rot', deg + 'deg');
    refreshMatrix();
  }
}
