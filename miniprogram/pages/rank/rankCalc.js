/**
 * 排行榜页前端纯函数（对齐 PRD F5/F6，开发计划阶段 G2）。
 *
 * 把分页切片、前后相邻名次、贡献占比、metric 校正、空态判定、更新时间格式化
 * 抽成纯函数，便于在 Node 下单测，不耦合 wx 运行时。
 *
 * 红线：
 *   - 入参仅消费后端下发的脱敏字段（rank/user_id/nickname/dept_name/total_steps 等）。
 *   - 不依赖 wx API、不调云函数（数据由 rank.js 拉取后传入）。
 */

const DEFAULT_PAGE_SIZE = 50; // F5：个人榜分页默认 50/页

/**
 * 分页切片：按 (page-1)*pageSize 起算切片，page<1 或 pageSize<1 兜底。
 * 与后端 readPersonal/readDept 切片口径一致，便于前端「分页加载更多」累计拼接。
 *
 * @param {Array} list 全量已加载列表
 * @param {number} page 页码（从 1 起）
 * @param {number} pageSize 每页条数
 * @returns {Array} 当前页切片
 */
function paginate(list, page, pageSize) {
  const arr = Array.isArray(list) ? list : [];
  const numPage = Number(page);
  const numSize = Number(pageSize);
  // page<1 或非数字 → 1；pageSize<1 或非数字 → 默认 50。
  const p = !Number.isFinite(numPage) || numPage < 1 ? 1 : Math.floor(numPage);
  const size = !Number.isFinite(numSize) || numSize < 1 ? DEFAULT_PAGE_SIZE : Math.floor(numSize);
  const start = (p - 1) * size;
  return arr.slice(start, start + size);
}

/**
 * 选取「我的排名」前后相邻 n 名（F5：我的排名条固定底部，显示名次 + 前后相邻）。
 * 入参为已加载的全量（或当前页）列表，按 user_id 定位本人，返回包含本人及前后各 n 名的子集。
 * - 本人未在列表中 → 返回空数组（前端可只展示 myRank 名次）。
 * - 首位/末位做边界裁剪（前不足 n 则少取，后同理）。
 *
 * @param {Array<{user_id:string}>} list 已排好序的列表（按 rank 升序）
 * @param {string} myUserId 本人 user_id
 * @param {number} [n=1] 前后各取 n 名
 * @returns {Array} 子集（按原顺序）
 */
function pickNeighbors(list, myUserId, n) {
  const arr = Array.isArray(list) ? list : [];
  if (!myUserId) return [];
  const cnt = Math.max(0, Math.floor(Number(n) || 0));
  const idx = arr.findIndex((it) => it && it.user_id === myUserId);
  if (idx < 0) return [];
  const start = Math.max(0, idx - cnt);
  const end = Math.min(arr.length, idx + cnt + 1);
  return arr.slice(start, end);
}

/**
 * 我的贡献占比（F6：我的部门卡显示「贡献占比 %」）。
 * 占比 = mySteps / deptTotal，保留 1 位小数；deptTotal<=0 → 0（除零保护）。
 *
 * @param {number} mySteps 本人累计步数
 * @param {number} deptTotal 部门累计步数
 * @returns {number} 百分比（0~100，保留 1 位小数）
 */
function contribution(mySteps, deptTotal) {
  const mine = Number(mySteps) || 0;
  const total = Number(deptTotal) || 0;
  if (total <= 0 || mine <= 0) return 0;
  return Math.round((mine / total) * 1000) / 10;
}

/**
 * 空态判定：list 为空 → true（F5/F6 无数据时占位，参照 R4.3 风格）。
 * @param {Array} list
 * @returns {boolean}
 */
function isEmptyRank(list) {
  return !Array.isArray(list) || list.length === 0;
}

/**
 * 格式化更新时间（F5：标注「更新于 N 分钟前 / N 小时前」，与 home 的 refreshLastSyncText 风格一致）。
 * @param {number|string|Date} ts 时间戳（毫秒数字 / ISO 字符串 / Date）
 * @param {number} [now=Date.now()] 当前时间（便于测试注入）
 * @returns {string} '刚刚' | 'N 分钟前' | 'N 小时前' | '' （无 ts → ''）
 */
function formatUpdatedAt(ts, now) {
  if (ts === null || ts === undefined || ts === '') return '';
  let t;
  if (ts instanceof Date) {
    t = ts.getTime();
  } else if (typeof ts === 'number') {
    t = ts;
  } else {
    // 字符串：可能是 ISO 字符串或数字字符串。
    const parsed = Date.parse(ts);
    t = Number.isNaN(parsed) ? Number(ts) : parsed;
  }
  if (!Number.isFinite(t)) return '';
  const base = Number(now) || Date.now();
  const diffMs = base - t;
  if (diffMs < 0) return '刚刚'; // 时钟漂移兜底
  const min = Math.floor(diffMs / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return min + ' 分钟前';
  const hours = Math.floor(min / 60);
  if (hours < 24) return hours + ' 小时前';
  const days = Math.floor(hours / 24);
  return days + ' 天前';
}

module.exports = {
  DEFAULT_PAGE_SIZE,
  paginate,
  pickNeighbors,
  contribution,
  isEmptyRank,
  formatUpdatedAt
};
