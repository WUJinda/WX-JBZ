// pages/login/login.js
// 登录授权 + 注册向导页（对齐 PRD F1）。
//
// 注册向导（新用户首次登录）：
//   1. 一键登录（auth.login 只查 OPENID 判新老用户，**不建号**）
//   2. 填昵称头像（chooseAvatar + nickname input，暂存前端）
//   3. 填写邀请码 → 一次性提交 auth.register（昵称+头像+邀请码，消费邀请码后建号）
//
// 老用户回归：auth.login 返回 join_status==='joined' → 直接 switchTab home；
//             registered=true（已建号）未 joined → 直接进 dept 选部门。
//
// 身份取 cloud.getWXContext().OPENID（云开发自动注入），不用 wx.login。
// 准入凭证为「一人一码邀请码」（手机号/白名单机制已移除）：用户输入邀请码，后端原子消费后建号。
// 昵称头像校验/上传复用 editCalc（与编辑资料页同源，与后端同口径）。
// 建号推迟到步骤 3 一次性提交（消费邀请码 → add User）。
//
// 注：邀请码输入变量命名 inviteInput，前端宽松校验（归一化后 6 位 Crockford），后端严格校验。

const { validateNickname, buildAvatarCloudPath } = require('../profile/edit/editCalc');

// 邀请码前端归一化（与后端 auth/inviteCode.normalizeInviteCode 同口径）：转大写 + 去 O/I/L/U 误读 + 去空格横线。
function normalizeInviteInput(raw) {
  if (raw == null) return '';
  return String(raw)
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
    .replace(/U/g, 'V');
}
// 前端宽松格式校验：归一化后 6 位 Crockford 字符（0-9 + 去 I/L/O/U 的 A-Z）。后端再严格校验。
const INVITE_RE = /^[0-9A-HJKMNP-TV-Z]{6}$/;

Page({
  data: {
    pageLabel: '登录授权',
    // 向导步骤态：'init'（登录）| 'profile'（昵称头像）| 'invite'（邀请码）
    authState: 'init',
    // 昵称头像（profile 步骤采集，提交时一并上传/带上传给 register）
    nickname: '',
    avatar: '',
    // 邀请码输入值（invite 步骤，手动填写）
    inviteInput: '',
    authDenied: false, // 登录查询失败
    profileDenied: false, // 昵称头像校验失败
    inviteDenied: false, // 邀请码校验/注册失败
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
        //   registered（已建号）未 joined → 直接选部门
        //   其余兜底       → 进 profile
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

  // 「下一步」：校验昵称后只暂存、进入邀请码步骤。
  // 不调 user.update —— 建号推迟到 register 一次性提交（昵称+头像+邀请码）。
  onSubmitProfile() {
    const self = this;
    if (this.data.submitting) return; // 防双击
    const nickname = (this.data.nickname || '').trim();
    if (!validateNickname(nickname)) {
      self.setData({ profileDenied: true });
      wx.showToast({ title: '请输入昵称（1-20字）', icon: 'none' });
      return;
    }
    self.setData({ authState: 'invite', nickname, profileDenied: false });
  },

  // ---- 步骤 3：填写邀请码 → auth.register 一次性建号（消费邀请码）----
  onInviteInput(e) {
    const v = (e && e.detail && e.detail.value) || '';
    this.setData({ inviteInput: v });
  },

  async onSubmitInviteCode() {
    const self = this;
    if (this.data.submitting) return; // 防双击
    const code = normalizeInviteInput(this.data.inviteInput);
    if (!INVITE_RE.test(code)) {
      self.setData({ inviteDenied: true });
      wx.showToast({ title: '邀请码格式不正确', icon: 'none' });
      return;
    }
    const app = getApp();
    const api = app && app.api;
    if (!api || typeof api.call !== 'function') {
      self.setData({ inviteDenied: true });
      wx.showToast({ title: '云能力未就绪', icon: 'none' });
      return;
    }
    self.setData({ submitting: true, inviteDenied: false });
    try {
      // 头像临时文件上传云存储拿 fileID（昵称头像与邀请码一起提交建号）。
      let avatar = this.data.avatar;
      if (this._pendingAvatarTempPath) {
        avatar = await this.uploadAvatar(this._pendingAvatarTempPath);
        if (!avatar) throw new Error('头像上传失败');
      }
      await api.call(
        'auth',
        { action: 'register', nickname: this.data.nickname, avatar, invite_code: code },
        { loading: '注册中' }
      );
      // register 成功 = User 已建号 = 已登录；同步 globalData.loggedIn。
      // 否则 activity 报名按钮（onCtaTap 以 globalData.loggedIn 判登录态）误判未登录，
      // 新用户点「报名参加」被跳回 login，而 login 又因 registered 跳回 dept → 死循环，
      // 永远调不到 user.join → join_status 恒 pending → sync 被 assertJoined 拦 + rankAggregate
      // 过滤 pending → 排行榜空（与 profile.js / home.js 调 user.profile 后置位同口径）。
      if (app && app.globalData) app.globalData.loggedIn = true;
      wx.showToast({ title: '注册成功', icon: 'success' });
      // 建号成功 → 选部门（dept 页 chooseDept 后进 activity 点报名）
      setTimeout(() => {
        wx.redirectTo({ url: '/pages/dept/dept' });
      }, 700);
    } catch (err) {
      self.setData({ inviteDenied: true });
      // 弹真实错误（邀请码已用/无效等），便于定位。
      wx.showModal({
        title: '注册失败',
        content: (err && (err.message || err.errMsg)) || '请重试',
        showCancel: false
      });
    } finally {
      self.setData({ submitting: false });
    }
  },

  // 邀请码失败后重新点击按钮（重置提示）
  onRetryInvite() {
    this.setData({ inviteDenied: false });
  }
});
