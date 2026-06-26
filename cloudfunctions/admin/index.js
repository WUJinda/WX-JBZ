/**
 * admin 云函数入口：后台管理（对齐技术架构 §4.1）。
 * Action: whitelistImport / users / changeDept / abnormalList / verdict / dashboard / deptManage
 *
 * 所有 action 均为管理员类，需校验 is_admin（后续轮次在 authMiddleware 开启 requireAdmin）。
 */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const { authMiddleware } = require('../common/authMiddleware');
const { ok, fail } = require('../common/response');
const { CODE, notImplemented } = require('../common/errors');

const handlers = {
  // whitelistImport: async (event, context) => { ... }   // H2
  // users:           async (event, context) => { ... }   // H3
  // changeDept:      async (event, context) => { ... }   // H3
  // abnormalList:    async (event, context) => { ... }   // H4
  // verdict:         async (event, context) => { ... }   // H4
  // dashboard:       async (event, context) => { ... }   // H6
  // deptManage:      async (event, context) => { ... }   // H5
};

exports.main = async (event) => {
  const action = event && event.action;
  try {
    const handler = handlers[action];
    if (typeof handler !== 'function') {
      const err = notImplemented(action ? 'admin.' + action : 'admin.<empty>');
      return fail(err.code, err.message);
    }
    // 后续轮次：requireAdmin=true
    const context = authMiddleware({ getWXContext: cloud.getWXContext });
    const data = await handler(event, context);
    return ok(data);
  } catch (err) {
    if (err && typeof err.code === 'number') {
      return fail(err.code, err.message);
    }
    return fail(CODE.SYS_DB_ERROR, (err && err.message) || 'admin error');
  }
};

module.exports = exports;
