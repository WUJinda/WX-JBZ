/**
 * 前端登录守卫（对齐 utils/request.js 错误码体系，错误码见 cloudfunctions/common/errors.js）。
 *
 * 两种使用场景：
 *
 * 1. 页面自动加载路径（onShow/onLoad 触发的 API catch）：
 *    用 isNotLoggedInError(err) 检测，不弹框、不跳转，仅设置游客态标志，
 *    让页面展示游客可见内容 + 登录引导。符合微信审核「先浏览体验再授权」要求。
 *
 * 2. 用户主动操作路径（点击按钮触发的 API catch）：
 *    用 handleNotLoggedIn(err)，弹 wx.showModal「请先登录」→ redirectTo 到 login。
 *
 * 设计要点：
 *   - 以云端 User 存在性为准（1002），不依赖易失同步的全局登录标志，避免误判；
 *   - 模块级 redirecting 锁：多个并发请求同时失败 1002 时只弹一次框（不刷屏）；modal 关闭后复位。
 */

/**
 * 静默检测是否为「未登录」错误（无副作用，不弹框、不跳转）。
 * 供页面自动加载路径使用——检测到未登录时设置游客态标志，展示游客可见内容。
 * @param {{code?: number}|null|undefined} err
 * @returns {boolean} true = 未登录（1002）
 */
function isNotLoggedInError(err) {
  return !!(err && err.code === 1002);
}

let redirecting = false;

/**
 * 检测并处理「未登录」错误。调用方在 catch 开头调用，返回 true 表示已拦截（应中断后续占位）。
 * @param {{code?: number}|null|undefined} err api.call reject 出的标准化错误（含 code）
 * @returns {boolean} true = 已作为未登录拦截；false = 非未登录错误，调用方自行处理
 */
function handleNotLoggedIn(err) {
  if (!err || err.code !== 1002) return false;
  if (redirecting) return true;
  redirecting = true;
  wx.showModal({
    title: '请先登录',
    content: '尚未登录，请先完成登录',
    showCancel: false,
    confirmText: '去登录',
    success: (res) => {
      if (res.confirm) wx.redirectTo({ url: '/pages/login/login' });
    },
    complete: () => {
      redirecting = false;
    }
  });
  return true;
}

module.exports = { isNotLoggedInError, handleNotLoggedIn };
