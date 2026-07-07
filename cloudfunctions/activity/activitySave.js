/**
 * activity.save 业务纯函数（对齐技术架构 §5.4 / §4.1，开发计划阶段 I，PRD F8 R8.1）。
 *
 * 职责：管理员创建 / 编辑活动。复用 activityStatus.deriveStatus 推算 status，
 * 输出风格对齐 projectActivity。R8.1「发布前用户端看不到活动」由 deriveStatus 天然满足：
 *   - now<start_time → pending（F7 显示未开始）
 *   - start≤now≤end → active（可见）
 *   - now>end → ended
 * 不新增 published 字段；前端传入的 publish 后端忽略（可见性纯由 start_time+now 推算）。
 *
 * 红线：
 *   - 管理员鉴权由调用方（云轨 handler）经 assertAdmin 承担，本纯函数不做鉴权；
 *   - 身份仅 OPENID（与全链一致）；
 *   - 本模块不调云 API、不 require wx-server-sdk（云轨仅在 index.js handler 层）。
 *
 * 本地轨：store 注入式 { Activity: object[] }，纯函数可单测。
 */

const { CODE, BizError } = require('../common/errors');
const { deriveStatus, _toTs } = require('./activityStatus');

/**
 * 投影：返回 projectActivity 风格的活动文档（不含 _id / total_steps 等服务端字段）。
 * 与 activityStatus.projectActivity 对齐，但 save 不返回 overview（概览属 current）。
 * @param {object} a Activity 文档
 * @returns {object}
 */
function projectSavedActivity(a) {
  return {
    activity_id: a.activity_id || '',
    name: a.name || '',
    start_time: a.start_time,
    end_time: a.end_time,
    signup_deadline: a.signup_deadline || null,
    status: a.status,
    rules: a.rules || ''
  };
}

/**
 * 生成 activity_id（P0 单期，预留多期）。
 * 形如 a_<时间戳>，调用方可覆盖。
 * @param {string} [ts]
 * @returns {string}
 */
function genActivityId(ts) {
  const stamp = ts != null ? String(ts) : String(Date.now());
  return 'a_' + stamp;
}

/**
 * save 主逻辑（纯函数 + 注入式 store）。
 * @param {object} store mock db（{ Activity: object[] }）
 * @param {object} params
 * @param {object} params.activity {activity_id?, name, start_time, end_time, signup_deadline?, rules}
 * @param {Date|number} [params.now] 当前时间（默认 new Date()）
 * @returns {object} projectSavedActivity 结果（含推算 status）
 * @throws {BizError}
 *   - name 空 / start_time、end_time 缺失或非法 / start>=end → BIZ_PARAM_MISSING
 *   - store.Activity 缺失 → SYS_DB_ERROR
 */
function saveActivity(store, params) {
  const p = params || {};
  const input = p.activity || {};

  // store 校验
  if (!store || !Array.isArray(store.Activity)) {
    throw BizError(CODE.SYS_DB_ERROR, 'saveActivity: store.Activity is required');
  }

  // name 必填（参数类错误 → BIZ_PARAM_MISSING，区别于下方 store 缺失的 SYS_DB_ERROR）
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name) {
    throw BizError(CODE.BIZ_PARAM_MISSING, 'saveActivity: name required');
  }

  // 起止时间必填 + 合法 + 不可倒序（用 activityStatus._toTs 比较，与 deriveStatus 同源）
  // 参数类错误 → BIZ_PARAM_MISSING（前端据此提示「参数缺失」而非「系统错误」）
  const startTs = _toTs(input.start_time);
  const endTs = _toTs(input.end_time);
  if (!Number.isFinite(startTs) || !Number.isFinite(endTs)) {
    throw BizError(CODE.BIZ_PARAM_MISSING, 'saveActivity: start_time/end_time invalid');
  }
  if (!(startTs < endTs)) {
    throw BizError(CODE.BIZ_PARAM_MISSING, 'saveActivity: start_time must be earlier than end_time');
  }

  // 报名截止（可选）：提供时须合法且 ≤ end_time（不填=活动结束前都可报名，user.join 据此拦截）
  const hasSignup = input.signup_deadline !== undefined && input.signup_deadline !== null && input.signup_deadline !== '';
  if (hasSignup) {
    const signupTs = _toTs(input.signup_deadline);
    if (!Number.isFinite(signupTs)) {
      throw BizError(CODE.BIZ_PARAM_MISSING, 'saveActivity: signup_deadline invalid');
    }
    if (!(signupTs <= endTs)) {
      throw BizError(CODE.BIZ_PARAM_MISSING, 'saveActivity: signup_deadline must be <= end_time');
    }
  }

  // 复用 deriveStatus 推算 status（now 缺省则 deriveStatus 内部取 new Date()）。
  const status = deriveStatus(
    { start_time: input.start_time, end_time: input.end_time },
    p.now === undefined ? undefined : p.now
  );

  const nowIso = p.now != null
    ? (p.now instanceof Date ? p.now.toISOString() : new Date(p.now).toISOString())
    : new Date().toISOString();

  // upsert：activity_id 存在 → 更新；不存在 → 新建。
  const activityId = input.activity_id
    ? String(input.activity_id).trim()
    : '';
  const existing = activityId
    ? store.Activity.find((a) => a && a.activity_id === activityId)
    : null;

  if (existing) {
    existing.name = name;
    existing.start_time = input.start_time;
    existing.end_time = input.end_time;
    existing.signup_deadline = hasSignup ? input.signup_deadline : null;
    existing.rules = typeof input.rules === 'string' ? input.rules : '';
    existing.status = status;
    existing.updated_at = nowIso;
    // terminated/terminated_at 由 terminate action 维护，save 不触碰（保留现有终止态）。
    return projectSavedActivity(existing);
  }

  const newId = activityId || genActivityId();
  const doc = {
    activity_id: newId,
    name,
    start_time: input.start_time,
    end_time: input.end_time,
    signup_deadline: hasSignup ? input.signup_deadline : null,
    status,
    terminated: false,
    rules: typeof input.rules === 'string' ? input.rules : '',
    created_at: nowIso,
    updated_at: nowIso
  };
  store.Activity.push(doc);
  return projectSavedActivity(doc);
}

module.exports = {
  saveActivity,
  projectSavedActivity,
  genActivityId
};
