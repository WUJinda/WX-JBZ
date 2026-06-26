/**
 * steps 云函数入口：步数同步与查询（对齐技术架构 §4.1）。
 * Action: sync / today / history / trend
 */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const { authMiddleware } = require('../common/authMiddleware');
const { ok, fail } = require('../common/response');
const { CODE, notImplemented } = require('../common/errors');

const handlers = {
  // sync:    async (event, context) => { ... }   // E2
  // today:   async (event, context) => { ... }   // E3
  // history: async (event, context) => { ... }   // E3
  // trend:   async (event, context) => { ... }   // E3
};

exports.main = async (event) => {
  const action = event && event.action;
  try {
    const handler = handlers[action];
    if (typeof handler !== 'function') {
      const err = notImplemented(action ? 'steps.' + action : 'steps.<empty>');
      return fail(err.code, err.message);
    }
    // 步数类 action 要求已报名用户（后续轮次开启 requireUser + 报名校验）
    const context = authMiddleware({ getWXContext: cloud.getWXContext });
    const data = await handler(event, context);
    return ok(data);
  } catch (err) {
    if (err && typeof err.code === 'number') {
      return fail(err.code, err.message);
    }
    return fail(CODE.SYS_DB_ERROR, (err && err.message) || 'steps error');
  }
};

module.exports = exports;
