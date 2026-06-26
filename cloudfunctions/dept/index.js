/**
 * dept 云函数入口：部门（对齐技术架构 §4.1）。
 * Action: list
 */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const { authMiddleware } = require('../common/authMiddleware');
const { ok, fail } = require('../common/response');
const { CODE, notImplemented } = require('../common/errors');
const { listDepartments } = require('./deptList');

const handlers = {
  // D1: 部门列表（员工可见，member_count 展示用）。
  // 本地轨：listDepartments 走 mock；真实云读留云轨联调，member_count 真实聚合留阶段 G。
  // 注：dept.list 不强制 requireUser（部门列表对已登录员工可见，白名单已在登录阶段校验），
  //    但仍走 authMiddleware 取 OPENID 以确保身份来源可信（与 activity.current 游客通道区分）。
  list: async (event, context) => {
    return listDepartments();
  }
};

exports.main = async (event) => {
  const action = event && event.action;
  try {
    const handler = handlers[action];
    if (typeof handler !== 'function') {
      const err = notImplemented(action ? 'dept.' + action : 'dept.<empty>');
      return fail(err.code, err.message);
    }
    const context = authMiddleware({ getWXContext: cloud.getWXContext });
    const data = await handler(event, context);
    return ok(data);
  } catch (err) {
    if (err && typeof err.code === 'number') {
      return fail(err.code, err.message);
    }
    return fail(CODE.SYS_DB_ERROR, (err && err.message) || 'dept error');
  }
};

module.exports = exports;
