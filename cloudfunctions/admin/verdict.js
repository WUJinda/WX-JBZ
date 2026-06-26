/**
 * admin.applyVerdict 纯函数（对齐技术架构 §122，PRD F8 R8.4 异步步数裁定）。
 *
 * 职责：
 *   - action ∈ {'ignore','zero'}，非法 action 抛错。
 *     · ignore：清 abnormal=false，保留 steps（视为非异常）。
 *     · zero：steps 置 0 + abnormal=false（R8.4 置零裁定）。
 *   - 校验 recordId 在 store.StepRecord（否则 SYS_DB_ERROR）。
 *   - 返回 { recordId, action, steps, abnormal, verdict_action, verdict_at }。
 *   - 留痕：给目标 StepRecord 写 verdict_action（'ignore'/'zero'）+ verdict_at（now），
 *     区分「同步为 0」与「裁定置 0」（R8.4 可追溯）。
 *   - 幂等：重复 zero 不报错；重复 ignore 幂等。
 *
 * 本地轨：store 注入式，纯函数可单测；不调真实云 API。
 * 解耦：本模块不 require wx-server-sdk。
 */

const { CODE, BizError } = require('../common/errors');

const VALID_ACTIONS = new Set(['ignore', 'zero']);

/**
 * 应用异常裁定。
 * @param {object} store mock db（{ StepRecord: object[] }）
 * @param {object} params
 * @param {string} params.recordId StepRecord._id
 * @param {string} params.action 'ignore' | 'zero'
 * @param {string} params.now 当前时间 ISO（写 synced_at，便于追溯裁定时间）
 * @returns {{recordId: string, action: string, steps: number, abnormal: boolean, verdict_action: string, verdict_at: string}}
 */
function applyVerdict(store, params) {
  const p = params || {};
  const { recordId, action, now } = p;

  if (!VALID_ACTIONS.has(action)) {
    throw BizError(CODE.SYS_DB_ERROR, 'applyVerdict: invalid action (ignore|zero)');
  }
  if (!recordId) {
    throw BizError(CODE.SYS_DB_ERROR, 'applyVerdict: recordId required');
  }
  if (!store || !Array.isArray(store.StepRecord)) {
    throw BizError(CODE.SYS_DB_ERROR, 'applyVerdict: store.StepRecord is required');
  }

  const rec = store.StepRecord.find((r) => r && r._id === recordId);
  if (!rec) {
    throw BizError(CODE.SYS_DB_ERROR, 'applyVerdict: record not found');
  }

  if (action === 'zero') {
    rec.steps = 0;
    rec.abnormal = false;
    if (now) rec.synced_at = now;
  } else {
    // ignore：保留 steps，清 abnormal。
    rec.abnormal = false;
    if (now) rec.synced_at = now;
  }

  // 裁定留痕：记录裁定动作与时间，便于区分「同步为 0」与「裁定置 0」（R8.4 可追溯）。
  rec.verdict_action = action;
  if (now) rec.verdict_at = now;

  return {
    recordId,
    action,
    steps: Number(rec.steps) || 0,
    abnormal: !!rec.abnormal,
    verdict_action: action,
    verdict_at: now || rec.verdict_at || ''
  };
}

module.exports = { applyVerdict, VALID_ACTIONS };
