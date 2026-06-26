/**
 * 集合 + 索引初始化脚本（对齐开发计划 B1 / 技术架构 §5）。
 *
 * 用途：在云开发数据库中为 User / Whitelist 创建唯一/普通索引。
 *   - 云开发数据库无 schema，集合本身在首次写入时自动创建，
 *     此脚本仅负责「索引」的显式建立（云数据库 API 支持按字段建索引）。
 *
 * 依赖注入：传入 cloud（wx-server-sdk 实例）即可执行；
 *   不依赖 cloud 也可 require（仅用于元信息查阅与结构校验单测）。
 *
 * 运行方式（云轨联调时）：
 *   - 在云函数中调用 ensureIndexes(cloud) 一次性建索引；
 *   - 或在云开发控制台手工按 COLLECTIONS 声明建索引。
 *
 * 幂等：createIndex 对已存在同名索引会抛错，脚本捕获并视为已完成。
 */

const { COLLECTIONS } = require('./collections');

/**
 * 对单个集合建声明的全部索引。
 * @param {object} db cloud.database() 句柄
 * @param {string} name 集合名
 * @returns {Promise<Array<{index:string, ok:boolean, reason?:string}>>}
 */
async function ensureCollectionIndexes(db, name) {
  const def = COLLECTIONS[name];
  if (!def || !Array.isArray(def.indexes)) return [];
  const collection = db.collection(name);
  const results = [];
  for (const idx of def.indexes) {
    try {
      // 云数据库 createIndex 接受字段映射与选项
      await collection.createIndex({
        name: idx.name,
        keys: idx.fields,
        options: idx.unique ? { unique: true } : undefined
      });
      results.push({ index: idx.name, ok: true });
    } catch (err) {
      // 索引已存在 / 集合未创建等情况：不视为失败，仅记录原因
      results.push({ index: idx.name, ok: false, reason: (err && err.errMsg) || (err && err.message) || 'skip' });
    }
  }
  return results;
}

/**
 * 对全部声明的集合建立索引（幂等）。
 * @param {object} cloud wx-server-sdk 实例（已 init）
 * @returns {Promise<object>} { User: [...], Whitelist: [...] }
 */
async function ensureIndexes(cloud) {
  if (!cloud || typeof cloud.database !== 'function') {
    throw new Error('ensureIndexes: cloud with database() is required');
  }
  const db = cloud.database();
  const out = {};
  for (const name of Object.keys(COLLECTIONS)) {
    out[name] = await ensureCollectionIndexes(db, name);
  }
  return out;
}

module.exports = { ensureIndexes, ensureCollectionIndexes, COLLECTIONS };
