// 第三人称深度轴的视觉反馈评估：玩家在 z 轴移动时，屏幕上能看出多少位移？
import * as THREE from '../vendor/three.module.js';

const CAM_DIST = 20, CAM_HEIGHT = 4.6, CAM_YAW = 0.22, CAM_LOOKAHEAD = 3.0;
const FOV = 55;
const ASPECT = 16 / 9;

const camera = new THREE.PerspectiveCamera(FOV, ASPECT, 0.1, 900);

// z 策略：camera-z 如何由 player-z 决定
const strategies = {
  'A  完全跟随 (现在的做法)': (pz) => pz,
  'B  跟随 50%（半滞后）': (pz) => pz * 0.5,
  'C  跟随 30%': (pz) => pz * 0.3,
  'D  完全固定（相机 z 恒定）': () => 0,
};

function project(playerPos, camZ) {
  const yaw = CAM_YAW;
  const elev = Math.asin(CAM_HEIGHT / CAM_DIST);
  const horiz = CAM_DIST * Math.cos(elev);
  camera.position.set(
    playerPos.x - Math.sin(yaw) * horiz,
    playerPos.y + CAM_DIST * Math.sin(elev),
    camZ + Math.cos(yaw) * horiz
  );
  camera.lookAt(playerPos.x + CAM_LOOKAHEAD, playerPos.y + 0.2, playerPos.z);
  camera.updateMatrixWorld();
  return playerPos.clone().project(camera);
}

console.log('=== 玩家在深度轴(z)移动时，屏幕上的位移 ===');
console.log('（玩家 x=50, y=2；管道 5 条车道，z 范围约 ±2.5）\n');

for (const [name, zFn] of Object.entries(strategies)) {
  const zs = [-2, -1, 0, 1, 2];
  const pts = zs.map(z => {
    const p = new THREE.Vector3(50, 2, z);
    return project(p, zFn(z));
  });
  // 相邻车道（1 格）的屏幕位移
  let step = 0;
  for (let i = 1; i < pts.length; i++) {
    step = Math.max(step, Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  }
  const total = Math.hypot(pts[pts.length - 1].x - pts[0].x, pts[pts.length - 1].y - pts[0].y);
  console.log(`${name}`);
  console.log(`  单格位移(屏幕单位): ${step.toFixed(4)}   4 格总位移: ${total.toFixed(4)}`);
  console.log(`  各车道屏幕位置: ${pts.map((p, i) => `z=${zs[i]}→(${p.x.toFixed(3)},${p.y.toFixed(3)})`).join('  ')}`);
  console.log(`  评估: ${step < 0.005 ? '❌ 完全看不出' : step < 0.02 ? '⚠️ 很微弱' : step < 0.06 ? '✓ 能感知' : '✓✓ 很明显'}`);
  console.log('');
}
