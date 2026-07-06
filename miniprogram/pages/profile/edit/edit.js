// pages/profile/edit/edit.js
// 编辑资料页：修改昵称 + 头像（对齐 PRD F1 个人资料修改）。
//
// 用微信「头像昵称填写能力」：
//   - 头像：<button open-type="chooseAvatar" bindchooseavatar> → e.detail.avatarUrl 为临时文件（wxfile://），
//           需 wx.cloud.uploadFile 上传云存储得 fileID 才能持久化（临时路径重启失效）。
//   - 昵称：<input type="nickname" bindblur> 取最终值（bindinput 过程值常为空，微信异步填充）。
//
// 提交：调 user.update（更新 User.nickname/avatar）。校验复用 editCalc.validateNickname（与后端同口径）。
// 红线：本页只展示/提交昵称头像，不涉及手机号 / openid（手机号变更走注销重注册）。
//
// api 实例从 getApp().api 取（与其余页一致）。本地轨 getApp().api 不存在 → 提示并兜底，不崩。

const { validateNickname, buildAvatarCloudPath } = require('./editCalc');
const { handleNotLoggedIn } = require('../../../utils/authGuard');

Page({
  data: {
    nickname: '',
    avatar: '', // 当前展示头像（fileID/URL/临时路径）
    submitting: false,
    loading: true,
    errorMsg: ''
  },

  onLoad() {
    this.loadProfile();
  },

  /** 拉当前资料回填。 */
  loadProfile() {
    const self = this;
    const app = getApp();
    const api = app && app.api;
    if (!api || typeof api.call !== 'function') {
      self.setData({ loading: false, errorMsg: '云能力未就绪' });
      return;
    }
    self.setData({ loading: true, errorMsg: '' });
    api
      .call('user', { action: 'profile' }, { silent: true })
      .then((data) => {
        self.setData({
          loading: false,
          nickname: (data && data.nickname) || '',
          avatar: (data && data.avatar) || ''
        });
      })
      .catch((err) => {
        if (handleNotLoggedIn(err)) {
          self.setData({ loading: false });
          return;
        }
        self.setData({ loading: false, errorMsg: (err && err.message) || '加载失败' });
      });
  },

  /** chooseAvatar 回调：e.detail.avatarUrl 是临时文件路径，暂存待上传。 */
  onChooseAvatar(e) {
    if (!e || !e.detail || !e.detail.avatarUrl) return;
    this.setData({ avatar: e.detail.avatarUrl });
    this._pendingAvatarTempPath = e.detail.avatarUrl;
  },

  /** nickname input 失焦取最终值（type=nickname 微信异步填充，须 bindblur）。 */
  onNicknameBlur(e) {
    const v = (e && e.detail && e.detail.value) || '';
    this.setData({ nickname: v });
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

  /** 保存：校验 → 上传新头像（若有）→ user.update → 返回。 */
  async onSave() {
    const self = this;
    if (this.data.submitting) return; // 防双击
    const nickname = (this.data.nickname || '').trim();
    if (!validateNickname(nickname)) {
      self.setData({ errorMsg: '请输入有效昵称（1-20字）' });
      return;
    }

    const app = getApp();
    const api = app && app.api;
    if (!api || typeof api.call !== 'function') {
      self.setData({ errorMsg: '云能力未就绪' });
      return;
    }

    self.setData({ submitting: true, errorMsg: '' });
    try {
      // 若用户选了新头像（暂存临时路径）→ 上传云存储得 fileID；否则沿用现有 avatar
      let avatar = this.data.avatar;
      if (this._pendingAvatarTempPath) {
        avatar = await this.uploadAvatar(this._pendingAvatarTempPath);
        if (!avatar) throw new Error('头像上传失败');
      }
      await api.call('user', { action: 'update', nickname, avatar }, { loading: '保存中' });
      wx.showToast({ title: '已保存', icon: 'success' });
      // 稍延返回，让 toast 可见
      setTimeout(() => wx.navigateBack(), 700);
    } catch (err) {
      if (handleNotLoggedIn(err)) return;
      self.setData({ errorMsg: (err && err.message) || '保存失败，请重试' });
    } finally {
      self.setData({ submitting: false });
    }
  }
});
