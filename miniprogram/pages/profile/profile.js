// pages/profile/profile.js
// 个人资料页（对齐 PRD F1，开发计划 B5）。
// 展示脱敏手机号 / 部门 / 累计步数（步数为占位，真实聚合留后续阶段）。
// 红线：本页只展示后端下发的脱敏字段，绝不展示完整手机号 / openid。

const { createApi } = require('../../utils/request');
const api = createApi(wx.cloud);

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
    errorMsg: ''
  },

  onShow() {
    this.loadProfile();
  },

  loadProfile() {
    const self = this;
    self.setData({ loading: true, errorMsg: '' });
    api
      .call('user', { action: 'profile' })
      .then((data) => {
        self.setData({
          loading: false,
          nickname: (data && data.nickname) || '',
          avatar: (data && data.avatar) || '',
          phoneMasked: (data && data.phone_masked) || '',
          deptName: (data && data.dept_name) || '',
          joinStatus: (data && data.join_status) || 'pending',
          totalSteps: (data && data.total_steps) || 0
        });
      })
      .catch((err) => {
        self.setData({ loading: false, errorMsg: (err && err.message) || '加载失败' });
      });
  },

  onPullDownRefresh() {
    this.loadProfile();
  }
});
