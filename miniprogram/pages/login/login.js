// pages/login/login.js
// 登录授权页（对齐 PRD F1，开发计划 B4）。
// 流程：wx.login + getUserProfile 授权 → 手机号验证（open-type=getPhoneNumber）。
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
    // wx.login 取 code（真实 code2Session 在云函数 auth.login 内由 OPENID 完成，
    // 本地轨 OPENID 由 wx.cloud 自动携带）
    wx.login({
      success() {
        wx.getUserProfile({
          desc: '用于完善健步走活动资料',
          success(res) {
            self.setData({
              authState: 'logged',
              userInfo: res.userInfo || null,
              authDenied: false
            });
          },
          fail() {
            // 用户拒绝授权 getUserProfile
            self.setData({ authDenied: true });
          }
        });
      },
      fail() {
        self.setData({ authDenied: true });
      }
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
