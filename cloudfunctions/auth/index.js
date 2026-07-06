/**
 * auth 云函数入口：登录鉴权（对齐技术架构 §4.1 / §6.1，开发计划 B2/B3）。
 * Action: login / phone
 *
 * 身份完全以 cloud.getWXContext().OPENID 为可信来源，不使用任何自管 token。
 * 业务逻辑见 authLogin.js / authPhone.js（纯函数 + 注入式 db，可单测）。
 */
// 模块级 cloud：真云环境 require wx-server-sdk；本地/测试环境（无 sdk）降级为 null，
// 以便单测可 require 本文件取 handlePhone（handlePhone 用注入的 cloud 参数，不依赖此模块级变量）。
// main 入口路径（cloud.init/getWXContext/database）仅在真云环境执行，那里 sdk 必然存在。
let cloud;
try {
  cloud = require('wx-server-sdk');
  cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
} catch (_) {
  cloud = null;
}

const { authMiddleware, getOpenid } = require('../common/authMiddleware');
const { ok, fail } = require('../common/response');
const { CODE, BizError, notImplemented } = require('../common/errors');
const { login } = require('./authLogin');
const { verifyPhone } = require('./authPhone');

/**
 * 解密手机号：调「手机号快速验证组件」openapi 取真实手机号（红线强制项）。
 *
 * 红线：禁止信任前端明文 event.phone（对齐 docs/开发计划.md §5）。
 *   任何前端可伪造明文 phone 绕过白名单，故手机号必须由微信侧解密得到。
 *
 * @param {object} options
 * @param {object} options.cloud 注入的 wx-server-sdk cloud 句柄（含 openapi）
 * @param {string} options.code 前端 onGetPhoneNumber 回调的 e.detail.code
 * @returns {Promise<string>} 解密得到的 11 位真实手机号
 * @throws {BizError}
 *   - SYS_EXTERNAL_ERROR(5002) 当 phonenumber 能力缺失（云轨未开通）或解密结果异常；
 *   - SYS_EXTERNAL_ERROR(5002) 当 code 缺失（参数错误：此处复用系统外部错误，
 *     因 code 来自微信回调，缺失等同外部链路异常；不引入新错误码以保持 §12 错误码表稳定）。
 */
async function decryptPhone({ cloud, code }) {
  if (!code || typeof code !== 'string') {
    // code 缺失：参数类异常，复用 SYS_EXTERNAL_ERROR（见上注释理由）。
    throw BizError(CODE.SYS_EXTERNAL_ERROR, 'phone code required from getPhoneNumber callback');
  }
  const openapi = cloud && cloud.openapi;
  const phonenumber = openapi && openapi.phonenumber;
  const getPhoneNumber = phonenumber && phonenumber.getPhoneNumber;
  if (typeof getPhoneNumber !== 'function') {
    // 能力缺失兜底：云环境未开通「手机号快速验证组件」权限 → 优雅失败，不白屏。
    throw BizError(CODE.SYS_EXTERNAL_ERROR, 'phonenumber.getPhoneNumber not available (cloud capability missing)');
  }
  let phoneRes;
  try {
    phoneRes = await getPhoneNumber({ code });
  } catch (e) {
    // openapi 调用异常（code 失效 / 网络 / 权限）→ 统一 SYS_EXTERNAL_ERROR。
    throw BizError(CODE.SYS_EXTERNAL_ERROR, 'getPhoneNumber failed: ' + ((e && e.message) || 'unknown'));
  }
  const phone = phoneRes && phoneRes.phoneInfo && phoneRes.phoneInfo.phoneNumber;
  if (!phone || typeof phone !== 'string') {
    throw BizError(CODE.SYS_EXTERNAL_ERROR, 'getPhoneNumber returned no phoneNumber');
  }
  return phone;
}

/**
 * phone handler（云轨解密链路）：可注入 cloud 句柄以便单测 mock openapi。
 *
 * 流程：
 *   1. 从 event.code 取快速验证组件回调 code；
 *   2. 调 cloud.openapi.phonenumber.getPhoneNumber({code}) 由微信侧解密取真实手机号；
 *   3. 把解密出的真实手机号传给 verifyPhone 纯函数做白名单 + 更新。
 *
 * 红线：**彻底忽略 event.phone 明文**——即使前端传了也不用作可信手机号。
 * verifyPhone 的 phone 来源只能是解密结果。
 *
 * @param {object} params
 * @param {object} params.cloud 注入的 cloud 句柄
 * @param {object} params.event 云函数 event
 * @param {object} params.context 鉴权上下文（含 openid）
 * @returns {Promise<object>} verifyPhone 返回的 { verified, phone_masked }
 */
async function handlePhone({ cloud, event, context }) {
  const openid = context && context.openid;
  const db = cloud.database();
  // 解密取真实手机号（红线：不读 event.phone 明文）。
  const phone = await decryptPhone({ cloud, code: event && event.code });
  // event.phone 明文在此被彻底忽略——故意不引用它进入业务。
  // 超管手机号由环境变量注入（绝不入源码），verifyPhone 命中则授予 is_admin（首个超管冷启动）。
  return verifyPhone({ openid, phone, db, superAdminPhone: process.env.SUPER_ADMIN_PHONE || '' });
}

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

  // B3: 手机号验证（解密真实手机号 + 白名单校验 + 更新 User，不下发完整手机号）
  // 红线：手机号由 cloud.openapi.phonenumber.getPhoneNumber({code}) 解密得到，
  //       禁止信任前端明文 event.phone（否则任意前端可伪造白名单手机号）。
  phone: async (event, context) => handlePhone({ cloud, event, context })
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

// 导出 handlePhone / decryptPhone 供单测注入 mock cloud（不进 handler 表的运行路径）。
module.exports = exports;
module.exports.handlePhone = handlePhone;
module.exports.decryptPhone = decryptPhone;
