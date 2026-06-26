/**
 * auth 云函数入口：登录鉴权（对齐技术架构 §4.1）。
 * Action: login / phone
 *
 * 本轮为骨架：未实现的 action 返回 not implemented。
 * 身份以 cloud.getWXContext().OPENID 为准，不使用任何自管 token。
 */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const { authMiddleware } = require('../common/authMiddleware');
const { ok, fail } = require('../common/response');
const { CODE, notImplemented } = require('../common/errors');

// handler 表：action -> handler。后续轮次在此挂载实现。
const handlers = {
  // login: async (event, context) => { ... }   // B2
  // phone: async (event, context) => { ... }   // B3
};

exports.main = async (event) => {
  const action = event && event.action;
  try {
    const handler = handlers[action];
    if (typeof handler !== 'function') {
      // 骨架阶段：未实现统一返回 not implemented
      const err = notImplemented(action ? 'auth.' + action : 'auth.<empty>');
      return fail(err.code, err.message);
    }
    // 登录前置 action 不强制 requireUser
    const context = authMiddleware({ getWXContext: cloud.getWXContext });
    const data = await handler(event, context);
    return ok(data);
  } catch (err) {
    if (err && typeof err.code === 'number') {
      return fail(err.code, err.message);
    }
    return fail(CODE.SYS_DB_ERROR, (err && err.message) || 'auth error');
  }
};

module.exports = exports;
