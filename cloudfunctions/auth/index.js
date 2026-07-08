/**
 * auth 云函数入口：登录鉴权（对齐技术架构 §4.1 / §6.1，开发计划 B2/B3）。
 * Action: login / register（微信 phone 解密路径已暂停：手机号→邀请码改造，见下方 decryptPhone/handlePhone 注释）
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
const { registerUser } = require('./authRegister');
// verifyPhone 暂留（当前无调用方）：微信 getPhoneNumber 解密路径已暂停（手机号→邀请码改造，UI 统一走手填）。
// 保留 require 便于恢复微信链路，且 structure-actions 测试断言 auth/index.js require('./authPhone')。
const { verifyPhone } = require('./authPhone');

// ▼▼ 微信「手机号快速验证组件」解密路径已暂停（手机号→邀请码改造，UI 统一走手填 auth.register / user.setPhone）。
// ▼▼ 下方 decryptPhone 整段注释保留，恢复时删除每行行首的 `// ` 即可。
// /**
//  * 解密手机号：调「手机号快速验证组件」openapi 取真实手机号（红线强制项）。
//  *
//  * 红线：禁止信任前端明文 event.phone（对齐 docs/开发计划.md §5）。
//  *   任何前端可伪造明文 phone 绕过白名单，故手机号必须由微信侧解密得到。
//  *
//  * @param {object} options
//  * @param {object} options.cloud 注入的 wx-server-sdk cloud 句柄（含 openapi）
//  * @param {string} options.code 前端 onGetPhoneNumber 回调的 e.detail.code
//  * @returns {Promise<string>} 解密得到的 11 位真实手机号
//  * @throws {BizError}
//  *   - SYS_EXTERNAL_ERROR(5002) 当 phonenumber 能力缺失（云轨未开通）或解密结果异常；
//  *   - SYS_EXTERNAL_ERROR(5002) 当 code 缺失（参数错误：此处复用系统外部错误，
//  *     因 code 来自微信回调，缺失等同外部链路异常；不引入新错误码以保持 §12 错误码表稳定）。
//  */
// async function decryptPhone({ cloud, code }) {
//   if (!code || typeof code !== 'string') {
//     // code 缺失：参数类异常，复用 SYS_EXTERNAL_ERROR（见上注释理由）。
//     throw BizError(CODE.SYS_EXTERNAL_ERROR, 'phone code required from getPhoneNumber callback');
//   }
//   const openapi = cloud && cloud.openapi;
//   const phonenumber = openapi && openapi.phonenumber;
//   const getPhoneNumber = phonenumber && phonenumber.getPhoneNumber;
//   if (typeof getPhoneNumber !== 'function') {
//     // 能力缺失兜底：云环境未开通「手机号快速验证组件」权限 → 优雅失败，不白屏。
//     throw BizError(CODE.SYS_EXTERNAL_ERROR, 'phonenumber.getPhoneNumber not available (cloud capability missing)');
//   }
//   let phoneRes;
//   try {
//     phoneRes = await getPhoneNumber({ code });
//   } catch (e) {
//     // openapi 调用异常（code 失效 / 网络 / 权限）→ 统一 SYS_EXTERNAL_ERROR。
//     throw BizError(CODE.SYS_EXTERNAL_ERROR, 'getPhoneNumber failed: ' + ((e && e.message) || 'unknown'));
//   }
//   const phone = phoneRes && phoneRes.phoneInfo && phoneRes.phoneInfo.phoneNumber;
//   if (!phone || typeof phone !== 'string') {
//     throw BizError(CODE.SYS_EXTERNAL_ERROR, 'getPhoneNumber returned no phoneNumber');
//   }
//   return phone;
// }

// ▼▼ handlePhone 同步暂停（依赖上方已注释的 decryptPhone）。恢复时删除每行行首的 `// `。
// /**
//  * phone handler（云轨解密链路）：可注入 cloud 句柄以便单测 mock openapi。
//  *
//  * 流程：
//  *   1. 从 event.code 取快速验证组件回调 code；
//  *   2. 调 cloud.openapi.phonenumber.getPhoneNumber({code}) 由微信侧解密取真实手机号；
//  *   3. 把解密出的真实手机号传给 verifyPhone 纯函数做白名单 + 更新。
//  *
//  * 红线：**彻底忽略 event.phone 明文**——即使前端传了也不用作可信手机号。
//  * verifyPhone 的 phone 来源只能是解密结果。
//  *
//  * @param {object} params
//  * @param {object} params.cloud 注入的 cloud 句柄
//  * @param {object} params.event 云函数 event
//  * @param {object} params.context 鉴权上下文（含 openid）
//  * @returns {Promise<object>} verifyPhone 返回的 { verified, phone_masked }
//  */
// async function handlePhone({ cloud, event, context }) {
//   const openid = context && context.openid;
//   const db = cloud.database();
//   // 解密取真实手机号（红线：不读 event.phone 明文）。
//   const phone = await decryptPhone({ cloud, code: event && event.code });
//   // event.phone 明文在此被彻底忽略——故意不引用它进入业务。
//   // 超管手机号由环境变量注入（绝不入源码），verifyPhone 命中则授予 is_admin（首个超管冷启动）。
//   // 注：SUPER_ADMIN_PHONE 环境变量随本路径一并暂停；超管冷启动改走云控制台手改 User.is_admin=true。
//   return verifyPhone({ openid, phone, db, superAdminPhone: process.env.SUPER_ADMIN_PHONE || '' });
// }

/**
 * register handler（云轨建号链路）：可注入 cloud 句柄以便单测 mock database。
 *
 * 流程：context 取 openid、event 取 nickname/avatar/phone，cloud.database() 取 db，
 *   一次性传给 registerUser 纯函数建号（phone 必填非空、upsert、不授 is_admin）。
 *
 * ⚠️ 胶水层职责：**必须把 db 传进 registerUser**（纯函数校验 db 存在，漏传 → SYS_DB_ERROR
 *   'db with collection() is required'）。历史上漏传过 db（体验版报该错），纯函数单测因直接
 *   注入 db 绕过此处而抓不到漏传，故 authRegisterHandler.test 直接注入 mock cloud 验证建号成功。
 *
 * @param {object} params
 * @param {object} params.cloud 注入的 cloud 句柄（database()）
 * @param {object} params.event 云函数 event（nickname/avatar/phone）
 * @param {object} params.context 鉴权上下文（含 openid）
 * @returns {Promise<object>} registerUser 返回的 { registered, is_new, phone_masked, join_status }
 */
async function handleRegister({ cloud, event, context }) {
  const db = cloud.database();
  return registerUser({
    db,
    openid: context && context.openid,
    nickname: event && event.nickname,
    avatar: event && event.avatar,
    phone: event && event.phone,
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

  // 注册建号（一次性提交：昵称 + 头像 + 手机号，phone 必填非空，upsert）。
  // 取 openid（authMiddleware），不 requireUser（User 尚不存在）。
  // 手机号手动填写（明文降级，安全代价见 authRegister.js 顶部注释）；不授 is_admin。
  register: async (event, context) => handleRegister({ cloud, event, context }),

  // B3 手机号验证（微信解密路径）已暂停：手机号→邀请码改造，UI 统一走手填（auth.register / user.setPhone）。
  // 原 phone handler（cloud.openapi.phonenumber.getPhoneNumber 解密 + 白名单 + 更新 User）注释保留如下：
  // // B3: 手机号验证（微信解密路径：cloud.openapi.phonenumber.getPhoneNumber({code}) 解密 + 白名单 + 更新 User）。
  // // 红线：手机号由微信侧解密，禁止信任前端明文 event.phone。
  // // 边界：verifyPhone 要求 User 已存在，故本 action 仅适用「老用户改绑手机号」；
  // //       新用户注册建号走 register。未来开通微信组件可让本路径支持建号 upsert + 授超管。
  // phone: async (event, context) => handlePhone({ cloud, event, context })
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
// 微信解密路径暂停（手机号→邀请码改造）：handlePhone / decryptPhone 已注释，导出同步注释；
// 对应测试 authPhoneHandler.test.js 整体 describe.skip。恢复时取消注释即可。
module.exports = exports;
// module.exports.handlePhone = handlePhone; // 已暂停
module.exports.handleRegister = handleRegister;
// module.exports.decryptPhone = decryptPhone; // 已暂停
