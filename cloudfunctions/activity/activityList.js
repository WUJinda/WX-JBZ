/**
 * activity.list 业务纯函数（对齐技术架构 §5.4 / §4.1，PRD F8 后台活动管理）。
 *
 * 职责：给管理员返回活动列表（含状态推算），供后台「活动配置」列表页渲染。
 *   - 复用 activityStatus.deriveStatus 推算每条活动的 status（pending/active/ended）；
 *   - terminated=true 的活动 deriveStatus 已返回 ended，靠返回的 terminated 字段区分「已终止」；
 *   - 排序：进行中(active) → 未开始(pending) → 已结束(ended)，同档按 start_time 降序（新活动靠前）。
 *
 * 红线：
 *   - 管理员鉴权由调用方（云轨 handler）经 assertAdmin 承担，本纯函数不做鉴权；
 *   - 投影只下发活动配置字段（activity_id/name/start_time/end_time/signup_deadline/status/terminated），
 *     活动文档本不含 _openid/phone/sync_count 等敏感字段，但仍显式投影避免泄露新增字段；
 *   - 本模块不调云 API、不 require wx-server-sdk（云轨仅在 index.js handler 层）。
 *
 * 本地轨：store 注入式 { Activity: object[] }，纯函数可单测。
 */

const { CODE, BizError } = require('../common/errors');
const { deriveStatus, STATUS, _toTs } = require('./activityStatus');

/** 状态档位权重：数字越小越靠前。 */
var RANK_WEIGHT = {};
RANK_WEIGHT[STATUS.ACTIVE] = 0;
RANK_WEIGHT[STATUS.PENDING] = 1;
RANK_WEIGHT[STATUS.ENDED] = 2;

/**
 * 投影：从 Activity 文档摘出列表页需要的字段（不下发 _id/created_at/updated_at 等服务端字段）。
 * @param {object} a Activity 文档
 * @param {string} status 推算出的状态
 * @returns {object}
 */
function projectListActivity(a, status) {
  return {
    activity_id: a.activity_id || a._id || '',
    name: a.name || '',
    start_time: a.start_time,
    end_time: a.end_time,
    signup_deadline: a.signup_deadline || null,
    status: status,
    terminated: a.terminated === true
  };
}

/**
 * list 主逻辑（纯函数 + 注入式 store）。
 * @param {object} store mock db（{ Activity: object[] }）
 * @param {object} [params]
 * @param {Date|number} [params.now] 当前时间（注入便于单测；缺省 deriveStatus 内部取 new Date()）
 * @returns {{ list: object[] }} 排序后的活动投影列表
 * @throws {BizError} store.Activity 缺失 → SYS_DB_ERROR
 */
function listActivities(store, params) {
  if (!store || !Array.isArray(store.Activity)) {
    throw BizError(CODE.SYS_DB_ERROR, 'listActivities: store.Activity is required');
  }
  var p = params || {};
  var now = p.now === undefined ? undefined : p.now;

  var items = store.Activity
    .filter(function (a) { return a && typeof a === 'object'; })
    .map(function (a) {
      var status = deriveStatus(a, now);
      return { item: projectListActivity(a, status), status: status, startTs: _toTs(a.start_time) };
    });

  items.sort(function (x, y) {
    var wx = RANK_WEIGHT[x.status] != null ? RANK_WEIGHT[x.status] : 99;
    var wy = RANK_WEIGHT[y.status] != null ? RANK_WEIGHT[y.status] : 99;
    if (wx !== wy) return wx - wy;
    // 同档：start_time 降序（更晚开始的靠前）；非法时间（NaN）排末尾
    var sx = Number.isFinite(x.startTs) ? x.startTs : -Infinity;
    var sy = Number.isFinite(y.startTs) ? y.startTs : -Infinity;
    return sy - sx;
  });

  return { list: items.map(function (x) { return x.item; }) };
}

module.exports = {
  listActivities,
  projectListActivity,
  RANK_WEIGHT
};
