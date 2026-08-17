/**
 * admin.queryAbnormal 纯函数（对齐技术架构 §122，PRD F8 步数与防作弊）。
 *
 * 职责：store.StepRecord 中 abnormal===true，按 activity_id 过滤，本地分页（按 synced_at 降序）。
 *   - projectAbnormal 下发白名单字段：user_id/date/steps/synced_at/abnormal/locked。
 *   - 绝不下发 _openid / sync_count（红线，逐字段白名单）。
 *   - DEFAULT_PAGE_SIZE=50。
 *
 * 本地轨：store 注入式，纯函数可单测；不调真实云 API。
 * 解耦：本模块不 require wx-server-sdk。
 */

const DEFAULT_PAGE_SIZE = 50;

// 投影白名单：逐字段枚举，绝不下发 _openid / sync_count。
// verdict_action/verdict_at 用于展示裁定留痕（区分同步为0 vs 裁定置0）。
const ABNORMAL_FIELDS = [
  '_id',
  'user_id',
  'date',
  'steps',
  'synced_at',
  'abnormal',
  'locked',
  'verdict_action',
  'verdict_at'
];

/**
 * 异常记录投影：仅下发白名单字段（红线：绝不下发 _openid / sync_count）。
 * @param {object} r
 * @returns {object}
 */
function projectAbnormal(r) {
  const rec = r || {};
  const out = {};
  for (const k of ABNORMAL_FIELDS) {
    if (rec[k] !== undefined) out[k] = rec[k];
  }
  return out;
}

/**
 * 查询异常步数记录列表（过滤 + 本地分页）。
 * @param {object} store mock db（{ StepRecord: object[] }）
 * @param {object} params
 * @param {string} params.activityId 活动 id
 * @param {number} [params.page=1] 页码（从 1 起）
 * @param {number} [params.pageSize=50] 每页条数
 * @returns {{list: object[], totalCount: number}}
 */
function queryAbnormal(store, params) {
  const p = params || {};
  const page = Math.max(1, Number(p.page) || 1);
  const pageSize = Math.max(1, Number(p.pageSize) || DEFAULT_PAGE_SIZE);

  const records = (store && Array.isArray(store.StepRecord)) ? store.StepRecord : [];

  let filtered = records.filter(
    (r) => r && r.abnormal === true && r.activity_id === p.activityId
  );

  // 按 synced_at 降序（最新异常在前）；缺省排末尾。
  filtered = filtered.slice().sort((a, b) => {
    const sa = a.synced_at || '';
    const sb = b.synced_at || '';
    if (sa < sb) return 1;
    if (sa > sb) return -1;
    return 0;
  });

  const totalCount = filtered.length;

  // 分页。
  const start = (page - 1) * pageSize;
  const slice = filtered.slice(start, start + pageSize);

  const users = (store && Array.isArray(store.User)) ? store.User : [];
  const list = slice.map((r) => {
    const out = projectAbnormal(r);
    const u = users.find((x) => x && x._openid === out.user_id);
    out.name = (u && (u.real_name || u.nickname)) || '';
    return out;
  });

  return { list, totalCount };
}

module.exports = { queryAbnormal, projectAbnormal, DEFAULT_PAGE_SIZE };
