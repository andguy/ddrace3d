// 输入映射：把按键/摇杆映射成世界方向
// 单独抽出来是为了让测试能直接验证真实逻辑，而不是复制一份。

/**
 * 第一人称：移动方向相对相机朝向
 * 相机 rotation.set(viewPitch, viewYaw, 0, 'YXZ')
 *   前向 = (-sin(yaw), 0, -cos(yaw))
 *   右向 = ( cos(yaw), 0, -sin(yaw))
 * @param {number} viewYaw  相机水平偏航（弧度）
 * @param {number} kForward 前进量：W=+1，S=-1（摇杆向上推为正）
 * @param {number} kStrafe  横移量：D=+1，A=-1
 */
export function firstPersonInput(viewYaw, kForward, kStrafe, out) {
  const fx = -Math.sin(viewYaw), fz = -Math.cos(viewYaw);
  const rx = Math.cos(viewYaw), rz = -Math.sin(viewYaw);
  out.x = fx * kForward + rx * kStrafe;
  out.z = fz * kForward + rz * kStrafe;
  return out;
}

/**
 * 第三人称：固定世界轴
 *   A/D → 关卡前后（+x）
 *   W/S → 管道深度（z，W 往管道深处）
 */
export function thirdPersonInput(kX, kZ, out) {
  out.x = kX;
  out.z = kZ;
  return out;
}
