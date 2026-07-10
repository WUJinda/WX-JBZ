// pages/profile/profile.js
// 个人资料页（对齐 PRD F1，开发计划 B5）。
// 展示脱敏手机号 / 部门 / 累计步数 + 账号管理入口（编辑资料 / 登出 / 注销）。
// 邀请码（底层仍为 phone 字段，手机号→邀请码 UI 改造）：统一走手填 user.setPhone（查重 + 写入）。
// 微信 getPhoneNumber 授权路径已暂停（onGetPhoneNumber 注释保留，恢复时去行首 //）。
// 红线：本页只展示后端下发的脱敏字段，绝不展示完整手机号 / openid；明文 phone 不入参。

const { handleNotLoggedIn } = require('../../utils/authGuard');

// 前端错误码镜像：前端无法 require 云函数 common/errors.js，按需内联（对齐 errors.js）。
const ERR_PHONE_TAKEN = 2007; // = BIZ_PHONE_TAKEN：手机号已被其他账号占用

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

  // ▼▼ onGetPhoneNumber（微信 getPhoneNumber 授权路径）已暂停：手机号→邀请码改造，统一走 onManualPhone 手填。
  // ▼▼ 整段注释保留，恢复时删除每行行首的 `// `。后端 auth.phone handler 已同步注释。
  // /**
  //  * 微信授权验证/更新手机号：复用 auth.phone（与注册流程同源）。
  //  * open-type=getPhoneNumber 回调：e.detail.code 由「手机号快速验证组件」下发，
  //  * 传给 auth.phone 走 cloud.openapi.phonenumber.getPhoneNumber({code}) 解密。
  //  * 红线：前端只传 code，绝不传明文 phone（明文可被伪造）；后端按 openid 覆盖写。
  //  * 适用：未验证（设号）+ 已验证（换号）；新号命中超管号时后端会顺带授 is_admin。
  //  */
  // onGetPhoneNumber(e) {
  //   // 诊断：点 button 若「没反应」，先看此 log 是否打印——
  //   //   不打印  → 回调根本没触发：「手机号快速验证组件」未开通，或开发者工具模拟器不支持（需开通+真机）；
  //   //   打印但 errMsg 非 ok → 授权被拒 / 组件无权限（errMsg 会写明原因）。
  //   console.log('[profile] getPhoneNumber callback', e && e.detail);
  //   if (!e || !e.detail) return;
  //   // 兼容授权失败/用户拒绝/组件未授权：errMsg 不含 ok，或 code 缺失（旧基础库 / 用户拒绝）。
  //   // 给反馈而非静默，避免「点了没反应」的错觉。
  //   if ((e.detail.errMsg && e.detail.errMsg.indexOf('ok') === -1) || !e.detail.code) {
  //     wx.showToast({ title: '未获取到手机号授权', icon: 'none' });
  //     return;
  //   }
  //   const self = this;
  //   if (self._phoneChanging) return; // 防双击（授权回调→结果返回期间）
  //   const code = e.detail.code;
  //   const app = getApp();
  //   const api = app && app.api;
  //   if (!api || typeof api.call !== 'function') {
  //     wx.showToast({ title: '云能力未就绪', icon: 'none' });
  //     return;
  //   }
  //   self._phoneChanging = true;
  //   api
  //     .call('auth', { action: 'phone', code }, { loading: '验证中' })
  //     .then((data) => {
  //       self._phoneChanging = false;
  //       const patch = { phoneMasked: (data && data.phone_masked) || '' };
  //       // 边缘情况：新手机号命中 SUPER_ADMIN_PHONE → 后端授予 is_admin，同步刷新后台入口可见性。
  //       if (data && data.is_admin) {
  //         patch.adminVisible = true;
  //         if (app && app.globalData) app.globalData.isAdmin = true;
  //       }
  //       self.setData(patch);
  //       wx.showToast({ title: '手机号已更新', icon: 'success' });
  //     })
  //     .catch((err) => {
  //       self._phoneChanging = false;
  //       if (handleNotLoggedIn(err)) return;
  //       // 解密失败 / 能力未开通 / 新号撞唯一索引（被他人占用）→ 统一友好提示，不透传后端英文。
  //       wx.showToast({ title: '手机号验证失败，请重试', icon: 'none' });
  //     });
  // },

  /**
   * 填写/修改邀请码（手机号→邀请码改造后为唯一入口；底层仍为 phone 字段，手填 user.setPhone）。
   * wx.showModal editable 单输入框 → 前端归一化 + 11 位校验 → user.setPhone（查重 + 写入）。
   * ⚠️ 明文 phone 经云函数校验；安全代价见 userPhone.js 顶部注释。
   */
  onManualPhone() {
    const self = this;
    if (self._phoneChanging) return; // 防双击
    wx.showModal({
      title: '填写邀请码',
      editable: true,
      placeholderText: '请输入邀请码',
      success: (res) => {
        if (!res.confirm) return; // 用户取消
        // 前端归一化（与后端 normalizePhoneInput 同口径）+ 11 位校验，减少无谓请求。
        const raw = (res.content || '').trim();
        const digits = raw.replace(/\D+/g, '').replace(/^86(?=\d{11})/, '');
        if (!/^\d{11}$/.test(digits)) {
          wx.showToast({ title: '邀请码格式不正确', icon: 'none' });
          return;
        }
        const app = getApp();
        const api = app && app.api;
        if (!api || typeof api.call !== 'function') {
          wx.showToast({ title: '云能力未就绪', icon: 'none' });
          return;
        }
        self._phoneChanging = true;
        api
          .call('user', { action: 'setPhone', phone: digits }, { loading: '验证中', silent: true })
          .then((data) => {
            self._phoneChanging = false;
            self.setData({ phoneMasked: (data && data.phone_masked) || '' });
            wx.showToast({ title: '邀请码已更新', icon: 'success' });
          })
          .catch((err) => {
            self._phoneChanging = false;
            if (handleNotLoggedIn(err)) return;
            // 撞号(BIZ_PHONE_TAKEN) 单独提示；其余（DB故障等）通用兜底。silent 已挡 request.js 自动弹。
            const msg =
              err && err.code === ERR_PHONE_TAKEN
                ? '该邀请码已被其他账号使用'
                : '更新失败，请重试';
            wx.showToast({ title: msg, icon: 'none' });
          });
      }
    });
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
