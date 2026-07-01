// pages/login/login.js
// 登录授权页（对齐 PRD F1，开发计划 B4）。
// 流程：一键登录（auth.login 用 OPENID 静默建号）→ 按 join_status 进主流程。
// MVP 阶段跳过手机号验证（快速验证组件收费 + 隐私协议审核周期长），
// 登录建号即视为注册；手机号/白名单代码（onGetPhoneNumber + auth.phone）保留，后续收紧员工身份时恢复。
// 身份取 cloud.getWXContext().OPENID（云开发自动注入），不用 wx.login。
// 拒绝授权时引导 openSetting 重新授权。授权状态机见 authFlow.js（纯函数单测）。

// api 实例从 getApp().api 取（与其余页一致，避免模块级 createApi 在本地轨发起真实 callFunction）。
// 实际调用处在函数内取 app.api 并守卫。

Page({
  data: {
    pageLabel: '登录授权',
    // 授权状态机：'init' | 'logging' | 'logged' | 'phoneVerifying' | 'phoneVerified'
    authState: 'init',
    userInfo: null,
    phoneMasked: '',
    inWhitelist: false,
    authDenied: false, // getUserProfile 被拒绝
    phoneDenied: false // getPhoneNumber 被拒绝
  },

  // ---- 登录授权（wx.login + getUserProfile）----
  onLoginTap() {
    const self = this;
    const app = getApp();
    const api = app && app.api;
    // 无云能力（本地轨占位）→ 仅切前端态兜底，不崩。
    if (!api || typeof api.call !== 'function') {
      self.setData({ authState: 'logged', userInfo: {}, authDenied: false });
      return;
    }
    // 一键登录：直接调 auth.login 用 OPENID 建号占位（registered=false）。
    // 不再调用 wx.getUserProfile —— 三个原因：
    //   1) errno 112：getUserProfile 须在「用户隐私保护指引」声明 scope，未声明则报错；
    //   2) 微信 2022-10-25 新规：getUserProfile 已不再返回真实昵称头像（仅默认值）；
    //   3) auth.login 取身份用 cloud.getWXContext().OPENID（云开发自动注入），本就不依赖它。
    // 真实昵称头像留待个人页「头像昵称填写能力」(chooseAvatar) 补，不阻塞建号。
    api
      .call('auth', { action: 'login', profile: {} })
      .then((data) => {
        // 登录建号成功：MVP 跳过手机号验证，按 join_status 直接进主流程。
        // 已报名 → 首页（tabBar，须 switchTab）；未报名 → 部门选择（报名）。
        if (data && data.join_status === 'joined') {
          wx.switchTab({ url: '/pages/home/home' });
        } else {
          wx.redirectTo({ url: '/pages/dept/dept' });
        }
      })
      .catch(() => {
        // 云函数失败：静默兜底切前端态（与各页加载失败兜底口径一致，不白屏）。
        self.setData({ authState: 'logged', userInfo: {}, authDenied: false });
      });
  },

  // 拒绝后引导用户到 openSetting 重新授权
  onOpenSetting() {
    const self = this;
    wx.openSetting({
      success(res) {
        if (res && res.authSetting && res.authSetting['scope.userInfo']) {
          // 重新走登录流程
          self.onLoginTap();
        }
      }
    });
  },

  // ---- 手机号验证 ----
  // open-type=getPhoneNumber 回调：e.detail.code 由「手机号快速验证组件」下发，
  // 传给云函数 auth.phone 走 cloud.openapi.phonenumber.getPhoneNumber({code}) 解密。
  // 红线：前端只传 code，绝不传明文 phone（明文可被伪造绕过白名单）。
  onGetPhoneNumber(e) {
    if (!e || !e.detail) return;
    // 兼容授权失败：errMsg 不含 ok，或 code 缺失（旧基础库 / 用户拒绝）。
    if ((e.detail.errMsg && e.detail.errMsg.indexOf('ok') === -1) || !e.detail.code) {
      this.setData({ phoneDenied: true });
      return;
    }
    const self = this;
    // 仅取 code（云轨解密）。不再读 e.detail.phone 明文。
    const code = e.detail.code;
    const app = getApp();
    const api = app && app.api;
    if (!api || typeof api.call !== 'function') {
      // 无云能力 → 停留在手机号验证态，提示重试（占位，不崩）。
      self.setData({ phoneDenied: true });
      return;
    }
    api
      .call('auth', { action: 'phone', code })
      .then((data) => {
        self.setData({
          authState: 'phoneVerified',
          phoneMasked: (data && data.phone_masked) || '',
          inWhitelist: !!(data && data.verified),
          phoneDenied: false
        });
      })
      .catch(() => {
        // 非白名单 / 校验失败：停留在手机号验证态，提示重试
        self.setData({ phoneDenied: true });
      });
  },

  // 手机号拒绝后重新点击按钮（重置提示）
  onRetryPhone() {
    this.setData({ phoneDenied: false });
  }
});
