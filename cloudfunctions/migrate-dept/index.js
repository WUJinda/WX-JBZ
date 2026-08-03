/**
 * 临时迁移脚本（一次性）：把「单位领导」部门的成员全部归入「综合办公室」。
 *
 * 安全说明：
 *   - 只更新 User.dept_id，不触碰 StepRecord / RankCache / Department
 *   - StepRecord 按 user_id(openid) 关联，与 dept_id 无关，步数数据不受影响
 *   - RankCache 会在下次 rankAggregate 定时任务时自动刷新
 *
 * 使用方法：
 *   1. 微信开发者工具 → cloudfunctions/migrate-dept → 右键「上传并部署」
 *   2. 云开发控制台 → 云函数 → migrate-dept → 点击「测试」/ 或在开发者工具控制台执行：
 *      wx.cloud.callFunction({ name: 'migrate-dept' }).then(console.log)
 *   3. 确认返回结果正确后，删除该云函数
 */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

exports.main = async () => {
  const db = cloud.database();

  // 1. 查两个部门的 dept_id
  const fromName = '单位领导';
  const toName = '综合办公室';

  const fromRes = await db.collection('Department').where({ name: fromName }).get();
  const toRes = await db.collection('Department').where({ name: toName }).get();

  const fromDepts = (fromRes && fromRes.data) || [];
  const toDepts = (toRes && toRes.data) || [];

  if (!fromDepts.length) {
    return { ok: false, msg: `未找到部门「${fromName}」` };
  }
  if (!toDepts.length) {
    return { ok: false, msg: `未找到部门「${toName}」` };
  }

  const fromDeptId = fromDepts[0].dept_id;
  const toDeptId = toDepts[0].dept_id;
  console.log(`源部门: ${fromName} (${fromDeptId}) → 目标部门: ${toName} (${toDeptId})`);

  // 2. 查所有属于「单位领导」的用户
  const usersRes = await db.collection('User').where({ dept_id: fromDeptId }).get();
  const users = (usersRes && usersRes.data) || [];

  if (!users.length) {
    return { ok: true, msg: `「${fromName}」下无成员，无需迁移`, fromDeptId, toDeptId };
  }

  console.log(`找到 ${users.length} 名待迁移用户`);

  // 3. 逐条更新 dept_id（每条用 _id 精确更新，不影响其他字段）
  let updated = 0;
  const failed = [];
  for (const u of users) {
    try {
      await db.collection('User').doc(u._id).update({
        data: { dept_id: toDeptId, updated_at: new Date().toISOString() }
      });
      updated++;
    } catch (err) {
      console.error(`[失败] User ${u._id}:`, err.message);
      failed.push(u._id);
    }
  }

  return {
    ok: failed.length === 0,
    msg: `迁移完成：${updated}/${users.length} 名用户从「${fromName}」→「${toName}」`,
    detail: {
      fromDept: { name: fromName, dept_id: fromDeptId },
      toDept: { name: toName, dept_id: toDeptId },
      totalUsers: users.length,
      updated,
      failed: failed.length ? failed : undefined
    }
  };
};
