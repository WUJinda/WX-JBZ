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
 * 容错：仅「集合未创建」（如 RankCache 首次、新环境未 ensureSchema）→ 返回空数组；
 *   其余 DB 异常（超时/权限/网络）一律上抛——否则静默吞错会让聚合覆盖写空榜、前端却 ok（假成功，
 *   见 code-review-2026-07 风险链 A）。
 * where/field 均可选：缺省 = 全量、无投影（等同原 loadCollection，供 admin 等需全量内存筛选的 handler）。
 * where 中值为 null/undefined 的键会被剔除（避免向 DB 传 {field:undefined} 的未定义行为）。
 *
 * @param {object} cloudSdk wx-server-sdk 实例
 * @param {string} name 集合名
 * @param {object} [whereExpr] 过滤条件，如 { user_id, activity_id }
 * @param {object} [fieldExpr] 白名单投影，如 { _id:1, steps:1 }（只取列出的字段）
 * @returns {Promise<object[]>}
 */
/**
 * 判断是否「集合未创建」错误（云开发 DATABASE_COLLECTION_NOT_EXIST，errCode -502005）。
 * 仅这种情况返回空数组兜底，其余 DB 异常必须上抛（防假成功）。
 * @param {object} err
 * @returns {boolean}
 */
function isCollectionNotExist(err) {
  if (!err) return false;
  const errCode = err.errCode != null ? err.errCode : err.code;
  if (errCode === -502005) return true;
  const msg = (err.errMsg || err.message || '') + '';
  return /-502005|collection.*(not.*exist|doesn'?t exist|不存在)|集合.*不存在/i.test(msg);
}

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
    // 仅当「集合未创建」时返回空数组兜底（RankCache 首次、新环境未 ensureSchema 等）。
    // 其他 DB 异常（超时/权限/网络）必须上抛——静默吞 [] 会让聚合覆盖写空榜、前端却 ok（假成功）。
    if (isCollectionNotExist(err)) return [];
    throw err;
  }
  return all;
}

module.exports = { createDb, loadByWhere };
