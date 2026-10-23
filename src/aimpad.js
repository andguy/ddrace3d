// 瞄准轮盘：手机上把「瞄准」和「出钩」合并成一个控件
//
// 为什么必须合并：
//   绝大多数人用双手拇指操作 —— 左手负责移动摇杆，右手只有一根拇指。
//   如果瞄准和出钩是两个按钮，右手拇指没法同时按到，
//   必须先松手瞄准、再按出钩，操作会非常别扭。
//
// 所以：轮盘本身就是钩子按钮。
//   按住轮盘   → 出钩（并保持，和 DDNet 按住鼠标左键一样）
//   拖动轮盘   → 实时改变钩子飞行的方向（钩子还在飞时也能改）
//   松开轮盘   → 脱钩
//
// 方向语义（关键，容易搞错）：
//   dx/dy 是舞台【局部 CSS 坐标】的位移。
//   局部坐标系 = 画面坐标系（画面内容也随 stage 一起旋转），
//   所以「画面右」= 局部 +x，「画面上」= 局部 -y。
//   关卡平面是 x 右 y 上，因此 levelX = dx, levelY = -dy。
//   这个换算与是否旋转无关 —— 因为画面和轮盘是一起转的。
//
// 实测（Edge 无头，stage 顺时针 90°）：
//   屏幕右 → 局部 (0,-1)   屏幕下 → 局部 (+1,0)
//   即「画面右 = 局部 -y」。若把局部直接当地标用，转屏后钩子方向会反。

import { screenToStage } from './viewport.js';

export class AimPad {
  /**
   * @param {HTMLElement} padEl  轮盘容器
   * @param {HTMLElement} knobEl 轮盘把手
   * @param {number} radius 把手最大偏移（像素）
   * @param {object} hooks 回调 { onFire(dirX, dirY), onRelease() }
   */
  constructor(padEl, knobEl, radius, hooks = {}) {
    this.padEl = padEl;
    this.knobEl = knobEl;
    this.radius = radius;
    this.hooks = hooks;
    // 当前偏移（像素，相对中心，舞台局部坐标）
    this.dx = 0;
    this.dy = 0;
    this.active = false;
    this.pointerId = -1;
    // 归一化的关卡平面方向（x 右 y 上）
    this.dirX = 1;
    this.dirY = 0;
    // 本次按下是否重新指定了方向（落在中心 = 没指定，沿用上次）
    this.dirUnset = false;
    // 本次按下是否已经出钩
    this.fired = false;
    // 累计的视角增量（第一人称用），每帧取用后清零
    this.yawDelta = 0;

    padEl.addEventListener('pointerdown', (e) => this.onDown(e));
    padEl.addEventListener('pointermove', (e) => this.onMove(e));
    padEl.addEventListener('pointerup', (e) => this.onUp(e));
    padEl.addEventListener('pointercancel', (e) => this.onUp(e));
  }

  onDown(e) {
    e.preventDefault();
    this.padEl.setPointerCapture(e.pointerId);
    this.pointerId = e.pointerId;
    this.active = true;
    this.dirUnset = false;
    this.update(e);
    // 注意：这里【不】立即出钩。
    // 手机上先给 0.2 秒瞄准时间（由 main.js 计时触发 onFire），
    // 否则拇指一碰轮盘钩子就飞走了，根本来不及瞄准。
    // 方向取"手指落点相对轮盘中心"的方向：落在中心才沿用上次的方向。
    if (this.hooks.onPress) this.hooks.onPress(this.dirX, this.dirY, !this.dirUnset);
  }

  onMove(e) {
    if (e.pointerId !== this.pointerId) return;
    e.preventDefault();
    this.update(e);
    // 拖动时如果已经出钩了，通知上层改方向
    if (this.fired && this.hooks.onAim) this.hooks.onAim(this.dirX, this.dirY);
  }

  onUp(e) {
    if (e.pointerId !== this.pointerId) return;
    e.preventDefault();
    this.pointerId = -1;
    this.active = false;
    this.fired = false;
    // 松手脱钩
    if (this.hooks.onRelease) this.hooks.onRelease();
  }

  update(e) {
    // 关键：必须用舞台局部坐标，因为 stage 可能被旋转了 90°
    const local = this.toLocal(e.clientX, e.clientY);
    // 轮盘中心也换算到局部坐标。
    // 注意：旋转后 getBoundingClientRect() 返回的是屏幕包围盒，
    // 不能直接拿它的宽高当局部尺寸用；只用它的中心点做换算即可。
    const r = this.padEl.getBoundingClientRect();
    const centerScreen = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    const c = this.toLocal(centerScreen.x, centerScreen.y);

    let dx = local.x - c.x;
    let dy = local.y - c.y;
    const len = Math.hypot(dx, dy);
    if (len > this.radius) {
      dx = dx / len * this.radius;
      dy = dy / len * this.radius;
    }
    this.dx = dx;
    this.dy = dy;

    // 归一化成关卡平面方向（x 右 y 上）
    const l2 = Math.hypot(dx, dy);
    if (l2 > 2) {
      this.dirX = dx / l2;
      this.dirY = -dy / l2;      // 局部 y 向下 → 关卡平面 y 向上
    } else {
      // 手指落在中心附近：保留上一次方向，但记录"未重新定向"，
      // 让 onFire 能知道"这次按下没有指定新方向"
      this.dirUnset = true;
    }

    this.knobEl.style.transform = `translate(${dx}px, ${dy}px)`;
  }

  /** 把客户端坐标换成舞台局部坐标 */
  toLocal(clientX, clientY) {
    return screenToStage(clientX, clientY);
  }

  /** 关卡平面方向（x 右 y 上），已归一化 */
  dir(out) {
    out.x = this.dirX;
    out.y = this.dirY;
    return true;
  }

  /**
   * 局部坐标系下的归一化偏移（x 右、y 下）。
   * 第一人称用「速率控制」：把手推向哪边就持续往哪转。
   */
  offset(out) {
    const len = Math.hypot(this.dx, this.dy);
    if (len < 1e-3) { out.x = 0; out.y = 0; return false; }
    out.x = this.dx / len;
    out.y = this.dy / len;
    return true;
  }

  /** 偏移幅度（0~1），用于速率控制的强度 */
  magnitude() {
    return Math.min(1, Math.hypot(this.dx, this.dy) / this.radius);
  }

  /** 累计的视角增量（取用后清零） */
  takeYawDelta() {
    const d = this.yawDelta;
    this.yawDelta = 0;
    return d;
  }
}
