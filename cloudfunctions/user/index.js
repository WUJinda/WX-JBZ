/**
 * user 云函数入口：用户与报名（对齐技术架构 §4.1，开发计划 B5）。
 * Action: profile / join / stats
 *
 * 本轮实现 profile（B5）。join 留 D1（不实现），stats 留后续阶段。
 * 身份完全以 cloud.getWXContext().OPENID 为可信来源，不下发原始 phone / openid。
 */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const { authMiddleware } = require('../common/authMiddleware');
const { ok, fail } = require('../common/response');
const { CODE, notImplemented } = require('../common/errors');
const { getProfile } = require('./userProfile');

// handler 表：action -> handler。
const handlers = {
  // B5: 个人资料（脱敏手机号 / 部门 / 累计步数占位，不下发敏感字段）
  profile: async (event, context) => {
    const db = cloud.database();
    return getProfile({ openid: context && context.openid, db });
  }
  // join:  async (event, context) => { ... }   // D1：报名归属，本轮不实现
  // stats: async (event, context) => { ... }   // 后续阶段
};

exports.main = async (event) => {
  const action = event && event.action;
  try {
    const handler = handlers[action];
    if (typeof handler !== 'function') {
      const err = notImplemented(action ? 'user.' + action : 'user.<empty>');
      return fail(err.code, err.message);
    }
    const context = authMiddleware({ getWXContext: cloud.getWXContext });
    const data = await handler(event, context);
    return ok(data);
  } catch (err) {
    if (err && typeof err.code === 'number') {
      return fail(err.code, err.message);
    }
    return fail(CODE.SYS_DB_ERROR, (err && err.message) || 'user error');
  }
};

module.exports = exports;
