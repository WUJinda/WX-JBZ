// pages/profile/edit/edit.js
// 编辑资料页：修改昵称 + 头像（对齐 PRD F1 个人资料修改）。
//
// 用微信「头像昵称填写能力」：
//   - 头像：<button open-type="chooseAvatar" bindchooseavatar> → e.detail.avatarUrl 为临时文件（wxfile://），
//           需 wx.cloud.uploadFile 上传云存储得 fileID 才能持久化（临时路径重启失效）。
//   - 昵称：<input type="nickname"> 必须绑 bindinput 实时同步过程值——点击「使用微信昵称」时
//           微信异步填入内部 value 并经 bindinput 派发；若只绑 bindblur，受控 value="{{nickname}}"
//           会用旧 data 值覆盖微信填充，表现为「昵称填不进去」。bindblur 仅作失焦兜底。
//
// 提交：调 user.update（更新 User.nickname/avatar）。校验复用 editCalc.validateNickname（与后端同口径）。
// 红线：本页只展示/提交昵称头像，不涉及手机号 / openid（手机号变更走注销重注册）。
//
// api 实例从 getApp().api 取（与其余页一致）。本地轨 getApp().api 不存在 → 提示并兜底，不崩。

const { validateNickname, buildAvatarCloudPath } = require('./editCalc');
const { handleNotLoggedIn, isNotLoggedInError } = require('../../../utils/authGuard');

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
        // 自动加载路径：1002 不弹框跳转，设游客态提示。
        if (isNotLoggedInError(err)) {
          self.setData({ loading: false, errorMsg: '请先登录后编辑资料' });
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

  /**
   * nickname input 过程值实时同步（修复点）。
   * type=nickname 点击「使用微信昵称」时，微信异步把昵称填入 input 内部 value，
   * 须借 bindinput 即时同步回 data.nickname——否则受控 value="{{nickname}}"
   * 会用旧的 data 值覆盖微信的填充，导致「点了微信昵称却填不进去、反复点也无效」。
   */
  onNicknameInput(e) {
    const v = (e && e.detail && e.detail.value) || '';
    this.setData({ nickname: v });
  },

  /** nickname input 失焦兜底取最终值（个别基础库异步填充到 blur 才完整）。 */
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
