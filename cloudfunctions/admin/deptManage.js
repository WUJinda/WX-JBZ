/**
 * admin 部门管理纯函数（对齐技术架构 §122，PRD F8 部门管理）。
 *   - createDept(store, {activityId, name, now})
 *   - updateDept(store, {deptId, name, now})
 *   - deleteDept(store, {deptId})
 *
 * 职责：
 *   - createDept：生成 dept_id；校验同 activity_id 下 name 唯一（idx_dept_activity_name，重复兜底 SYS_DB_ERROR）；写入 Department。
 *   - updateDept：校验存在；名称唯一（排除自身）；更新 name。
 *   - deleteDept：校验存在；从 Department 删除。
 *
 * 本地轨：store 注入式，纯函数可单测；不调真实云 API。
 * 解耦：本模块不 require wx-server-sdk。
 */

const { CODE, BizError } = require('../common/errors');

function ensureDepartmentArray(store) {
  if (!store || !Array.isArray(store.Department)) {
    throw BizError(CODE.SYS_DB_ERROR, 'deptManage: store.Department is required');
  }
}

/**
 * 生成部门 id（d_<时间戳>_<随机>，保证业务键唯一）。
 * @returns {string}
 */
function genDeptId() {
  return 'd_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

/**
 * 规整部门规模人数（Department.size）：整数≥0，缺省/非数字/负数 → 0。
 * size 是管理员配置的可选字段（纯配置，非 number 也兜底为 0，宽松不抛错）。
 * @param {*} v
 * @returns {number}
 */
function normalizeSize(v) {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

/**
 * 创建部门。
 * @param {object} store mock db（{ Department: object[] }）
 * @param {object} params
 * @param {string} params.activityId 活动 id
 * @param {string} params.name 部门名
 * @param {string} params.now 当前时间 ISO
 * @returns {{deptId: string, name: string}}
 */
function createDept(store, params) {
  const p = params || {};
  ensureDepartmentArray(store);
  const { activityId, name, now } = p;
  const size = normalizeSize(p.size);

  if (!activityId) {
    throw BizError(CODE.SYS_DB_ERROR, 'createDept: activityId required');
  }
  if (!name || typeof name !== 'string') {
    throw BizError(CODE.SYS_DB_ERROR, 'createDept: name required');
  }

  // 同 activity_id 下 name 唯一（idx_dept_activity_name），重复兜底 SYS_DB_ERROR。
  const dup = store.Department.find(
    (d) => d && d.activity_id === activityId && d.name === name
  );
  if (dup) {
    throw BizError(CODE.SYS_DB_ERROR, 'createDept: dept name duplicated in activity');
  }

  const deptId = genDeptId();
  store.Department.push({
    dept_id: deptId,
    name,
    activity_id: activityId,
    member_count: 0,
    size,
    created_at: now
  });

  return { deptId, name, size };
}

/**
 * 更新部门名称。
 * @param {object} store mock db（{ Department: object[] }）
 * @param {object} params
 * @param {string} params.deptId 部门 id
 * @param {string} params.name 新名称
 * @param {string} params.now 当前时间 ISO
 * @returns {{deptId: string, name: string, updatedAt: string}}
 */
function updateDept(store, params) {
  const p = params || {};
  ensureDepartmentArray(store);
  const { deptId, name, now } = p;

  if (!deptId) {
    throw BizError(CODE.BIZ_DEPT_NOT_FOUND, 'updateDept: deptId required');
  }
  if (!name || typeof name !== 'string') {
    throw BizError(CODE.SYS_DB_ERROR, 'updateDept: name required');
  }

  const dept = store.Department.find((d) => d && d.dept_id === deptId);
  if (!dept) {
    throw BizError(CODE.BIZ_DEPT_NOT_FOUND, 'updateDept: dept not found');
  }

  // 名称唯一（排除自身）。
  const dup = store.Department.find(
    (d) => d && d !== dept && d.activity_id === dept.activity_id && d.name === name
  );
  if (dup) {
    throw BizError(CODE.SYS_DB_ERROR, 'updateDept: dept name duplicated in activity');
  }

  dept.name = name;
  // size 可选更新：显式提供（非 undefined/null/''）时规整为整数≥0 写入；否则保留原值并规整返回。
  const sizeProvided = p.size !== undefined && p.size !== null && p.size !== '';
  const size = sizeProvided ? normalizeSize(p.size) : normalizeSize(dept.size);
  if (sizeProvided) dept.size = size;
  const updatedAt = now;
  // Department schema 无 updated_at 字段（仅 created_at），但仍返回裁定时间便于追溯。
  return { deptId, name, size, updatedAt };
}

/**
 * 删除部门。
 * @param {object} store mock db（{ Department: object[] }）
 * @param {object} params
 * @param {string} params.deptId 部门 id
 * @returns {{deptId: string, deleted: boolean}}
 */
function deleteDept(store, params) {
  const p = params || {};
  ensureDepartmentArray(store);
  const { deptId } = p;

  if (!deptId) {
    throw BizError(CODE.BIZ_DEPT_NOT_FOUND, 'deleteDept: deptId required');
  }

  const idx = store.Department.findIndex((d) => d && d.dept_id === deptId);
  if (idx < 0) {
    throw BizError(CODE.BIZ_DEPT_NOT_FOUND, 'deleteDept: dept not found');
  }

  // 孤儿数据防护：若有 User 仍归属该部门，拒绝删除（强制管理员先转移/清除成员）。
  // 避免 User.dept_id 悬空导致 userList 筛选 / 部门榜分布 / 部门下拉失真。
  // store.User 可缺省（旧测试或非 deptManage handler 调用），缺省视为无成员不阻断。
  const users = Array.isArray(store && store.User) ? store.User : [];
  const memberCount = users.filter((u) => u && u.dept_id === deptId).length;
  if (memberCount > 0) {
    throw BizError(
      CODE.SYS_DB_ERROR,
      'deleteDept: 部门下仍有 ' + memberCount + ' 名成员，请先转移成员再删除'
    );
  }

  store.Department.splice(idx, 1);
  return { deptId, deleted: true };
}

module.exports = { createDept, updateDept, deleteDept, genDeptId };
