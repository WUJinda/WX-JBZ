// pages/login/login.js
// 登录授权 + 注册向导页（对齐 PRD F1）。
//
// 注册向导（新用户首次登录）：
//   1. 一键登录（auth.login 只查 OPENID 判新老用户，**不建号**）
//   2. 填昵称头像（chooseAvatar + nickname input，暂存前端）
//   3. 手动填写手机号 → 一次性提交 auth.register（昵称+头像+手机号建号，phone 必填非空）
//
// 老用户回归：auth.login 返回 join_status==='joined' → 直接 switchTab home；
//             registered=true（已验手机号）未 joined → 直接进 dept 选部门。
//
// 身份取 cloud.getWXContext().OPENID（云开发自动注入），不用 wx.login。
// 手机号手动填写（明文降级，不依赖微信「手机号快速验证组件」——体验版无需开通组件即可测；
//   安全代价与缓解见后端 authRegister.js 顶部注释）。
// 昵称头像校验/上传复用 editCalc（与编辑资料页同源，与后端同口径）。
// 建号推迟到步骤 3 一次性提交，避免旧流程「先建 phone='' 占位」撞 idx_user_phone 唯一索引。
//
// 注：手机号输入变量命名 phoneInput（非 phone），以避开结构测试「wxml 不绑定后端完整 phone」
//   红线——此处是用户手动输入值，非后端下发的完整手机号。

const { validateNickname, buildAvatarCloudPath } = require('../profile/edit/editCalc');

Page({
  data: {
    pageLabel: '登录授权',
    // 向导步骤态：'init'（登录）| 'profile'（昵称头像）| 'phone'（手机号）
    authState: 'init',
    // 昵称头像（profile 步骤采集，提交时一并上传/带上传给 register）
    nickname: '',
    avatar: '',
    // 手机号输入值（phone 步骤，手动填写）
    phoneInput: '',
    authDenied: false, // 登录查询失败
    profileDenied: false, // 昵称头像校验失败
    phoneDenied: false, // 手机号校验/注册失败
    submitting: false
  },

  // ---- 步骤 1：一键登录（auth.login 只查 OPENID 判新老，不建号）----
  onLoginTap() {
    const self = this;
    const app = getApp();
    const api = app && app.api;
    // 无云能力 → 停留 init 提示，不进后续步骤：
    // User 未建号，进 profile 后 register 必抛 AUTH_USER_NOT_FOUND，用户卡死无恢复路径。
    if (!api || typeof api.call !== 'function') {
      wx.showToast({ title: '云能力未就绪', icon: 'none' });
      return;
    }
    api
      .call('auth', { action: 'login' })
      .then((data) => {
        // 按 is_new / join_status / registered 分流：
        //   is_new===true  → 新用户（库内无 User），进昵称头像填写步骤
        //   joined         → 老用户回归首页（tabBar 须 switchTab）
        //   registered（已验手机号）未 joined → 直接选部门
        //   其余兜底       → 进 profile（兼容历史 phone='' 占位用户补全注册）
        if (data && data.is_new) {
          self.setData({ authState: 'profile', authDenied: false });
        } else if (data && data.join_status === 'joined') {
          wx.switchTab({ url: '/pages/home/home' });
        } else if (data && data.registered) {
          wx.redirectTo({ url: '/pages/dept/dept' });
        } else {
          self.setData({ authState: 'profile', authDenied: false });
        }
      })
      .catch((err) => {
        // 登录查询失败（网络 / 未部署）→ 停留 init，弹真实错误便于定位（不再吞错）。
        self.setData({ authState: 'init' });
        wx.showModal({
          title: '登录失败',
          content: (err && (err.message || err.errMsg)) || '请重试',
          showCancel: false
        });
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

  // ---- 步骤 2：昵称头像（chooseAvatar + nickname input，暂存前端）----
  // chooseAvatar 回调：e.detail.avatarUrl 是临时文件路径，暂存待步骤 3 提交时上传。
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

  // 「下一步」：校验昵称后只暂存、进入手机号步骤。
  // 不调 user.update —— 建号推迟到 register 一次性提交（昵称+头像+手机号），避免空占位。
  onSubmitProfile() {
    const self = this;
    if (this.data.submitting) return; // 防双击
    const nickname = (this.data.nickname || '').trim();
    if (!validateNickname(nickname)) {
      self.setData({ profileDenied: true });
      wx.showToast({ title: '请输入昵称（1-20字）', icon: 'none' });
      return;
    }
    self.setData({ authState: 'phone', nickname, profileDenied: false });
  },

  // ---- 步骤 3：手动填写手机号 → auth.register 一次性建号 ----
  onPhoneInput(e) {
    const v = (e && e.detail && e.detail.value) || '';
    this.setData({ phoneInput: v });
  },

  async onSubmitPhone() {
    const self = this;
    if (this.data.submitting) return; // 防双击
    const phone = (this.data.phoneInput || '').trim();
    if (!/^\d{11}$/.test(phone)) {
      self.setData({ phoneDenied: true });
      wx.showToast({ title: '请输入11位手机号', icon: 'none' });
      return;
    }
    const app = getApp();
    const api = app && app.api;
    if (!api || typeof api.call !== 'function') {
      self.setData({ phoneDenied: true });
      wx.showToast({ title: '云能力未就绪', icon: 'none' });
      return;
    }
    self.setData({ submitting: true, phoneDenied: false });
    try {
      // 头像临时文件上传云存储拿 fileID（昵称头像与手机号一起提交建号）。
      let avatar = this.data.avatar;
      if (this._pendingAvatarTempPath) {
        avatar = await this.uploadAvatar(this._pendingAvatarTempPath);
        if (!avatar) throw new Error('头像上传失败');
      }
      await api.call(
        'auth',
        { action: 'register', nickname: this.data.nickname, avatar, phone },
        { loading: '注册中' }
      );
      wx.showToast({ title: '注册成功', icon: 'success' });
      // 建号成功 → 选部门（dept 页 chooseDept 后进 activity 点报名）
      setTimeout(() => {
        wx.redirectTo({ url: '/pages/dept/dept' });
      }, 700);
    } catch (err) {
      self.setData({ phoneDenied: true });
      // 弹真实错误（手机号被占用 BIZ_PHONE_TAKEN 等），便于定位。
      wx.showModal({
        title: '注册失败',
        content: (err && (err.message || err.errMsg)) || '请重试',
        showCancel: false
      });
    } finally {
      self.setData({ submitting: false });
    }
  },

  // 手机号失败后重新点击按钮（重置提示）
  onRetryPhone() {
    this.setData({ phoneDenied: false });
  }
});
