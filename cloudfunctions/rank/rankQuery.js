/**
 * rank.personal / rank.dept / rank.deptMembers 业务纯函数（对齐技术架构 §6.6，PRD R5.2/R6.1/R6.3）。
 *
 * 职责（读 RankCache，分页 + 我的排名）：
 *   - readPersonal：个人榜分页（默认 50/页），按 rank 升序；返回 list + myRank（ref_id 定位，未进榜 null）
 *     + totalCount + updatedAt。
 *   - readDept：部门榜分页，metric avg/total 可切重排 rank；返回 list + myDeptRank + updatedAt。
 *   - readDeptMembers：按 dept_id 过滤部门内成员（读 personal RankCache 重排），本人标记 is_me。
 *
 * 红线：
 *   - 全部从 store.RankCache 读（聚合由 tasks.rankAggregate 预生成）。
 *   - 投影脱敏、不下发 _openid / phone / sync_count（RankCache 已无这些字段；投影再兜底剔除）。
 *
 * 本地轨：store 注入式，纯函数可单测；不调真实微信云 API。
 *
 * 解耦：本模块不 require wx-server-sdk。
 */

const DEFAULT_PAGE_SIZE = 50; // R5.4：分页默认 50/页

/**
 * 取某活动某 type 的 RankCache 行（按 rank 升序）。
 * P0-3 单文档：从 (type, activity_id) 的单个文档读 doc.rows。
 * P1-8：返回每行的浅拷贝，避免 readDept/readDeptMembers 改 r.rank/dept_rank 时污染源 doc.rows。
 * @param {object} store
 * @param {string} type 'personal' | 'dept'
 * @param {string} activityId
 * @returns {object[]}
 */
function getCacheRows(store, type, activityId) {
  if (!store || !Array.isArray(store.RankCache)) return [];
  const doc = store.RankCache.find(
    (d) => d && d.type === type && d.activity_id === activityId
  );
  const rows = doc && Array.isArray(doc.rows) ? doc.rows : [];
  return rows
    .map((r) => (r ? Object.assign({}, r) : r))
    .sort((a, b) => ((a && a.rank) || 0) - ((b && b.rank) || 0));
}

/**
 * 取最近更新时间（updated_at，取缓存中任意一条）。
 * @param {object[]} rows
 * @returns {string|null}
 */
function pickUpdatedAt(rows) {
  if (!rows || !rows.length) return null;
  return rows[0].updated_at || null;
}

/**
 * 个人榜投影：剔除敏感字段，规整输出。
 * RankCache(personal) 本就不含 _openid/phone/sync_count；此处再兜底剔除以防误存。
 * @param {object} row
 * @returns {object}
 */
function projectPersonal(row) {
  const r = row || {};
  return {
    rank: r.rank,
    user_id: r.user_id,
    ref_id: r.user_id, // ref_id = user_id（personal）
    total_steps: r.total_steps,
    first_reach_at: r.first_reach_at || null,
    nickname: r.nickname || '',
    dept_id: r.dept_id || '',
    dept_name: r.dept_name || ''
  };
}

/**
 * 部门榜投影：剔除敏感字段。
 * @param {object} row
 * @returns {object}
 */
function projectDept(row) {
  const r = row || {};
  return {
    rank: r.rank,
    dept_id: r.dept_id,
    ref_id: r.dept_id, // ref_id = dept_id（dept）
    total_steps: r.total_steps,
    member_count: r.member_count,
    avg_steps: r.avg_steps,
    small_sample: !!r.small_sample,
    dept_name: r.dept_name || ''
  };
}

/**
 * readPersonal：个人榜分页 + 我的排名。
 *
 * @param {object} params
 * @param {object} params.store
 * @param {string} params.activityId
 * @param {string} [params.userId] 当前用户 id（用于定位 myRank）
 * @param {number} [params.page=1] 页码（从 1 起）
 * @param {number} [params.pageSize=50] 每页条数
 * @returns {Promise<object>} { list, myRank, totalCount, updatedAt }
 */
async function readPersonal(params) {
  const p = params || {};
  const { store, activityId } = p;
  const page = Math.max(1, Number(p.page) || 1);
  const pageSize = Math.max(1, Number(p.pageSize) || DEFAULT_PAGE_SIZE);

  const rows = getCacheRows(store, 'personal', activityId);

  // 我的排名：按 user_id(ref_id) 定位；未进榜 → null。
  let myRank = null;
  if (p.userId) {
    const mine = rows.find((r) => r.user_id === p.userId);
    if (mine) {
      myRank = projectPersonal(mine);
    }
  }

  // 分页（按 rank 升序已排好）。
  const start = (page - 1) * pageSize;
  const slice = rows.slice(start, start + pageSize);
  const list = slice.map(projectPersonal);

  return {
    list,
    myRank,
    totalCount: rows.length,
    updatedAt: pickUpdatedAt(rows)
  };
}

/**
 * readDept：部门榜分页（metric avg/total 可切重排）。
 *
 * @param {object} params
 * @param {object} params.store
 * @param {string} params.activityId
 * @param {string} [params.deptIdOfUser] 当前用户所在 dept_id（用于定位 myDeptRank）
 * @param {string} [params.metric='avg'] 排序口径：'avg'（人均，默认）/ 'total'（总步数）
 * @param {number} [params.page=1]
 * @param {number} [params.pageSize=50]
 * @returns {Promise<object>} { list, myDeptRank, totalCount, updatedAt }
 */
async function readDept(params) {
  const p = params || {};
  const { store, activityId } = p;
  const metric = p.metric === 'total' ? 'total' : 'avg'; // 默认 avg（R6.1）
  const page = Math.max(1, Number(p.page) || 1);
  const pageSize = Math.max(1, Number(p.pageSize) || DEFAULT_PAGE_SIZE);

  let rows = getCacheRows(store, 'dept', activityId);

  // metric 切换重排：avg → avg_steps desc（小部门仍排后，§657）；total → total_steps desc（小部门仍排后）。
  // 重排后重新赋 rank。
  rows.sort((a, b) => {
    // 小部门排主榜之后（§657，两种 metric 都遵循）。
    if (!!a.small_sample !== !!b.small_sample) {
      return a.small_sample ? 1 : -1;
    }
    const av = metric === 'total' ? a.total_steps : a.avg_steps;
    const bv = metric === 'total' ? b.total_steps : b.avg_steps;
    if (bv !== av) return bv - av;
    // 兜底稳定排序。
    const da = a.dept_id || '';
    const db = b.dept_id || '';
    if (da < db) return -1;
    if (da > db) return 1;
    return 0;
  });
  rows.forEach((r, i) => {
    r.rank = i + 1;
  });

  // 我的部门排名：按 dept_id(ref_id) 定位。
  let myDeptRank = null;
  if (p.deptIdOfUser) {
    const mine = rows.find((r) => r.dept_id === p.deptIdOfUser);
    if (mine) {
      myDeptRank = projectDept(mine);
    }
  }

  // 分页。
  const start = (page - 1) * pageSize;
  const slice = rows.slice(start, start + pageSize);
  const list = slice.map(projectDept);

  return {
    list,
    myDeptRank,
    totalCount: rows.length,
    updatedAt: pickUpdatedAt(rows)
  };
}

/**
 * readDeptMembers：部门内成员排名（按 dept_id 过滤 personal RankCache，重排，本人标记 is_me）。
 *
 * @param {object} params
 * @param {object} params.store
 * @param {string} params.activityId
 * @param {string} params.deptId 目标部门 id
 * @param {string} [params.currentUserId] 当前用户 id（标记 is_me）
 * @param {number} [params.page=1]
 * @param {number} [params.pageSize=50]
 * @returns {Promise<object>} { list, totalCount, updatedAt }
 */
async function readDeptMembers(params) {
  const p = params || {};
  const { store, activityId, deptId } = p;
  const page = Math.max(1, Number(p.page) || 1);
  const pageSize = Math.max(1, Number(p.pageSize) || DEFAULT_PAGE_SIZE);

  const rows = getCacheRows(store, 'personal', activityId);

  // 按 dept_id 过滤，重排部门内 rank（total_steps desc / first_reach_at asc，与个人榜口径一致）。
  const filtered = rows
    .filter((r) => r.dept_id === deptId)
    .slice()
    .sort((a, b) => {
      if (b.total_steps !== a.total_steps) return b.total_steps - a.total_steps;
      const fa = a.first_reach_at || '';
      const fb = b.first_reach_at || '';
      if (fa < fb) return -1;
      if (fa > fb) return 1;
      return 0;
    });
  filtered.forEach((r, i) => {
    r.dept_rank = i + 1; // 部门内排名（区别于全局 rank）
  });

  // 分页。
  const start = (page - 1) * pageSize;
  const slice = filtered.slice(start, start + pageSize);

  const list = slice.map((r) => {
    const out = projectPersonal(r);
    out.rank = r.dept_rank; // 部门内排名覆盖
    out.is_me = !!(p.currentUserId && r.user_id === p.currentUserId);
    return out;
  });

  return {
    list,
    totalCount: filtered.length,
    updatedAt: pickUpdatedAt(rows)
  };
}

module.exports = {
  readPersonal,
  readDept,
  readDeptMembers,
  projectPersonal,
  projectDept,
  DEFAULT_PAGE_SIZE
};
