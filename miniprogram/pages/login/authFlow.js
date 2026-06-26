/**
 * 授权状态机纯函数（对齐开发计划 B4：授权状态机单测）。
 *
 * 把页面里的状态流转逻辑抽出成纯函数，便于在 Node 下单测，
 * 不耦合 wx 运行时。页面 Page() 内部按这些转移驱动 data.authState。
 *
 * 状态：
 *   init            初始（未登录）
 *   logging         登录中（wx.login + getUserProfile 进行中）
 *   logged          已登录，待手机号验证
 *   phoneVerifying  手机号验证中
 *   phoneVerified   手机号验证通过（可前往部门选择）
 *
 * 外部事件：
 *   LOGIN_START     开始登录
 *   LOGIN_OK        wx.login + getUserProfile 成功（携带 userInfo）
 *   LOGIN_DENIED    getUserProfile 被拒绝
 *   SETTING_GRANTED openSetting 后用户授予了 scope.userInfo
 *   PHONE_START     开始手机号验证
 *   PHONE_OK        手机号验证通过（携带 phoneMasked）
 *   PHONE_DENIED    getPhoneNumber 被拒绝 / 非白名单
 */

const STATES = {
  INIT: 'init',
  LOGGING: 'logging',
  LOGGED: 'logged',
  PHONE_VERIFYING: 'phoneVerifying',
  PHONE_VERIFIED: 'phoneVerified'
};

/**
 * 状态转移：返回新的状态对象（含 authState + 相关派生字段）。
 * 纯函数：不修改入参。
 *
 * @param {object} state 当前状态快照 { authState, authDenied, phoneDenied, ... }
 * @param {{type:string, [payload]:object}} event
 * @returns {object} 新状态
 */
function transition(state, event) {
  const s = Object.assign({}, state || {});
  const e = event || {};
  const cur = s.authState || STATES.INIT;

  switch (e.type) {
    case 'LOGIN_START':
      s.authState = STATES.LOGGING;
      s.authDenied = false;
      break;
    case 'LOGIN_OK':
      s.authState = STATES.LOGGED;
      s.authDenied = false;
      if (e.payload) s.userInfo = e.payload.userInfo || null;
      break;
    case 'LOGIN_DENIED':
      // 登录失败回到 init 并标记拒绝
      s.authState = STATES.INIT;
      s.authDenied = true;
      break;
    case 'SETTING_GRANTED':
      // openSetting 授予后重新开始登录流程
      s.authDenied = false;
      s.authState = STATES.LOGGING;
      break;
    case 'PHONE_START':
      if (cur === STATES.LOGGED || cur === STATES.PHONE_VERIFYING) {
        s.authState = STATES.PHONE_VERIFYING;
        s.phoneDenied = false;
      }
      break;
    case 'PHONE_OK':
      s.authState = STATES.PHONE_VERIFIED;
      s.phoneDenied = false;
      s.inWhitelist = true;
      if (e.payload) s.phoneMasked = e.payload.phoneMasked || '';
      break;
    case 'PHONE_DENIED':
      // 验证失败回到 logged（可重试）
      s.authState = STATES.LOGGED;
      s.phoneDenied = true;
      break;
    default:
      break;
  }
  return s;
}

module.exports = { STATES, transition };
