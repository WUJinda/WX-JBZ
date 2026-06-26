/**
 * tasks 云函数入口：定时任务（对齐技术架构 §4.1 / §6.5）。
 * Action: rankAggregate / dailyLock
 *
 * 同一逻辑既可被定时触发器调用，也可手动触发，便于本地与回归测试（架构 §6.5）。
 */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const { ok, fail } = require('../common/response');
const { CODE, notImplemented } = require('../common/errors');

const handlers = {
  // rankAggregate: async (event) => { ... }   // G2  每 10 分钟
  // dailyLock:     async (event) => { ... }   // G3  每日次日 12:00（可配置）
};

exports.main = async (event) => {
  const action = event && event.action;
  try {
    const handler = handlers[action];
    if (typeof handler !== 'function') {
      const err = notImplemented(action ? 'tasks.' + action : 'tasks.<empty>');
      return fail(err.code, err.message);
    }
    // 定时任务为系统级，不取调用者 OPENID 做用户鉴权
    const data = await handler(event);
    return ok(data);
  } catch (err) {
    if (err && typeof err.code === 'number') {
      return fail(err.code, err.message);
    }
    return fail(CODE.SYS_DB_ERROR, (err && err.message) || 'tasks error');
  }
};

module.exports = exports;
