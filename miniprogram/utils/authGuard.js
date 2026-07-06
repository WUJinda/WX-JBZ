/**
 * 前端登录守卫（对齐 utils/request.js 错误码体系，错误码见 cloudfunctions/common/errors.js）。
 *
 * 各需登录页（profile/home/rank）在 API catch 里调 handleNotLoggedIn(err)：
 *   - err.code === 1002（AUTH_USER_NOT_FOUND：openid 无 User 文档 = 未登录建号）
 *     → 弹 wx.showModal「请先登录」→ redirectTo 到 /pages/login/login；返回 true。
 *   - 其余错误 → 不处理，返回 false（调用方走自己的占位 / 错误逻辑）。
 *
 * 设计要点：
 *   - 以云端 User 存在性为准（1002），不依赖易失同步的全局登录标志，避免误判；
 *   - 模块级 redirecting 锁：home/rank 一次 onShow 会并发多个请求，未登录时可能同时
 *     失败 1002，该锁保证只弹一次框（不刷屏）；modal 关闭后复位。
 */

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

module.exports = { handleNotLoggedIn };
