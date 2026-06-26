/**
 * user 云函数入口：用户与报名（对齐技术架构 §4.1）。
 * Action: profile / join / stats
 */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const { authMiddleware } = require('../common/authMiddleware');
const { ok, fail } = require('../common/response');
const { CODE, notImplemented } = require('../common/errors');

const handlers = {
  // profile: async (event, context) => { ... }
  // join:    async (event, context) => { ... }   // D1
  // stats:   async (event, context) => { ... }
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
