/**
 * 云数据库初始化封装 + 查询 helper。
 * 依赖注入 cloud，便于在 Node 下单测（注入 mock cloud）。
 * 真实环境由各云函数入口传入 `require('wx-server-sdk')`。
 *
 * @param {object} cloud wx-server-sdk 实例
 * @returns {object} database 句柄
 */
function createDb(cloud) {
  if (!cloud || typeof cloud.database !== 'function') {
    throw new Error('createDb: cloud with database() is required');
  }
  return cloud.database();
}

/**
 * 按 where 条件分页加载集合文档（可选 field 白名单投影）。
 *
 * P0-5：替代各 handler 复制的裸 loadCollection（全量拉取），只拉需要的行 + 字段，
 *   避免大集合 OOM 与 _openid/phone/sync_count 等敏感字段入内存。
 *
 * 容错：集合未创建（如 RankCache 首次）或查询异常 → 返回空数组（与原 loadCollection 一致）。
 * where/field 均可选：缺省 = 全量、无投影（等同原 loadCollection，供 admin 等需全量内存筛选的 handler）。
 * where 中值为 null/undefined 的键会被剔除（避免向 DB 传 {field:undefined} 的未定义行为）。
 *
 * @param {object} cloudSdk wx-server-sdk 实例
 * @param {string} name 集合名
 * @param {object} [whereExpr] 过滤条件，如 { user_id, activity_id }
 * @param {object} [fieldExpr] 白名单投影，如 { _id:1, steps:1 }（只取列出的字段）
 * @returns {Promise<object[]>}
 */
async function loadByWhere(cloudSdk, name, whereExpr, fieldExpr) {
  const db = cloudSdk.database();
  const PAGE = 100;
  let all = [];
  let skip = 0;
  // 归一化 where：剔除 null/undefined 值（避免 DB 未定义行为）。
  const cleanWhere = {};
  if (whereExpr) {
    for (const k of Object.keys(whereExpr)) {
      if (whereExpr[k] !== undefined && whereExpr[k] !== null) cleanWhere[k] = whereExpr[k];
    }
  }
  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      let q = db.collection(name);
      if (Object.keys(cleanWhere).length) q = q.where(cleanWhere);
      if (fieldExpr && Object.keys(fieldExpr).length) q = q.field(fieldExpr);
      const res = await q.skip(skip).limit(PAGE).get();
      const data = (res && res.data) || [];
      all = all.concat(data);
      if (data.length < PAGE) break;
      skip += PAGE;
    }
  } catch (err) {
    // 集合未创建 / 查询异常：返回空数组兜底（与原 loadCollection 容错一致）。
    return [];
  }
  return all;
}

module.exports = { createDb, loadByWhere };
