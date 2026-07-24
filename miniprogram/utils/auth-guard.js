/**
 * 路由守卫工具骨架（纯函数，可单测）。
 *
 * 根据登录 / 报名状态决定目标页。本轮只提供判定函数，
 * 具体页面跳转由调用方执行（避免在小程序运行时之外的耦合）。
 *
 * 状态字段（由调用方从本地缓存或登录结果传入）：
 *   - loggedIn: 是否已登录（拿到 openid 且 User 已存在）
 *   - registered: 是否已完成邀请码准入建号（去手机号后与 loggedIn 同口径，保留以兼容守卫语义）
 *   - joined: 是否已报名（join_status === 'joined'）
 *   - isAdmin: 是否管理员（决定能否进入 admin/*）
 *
 * 目标页优先级：登录 > 已注册 > 部门选择(报名) > 业务页。
 */

const PAGES = {
  LOGIN: '/pages/login/login',
  DEPT: '/pages/dept/dept',
  HOME: '/pages/home/home',
  PROFILE: '/pages/profile/profile',
  RANK: '/pages/rank/rank',
  ACTIVITY: '/pages/activity/activity',
  ADMIN_DASHBOARD: '/pages/admin/dashboard/dashboard'
};

/**
 * 根据状态决定下一个该去的页面。
 * @param {object} state
 * @param {boolean} [state.loggedIn]
 * @param {boolean} [state.registered]
 * @param {boolean} [state.joined]
 * @returns {string} 目标页路径
 */
function nextRoute(state) {
  const s = state || {};
  if (!s.loggedIn) return PAGES.LOGIN;
  if (!s.registered) return PAGES.LOGIN;
  if (!s.joined) return PAGES.DEPT;
  return PAGES.HOME;
}

/**
 * 判断某 admin 路径是否被允许访问。
 * @param {string} path
 * @param {object} state
 * @param {boolean} [state.loggedIn]
 * @param {boolean} [state.isAdmin]
 * @returns {boolean}
 */
function canEnterAdmin(path, state) {
  const s = state || {};
  if (!s.loggedIn) return false;
  if (!s.isAdmin) return false;
  return typeof path === 'string' && path.indexOf('/pages/admin/') === 0;
}

/**
 * 运行时 admin 路由守卫（P1-7）：在 admin 页 onShow/onLoad 顶部调用。
 * 从 globalData 读 {loggedIn, isAdmin}（profile 下发 is_admin 后写入），非管理员 redirectTo login。
 * 取代旧 canEnterAdmin「定义了但无页面接入」的死代码状态。
 * @param {string} pagePath 当前页路径（如 '/pages/admin/users/users'）
 * @returns {boolean} 是否允许进入（false 时已触发 redirectTo login）
 */
function enterAdminGuard(pagePath) {
  const app = typeof getApp === 'function' ? getApp() : null;
  const gd = (app && app.globalData) || {};
  const allowed = canEnterAdmin(pagePath, { loggedIn: !!gd.loggedIn, isAdmin: !!gd.isAdmin });
  if (!allowed && typeof wx !== 'undefined' && wx.redirectTo) {
    wx.redirectTo({ url: PAGES.LOGIN });
  }
  return allowed;
}

module.exports = { PAGES, nextRoute, canEnterAdmin, enterAdminGuard };
