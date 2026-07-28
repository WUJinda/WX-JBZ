// pages/profile/profile.js
// 个人资料页（对齐 PRD F1，开发计划 B5）。
// 展示邀请码 / 部门 / 累计步数 + 账号管理入口（编辑资料 / 登出 / 注销）。
// 准入凭证为「一人一码邀请码」（注册时一次性消费，无"更改"入口）；本页只读展示 invite_code。
// 红线：本页只展示后端下发的字段，绝不展示完整 openid。

const { handleNotLoggedIn, isNotLoggedInError } = require('../../utils/authGuard');

Page({
  data: {
    pageLabel: '个人资料',
    nickname: '',
    avatar: '',
    inviteCode: '',
    deptName: '',
    joinStatus: 'pending',
    totalSteps: 0,
    loading: true,
    errorMsg: '',
    // 后台入口（仅 is_admin===true 的用户可见，F8）
    adminVisible: false,
    // 游客态标志：未登录用户展示登录引导卡片，不弹框跳转。
    isLoggedIn: true
  },

  onShow() {
    // 每次 onShow 重置游客态：profile 成功 isLoggedIn=true；1002 时切为游客态。
    this.setData({ isLoggedIn: true });
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
          inviteCode: (data && data.invite_code) || '',
          deptName: (data && data.dept_name) || '',
          joinStatus: (data && data.join_status) || 'pending',
          totalSteps: (data && data.total_steps) || 0,
          // 后台入口仅管理员可见：is_admin===true 才显示（本地轨失败保持 false）
          adminVisible: isAdmin
        });
      })
      .catch((err) => {
        // 1002 未登录（未注册建号）→ 设游客态（不弹框不跳转），页面展示登录引导卡片。
        if (isNotLoggedInError(err)) {
          self.setData({ isLoggedIn: false, loading: false, errorMsg: '' });
          return;
        }
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
  },

  /** 编辑资料（昵称 + 头像），navigateTo 到 edit 子页。 */
  onEditProfile() {
    if (typeof wx === 'undefined' || !wx.navigateTo) return;
    wx.navigateTo({ url: '/pages/profile/edit/edit' });
  },

  /** 游客态「登录查看」入口：引导去登录页（用户主动点击）。 */
  onGuestLoginTap() {
    if (typeof wx === 'undefined' || !wx.navigateTo) return;
    wx.navigateTo({ url: '/pages/login/login' });
  },

  /** 登出：清本地状态 + 重置 globalData + 回登录页（OPENID 固定，无真正登出）。 */
  onLogout() {
    const self = this;
    wx.showModal({
      title: '登出',
      content: '确定要登出当前账号吗？',
      success: (res) => {
        if (res.confirm) self.clearLocalAndRelaunch();
      }
    });
  },

  /** 注销账号：删本人 User + StepRecord（不可恢复），二次确认。 */
  onCancelAccount() {
    const self = this;
    if (self._cancelling) return; // 防双击
    wx.showModal({
      title: '注销账号',
      content: '将永久删除你的账号和全部步数记录，且不可恢复。确定注销？',
      confirmText: '确认注销',
      confirmColor: '#e64c45',
      success: (res) => {
        if (!res.confirm) return;
        self._cancelling = true;
        const app = getApp();
        const api = app && app.api;
        if (!api || typeof api.call !== 'function') {
          self._cancelling = false;
          wx.showToast({ title: '云能力未就绪', icon: 'none' });
          return;
        }
        api
          .call('user', { action: 'cancel' }, { loading: '注销中' })
          .then(() => {
            wx.showToast({ title: '已注销', icon: 'success' });
            // 锁延迟到跳转前才释放：700ms toast 窗口内仍防双击（reLaunch 后页面销毁，锁无意义）。
            setTimeout(() => {
              self._cancelling = false;
              self.clearLocalAndRelaunch();
            }, 700);
          })
          .catch((err) => {
            self._cancelling = false;
            if (handleNotLoggedIn(err)) return;
            wx.showToast({ title: '注销失败，请重试', icon: 'none' });
          });
      }
    });
  },

  /** 登出/注销共用：清本地缓存 + 重置全局上下文 + reLaunch 到登录页。 */
  clearLocalAndRelaunch() {
    try {
      wx.clearStorageSync();
    } catch (e) {
      // 清缓存失败不阻塞跳转
    }
    const app = getApp();
    if (app && app.globalData) {
      app.globalData.userInfo = null;
      app.globalData.isAdmin = null; // 注销回到「未知」态（非布尔），下次 loadAdminFlag 重新查 profile（E2）
      app.globalData.loggedIn = false;
      app.globalData.currentActivity = { activity_id: '', name: '', status: '' };
    }
    wx.reLaunch({ url: '/pages/login/login' });
  }
});
