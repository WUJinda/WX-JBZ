// pages/login/login.js
// 登录授权 + 注册向导页（对齐 PRD F1）。
//
// 注册向导（新用户首次登录）：
//   1. 一键登录（auth.login 用 OPENID 静默建号）
//   2. 填昵称头像（chooseAvatar + nickname input → user.update）
//   3. 验证手机号（getPhoneNumber → auth.phone 微信解密；白名单已放开，任意手机号可注册）
//   4. 选部门（跳转 dept 页 → user.chooseDept 写 dept_id，不报名 → 进 activity 点「报名参加」）
//
// 老用户回归：auth.login 返回 join_status==='joined' → 直接 switchTab home；
//             registered=true（已验手机号）未 joined → 直接进 dept 选部门。
//
// 身份取 cloud.getWXContext().OPENID（云开发自动注入），不用 wx.login。
// 拒绝授权时引导 openSetting 重新授权。授权状态机见 authFlow.js（纯函数单测）。
// 昵称头像校验/上传复用 editCalc（与编辑资料页同源，与后端同口径）。

const { validateNickname, buildAvatarCloudPath } = require('../profile/edit/editCalc');

Page({
  data: {
    pageLabel: '登录授权',
    // 向导步骤态：'init'（登录）| 'profile'（昵称头像）| 'phone'（手机号）
    authState: 'init',
    userInfo: null,
    // 昵称头像（profile 步骤）
    nickname: '',
    avatar: '',
    phoneMasked: '',
    authDenied: false, // 登录授权被拒绝
    phoneDenied: false, // getPhoneNumber 被拒绝 / 解密失败
    profileDenied: false, // 昵称头像校验/提交失败
    submitting: false
  },

  // ---- 步骤 1：一键登录（auth.login 用 OPENID 建号）----
  onLoginTap() {
    const self = this;
    const app = getApp();
    const api = app && app.api;
    // 无云能力（本地轨）→ 停留 init 提示，不进后续步骤：
    // User 未建号，进 profile 后 user.update 必抛 AUTH_USER_NOT_FOUND，用户卡死无恢复路径。
    if (!api || typeof api.call !== 'function') {
      wx.showToast({ title: '云能力未就绪', icon: 'none' });
      return;
    }
    // 一键登录：直接调 auth.login 用 OPENID 建号占位。
    // 不调 wx.getUserProfile —— 2022-10-25 新规已不返回真实昵称头像；
    // 真实昵称头像由步骤 2「头像昵称填写能力」(chooseAvatar) 采集。
    api
      .call('auth', { action: 'login', profile: {} })
      .then((data) => {
        // 按 join_status / registered 分流：
        //   joined    → 老用户回归首页（tabBar 须 switchTab）
        //   registered（已验手机号）未 joined → 直接选部门
        //   其余      → 新用户，进入昵称头像填写步骤
        if (data && data.join_status === 'joined') {
          wx.switchTab({ url: '/pages/home/home' });
        } else if (data && data.registered) {
          wx.redirectTo({ url: '/pages/dept/dept' });
        } else {
          self.setData({ authState: 'profile', authDenied: false });
        }
      })
      .catch(() => {
        // 登录建号失败（网络 / 未部署 / 并发注销）→ 停留 init 提示重试。
        // 不进 profile：User 未建号，后续 user.update 必抛 1002 卡死无恢复路径。
        self.setData({ authState: 'init' });
        wx.showToast({ title: '登录失败，请重试', icon: 'none' });
      });
  },

  // 拒绝后引导用户到 openSetting 重新授权
  onOpenSetting() {
    const self = this;
    wx.openSetting({
      success(res) {
        if (res && res.authSetting && res.authSetting['scope.userInfo']) {
          self.onLoginTap();
        }
      }
    });
  },

  // ---- 步骤 2：昵称头像（chooseAvatar + nickname input）----
  // chooseAvatar 回调：e.detail.avatarUrl 是临时文件路径，暂存待上传。
  onChooseAvatar(e) {
    if (!e || !e.detail || !e.detail.avatarUrl) return;
    this.setData({ avatar: e.detail.avatarUrl });
    this._pendingAvatarTempPath = e.detail.avatarUrl;
  },

  // nickname input 过程值实时同步：type=nickname 点击「使用微信昵称」时，微信异步填入 input
  // 内部 value 并经 bindinput 派发；须即时同步回 data.nickname，否则受控 value="{{nickname}}"
  // 会用旧值覆盖微信填充，导致「点了微信昵称却填不进去」。bindblur 仅作失焦兜底。
  onNicknameInput(e) {
    const v = (e && e.detail && e.detail.value) || '';
    this.setData({ nickname: v });
  },

  // nickname input 失焦兜底取最终值（个别基础库异步填充到 blur 才完整）。
  onNicknameBlur(e) {
    const v = (e && e.detail && e.detail.value) || '';
    if (v) this.setData({ nickname: v });
  },

  /** 上传头像临时文件到云存储，返回 fileID。 */
  uploadAvatar(filePath) {
    const cloudPath = buildAvatarCloudPath();
    return new Promise((resolve, reject) => {
      wx.cloud.uploadFile({
        cloudPath,
        filePath,
        success: (res) => resolve((res && res.fileID) || ''),
        fail: (err) => reject(err)
      });
    });
  },

  // 提交昵称头像 → user.update → 进入手机号步骤。
  async onSubmitProfile() {
    const self = this;
    if (this.data.submitting) return; // 防双击
    const nickname = (this.data.nickname || '').trim();
    if (!validateNickname(nickname)) {
      self.setData({ profileDenied: true });
      wx.showToast({ title: '请输入昵称（1-20字）', icon: 'none' });
      return;
    }
    const app = getApp();
    const api = app && app.api;
    if (!api || typeof api.call !== 'function') {
      // 无云能力 → 直接进手机号步骤兜底（本地轨不阻塞流程）
      self.setData({ authState: 'phone', profileDenied: false });
      return;
    }
    self.setData({ submitting: true, profileDenied: false });
    try {
      let avatar = this.data.avatar;
      if (this._pendingAvatarTempPath) {
        avatar = await this.uploadAvatar(this._pendingAvatarTempPath);
        if (!avatar) throw new Error('头像上传失败');
      }
      await api.call('user', { action: 'update', nickname, avatar }, { loading: '保存中' });
      self.setData({ authState: 'phone', nickname, avatar });
    } catch (err) {
      self.setData({ profileDenied: true });
      wx.showToast({ title: '提交失败，请重试', icon: 'none' });
    } finally {
      self.setData({ submitting: false });
    }
  },

  // ---- 步骤 3：手机号验证（getPhoneNumber → auth.phone 解密）----
  // open-type=getPhoneNumber 回调：e.detail.code 由「手机号快速验证组件」下发，
  // 传给云函数 auth.phone 走 cloud.openapi.phonenumber.getPhoneNumber({code}) 解密。
  // 红线：前端只传 code，绝不传明文 phone（明文可被伪造）。
  // 白名单已放开（PHONE_WHITELIST_REQUIRED=false）：任意解密成功的手机号均可注册。
  onGetPhoneNumber(e) {
    if (!e || !e.detail) return;
    // 兼容授权失败：errMsg 不含 ok，或 code 缺失（旧基础库 / 用户拒绝）。
    if ((e.detail.errMsg && e.detail.errMsg.indexOf('ok') === -1) || !e.detail.code) {
      this.setData({ phoneDenied: true });
      return;
    }
    const self = this;
    const code = e.detail.code;
    const app = getApp();
    const api = app && app.api;
    if (!api || typeof api.call !== 'function') {
      self.setData({ phoneDenied: true });
      return;
    }
    api
      .call('auth', { action: 'phone', code })
      .then((data) => {
        self.setData({
          phoneMasked: (data && data.phone_masked) || '',
          phoneDenied: false
        });
        wx.showToast({ title: '手机号已验证', icon: 'success' });
        // 验证成功 → 选部门（dept 页 chooseDept 后进 activity 点报名）
        setTimeout(() => {
          wx.redirectTo({ url: '/pages/dept/dept' });
        }, 700);
      })
      .catch(() => {
        // 解密失败 / 能力未开通 / 用户拒绝：停留在手机号步骤，提示重试
        self.setData({ phoneDenied: true });
      });
  },

  // 手机号拒绝后重新点击按钮（重置提示）
  onRetryPhone() {
    this.setData({ phoneDenied: false });
  }
});
