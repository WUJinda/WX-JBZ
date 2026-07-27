/**
 * auth 云函数入口：登录鉴权（对齐技术架构 §4.1 / §6.1，开发计划 B2/B3）。
 * Action: login / register
 *
 * 准入凭证为「一人一码邀请码」（手机号/白名单机制已移除）：
 *   - login 只查 User by openid，判新老用户（is_new 引导注册向导）；
 *   - register 消费邀请码（unused→used 绑定 openid）后建号。
 *
 * 身份完全以 cloud.getWXContext().OPENID 为可信来源，不使用任何自管 token。
 * 业务逻辑见 authLogin.js / authRegister.js / inviteCode.js（纯函数 + 注入式 db，可单测）。
 */
// 模块级 cloud：真云环境 require wx-server-sdk；本地/测试环境（无 sdk）降级为 null，
// 以便单测可 require 本文件。main 入口路径仅在真云环境执行，那里 sdk 必然存在。
let cloud;
try {
  cloud = require('wx-server-sdk');
  cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
} catch (_) {
  cloud = null;
}

const { authMiddleware } = require('../common/authMiddleware');
const { ok, fail } = require('../common/response');
const { CODE, notImplemented } = require('../common/errors');
const { login } = require('./authLogin');
const { registerUser } = require('./authRegister');

/**
 * register handler（云轨建号链路）：可注入 cloud 句柄以便单测 mock database。
 *
 * 流程：context 取 openid、event 取 nickname/avatar/invite_code，cloud.database() 取 db，
 *   一次性传给 registerUser 纯函数（消费邀请码 + 建号，不授 is_admin）。
 *
 * ⚠️ 胶水层职责：**必须把 db 传进 registerUser**（纯函数校验 db 存在，漏传 → SYS_DB_ERROR
 *   'db with collection() is required'）。
 *
 * @param {object} params
 * @param {object} params.cloud 注入的 cloud 句柄（database()）
 * @param {object} params.event 云函数 event（nickname/avatar/invite_code）
 * @param {object} params.context 鉴权上下文（含 openid）
 * @returns {Promise<object>} registerUser 返回的 { registered, is_new, invite_code, join_status }
 */
async function handleRegister({ cloud, event, context }) {
  const db = cloud.database();
  return registerUser({
    db,
    openid: context && context.openid,
    nickname: event && event.nickname,
    avatar: event && event.avatar,
    inviteCode: event && event.invite_code,
    now: new Date()
  });
}

// handler 表：action -> handler。handler 只做「取上下文 → 调纯函数 → 组装出入参」。
const handlers = {
  // B2: 登录（取 openid → 只查 User → 返回登录态含 is_new，不下发 token）。
  // login 不建号（建号移至 register），仅判新老用户：is_new=true 前端引导走注册向导。
  login: async (event, context) => {
    const db = cloud.database();
    return login({ getWXContext: cloud.getWXContext, db });
  },

  // 注册建号（一次性提交：昵称 + 头像 + 邀请码）。取 openid（authMiddleware），不 requireUser。
  // registerUser 消费邀请码（原子 unused→used 绑定 openid）后建号；不授 is_admin。
  register: async (event, context) => handleRegister({ cloud, event, context })
};

exports.main = async (event) => {
  const action = event && event.action;
  try {
    const handler = handlers[action];
    if (typeof handler !== 'function') {
      const err = notImplemented(action ? 'auth.' + action : 'auth.<empty>');
      return fail(err.code, err.message);
    }
    // 登录/注册前置 action 不强制 requireUser；均需 openid 上下文。
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

// 注意：不能用 module.exports = { handleRegister }，会覆盖 exports.main，
// 导致微信云运行时找不到 main handler（报 handler not found）。
module.exports.handleRegister = handleRegister;
