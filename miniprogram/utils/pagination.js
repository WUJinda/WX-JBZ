/**
 * 分页通用纯函数（对齐 PRD F5/F6/F8 分页口径）。
 *
 * 仅消费「本次返回条数 + 每页条数」，不耦合 wx 运行时、不调云函数，
 * 便于在 Node 下单测。
 */

/**
 * 分页 hasMore 判定：本页满（count >= pageSize）→ 可能还有更多。
 *
 * 语义说明：
 *   - 后端按 pageSize 切片，返回条数 == pageSize 说明可能还有下一页 → true；
 *   - 返回条数 < pageSize 说明已是末页 → false。
 *   - pageSize 缺省/非法（<1 或非数字）兜底为 50。
 *
 * @param {number} count 本次返回条数
 * @param {number} pageSize 每页条数
 * @returns {boolean}
 */
function hasMore(count, pageSize) {
  const cnt = Number(count) || 0;
  const size = Number(pageSize);
  const ps = !Number.isFinite(size) || size < 1 ? 50 : Math.floor(size);
  return cnt >= ps;
}

module.exports = { hasMore };
