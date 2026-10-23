import * as THREE from '../vendor/three.module.js';
import { Level, LANES, laneCenter } from './map.js';
import { Player, HOOK_IDLE, HOOK_FLYING, HOOK_GRABBED, HOOK_LENGTH } from './player.js';
import { firstPersonInput, thirdPersonInput } from './input.js';
import { pollViewport, screenToStage, view, cycleRotation, setRotation } from './viewport.js';
import { AimPad } from './aimpad.js';
import { sfx } from './sfx.js';

const qs = new URLSearchParams(location.search);

// 舞台局部尺寸：竖屏旋转后舞台被转成横向，与 innerWidth/innerHeight 不同
function stageW() { return view.rotated ? view.h : view.w; }
function stageH() { return view.rotated ? view.w : view.h; }

// 触屏判定（提前声明：computeAimDir 等函数会用到）
// 注意区分两个概念：
//   isTouchDevice —— 设备物理上支持触摸
//   touchUI       —— 本次会话启用了触屏 UI（isTouchDevice 或 ?touch=1）
// 瞄准来源应该看后者：用户看到的是摇杆+轮盘，就该用轮盘瞄准。
const isTouchDevice = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;
const touchUI = isTouchDevice || qs.get('touch') === '1';

// 瞄准轮盘（提前声明：computeAimDir 会用到）
// 瞄准轮盘：瞄准与出钩合并成一个控件（右手拇指只够按一个）
//   按住 = 出钩并保持，拖动 = 实时改向，松手 = 脱钩
const aimPad = new AimPad(
  document.getElementById('aimpad'),
  document.getElementById('aim-knob'),
  34,
  {
    // 按下：进入"瞄准中"状态，给玩家 0.2 秒调整方向，之后才真正出钩。
    // 手机上拇指一碰就出钩的话，根本来不及瞄准。
    onPress: (dx, dy) => {
      padAimX = dx;
      padAimY = dy;
      padPressTime = performance.now();
      padPending = true;
      padFired = false;
    },
    // 拖动：更新瞄准方向（若已出钩则同时改钩子的飞行方向）
    onAim: (dx, dy) => {
      padAimX = dx;
      padAimY = dy;
    },
    // 松手：脱钩；若还没出钩就取消
    onRelease: () => {
      padPending = false;
      hookHeld = false;
      player.releaseHook();
    }
  }
);
let padAimX = 1, padAimY = 0;
let padPressTime = 0;
let padPending = false;   // 已按下，等待出钩
let padFired = false;    // 已经出钩了
const PAD_FIRE_DELAY = 200;   // 瞄准延时（毫秒）
// 暴露内部状态给 E2E 测试
window.__padPending = () => padPending;
window.__padFired = () => padFired;
window.__padAim = () => ({ x: padAimX, y: padAimY });
window.__viewYaw = () => viewYaw;
const aimDir2 = new THREE.Vector2();
const aimOffset = new THREE.Vector2();
// 暴露给测试用（E2E 测试需要调用真实实现，而不是复制一份公式）
window.__aimPad = aimPad;

const FIXED_DT = 1 / 60;
const CAM_DIST = 20;
const CAM_HEIGHT = 4.6;
const CAM_YAW = 0.22;          // 轻微斜视，让管道纵深可见，同时不牺牲左右判读
const CAM_LOOKAHEAD = 3.0;     // 预判前方：DDNet 速度下没有这个会来不及看
const FOV_THIRD = 55;
const FOV_FIRST = 82;
const EYE_HEIGHT = 0.08;       // 第一人称眼睛相对球心的偏移
const LOOK_SENS = 0.0022;

const canvas = document.getElementById('game');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b1016);
scene.fog = new THREE.Fog(0x0b1016, 26, 62);

const camera = new THREE.PerspectiveCamera(FOV_THIRD, 16 / 9, 0.1, 900);

// ── 视角状态 ──
let cameraMode = 'third';      // 'third' | 'first'
// 第三人称轨道视角：按住中键拖动可改角度（只影响观感，不影响 A/D 的世界方向）
let camYaw = 0;
const DEFAULT_ELEV = Math.asin(CAM_HEIGHT / CAM_DIST);   // 默认仰角，还原原来的构图
let camElev = DEFAULT_ELEV;
let orbiting = false;
let orbitLX = 0;
let orbitLY = 0;
let orbitPointerId = -1;   // 正在轨道视角的指针 id
let viewYaw = -Math.PI / 2;    // 第一人称水平朝向，-90° 即看向 +x（关卡推进方向）
let viewPitch = 0;
let hadLock = false;

// ── 灯光：一个主光 + 一个冷色补光，无阴影（省性能，靠明暗区分面） ──
scene.add(new THREE.HemisphereLight(0x9fd7ff, 0x1a2430, 0.55));
const key = new THREE.DirectionalLight(0xffffff, 1.25);
key.position.set(6, 12, 10);
scene.add(key);
const fill = new THREE.DirectionalLight(0x4f8fff, 0.45);
fill.position.set(-8, 3, -6);
scene.add(fill);

// 关卡：默认加载导出的 DDNet 地图，?map=builtin 用内置测试关
// ── 天空球：两张背景图左右拼接成一圈，包住整个场景 ──
let skyMesh = null;
async function buildSky() {
  try {
    const tex0 = await new THREE.TextureLoader().loadAsync('./vendor/desert_background.png');
    const W = 2048, H = 1024;
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const g = c.getContext('2d');
    // 上半球：天空渐变（赤道处最亮）
    const grad = g.createLinearGradient(0, 0, 0, H / 2);
    grad.addColorStop(0, '#0a1420');
    grad.addColorStop(1, '#3d5c74');
    g.fillStyle = grad;
    g.fillRect(0, 0, W, H / 2);
    // 下半球：只取背景图的地平线部分（它自带上半部黑天空，必须裁掉），左右镜像拼成一圈
    const iw = tex0.image.width, ih = tex0.image.height;
    const srcH = Math.round(ih * 0.20);
    const srcY = ih - srcH;
    const horizon = H * 0.60;   // 地平线压到赤道以下，俯视时不会满屏都是沙地
    g.drawImage(tex0.image, 0, srcY, iw, srcH, 0, horizon, W / 2, H - horizon);
    g.save();
    g.translate(W, 0);
    g.scale(-1, 1);
    g.drawImage(tex0.image, 0, srcY, iw, srcH, 0, horizon, W / 2, H - horizon);
    g.restore();
    // 背景图自带一片黑天空：把暗像素直接替换成该行的天空渐变色，黑带就消失了
    // （不能用 alpha=0 抠图，材质没开 transparent 会渲染成黑色）
    const img = g.getImageData(0, 0, W, H);
    const d = img.data;
    const lerp = (a, b, u) => a + (b - a) * u;
    for (let y = 0; y < H; y++) {
      const t = y / H;
      let cr, cg, cb;
      if (t < 0.55) {
        const u = t / 0.55;
        cr = lerp(10, 61, u); cg = lerp(20, 92, u); cb = lerp(32, 116, u);
      } else {
        const u = (t - 0.55) / 0.45;
        cr = lerp(61, 16, u); cg = lerp(92, 28, u); cb = lerp(116, 40, u);
      }
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        const lum = d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11;
        if (lum < 58) { d[i] = cr; d[i + 1] = cg; d[i + 2] = cb; d[i + 3] = 255; }
      }
    }
    g.putImageData(img, 0, 0);

    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.RepeatWrapping;
    tex.minFilter = THREE.LinearFilter;
    skyMesh = new THREE.Mesh(
      new THREE.SphereGeometry(300, 48, 24),
      new THREE.MeshBasicMaterial({
        map: tex, side: THREE.BackSide, fog: false, depthWrite: false
      })
    );
    skyMesh.renderOrder = -1;
    scene.add(skyMesh);
  } catch (err) {
    console.warn('天空球加载失败', err);
  }
}
await buildSky();

const qsMap = new URLSearchParams(location.search);
let levelJson = null;
if (qsMap.get('map') !== 'builtin') {
  try {
    levelJson = await fetch('./levels/qeasy.json').then((r) => r.json());
  } catch (err) {
    console.warn('关卡 JSON 加载失败，退回内置关卡', err);
  }
}
const level = new Level(levelJson);
const player = new Player(level);
// 暴露给测试用（E2E 测试需要调用真实实现，而不是复制一份公式）
window.__player = player;

// ── 贴图：FunClient entities 图集 ──
// 图集是 1024x1024、64x64 槽位（原点有 64px 透明边距，实测非 32px 网格）。
// 用 offset/repeat 从图集里裁出单块，BoxGeometry 每面 UV 都是 0..1，改这两个值即可。
const ATLAS_SIZE = 1024;
const TILE_PX = 64;
let atlasBase = null;
let gameBase = null;
let skinBase = null;
try {
  atlasBase = await new THREE.TextureLoader().loadAsync('./vendor/FunClient.png');
  atlasBase.magFilter = THREE.NearestFilter;
  atlasBase.minFilter = THREE.LinearMipmapLinearFilter;
  atlasBase.anisotropy = 4;
} catch (err) {
  console.warn('方块图集加载失败，退回纯色材质', err);
}
try {
  gameBase = await new THREE.TextureLoader().loadAsync('./vendor/game.png');
} catch (err) {
  console.warn('game.png 加载失败', err);
}
try {
  skinBase = await new THREE.TextureLoader().loadAsync('./vendor/tuzi.png');
} catch (err) {
  console.warn('皮肤加载失败', err);
}

function cropTexture(img, sx, sy, sw, sh, outW, outH) {
  const c = document.createElement('canvas');
  c.width = outW;
  c.height = outH;
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = false;
  g.drawImage(img, sx, sy, sw, sh, 0, 0, outW, outH);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.anisotropy = 4;
  return t;
}

// 直接用 canvas 从图集裁一块，避免 offset/repeat 在部分驱动上的兼容问题。
// inset = 0 取完整的 64x64 方块图标（含它自带的描边与高光）—— 那才是 DDNet 方块的样子。
function atlasTexture(px, py, inset = 0) {
  if (!atlasBase || !atlasBase.image) return null;
  const OUT = 64;
  const c = document.createElement('canvas');
  c.width = c.height = OUT;
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = false;
  const crop = TILE_PX * (1 - inset * 2);
  g.drawImage(
    atlasBase.image,
    px + TILE_PX * inset, py + TILE_PX * inset, crop, crop,
    0, 0, OUT, OUT
  );
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.anisotropy = 4;
  return t;
}

// ── 关卡渲染：全部 1x1x1 实例，一次 draw call ──
const tileGeo = new THREE.BoxGeometry(1, 1, 1);
const solidMat = new THREE.MeshStandardMaterial({
  map: atlasTexture(64, 0),    // 土黄方块，只取图标正中心避免重复出边框
  color: 0xffffff,
  roughness: 0.88,
  metalness: 0.05
});

function buildTiles(tiles, material, base, spread) {
  const mesh = new THREE.InstancedMesh(tileGeo, material, tiles.length);
  mesh.frustumCulled = false;
  const m = new THREE.Matrix4();
  const c = new THREE.Color();
  for (let i = 0; i < tiles.length; i++) {
    const t = tiles[i];
    m.makeTranslation(t.x, t.y, t.z);
    mesh.setMatrixAt(i, m);
    // 只做明暗扰动，颜色交给贴图
    const v = base + Math.random() * spread;
    c.setRGB(v, v, v);
    mesh.setColorAt(i, c);
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  scene.add(mesh);
  return mesh;
}

buildTiles(level.tiles, solidMat, 1.0, 0.16);
const hazardMat = new THREE.MeshStandardMaterial({
  map: atlasTexture(64, 0),
  color: 0xff6a55,
  emissive: 0x5a1018,
  emissiveIntensity: 1,
  roughness: 0.7,
  metalness: 0.0
});
buildTiles(level.hazardTiles, hazardMat, 0.95, 0.08);

// ── 车道分隔线：深度轴的视觉参照 ──

// 相机在管道正上方时，玩家在 z 轴移动只改变透视缩放，屏幕位移极小（实测 0.03）。
// 解决办法是在可站立的地面画出车道边界线 —— 玩家穿过它们时能明确感知自己换了车道。
{
  const lineMat = new THREE.MeshBasicMaterial({
    color: 0x000000, transparent: true, opacity: 0.72, fog: false,
    depthWrite: false
  });
  const geo = new THREE.PlaneGeometry(1, 1);
  const edges = [];
  for (let l = 0; l <= LANES; l++) edges.push(l - LANES / 2);   // 车道边界 z

  const rects = level.floorRects || [];
  const lines = new THREE.InstancedMesh(geo, lineMat, Math.max(1, edges.length * rects.length));
  lines.frustumCulled = false;
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
  const p = new THREE.Vector3();
  const s = new THREE.Vector3();
  let k = 0;
  for (const [x0, y0, x1, y1] of rects) {
    for (const z of edges) {
      p.set((x0 + x1) / 2, y1 + 0.012, z);       // 贴在地面顶面上
      s.set(x1 - x0, 0.11, 1);                     // 沿 x 铺满，细长条
      m.compose(p, q, s);
      lines.setMatrixAt(k++, m);
    }
  }
  lines.count = k;
  lines.instanceMatrix.needsUpdate = true;
  scene.add(lines);

  // 不做"当前车道高亮" —— 玩家看不懂这是什么，只会觉得莫名其妙。
  // 深度变化靠分隔线本身来感知就够了。
}

// 冻结水：所有矩形合并成【一个】几何体，只生成顶面和正面。
// 每个矩形各画一个盒子的话，相邻处会因接触面重叠出现分界线。
const freezeMat = new THREE.MeshBasicMaterial({
  color: 0x343a40,
  transparent: true,
  opacity: 0.5,
  depthWrite: false,
  side: THREE.DoubleSide
});

function buildWaterMesh(cells, material) {
  const set = new Set();
  for (let i = 0; i < cells.length; i += 3) set.add(cells[i] + ',' + cells[i + 1] + ',' + cells[i + 2]);
  const has = (x, y, l) => set.has(x + ',' + y + ',' + l);

  const pos = [];
  const uv = [];
  const idx = [];
  let v = 0;
  const quad = (a, b, c, d) => {
    pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2], d[0], d[1], d[2]);
    uv.push(0, 0, 1, 0, 1, 1, 0, 1);
    idx.push(v, v + 1, v + 2, v, v + 2, v + 3);
    v += 4;
  };

  for (let i = 0; i < cells.length; i += 3) {
    const x = cells[i], y = cells[i + 1], l = cells[i + 2];
    const x0 = x, x1 = x + 1, y0 = y, y1 = y + 1;
    const zA = laneCenter(l) - 0.5, zB = laneCenter(l) + 0.5;

    // 只生成【暴露在空气里】的面：水与水之间不生成，水与空气之间要生成
    if (!has(x, y + 1, l)) quad([x0, y1, zA], [x1, y1, zA], [x1, y1, zB], [x0, y1, zB]);   // 顶
    if (!has(x, y - 1, l)) quad([x0, y0, zB], [x1, y0, zB], [x1, y0, zA], [x0, y0, zA]);   // 底
    if (l === LANES - 1 || !has(x, y, l + 1)) quad([x0, y0, zB], [x1, y0, zB], [x1, y1, zB], [x0, y1, zB]); // 前
    if (l === 0 || !has(x, y, l - 1)) quad([x0, y0, zA], [x1, y0, zA], [x1, y1, zA], [x0, y1, zA]); // 后
    if (!has(x - 1, y, l)) quad([x0, y0, zA], [x0, y0, zB], [x0, y1, zB], [x0, y1, zA]);   // 左
    if (!has(x + 1, y, l)) quad([x1, y0, zA], [x1, y0, zB], [x1, y1, zB], [x1, y1, zA]);   // 右
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, material);
  mesh.frustumCulled = false;
  scene.add(mesh);
  return mesh;
}
if (level.freezeCells && level.freezeCells.length) {
  buildWaterMesh(level.freezeCells, freezeMat);
}

// ── 玩家：tuzi 皮肤（body / 眼睛 / 脚 三个独立 sprite）──
// tuzi 是新式皮肤：body 自带耳朵和尾巴，实际尺寸 76x84，比标准 64x64 大。
// 实测：body (4,4) 起 76x84；睁眼 (231,9) 起 17x12；站立脚 (73,110) 起 8x13
function cropSkin(sx, sy, sw, sh) {
  const S = 4;
  const c = document.createElement('canvas');
  c.width = sw * S;
  c.height = sh * S;
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = false;
  if (skinBase && skinBase.image) {
    g.drawImage(skinBase.image, sx, sy, sw, sh, 0, 0, sw * S, sh * S);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 4;
  return t;
}

const playerSprite = new THREE.Sprite(new THREE.SpriteMaterial({
  map: cropSkin(4, 4, 76, 84),
  transparent: true,
  depthWrite: false,
  alphaTest: 0.25
}));
// 按圆的直径标定：源图圆直径 67px，DDNet 里 tee 身体圆直径 = 物理尺寸 0.875 格
const PX = 0.875 / 67;
playerSprite.scale.set(76 * PX, 84 * PX, 1);   // 0.993 x 1.097 格
// 让 sprite 的 position 对准【圆的圆心】而不是裁剪框中心，否则整个身体会偏下
// 注意：center.y 从【下往上】算，源图 y 从【上往下】算，必须翻转
playerSprite.center.set((41.5 - 4) / 76, (84 - 54.5) / 84);
scene.add(playerSprite);

// 脚：tuzi 的 feet 站立帧，实测 (73,110) 起 8x13
function makeFeetTexture() {
  const S = 4;
  const c = document.createElement('canvas');
  c.width = 8 * S;
  c.height = 13 * S;
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = false;
  if (skinBase && skinBase.image) {
    g.drawImage(skinBase.image, 73, 110, 8, 13, 0, 0, 8 * S, 13 * S);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  return t;
}

const feetSprite = new THREE.Sprite(new THREE.SpriteMaterial({
  map: makeFeetTexture(),
  transparent: true,
  depthWrite: false,
  alphaTest: 0.2
}));
feetSprite.scale.set(8 * PX, 13 * PX, 1);       // 0.105 x 0.17 格
feetSprite.center.set(0.5, 0.5);
scene.add(feetSprite);

// 眼睛：tuzi 的睁眼图元 (231,9) 起 17x12，画两次得到一对
function makeEyesTexture() {
  const S = 4;
  const c = document.createElement('canvas');
  c.width = 40 * S;
  c.height = 12 * S;
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = false;
  if (skinBase && skinBase.image) {
    g.drawImage(skinBase.image, 231, 9, 17, 12, 2 * S, 0, 17 * S, 12 * S);
    g.drawImage(skinBase.image, 231, 9, 17, 12, 21 * S, 0, 17 * S, 12 * S);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  return t;
}

const eyesSprite = new THREE.Sprite(new THREE.SpriteMaterial({
  map: makeEyesTexture(),
  transparent: true,
  depthWrite: false,
  alphaTest: 0.2
}));
eyesSprite.scale.set(30 * PX, 10 * PX, 1);      // 一对眼睛 0.39 x 0.13 格
eyesSprite.center.set(0.5, 0.5);
scene.add(eyesSprite);

// ── 终点 ──
const goalMesh = new THREE.Mesh(
  new THREE.TorusGeometry(0.5, 0.07, 10, 32),
  new THREE.MeshStandardMaterial({ color: 0xffd166, emissive: 0xffb703, emissiveIntensity: 0.7, roughness: 0.3 })
);
goalMesh.position.copy(level.goal);
scene.add(goalMesh);

// ── 钩绳：整条都是 game.png 里的铁链，不是画的线 ──
const chainTex = gameBase && gameBase.image
  ? cropTexture(gameBase.image, 64, 0, 64, 32, 64, 32)
  : null;
if (chainTex) {
  chainTex.wrapS = THREE.RepeatWrapping;
  chainTex.wrapT = THREE.RepeatWrapping;
}
const ropeMesh = new THREE.Mesh(
  new THREE.CylinderGeometry(0.075, 0.075, 1, 6),
  new THREE.MeshBasicMaterial({
    map: chainTex,
    color: 0xffffff,
    transparent: true,
    opacity: 0.98,
    side: THREE.DoubleSide
  })
);
ropeMesh.visible = false;
scene.add(ropeMesh);

// 钩头：game.png 里的铁链+箭头，实测位于 (112,0) 起 64x32。
// 之前用的 (64,64) 是那把剑 —— 那是无限钩 buff 图标，不对。
const hookHead = new THREE.Sprite(new THREE.SpriteMaterial({
  map: gameBase && gameBase.image
    ? cropTexture(gameBase.image, 112, 0, 64, 32, 64, 32)
    : null,
  transparent: true,
  depthWrite: false,
  alphaTest: 0.05
}));
hookHead.scale.set(1.0, 0.5, 1);
hookHead.visible = false;
scene.add(hookHead);
const UP = new THREE.Vector3(0, 1, 0);
const ropeDir = new THREE.Vector3();
const ropeMid = new THREE.Vector3();
const aimA = new THREE.Vector3();
const aimB = new THREE.Vector3();
const aimVec = new THREE.Vector3();
const aimProbe = new THREE.Vector3();
const AIM_PROBE_DIST = 6;   // 准星投影用的参考距离（格）

// ── 输入 ──
const keys = new Set();
const input = { x: 0, z: 0, jump: false };
let jumpQueued = false;
let hookHeld = false;
let hookQueued = false;

addEventListener('keydown', (e) => {
  if (e.repeat) return;
  keys.add(e.code);
  if (e.code === 'Space') { jumpQueued = true; e.preventDefault(); }
  if (e.code === 'KeyR' || e.code === 'KeyK') player.respawn();
  if (e.code === 'KeyV') toggleView();
});
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('blur', () => keys.clear());

// ── 视角切换 ──
const keyMoveEl = document.getElementById('key-move');
const HINT_THIRD = '<b>A / D</b> <span>左右</span> &nbsp; <b>W / S</b> <span>横移（深浅）</span>';
const HINT_FIRST = '<b>W A S D</b> <span>相对视角移动</span> &nbsp; <b>鼠标</b> <span>转视角</span>';

function requestLock() {
  const p = canvas.requestPointerLock?.();
  if (p && p.catch) p.catch(() => {});
}

function updateFov() {
  // 用舞台局部尺寸：竖屏旋转后舞台是横的，但 innerWidth/innerHeight 还是竖的
  const aspect = stageW() / stageH();
  const first = cameraMode === 'first';
  const hFov = (first ? FOV_FIRST : FOV_THIRD) * Math.PI / 180;
  let fov = 2 * Math.atan(Math.tan(hFov / 2) / aspect) * 180 / Math.PI;
  fov = Math.max(first ? FOV_FIRST : FOV_THIRD, Math.min(92, fov));
  camera.fov = fov;
  camera.updateProjectionMatrix();
}

function setCameraMode(mode) {
  cameraMode = mode;
  const first = mode === 'first';
  updateFov();
  document.body.classList.toggle('first-person', first);
  keyMoveEl.innerHTML = first ? HINT_FIRST : HINT_THIRD;

  if (first) {
    requestLock();
    hadLock = false;
    setTimeout(() => {
      if (cameraMode === 'first' && !document.pointerLockElement) {
        document.body.classList.add('lock-failed');
      }
    }, 500);
  } else {
    document.body.classList.remove('lock-failed');
    if (document.pointerLockElement) document.exitPointerLock();
  }
}

function toggleView() {
  setCameraMode(cameraMode === 'first' ? 'third' : 'first');
}

// 只有"曾经锁定成功"再掉锁才算 Esc 退出（否则无用户手势导致的锁定失败会误判）
document.addEventListener('pointerlockchange', () => {
  if (document.pointerLockElement) {
    hadLock = true;
    document.body.classList.remove('lock-failed');
  } else if (hadLock && cameraMode === 'first') {
    hadLock = false;
    setCameraMode('third');
  }
});

// 右键要用来出钩：全链路吃掉右键，避免弹菜单 / 浏览器手势
window.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); }, true);
canvas.addEventListener('auxclick', (e) => { e.preventDefault(); }, true);
canvas.addEventListener('pointerdown', (e) => {
  if (e.button === 2) e.preventDefault();
}, { passive: false });
addEventListener('pointerdown', (e) => {
  if (e.button === 1) {                // 中键：拖动改第三人称视角
    e.preventDefault();
    if (cameraMode !== 'first') {
      if (e.detail === 2) {            // 双击中键 = 复位
        camYaw = 0;
        camElev = DEFAULT_ELEV;
        endOrbit();
        return;
      }
      orbiting = true;
      orbitLX = e.clientX;
      orbitLY = e.clientY;
      orbitPointerId = e.pointerId;
      // 必须捕获指针：否则拖出 canvas 或窗口外再松手，pointerup 收不到，
      // 视角就永远卡在 orbiting 状态（表现为"中键脱不了视角"）。
      try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
      document.body.classList.add('orbiting');
    }
    return;
  }
});

canvas.addEventListener('pointerdown', (e) => {
  if (e.button === 0 || e.button === 2) {   // 左键 / 右键 都能出钩
    e.preventDefault();
    if (cameraMode === 'first' && !document.pointerLockElement) requestLock();
    // 触屏 UI 开启时，出钩由瞄准轮盘负责（合并控件），这里不重复触发
    if (touchUI) return;
    hookHeld = true;
    hookQueued = true;
  }
});
// 结束轨道视角（所有出口都走这里，保证状态一定复位）
function endOrbit() {
  orbiting = false;
  orbitPointerId = -1;
  document.body.classList.remove('orbiting');
}

// 指针在窗口外松开时，pointerup 可能不触发 —— 兜底
addEventListener('pointerup', (e) => {
  if (e.button === 1) {
    e.preventDefault();
    endOrbit();
    return;
  }
  if (e.button === 0 || e.button === 2) {
    e.preventDefault();
    if (touchUI) return;
    hookHeld = false;
    player.releaseHook();
  }
});
// 指针被系统中断（拖出窗口、被通知栏打断等）
addEventListener('pointercancel', (e) => {
  if (e.button === 1 || orbiting) endOrbit();
  if ((e.button === 0 || e.button === 2) && !touchUI) {
    hookHeld = false;
    player.releaseHook();
  }
});
// 窗口失焦：中键/左键状态都要清掉，否则会一直卡住
addEventListener('blur', () => {
  endOrbit();
  if (!touchUI) {
    hookHeld = false;
    player.releaseHook();
  }
});

// 视口变化由 pollViewport() 每帧轮询处理（QQ 的 resize/orientationchange 不可靠）
function applyViewport() {
  const w = stageW();
  const h = stageH();
  renderer.setSize(w, h, false);   // false = 不动 CSS 尺寸，交给 stage 的样式控制
  camera.aspect = w / h;
  updateFov();
}

// 手机端第三人称固定在中间车道（不换轴）
if (touchUI && cameraMode === 'third') player.pos.z = 0;

// ── 出钩：只决定方向，钩子是飞行物（有速度、够不到也会飞出去再收回） ──
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
const hookDir = new THREE.Vector3();
const aimPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
const aimPoint = new THREE.Vector3();
const testRay = new THREE.Ray();
const testHit = new THREE.Vector3();

// 当前瞄准方向（第一人称用准星中心，第三人称用鼠标与玩家深度平面的交点）
function computeAimDir(out) {
  if (cameraMode === 'first') {
    camera.getWorldDirection(out);
    return true;
  }
  // 触屏：钩子方向由瞄准轮盘决定（手机上没有鼠标指针可用）
  if (touchUI) {
    out.set(padAimX, padAimY, 0);
    return true;
  }
  ndc.set((mouseX / stageW()) * 2 - 1, -(mouseY / stageH()) * 2 + 1);
  camera.updateMatrixWorld();
  raycaster.setFromCamera(ndc, camera);
  aimPlane.constant = -player.pos.z;
  const hit = raycaster.ray.intersectPlane(aimPlane, aimPoint);
  if (!hit) return false;
  out.subVectors(aimPoint, player.pos);
  out.z = 0;
  const len = out.length();
  if (len < 0.2) return false;
  out.multiplyScalar(1 / len);       // 必须归一化：否则长度=鼠标距离，偏移会无限放大
  return true;
}

// 这个方向上钩子够不够得到东西（供准星变色）
function canHookNow(dir) {
  if (!dir) return false;
  testRay.origin.copy(player.pos);
  testRay.direction.copy(dir).normalize();
  const cols = level.colliders;
  let best = Infinity;
  for (let i = 0; i < cols.length; i++) {
    const p = testRay.intersectBox(cols[i], testHit);
    if (!p) continue;
    const d = p.distanceTo(player.pos);
    if (d > 0.1 && d < best) best = d;
  }
  return best <= HOOK_LENGTH;
}

// 第一人称下钩子从身体右下方射出，而不是从镜头中心 —— 否则绳索正好糊在准星上
const _right = new THREE.Vector3();
const _down = new THREE.Vector3();
function hookOrigin() {
  if (cameraMode !== 'first') return player.pos;
  _right.set(1, 0, 0).applyQuaternion(camera.quaternion);
  _down.set(0, -1, 0).applyQuaternion(camera.quaternion);
  return camera.position.clone()
    .addScaledVector(_right, 0.42)
    .addScaledVector(_down, 0.34);
}

function tryHook(mx, my) {
  if (!computeAimDir(hookDir)) {
    hookDir.set(player.facing, 0, 0);
  }
  player.fireHook(hookDir, hookOrigin());
}

// 鼠标坐标存的是【舞台局部坐标】（竖屏旋转后与屏幕坐标不同）
let mouseX = 0, mouseY = 0;
let edgeX = 0, edgeY = 0;
const EDGE_TURN = 2.6;

function clampPitch() {
  const lim = Math.PI / 2 - 0.02;
  if (viewPitch > lim) viewPitch = lim;
  if (viewPitch < -lim) viewPitch = -lim;
}

mouseX = stageW() / 2;
mouseY = stageH() / 2;

addEventListener('mousemove', (e) => {
  // 屏幕坐标 → 舞台局部坐标
  const loc = screenToStage(e.clientX, e.clientY);
  if (orbiting && cameraMode !== 'first') {
    camYaw -= (loc.x - orbitLX) * 0.005;
    camElev -= (loc.y - orbitLY) * 0.004;
    camYaw = Math.max(-1.0, Math.min(1.0, camYaw));
    camElev = Math.max(0.02, Math.min(1.25, camElev));
    orbitLX = loc.x;
    orbitLY = loc.y;
    return;
  }
  if (cameraMode === 'first') {
    if (document.pointerLockElement) {
      viewYaw -= e.movementX * LOOK_SENS;
      viewPitch -= e.movementY * LOOK_SENS;
    } else {
      // 没拿到指针锁时用鼠标偏离屏幕中心的量做持续转向，
      // 保证任何情况下都能转满 360°（yaw 本身不做任何 clamp）
      edgeX = (loc.x / stageW()) * 2 - 1;
      edgeY = (loc.y / stageH()) * 2 - 1;
      if (Math.abs(edgeX) < 0.3) edgeX = 0;
      if (Math.abs(edgeY) < 0.3) edgeY = 0;
    }
    clampPitch();
  } else {
    mouseX = loc.x;
    mouseY = loc.y;
  }
});


// ── 触屏控制：左摇杆 + 右下按钮 ──
const STICK_R = 46;
const stickEl = document.getElementById('stick');
const knobEl = document.getElementById('stick-knob');
let stickId = -1;
let stickX = 0, stickY = 0;

if (touchUI) document.body.classList.add('touch');

function setStick(x, y) {
  stickX = x;
  stickY = y;
  knobEl.style.transform = `translate(${x}px, ${y}px)`;
}

stickEl.addEventListener('pointerdown', (e) => {
  stickId = e.pointerId;
  stickEl.setPointerCapture(e.pointerId);
  setStick(0, 0);
  e.preventDefault();
});
stickEl.addEventListener('pointermove', (e) => {
  if (e.pointerId !== stickId) return;
  // 屏幕坐标 → 舞台局部坐标（stage 旋转后两者不同）
  const loc = screenToStage(e.clientX, e.clientY);
  // 摇杆中心也换算到局部坐标。
  // 注意：旋转后 getBoundingClientRect() 返回的是屏幕包围盒，
  // 不能直接拿它的宽高当局部尺寸用；只用它的中心点做换算即可。
  const r = stickEl.getBoundingClientRect();
  const c = screenToStage(r.left + r.width / 2, r.top + r.height / 2);
  let dx = loc.x - c.x;
  let dy = loc.y - c.y;
  const len = Math.hypot(dx, dy);
  if (len > STICK_R) { dx = dx / len * STICK_R; dy = dy / len * STICK_R; }
  setStick(dx, dy);
});
const stickEnd = (e) => {
  if (e.pointerId !== stickId) return;
  stickId = -1;
  setStick(0, 0);
};
stickEl.addEventListener('pointerup', stickEnd);
stickEl.addEventListener('pointercancel', stickEnd);

function bindTouchBtn(id, down, up) {
  const el = document.getElementById(id);
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    down();
  });
  const end = (e) => { e.preventDefault(); if (up) up(); };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
}
// 触屏按钮：出钩已经合并进瞄准轮盘，这里只剩跳和视角切换
bindTouchBtn('btn-jump', () => { jumpQueued = true; });
bindTouchBtn('btn-view', () => setCameraMode(cameraMode === 'first' ? 'third' : 'first'));

// ── 视口轮询：不用 resize/orientationchange 事件 ──
// QQ 内置浏览器这两个事件都不可靠，所以每帧检查一次视口尺寸。
// 竖屏时整个 stage 旋转 90°，画面看起来始终是横屏的；用户转手机后自动还原。
let rotParam = qs.get('rot');
if (rotParam !== null) {
  const d = parseFloat(rotParam);
  if (!Number.isNaN(d)) setRotation(d);
}

let triedLock = false;
function tryLockLandscape() {
  if (triedLock) return;
  triedLock = true;
  try {
    const so = screen.orientation;
    if (so && typeof so.lock === 'function') {
      const p = so.lock('landscape');
      if (p && p.catch) p.catch(() => {});
    }
  } catch (e) { /* 不支持就算了 —— 我们本来就不依赖它 */ }
}
addEventListener('pointerdown', tryLockLandscape, { once: true });

// 浏览器要求用户交互后才能播声音频 → 第一次交互时解锁
addEventListener('pointerdown', () => sfx.unlock(), { once: true });
addEventListener('keydown', () => sfx.unlock(), { once: true });

// ── 瞄准轮盘 ──
// 第三人称：轮盘方向 = 钩子飞出的方向（在关卡平面内）
// 第一人称：轮盘 = 转视角（拖动改变朝向），出钩仍朝准星
function applyAimPad() {
  // 第一人称改视角用【滑动屏幕】，轮盘只负责出钩（朝准星方向），
  // 所以这里不需要任何轮盘 → 视角的映射。
}

// 轮盘方向（第三人称的钩子方向）
function aimPadDir() {
  if (!aimPad.dir(aimDir2)) return false;
  return true;
}

// 轮盘按下 → 出钩（第三人称用轮盘方向；第一人称用相机朝向）
function fireHookByPad(dx, dy) {
  if (cameraMode === 'first') {
    // 第一人称：钩子朝相机正前方（准星方向），和桌面端一致。
    // 手机上第一人称靠【滑动屏幕】转视角，轮盘只管出钩。
    camera.getWorldDirection(hookDir);
    hookDir.z = 0;
    const l = Math.hypot(hookDir.x, hookDir.y);
    if (l > 1e-3) { hookDir.x /= l; hookDir.y /= l; }
  } else {
    hookDir.set(dx, dy, 0);
  }
  hookHeld = true;
  player.fireHook(hookDir, hookOrigin());
  aimPad.fired = true;
}

// 轮盘拖动 → 钩子还在飞时实时改向（抓住之后不改，锚点已固定）
function updateHookAim() {
  if (!aimPad.active) return;
  if (player.hook.state !== HOOK_FLYING) return;
  if (cameraMode === 'first') {
    camera.getWorldDirection(hookDir);
    hookDir.z = 0;
    const l = Math.hypot(hookDir.x, hookDir.y);
    if (l < 1e-3) return;
    hookDir.x /= l; hookDir.y /= l;
  } else {
    hookDir.set(padAimX, padAimY, 0);
  }
  player.hook.dir.copy(hookDir);
}

// 旋转方向切换按钮
document.getElementById('btn-rot').addEventListener('pointerdown', (e) => {
  e.preventDefault();
  cycleRotation();
});

// 第一人称：直接在画面上拖动转视角（手机上没有指针锁）
let lookId = -1;
let lookLX = 0;
let lookLY = 0;
canvas.addEventListener('pointerdown', (e) => {
  if (cameraMode !== 'first' || e.pointerType !== 'touch') return;
  const loc = screenToStage(e.clientX, e.clientY);
  lookId = e.pointerId;
  lookLX = loc.x;
  lookLY = loc.y;
});
canvas.addEventListener('pointermove', (e) => {
  if (e.pointerId !== lookId) return;
  const loc = screenToStage(e.clientX, e.clientY);
  viewYaw -= (loc.x - lookLX) * LOOK_SENS * 1.6;
  viewPitch -= (loc.y - lookLY) * LOOK_SENS * 1.6;
  lookLX = loc.x;
  lookLY = loc.y;
  clampPitch();
});
const lookEnd = (e) => { if (e.pointerId === lookId) lookId = -1; };
canvas.addEventListener('pointerup', lookEnd);
canvas.addEventListener('pointercancel', lookEnd);

// ── HUD ──
const hudTime = document.getElementById('time');
const hudDeaths = document.getElementById('deaths');
const hudJump = document.getElementById('jump');
const crosshairEl = document.getElementById('crosshair');
const hudCamEl = document.getElementById('camangle');
const hudBanner = document.getElementById('banner');
let elapsed = 0;

// ── 固定步长主循环 ──
let last = performance.now();
let acc = 0;

function tick(dt) {
  // 第三人称：A/D 沿关卡前后（+x），W/S 沿管道深度（z）
  const kx = (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0);
  const kz = (keys.has('KeyS') ? 1 : 0) - (keys.has('KeyW') ? 1 : 0);
  // 第一人称：W/S 是「前/后」，符号与第三人称的深度轴相反，必须单独取
  const kf = (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0);
  const tx = stickX / STICK_R;      // 摇杆
  const tz = stickY / STICK_R;
  if (cameraMode === 'first') {
    // 第一人称：移动方向相对视角朝向（W=前进，S=后退）
    // 摇杆向上推 = 前进，所以用 -tz；tz 向下为正
    // 手机端第一人称【可以换轴】：摇杆左右 → 深度轴（z），
    // 因为第一人称的左右是"侧移"，在 2.5D 里正好对应管道的深度方向。
    if (touchUI) {
      // 手机端第一人称：摇杆上下 = 前后，左右 = 侧移。
      // 侧移在 2.5D 里天然会同时改变 x 和 z（因为视角可以朝任意方向），
      // 所以第一人称是可以换轴的 —— 保持完整的视角相对映射即可。
      firstPersonInput(viewYaw, kf - tz, tx, input);
    } else {
      firstPersonInput(viewYaw, kf - tz, kx + tx, input);
    }
  } else {
    // 第三人称：A/D 沿关卡前后，W/S 沿管道深度
    // 手机端：摇杆【只控制前后】，不换车道（单车道玩法，深度固定在中间）
    if (touchUI) {
      thirdPersonInput(kx + tx, 0, input);
    } else {
      thirdPersonInput(kx + tx, kz + tz, input);
    }
  }
  if (DEMO_FWD) {
    if (cameraMode === 'first') { input.x = 1; input.z = 0; }
    else { input.z = -1; }
  }
  input.jump = jumpQueued;
  jumpQueued = false;

  if (hookQueued) {
    if (hookHeld) {
      tryHook(cameraMode === 'first' ? stageW() / 2 : mouseX,
              cameraMode === 'first' ? stageH() / 2 : mouseY);
    }
    hookQueued = false;
  }
  if (!hookHeld && player.hook.state === HOOK_GRABBED) player.releaseHook();

  const before = player.deaths;
  player.step(dt, input);
  if (player.deaths !== before) player.finished = false;

  // 物理层事件 → 音效
  const evts = player.takeEvents();
  if (evts) {
    for (const e of evts) {
      if (e === 'dbljump') sfx.play('dbljump', 0.45);
      else if (e === 'hookAttach') sfx.play('hookAttach', 0.5);
      else if (e === 'hookNoAttach') sfx.play('hookNoAttach', 0.35);
    }
  }

  if (!player.finished) elapsed += dt;

  // 第一人称、且没锁指针时的边缘转向（保证 360° 可用）
  if (cameraMode === 'first' && !document.pointerLockElement && (edgeX || edgeY)) {
    viewYaw -= edgeX * EDGE_TURN * dt;
    viewPitch -= edgeY * EDGE_TURN * dt;
    clampPitch();
  }

  if (AUTO_HOOK && player.hook.state === HOOK_IDLE) {
    player.fireHook(new THREE.Vector3(0.9, 0.55, 0), hookOrigin());
  }
}

function render() {
  const firstPerson = cameraMode === 'first';
  const aimOk = computeAimDir(aimVec);

  // 2D 皮肤永远面向摄像机；第一人称下藏起来，避免糊在脸上
  playerSprite.visible = !firstPerson;
  playerSprite.position.copy(player.pos);
  // 脚：DDNet 的 tee 跑动时脚会左右交替，站着/空中则收在中间
  feetSprite.visible = !firstPerson;
  {
    const spd = Math.abs(player.vel.x) + Math.abs(player.vel.z);
    let fx = 0, fy = 0;
    if (!player.grounded) {
      fy = 0.06;                                   // 空中收脚
    } else if (spd > 1.2) {
      fx = (Math.floor(elapsed * 8) % 2) ? 0.11 : -0.11;   // 走路：两脚交替
      fy = -0.02;
    }
    feetSprite.position.set(
      player.pos.x + fx,
      player.pos.y - 0.40 + fy,
      player.pos.z + 0.06
    );
  }
  eyesSprite.visible = !firstPerson;
  if (aimOk) {
    // 眼睛朝准星方向看：整体朝瞄准方向偏移一点
    // DDNet 里眼睛随瞄准移动的幅度只有 ~2px(0.06 格)，给大了会飘出脸
    eyesSprite.position.set(
      player.pos.x + aimVec.x * 0.05 + player.facing * 0.02,
      player.pos.y + 0.06 + aimVec.y * 0.04,
      player.pos.z + 0.02
    );
  } else {
    eyesSprite.position.set(
      player.pos.x + player.facing * 0.02,
      player.pos.y + 0.06,
      player.pos.z + 0.02
    );
  }

  if (player.hook.state !== HOOK_IDLE) {
    const hp = player.hook.state === HOOK_GRABBED ? player.hook.anchor : player.hook.pos;
    ropeMesh.visible = true;
    hookHead.visible = true;
    // 每帧重算发射点：钩子甩出去后绳索要一直连着身体，不能钉在发射时的位置上
    const from = hookOrigin();
    ropeDir.subVectors(from, hp);
    const len = ropeDir.length();
    ropeMid.addVectors(from, hp).multiplyScalar(0.5);
    ropeMesh.position.copy(ropeMid);
    ropeMesh.scale.set(1, Math.max(len, 0.001), 1);
    ropeMesh.quaternion.setFromUnitVectors(UP, ropeDir.normalize());
    // 铁链按绳长平铺，每一格一个链环
    if (chainTex) chainTex.repeat.set(1, Math.max(1, Math.round(len * 2)));
    hookHead.position.copy(hp);
    // 钩头朝向跟着绳索走：把方向投影到屏幕空间，转给 sprite 的屏幕旋转
    const dir3 = ropeDir.copy(hp).sub(from);
    if (dir3.lengthSq() > 1e-6) {
      dir3.normalize();
      aimA.copy(hp).project(camera);
      aimB.copy(hp).addScaledVector(dir3, 0.5).project(camera);
      if (aimA.z < 1 && aimB.z < 1) {
        hookHead.material.rotation = Math.atan2(aimB.y - aimA.y, aimB.x - aimA.x);
      }
    }
  } else {
    ropeMesh.visible = false;
    hookHead.visible = false;
  }

  goalMesh.rotation.y += 0.012;
  goalMesh.position.y = level.goal.y + Math.sin(performance.now() * 0.003) * 0.12;

  const camTarget = player.pos;
  if (firstPerson) {
    camera.position.set(camTarget.x, camTarget.y + EYE_HEIGHT, camTarget.z);
    camera.rotation.set(viewPitch, viewYaw, 0, 'YXZ');
  } else {
    const yaw = CAM_YAW + camYaw;
    const horiz = CAM_DIST * Math.cos(camElev);
    camera.position.set(
      camTarget.x - Math.sin(yaw) * horiz,
      camTarget.y + CAM_DIST * Math.sin(camElev),
      camTarget.z + Math.cos(yaw) * horiz
    );
    // 相机防穿墙：贴到左墙/内侧就停住
    camera.position.x = Math.max(camera.position.x, 1.6);
    camera.position.y = Math.max(camera.position.y, 1.2);
    camera.lookAt(camTarget.x + CAM_LOOKAHEAD, camTarget.y + 0.2, camTarget.z);
  }

  hudTime.textContent = elapsed.toFixed(2) + 's';
  hudDeaths.textContent = player.deaths;
  hudJump.style.opacity = player.jumpAvail ? 1 : 0.25;
  hudBanner.textContent = player.finished ? '到达终点 / 按 R 重来' : '';

  // 准星：钩得到 → 绿，钩不到 → 红
  // 第一人称固定在画面中心；第三人称跟随鼠标（桌面）或轮盘指向（触屏）
  let cx = firstPerson ? stageW() / 2 : mouseX;
  let cy = firstPerson ? stageH() / 2 : mouseY;
  if (!firstPerson && touchUI && aimOk) {
    // 把瞄准方向上的一个点投影到屏幕，准星就显示在那儿。
    // 用角色的高度作参考点（而不是 pos 本身，pos 是脚底），否则水平瞄准时准星会跑到画面外。
    aimProbe.set(player.pos.x, player.pos.y + 0.4, player.pos.z);
    aimProbe.addScaledVector(aimVec, AIM_PROBE_DIST);
    aimProbe.project(camera);
    if (aimProbe.z < 1) {
      cx = (aimProbe.x * 0.5 + 0.5) * stageW();
      cy = (-aimProbe.y * 0.5 + 0.5) * stageH();
      // 限制在画面内，避免瞄准到画面外时准星消失
      cx = Math.max(4, Math.min(stageW() - 4, cx));
      cy = Math.max(4, Math.min(stageH() - 4, cy));
    }
  }
  crosshairEl.style.left = cx + 'px';
  crosshairEl.style.top = cy + 'px';
  crosshairEl.style.background = (aimOk && canHookNow(aimVec)) ? '#5eff9f' : '#ff5e5e';

  if (hudCamEl) {
    const deg = (camYaw * 180 / Math.PI).toFixed(0);
    const elev = (camElev * 180 / Math.PI).toFixed(0);
    hudCamEl.textContent = orbiting ? `视角 ${deg}° / ${elev}°` : '';
  }

  if (skyMesh) skyMesh.position.copy(camera.position);

  renderer.render(scene, camera);
}

function loop(now) {
  // 每帧轮询视口：QQ 不触发 resize/orientationchange，只能自己查
  if (pollViewport()) applyViewport();

  applyAimPad();
  updateHookAim();

  // 手机端【第三人称】固定在中间车道（不换轴）；
  // 第一人称仍然可以换轴（摇杆左右控制深度）。
  if (touchUI && cameraMode === 'third') {
    player.pos.z = 0;
    player.vel.z = 0;
  }

  // 轮盘瞄准延时：按住 0.2 秒后才真正出钩
  if (padPending && !padFired && performance.now() - padPressTime >= PAD_FIRE_DELAY) {
    padFired = true;
    window.__padFireCount = (window.__padFireCount || 0) + 1;
    fireHookByPad(padAimX, padAimY);
  }

  const frame = Math.min(0.25, (now - last) / 1000);
  last = now;
  acc += frame;
  let steps = 0;
  // 步数上限放宽到 15：原来 5 步（=12fps 以下）会丢弃物理时间，
  // 导致低帧率设备上人物变慢、跳跃看起来更高 —— 手机上正是这种情况。
  // 宁可多跑几步物理，也不能让行为随帧率变化。
  while (acc >= FIXED_DT && steps < 15) {
    tick(FIXED_DT);
    acc -= FIXED_DT;
    steps++;
  }
  // 极端卡顿（>15 步积压）时丢弃多余时间，避免"死亡螺旋"
  if (acc > FIXED_DT) acc = 0;
  render();
  requestAnimationFrame(loop);
}
// 方便截图/调试：?view=first 直接进第一人称；?demo=hook 自动出钩
const AUTO_HOOK = qs.get('demo') === 'hook';
if (qs.get('view') === 'first') setCameraMode('first');

// ?demo=fwd —— 调试用：模拟一直按 W（前进），用于验证方向映射
const DEMO_FWD = qs.get('demo') === 'fwd';

// ?z=数值 —— 调试用：把玩家放到指定深度（车道）
const zArg = parseFloat(qs.get('z'));
if (!Number.isNaN(zArg)) player.pos.z = zArg;

// ?cam=偏航角,仰角  —— 预设第三人称视角（角度制）
const camArg = qs.get('cam');
if (camArg) {
  const [a, b] = camArg.split(',').map(Number);
  if (!Number.isNaN(a)) camYaw = a * Math.PI / 180;
  if (!Number.isNaN(b)) camElev = b * Math.PI / 180;
}

// 启动前先应用一次视口：canvas 的初始尺寸必须正确，否则第一帧是错的
pollViewport();
applyViewport();

requestAnimationFrame((t) => { last = t; loop(t); });
