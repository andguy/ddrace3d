import * as THREE from '../vendor/three.module.js';

// ─────────────────────────────────────────────────────────────
// 坐标约定
//   x 向右，y 向上，z 朝向镜头（深度 = 车道）
//   1 tile = 1 世界单位 = DDNet 的 32px，LANES 条车道并排，总宽 = LANES
//   车道 li 的世界 z 范围 = [li - LANES/2, li - LANES/2 + 1]
//
// 改关卡只改 build() 里的 region() 调用：
//   region(kind, x0, y0, lane0, x1, y1, lane1)
//   kind: 'solid' 实体 | 'hazard' 死亡区
// 全部按 tile 整数给出，和 DDNet 的 tile 图层一一对应。
//
// 关卡尺寸按 DDNet 物理标定（跳高 5.44、平地跳距 16.5、钩程 12）：
//   坑宽 > 16.5 必须冲刺，台阶级差 ≤ 4，超过 5.44 必须挂钩。
// ─────────────────────────────────────────────────────────────

export const LANES = 5;
export const Z_HALF = LANES / 2;
export const MAP_W = 120;
export const MAP_H = 28;

export function laneCenter(lane) {
  return lane - (LANES - 1) / 2;
}

export function laneEdge(lane) {
  return lane - Z_HALF;
}

export class Level {
  constructor(json) {
    this.colliders = [];        // 合并后的大盒子，只用于碰撞（少而快）
    this.hazardColliders = [];
    this.tiles = [];            // 1x1x1 小块，只用于渲染
    this.hazardTiles = [];
    this.freezeColliders = [];  // 冻结区（水），只做减速不挡路
    this.freezeRects = [];      // 原始矩形
    this.floorRects = [];       // 地面矩形（顶面暴露的实体），用于画车道分隔线
    this.freezeCells = [];      // 格子级 [x,y,lane,...]，用来判断哪些面暴露在空气中
    this.freezeTiles = [];
    this.spawn = new THREE.Vector3(5, 1.45, 0);
    this.goal = new THREE.Vector3(112, 12.0, 0);
    this.width = MAP_W;
    this.height = MAP_H;
    this.name = 'builtin';
    // 管道左右边界（z 轴）。玩家物理会把自己夹在这个范围内，等于两道空气墙。
    this.zMin = laneEdge(0);
    this.zMax = laneEdge(LANES);
    this.floorY = -6;          // 掉到这以下直接重生，防止漏出地图卡死
    if (json && json.rects) this.loadMapJson(json);
    else this.build();
  }

  // 从 tools/export_map.py 导出的 DDNet 地图加载
  loadMapJson(data) {
    this.name = data.name || 'ddnet';
    this.width = data.width;
    this.height = data.height;
    const z0 = laneEdge(0);
    const z1 = laneEdge(LANES);

    // 碰撞体：完整的实体矩形（物理必须用完整的）
    for (let i = 0; i < data.rects.length; i++) {
      const [x0, y0, x1, y1] = data.rects[i];
      this.colliders.push(new THREE.Box3(
        new THREE.Vector3(x0, y0, z0),
        new THREE.Vector3(x1, y1, z1)
      ));
    }

    // 渲染方块：只画暴露在外的（data.visible）。完全被包住的方块永远看不见，
    // 画它们纯属浪费 —— 手机上这是最大的性能杀手（15 万实例 → 2.6 万）。
    // 没有 visible 数据时退回画全部（兼容旧 JSON）。
    const renderRects = data.visible || data.rects;
    for (let i = 0; i < renderRects.length; i++) {
      const [x0, y0, x1, y1] = renderRects[i];
      for (let x = x0; x < x1; x++) {
        for (let y = y0; y < y1; y++) {
          for (let l = 0; l < LANES; l++) {
            this.tiles.push({ x: x + 0.5, y: y + 0.5, z: laneCenter(l) });
          }
        }
      }
    }

    // 找出真正的"地面"：能站人的水平面
    // 判据：这一行的左右两侧都是空的（是平台而不是墙），且正上方也空。
    // 只查正上方会把墙顶也算进来（墙顶上方是空的），所以必须同时查左右。
    const solidCols = new Set();
    for (const [x0, y0, x1, y1] of data.rects) {
      for (let x = x0; x < x1; x++) {
        for (let y = y0; y < y1; y++) solidCols.add(x + ',' + y);
      }
    }
    const solidAt = (x, y) => x >= 0 && y >= 0 && solidCols.has(x + ',' + y);
    for (const [x0, y0, x1, y1] of data.rects) {
      const topY = y1 - 1;
      // 逐列判断：正上方空 → 可能是地面；左右都空 → 一定是开阔的平台面
      let allPlatform = true;
      for (let x = x0; x < x1; x++) {
        if (solidAt(x, topY + 1)) { allPlatform = false; break; }
        // 左右有实体说明这是竖直墙面（贴边），不算地面
        if (solidAt(x - 1, topY) || solidAt(x + 1, topY)) { allPlatform = false; break; }
      }
      if (allPlatform) this.floorRects.push([x0, y0, x1, y1]);
    }

    if (data.spawn) this.spawn.set(data.spawn[0], data.spawn[1] + 0.45, data.spawn[2]);
    if (data.goal) this.goal.set(data.goal[0], data.goal[1] + 1.0, data.goal[2]);

    if (data.freeze) {
      for (let i = 0; i < data.freeze.length; i++) {
        const [x0, y0, x1, y1] = data.freeze[i];
        this.freezeRects.push([x0, y0, x1, y1]);
        for (let x = x0; x < x1; x++) {
          for (let y = y0; y < y1; y++) {
            for (let l = 0; l < LANES; l++) this.freezeCells.push(x, y, l);
          }
        }
        this.freezeColliders.push(new THREE.Box3(
          new THREE.Vector3(x0, y0, z0),
          new THREE.Vector3(x1, y1, z1)
        ));
      }
    }

    // 地图左右两端补两道空气墙，否则跑出边界就会一直往下掉
    const wallT = 8;
    const yLow = -20;
    const yHigh = this.height + 20;
    this.colliders.push(new THREE.Box3(
      new THREE.Vector3(-wallT, yLow, z0),
      new THREE.Vector3(0, yHigh, z1)
    ));
    this.colliders.push(new THREE.Box3(
      new THREE.Vector3(this.width, yLow, z0),
      new THREE.Vector3(this.width + wallT, yHigh, z1)
    ));
  }

  region(kind, x0, y0, l0, x1, y1, l1) {
    const z0 = laneEdge(l0);
    const z1 = laneEdge(l1);
    const box = new THREE.Box3(
      new THREE.Vector3(x0, y0, z0),
      new THREE.Vector3(x1, y1, z1)
    );
    const isSolid = kind === 'solid';
    (isSolid ? this.colliders : this.hazardColliders).push(box);

    const bucket = isSolid ? this.tiles : this.hazardTiles;
    for (let x = x0; x < x1; x++) {
      for (let y = y0; y < y1; y++) {
        for (let l = l0; l < l1; l++) {
          bucket.push({ x: x + 0.5, y: y + 0.5, z: laneCenter(l) });
        }
      }
    }
  }

  build() {
    const L = LANES;

    // ── 地面（y 0..1），20~34 是 14 格坑 ──
    // 平地跳距实测 16.5 tile（15.625 tile/s × 1.056s 滞空），14 格留了余量
    this.region('solid', 1, 0, 0, 20, 1, L);
    this.region('hazard', 20, 0, 0, 34, 1, L);
    this.region('solid', 34, 0, 0, 119, 1, L);
    // 坑底不参与碰撞，否则掉下去会无限下落；只在坑下方生成
    this.region('solid', 20, -2, 0, 34, 0, L);

    // ── 外壳 ──
    this.region('solid', 0, 0, 0, 1, MAP_H, L);
    this.region('solid', 119, 0, 0, 120, MAP_H, L);
    this.region('solid', 0, MAP_H - 1, 0, 120, MAP_H, L);

    // ── 段 2：11 格高墙。二段跳极限约 9.2 格，仍然上不去，必须挂钩 ──
    this.region('solid', 45, 1, 0, 49, 12, L);

    // ── 段 3：三级台阶，每级 4 格高（在跳跃极限内） ──
    this.region('solid', 70, 1, 0, 74, 5, L);
    this.region('solid', 78, 1, 0, 82, 9, L);
    this.region('solid', 86, 1, 0, 90, 13, L);

    // ── 段 4：窄门直通天花板，只能从中间 3 条车道穿过 ──
    this.region('solid', 94, 1, 0, 95, MAP_H - 1, 1);
    this.region('solid', 94, 1, 4, 95, MAP_H - 1, 5);

    // ── 段 5：三级台阶到终点 ──
    this.region('solid', 96, 1, 0, 99, 3, L);
    this.region('solid', 100, 1, 0, 104, 7, L);
    this.region('solid', 105, 1, 0, 119, 11, L);
  }
}
