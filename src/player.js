import * as THREE from '../vendor/three.module.js';

// ─────────────────────────────────────────────────────────────
// 玩家物理：AABB vs AABB，分轴移动 + 沿轴推出。
//
// ★ 碰撞形状是【方盒】不是球。DDNet 的 PhysicalSize = 28px，
//   源码 collision.cpp 的 MoveBox 就是 28x28 矩形扫掠。
//   用球体做碰撞会在方块棱角产生斜向推出 —— 那就是"脚滑"，原版没有。
//
// ★ 常数全部对照本机 DDNet 源码：src/game/tuning.h + src/game/gamecore.cpp
//   （SERVER_TICK_SPEED = 50，PhysicalSize = 28px，1 tile = 32px）
//
//   tuning.h 原始值            →  换算（px/tick → tile/s）
//   gravity            0.5     →  0.5 × 50² / 32        = 39.06  tile/s²
//   ground_jump_impulse 13.2   →  13.2 × 50 / 32        = 20.625 tile/s
//   air_jump_impulse    12.0   →  12.0 × 50 / 32        = 18.75  tile/s
//   ground_control_speed 10    →  10 × 50 / 32          = 15.625 tile/s
//   air_control_speed   250/50 →  5 × 50 / 32           = 7.8125 tile/s
//   ground_control_accel 100/50→  2.0 × 50² / 32        = 156.25 tile/s²
//   air_control_accel    1.5   →  1.5 × 50² / 32        = 117.19 tile/s²
//   ground_friction     0.5    →  乘法 0.5/tick → 指数 k = ln(0.5)×50  = 34.66
//   air_friction        0.95   →  乘法 0.95/tick → 指数 k = ln(0.95)×50 = 2.564
//   hook_length         380    →  380 / 32              = 11.875 tile
//   hook_fire_speed     80     →  80 × 50 / 32          = 125    tile/s
//   hook_drag_accel     3.0    →  3.0 × 50² / 32        = 234    tile/s²
//   hook_drag_speed     15     →  15 × 50 / 32          = 23.4375 tile/s
//
// 钩子是【飞行物】不是射线：以 125 tile/s 飞出去，撞到实体才抓住，
// 飞满 11.875 格没撞到就缩回 —— 所以够不到东西时也能出钩。
// ─────────────────────────────────────────────────────────────

const HS = 0.4375;                // 半边长 = 14px / 32
const GRAVITY = -39.06;
const TERMINAL_VY = -60;

const JUMP_GROUND = 20.625;
const JUMP_AIR = 18.75;

const MAX_SPEED_GROUND = 15.625;
const MAX_SPEED_AIR = 7.8125;
const ACCEL_GROUND = 156.25;
const ACCEL_AIR = 117.19;
const FRICTION_GROUND = 34.66;
const FRICTION_AIR = 2.564;

export const HOOK_LENGTH = 11.875;
const HOOK_FIRE_SPEED = 125;
const HOOK_DRAG_ACCEL = 234;
const HOOK_DRAG_SPEED = 23.4375;
const HOOK_MIN_DIST = 1.4375;      // 46px，小于这个距离不再拉拽
const HOOK_DOWN_SCALE = 0.3;
const HOOK_SAME_DIR = 0.95;
const HOOK_OTHER_DIR = 0.75;

const COYOTE_TIME = 0.06;
const GROUND_PROBE = 0.156;        // 5px
const MAX_SUBSTEP = 0.25;

export const HOOK_IDLE = 'idle';
export const HOOK_FLYING = 'flying';
export const HOOK_GRABBED = 'grabbed';
export const HOOK_RETRACTING = 'retracting';

export class Player {
  constructor(level) {
    this.level = level;
    this.pos = level.spawn.clone();
    this.vel = new THREE.Vector3();
    this.grounded = false;
    this.coyote = 0;
    this.jumpAvail = true;
    // 事件队列：物理层只记录"发生了什么"，由上层决定怎么表现（音效等）
    this.events = [];
    this.facing = 1;
    this.deaths = 0;
    this.finished = false;
    this.hook = {
      state: HOOK_IDLE,
      pos: new THREE.Vector3(),      // 钩头位置（飞行中实时更新）
      dir: new THREE.Vector3(1, 0, 0),
      anchor: new THREE.Vector3(),   // 抓住后的锚点
      origin: new THREE.Vector3(),   // 发射点（第一人称下是身体右下方，不是镜头中心）
      travel: 0
    };
    this._wish = new THREE.Vector3();
    this._tmp = new THREE.Vector3();
  }

  respawn() {
    this.pos.copy(this.level.spawn);
    this.vel.set(0, 0, 0);
    this.releaseHook();
    this.jumpAvail = true;
    this.deaths++;
  }

  get hookActive() {
    return this.hook.state === HOOK_GRABBED;
  }

  // 朝某个方向把钩子甩出去。不管前方有没有东西都会发射。
  fireHook(dir, origin) {
    const h = this.hook;
    if (!dir || dir.lengthSq() < 1e-6) return;
    h.state = HOOK_FLYING;
    h.dir.copy(dir).normalize();
    h.origin.copy(origin || this.pos);
    h.pos.copy(h.origin).addScaledVector(h.dir, HS * 2);
    h.travel = 0;
  }

  releaseHook() {
    this.hook.state = HOOK_IDLE;
    this.hook.travel = 0;
  }

  step(dt, inp) {
    const pos = this.pos;
    const vel = this.vel;
    if (this.coyote > 0) this.coyote -= dt;

    this.updateHookFlight(dt);

    // 冻结区（水）：重力减半、速度上限砍半、额外阻尼
    this.inFreeze = this.checkFreeze();

    // ── 1. 重力 ──
    vel.y += GRAVITY * (this.inFreeze ? 0.45 : 1) * dt;
    if (vel.y < TERMINAL_VY) vel.y = TERMINAL_VY;

    // ── 2. 跳跃 ──
    if (inp.jump) {
      if (this.grounded || this.coyote > 0) {
        vel.y = JUMP_GROUND;
        this.grounded = false;
        this.coyote = 0;
        this.jumpAvail = true;
      } else if (this.jumpAvail) {
        vel.y = JUMP_AIR;
        this.jumpAvail = false;
        this.events.push('dbljump');
      }
    }

    // ── 3. 水平控制：SaturatedAdd 语义 ──
    const slow = this.inFreeze ? 0.5 : 1;
    const maxSpeed = (this.grounded ? MAX_SPEED_GROUND : MAX_SPEED_AIR) * slow;
    const accel = (this.grounded ? ACCEL_GROUND : ACCEL_AIR) * slow;
    const fric = (this.grounded ? FRICTION_GROUND : FRICTION_AIR) + (this.inFreeze ? 6 : 0);
    const wl = Math.hypot(inp.x, inp.z);

    if (wl > 1e-3) {
      const wx = inp.x / wl, wz = inp.z / wl;
      const along = vel.x * wx + vel.z * wz;
      if (along <= maxSpeed) {
        const next = Math.min(along + accel * dt, maxSpeed);
        const delta = next - along;
        if (delta > 0) {
          vel.x += wx * delta;
          vel.z += wz * delta;
        }
      }
      if (Math.abs(wx) > 0.1) this.facing = wx > 0 ? 1 : -1;
    } else {
      const k = Math.exp(-fric * dt);
      vel.x *= k;
      vel.z *= k;
      if (Math.abs(vel.x) < 1e-4) vel.x = 0;
      if (Math.abs(vel.z) < 1e-4) vel.z = 0;
    }

    // ── 4. 钩住后的拉拽 ──
    if (this.hook.state === HOOK_GRABBED) this.applyHookDrag(dt, inp);

    // ── 5. 积分 + 碰撞 ──
    this.moveAxis('y', vel.y * dt);
    this.moveAxis('x', vel.x * dt);
    this.moveAxis('z', vel.z * dt);

    // ── 6. 管道左右空气墙（z 轴）──
    // 碰撞体只覆盖管道内部，不夹住的话横向走出管道就会直接掉下去。
    const zLo = this.level.zMin + HS;
    const zHi = this.level.zMax - HS;
    if (pos.z < zLo) { pos.z = zLo; if (vel.z < 0) vel.z = 0; }
    if (pos.z > zHi) { pos.z = zHi; if (vel.z > 0) vel.z = 0; }

    // 漏出地图底部（理论上不该发生，兜底防卡死）
    if (pos.y < this.level.floorY) { this.respawn(); return; }

    // ── 7. 地面检测 ──
    const wasGrounded = this.grounded;
    this.grounded = this.probeGround();
    if (this.grounded) {
      this.coyote = COYOTE_TIME;
      this.jumpAvail = true;
    } else if (wasGrounded && vel.y <= 0) {
      this.coyote = COYOTE_TIME;
    }

    // ── 7. 死亡 / 终点 ──
    if (this.checkHazard()) this.respawn();
    if (!this.finished && pos.distanceTo(this.level.goal) < 1.4) {
      this.finished = true;
    }
  }

  /** 取走并清空事件队列 */
  takeEvents() {
    if (!this.events.length) return null;
    const e = this.events;
    this.events = [];
    return e;
  }

  // ── 钩子飞行 / 缩回 ──
  updateHookFlight(dt) {
    const h = this.hook;
    if (h.state === HOOK_FLYING) {
      let remain = HOOK_FIRE_SPEED * dt;
      while (remain > 0) {
        const s = Math.min(remain, MAX_SUBSTEP);
        h.pos.addScaledVector(h.dir, s);
        h.travel += s;
        if (this.pointInSolid(h.pos)) {
          h.pos.addScaledVector(h.dir, -s);       // 退回表面外
          h.state = HOOK_GRABBED;
          h.anchor.copy(h.pos);
          this.events.push('hookAttach');
          return;
        }
        if (h.travel >= HOOK_LENGTH || h.pos.distanceTo(this.pos) >= HOOK_LENGTH) {
          h.state = HOOK_RETRACTING;              // 够不到，开始回收
          this.events.push('hookNoAttach');
          return;
        }
        remain -= s;
      }
    } else if (h.state === HOOK_RETRACTING) {
      const to = this._tmp.subVectors(this.pos, h.pos);
      const d = to.length();
      const stepLen = HOOK_FIRE_SPEED * 1.6 * dt;
      if (d <= stepLen + HS) {
        h.state = HOOK_IDLE;
      } else {
        h.pos.addScaledVector(to.multiplyScalar(1 / d), stepLen);
      }
    }
  }

  // DDNet HOOK_GRABBED：不是刚性绳，是每 tick 朝锚点给一个速度增量
  applyHookDrag(dt, inp) {
    const pos = this.pos, vel = this.vel;
    const a = this.hook.anchor;
    const dx = a.x - pos.x, dy = a.y - pos.y, dz = a.z - pos.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist <= HOOK_MIN_DIST) return;

    const inv = 1 / dist;
    let ax = dx * inv * HOOK_DRAG_ACCEL * dt;
    let ay = dy * inv * HOOK_DRAG_ACCEL * dt;
    let az = dz * inv * HOOK_DRAG_ACCEL * dt;

    if (ay < 0) ay *= HOOK_DOWN_SCALE;            // 往下拉只给 30%

    const same = (ax * inp.x + az * inp.z) > 0;
    const hs = same ? HOOK_SAME_DIR : HOOK_OTHER_DIR;
    ax *= hs;
    az *= hs;

    const nvx = vel.x + ax, nvy = vel.y + ay, nvz = vel.z + az;
    const newLen = Math.sqrt(nvx * nvx + nvy * nvy + nvz * nvz);
    if (newLen < HOOK_DRAG_SPEED || newLen < vel.length()) {
      vel.set(nvx, nvy, nvz);
    }
  }

  // ── AABB vs AABB ──
  overlaps(cx, cy, cz, b) {
    return cx + HS > b.min.x && cx - HS < b.max.x &&
           cy + HS > b.min.y && cy - HS < b.max.y &&
           cz + HS > b.min.z && cz - HS < b.max.z;
  }

  pointInSolid(p) {
    const cols = this.level.colliders;
    for (let i = 0; i < cols.length; i++) {
      const b = cols[i];
      if (p.x > b.min.x && p.x < b.max.x &&
          p.y > b.min.y && p.y < b.max.y &&
          p.z > b.min.z && p.z < b.max.z) return true;
    }
    return false;
  }

  moveAxis(axis, delta) {
    const steps = Math.max(1, Math.ceil(Math.abs(delta) / MAX_SUBSTEP));
    const d = delta / steps;
    for (let i = 0; i < steps; i++) this.moveAxisOnce(axis, d);
  }

  moveAxisOnce(axis, delta) {
    if (delta === 0) return;
    const pos = this.pos;
    pos[axis] += delta;
    const cols = this.level.colliders;

    for (let i = 0; i < cols.length; i++) {
      const b = cols[i];
      if (!this.overlaps(pos.x, pos.y, pos.z, b)) continue;
      // 方盒只沿移动轴推出，不产生斜向分量 —— 站在棱角上不会脚滑
      if (delta > 0) pos[axis] = b.min[axis] - HS;
      else pos[axis] = b.max[axis] + HS;
      this.vel[axis] = 0;
    }
  }

  probeGround() {
    const pos = this.pos;
    const py = pos.y - GROUND_PROBE;
    const cols = this.level.colliders;
    for (let i = 0; i < cols.length; i++) {
      if (this.overlaps(pos.x, py, pos.z, cols[i])) return true;
    }
    return false;
  }

  checkFreeze() {
    const p = this.pos;
    const list = this.level.freezeColliders;
    if (!list || !list.length) return false;
    for (let i = 0; i < list.length; i++) {
      if (this.overlaps(p.x, p.y, p.z, list[i])) return true;
    }
    return false;
  }

  checkHazard() {
    const p = this.pos;
    const list = this.level.hazardColliders;
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      if (this.overlaps(p.x, p.y, p.z, b) && p.y < b.max.y - 0.05) return true;
    }
    return false;
  }
}
