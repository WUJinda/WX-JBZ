// pages/dept/dept.js
const { createApi } = require('../../utils/request');
const api = createApi(wx.cloud);

Page({
  data: {
    departments: [],
    selectedDeptId: '',
    loading: true,
    submitting: false,
    errorMsg: ''
  },

  onLoad() {
    this.loadDepartments();
  },

  loadDepartments() {
    this.setData({ loading: true, errorMsg: '' });
    // 调 dept.list 获取部门列表（含 member_count 展示用）。
    // 本地轨：dept.list 走 mock 部门数据。
    api
      .call('dept', { action: 'list' })
      .then((res) => {
        const list = (res && res.list) || [];
        this.setData({ departments: list, loading: false });
      })
      .catch((err) => {
        this.setData({
          loading: false,
          errorMsg: (err && err.message) || '部门列表加载失败'
        });
      });
  },

  onDeptTap(e) {
    const id = e.currentTarget.dataset.id;
    this.setData({ selectedDeptId: id });
  },

  onConfirmTap() {
    const { selectedDeptId, submitting } = this.data;
    if (!selectedDeptId || submitting) return;
    this.setData({ submitting: true, errorMsg: '' });
    // 调 user.join 报名归属（入参 dept_id）。
    // 后端会校验：防重复、报名后不可自改（R1.4/R2.2）。
    api
      .call('user', { action: 'join', dept_id: selectedDeptId })
      .then(() => {
        this.setData({ submitting: false });
        wx.showToast({ title: '加入成功', icon: 'success' });
        // 报名成功 → 进入首页。
        wx.redirectTo({ url: '/pages/home/home' });
      })
      .catch((err) => {
        this.setData({
          submitting: false,
          errorMsg: (err && err.message) || '报名失败'
        });
      });
  }
});
