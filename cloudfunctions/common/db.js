/**
 * 云数据库初始化封装。
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

module.exports = { createDb };
