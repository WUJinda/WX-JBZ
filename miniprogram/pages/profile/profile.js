// pages/profile/profile.js
// 个人资料页（对齐 PRD F1，开发计划 B5）。
// 展示脱敏手机号 / 部门 / 累计步数（步数为占位，真实聚合留后续阶段）。
// 红线：本页只展示后端下发的脱敏字段，绝不展示完整手机号 / openid。

// api 实例从 getApp().api 取（与其余页一致，避免模块级 createApi 在本地轨发起真实 callFunction）。
// 实际调用处在函数内取 app.api 并守卫。

const { handleNotLoggedIn } = require('../../utils/authGuard');

Page({
  data: {
    pageLabel: '个人资料',
    nickname: '',
    avatar: '',
    phoneMasked: '',
    deptName: '',
    joinStatus: 'pending',
    totalSteps: 0,
    loading: true,
    errorMsg: '',
    // 后台入口（仅 is_admin===true 的用户可见，F8）
    adminVisible: false
  },

  onShow() {
    this.loadProfile();
  },

  loadProfile() {
    const self = this;
    self.setData({ loading: true, errorMsg: '' });
    const app = getApp();
    const api = app && app.api;
    if (!api || typeof api.call !== 'function') {
      // 无云能力 → 占位空态，不崩（adminVisible 保持 false）。
      self.setData({ loading: false, errorMsg: '云能力未就绪', adminVisible: false });
      return;
    }
    api
      .call('user', { action: 'profile' }, { silent: true })
      .then((data) => {
        const isAdmin = !!(data && data.is_admin === true);
        // P1-7：写入全局上下文，供 admin 页 enterAdminGuard 守卫读取。
        if (app && app.globalData) {
          app.globalData.isAdmin = isAdmin;
          app.globalData.loggedIn = true; // profile 成功 = User 存在 = 已登录
        }
        self.setData({
          loading: false,
          nickname: (data && data.nickname) || '',
          avatar: (data && data.avatar) || '',
          phoneMasked: (data && data.phone_masked) || '',
          deptName: (data && data.dept_name) || '',
          joinStatus: (data && data.join_status) || 'pending',
          totalSteps: (data && data.total_steps) || 0,
          // 后台入口仅管理员可见：is_admin===true 才显示（本地轨失败保持 false）
          adminVisible: isAdmin
        });
      })
      .catch((err) => {
        // 1002 AUTH_USER_NOT_FOUND（未登录建号）→ 统一守卫弹框引导去登录页（utils/authGuard）。
        if (handleNotLoggedIn(err)) return;
        // 本地轨失败 → adminVisible 保持 false（入口不显示，符合「仅管理员可见」）
        self.setData({ loading: false, errorMsg: (err && err.message) || '加载失败', adminVisible: false });
      });
  },

  onPullDownRefresh() {
    this.loadProfile();
    // P2：结束下拉动画（loadProfile 异步，数据稍后 setData，动画先停避免卡死）。
    wx.stopPullDownRefresh();
  },

  /** 进入后台管理（admin 页非 tabBar，用 navigateTo）。 */
  onAdminEntry() {
    if (typeof wx === 'undefined' || !wx.navigateTo) return;
    wx.navigateTo({ url: '/pages/admin/dashboard/dashboard' });
  }
});
