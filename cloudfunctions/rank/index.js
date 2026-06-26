/**
 * rank 云函数入口：排行榜（读缓存，对齐技术架构 §4.1）。
 * Action: personal / dept / deptMembers
 */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const { authMiddleware } = require('../common/authMiddleware');
const { ok, fail } = require('../common/response');
const { CODE, notImplemented } = require('../common/errors');

const handlers = {
  // personal:   async (event, context) => { ... }   // G4
  // dept:       async (event, context) => { ... }   // G5
  // deptMembers: async (event, context) => { ... }  // G5
};

exports.main = async (event) => {
  const action = event && event.action;
  try {
    const handler = handlers[action];
    if (typeof handler !== 'function') {
      const err = notImplemented(action ? 'rank.' + action : 'rank.<empty>');
      return fail(err.code, err.message);
    }
    const context = authMiddleware({ getWXContext: cloud.getWXContext });
    const data = await handler(event, context);
    return ok(data);
  } catch (err) {
    if (err && typeof err.code === 'number') {
      return fail(err.code, err.message);
    }
    return fail(CODE.SYS_DB_ERROR, (err && err.message) || 'rank error');
  }
};

module.exports = exports;
