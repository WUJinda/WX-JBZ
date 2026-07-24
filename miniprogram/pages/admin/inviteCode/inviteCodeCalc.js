/**
 * 邀请码管理页前端纯函数（可单测）。
 */

/** 单次批量生成上限（与后端 admin/inviteCode.MAX_BATCH 同口径）。 */
const MAX_BATCH = 500;

/**
 * 状态 → {text, cls} 用于列表徽章渲染。
 * @param {string} status unused/used/disabled
 * @returns {{text: string, cls: string}}
 */
function formatStatus(status) {
  if (status === 'used') return { text: '已使用', cls: 'status-used' };
  if (status === 'disabled') return { text: '已禁用', cls: 'status-disabled' };
  return { text: '未使用', cls: 'status-unused' };
}

/**
 * 校验生成数量：1..MAX_BATCH 正整数。
 * @param {*} raw
 * @returns {{ok: boolean, value?: number, msg?: string}}
 */
function validateCount(raw) {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n <= 0) return { ok: false, msg: '请输入正整数' };
  if (n > MAX_BATCH) return { ok: false, msg: '单次最多 ' + MAX_BATCH + ' 个' };
  return { ok: true, value: n };
}

module.exports = { formatStatus, validateCount, MAX_BATCH };
