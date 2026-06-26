/**
 * auth 云函数入口：登录鉴权（对齐技术架构 §4.1 / §6.1，开发计划 B2/B3）。
 * Action: login / phone
 *
 * 身份完全以 cloud.getWXContext().OPENID 为可信来源，不使用任何自管 token。
 * 业务逻辑见 authLogin.js / authPhone.js（纯函数 + 注入式 db，可单测）。
 */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const { authMiddleware, getOpenid } = require('../common/authMiddleware');
const { ok, fail } = require('../common/response');
const { CODE, notImplemented } = require('../common/errors');
const { login } = require('./authLogin');
const { verifyPhone } = require('./authPhone');

// handler 表：action -> handler。handler 只做「取上下文 → 调纯函数 → 组装出入参」。
const handlers = {
  // B2: 登录（取 openid → 查/建 User → 返回登录态，不下发 token）
  login: async (event, context) => {
    const db = cloud.database();
    return login({
      getWXContext: cloud.getWXContext,
      db,
      profile: event && event.profile
    });
  },

  // B3: 手机号验证（脱敏 + 白名单校验 + 更新 User，不下发完整手机号）
  phone: async (event, context) => {
    const openid = context && context.openid;
    const db = cloud.database();
    // 本地轨：phone 由调用方传入「已解密的完整手机号」。
    // 真实 getPhoneNumber / encryptedData 解密链路在云轨接入。
    //
    // === 云轨 TODO（联调强制项）===
    // 当前直接读 event.phone 明文，仅为本地轨联调占位。
    // 云轨联调必须改为：从前端 open-type=getPhoneNumber 回调拿 code，
    // 调 cloud.openapi.phonenumber.getPhoneNumber({ code }) 由微信侧解密返回真实手机号，
    // 禁止把前端明文 phone 作为信任源（否则任何前端可伪造任意手机号绕过白名单）。
    // 改造点示例：
    //   const phoneRes = await cloud.openapi.phonenumber.getPhoneNumber({ code: event.code });
    //   const phone = phoneRes && phoneRes.phoneInfo && phoneRes.phoneInfo.phoneNumber;
    const phone = event && event.phone;
    return verifyPhone({ openid, phone, db });
  }
};

exports.main = async (event) => {
  const action = event && event.action;
  try {
    const handler = handlers[action];
    if (typeof handler !== 'function') {
      const err = notImplemented(action ? 'auth.' + action : 'auth.<empty>');
      return fail(err.code, err.message);
    }
    // 登录前置 action 不强制 requireUser；phone 需要 openid 上下文
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
