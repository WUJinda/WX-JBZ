// pages/admin/inviteCode/inviteCode.js
// 后台邀请码管理：批量生成 + 列表 + 禁用 + 复制（一人一码小程序准入券）。
//
// 对接 admin.inviteCode.generate/list/disable。
// 红线：后端 listCodes 已剥离 used_by 原始 openid，本页只渲染 code/status 等非敏感字段。
const { formatStatus, validateCount } = require('./inviteCodeCalc');
const { enterAdminGuard } = require('../../../utils/auth-guard');

const PAGE_SIZE = 20;

Page({
  data: {
    pageLabel: '邀请码管理',
    // 生成
    countInput: '10',
    generating: false,
    genResult: '',
    // 列表
    list: [],
    totalCount: 0,
    page: 1,
    hasMore: false,
    loadingMore: false,
    filterStatus: '', // '' 全部 / unused / used / disabled
    // 通用
    loading: true,
    errorMsg: ''
  },

  onLoad() {
    if (!enterAdminGuard('/pages/admin/inviteCode/inviteCode')) return;
  },

  onShow() {
    this.loadList(true);
  },

  onCountInput(e) {
    this.setData({ countInput: (e && e.detail && e.detail.value) || '' });
  },

  /** 批量生成。 */
  onGenerate() {
    if (this.data.generating) return;
    const v = validateCount(this.data.countInput);
    if (!v.ok) {
      this.setData({ genResult: v.msg });
      return;
    }
    const app = getApp();
    const api = app && app.api;
    if (!api || typeof api.call !== 'function') {
      this.setData({ genResult: '云能力未就绪' });
      return;
    }
    this.setData({ generating: true, genResult: '' });
    api
      .call('admin', { action: 'inviteCode.generate', count: v.value }, { loading: '生成中' })
      .then((data) => {
        const d = data || {};
        const written = d.written || 0;
        const failed = (d.write_failed || []).length;
        this.setData({
          generating: false,
          genResult: '已生成 ' + written + ' 个' + (failed > 0 ? '（' + failed + ' 个失败）' : '')
        });
        wx.showToast({ title: '生成完成', icon: 'success' });
        this.loadList(true);
      })
      .catch((err) => {
        this.setData({ generating: false, genResult: (err && err.message) || '生成失败' });
      });
  },

  /** 状态筛选切换。 */
  onFilterChange(e) {
    const idx = Number((e && e.detail && e.detail.value) || 0);
    const statuses = ['', 'unused', 'used', 'disabled'];
    this.setData({ filterStatus: statuses[idx] || '' });
    this.loadList(true);
  },

  /**
   * 加载列表。
   * @param {boolean} refresh true=重置第 1 页；false=加载下一页（page+1）。
   */
  loadList(refresh) {
    const app = getApp();
    const api = app && app.api;
    if (!api || typeof api.call !== 'function') {
      this.setData({ loading: false, errorMsg: '云能力未就绪', list: [] });
      return Promise.resolve();
    }
    const page = refresh ? 1 : this.data.page + 1;
    if (refresh) this.setData({ loading: true, errorMsg: '' });
    else this.setData({ loadingMore: true });
    return api
      .call(
        'admin',
        {
          action: 'inviteCode.list',
          status: this.data.filterStatus || undefined,
          page,
          page_size: PAGE_SIZE
        },
        { loading: false, silent: true }
      )
      .then((data) => {
        const d = data || {};
        const incoming = Array.isArray(d.list)
          ? d.list.map((it) => Object.assign({}, it, formatStatus(it.status)))
          : [];
        const list = refresh ? incoming : this.data.list.concat(incoming);
        const totalCount = Number(d.totalCount) || 0;
        this.setData({
          loading: false,
          loadingMore: false,
          errorMsg: '',
          list,
          totalCount,
          page,
          hasMore: list.length < totalCount
        });
      })
      .catch(() => {
        this.setData({
          loading: false,
          loadingMore: false,
          errorMsg: refresh ? '加载失败' : this.data.errorMsg,
          list: refresh ? [] : this.data.list
        });
      });
  },

  onReachBottom() {
    if (!this.data.hasMore || this.data.loadingMore) return;
    this.loadList(false);
  },

  /** 禁用邀请码（仅 unused）。 */
  onDisable(e) {
    const code = e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.code;
    if (!code) return;
    const self = this;
    wx.showModal({
      title: '禁用邀请码',
      content: '确认禁用该邀请码？禁用后不可再用。',
      success: (res) => {
        if (!res.confirm) return;
        const app = getApp();
        const api = app && app.api;
        if (!api || typeof api.call !== 'function') return;
        api
          .call('admin', { action: 'inviteCode.disable', code }, { loading: '处理中' })
          .then(() => {
            wx.showToast({ title: '已禁用', icon: 'success' });
            self.loadList(true);
          })
          .catch((err) => {
            wx.showToast({ title: (err && err.message) || '禁用失败', icon: 'none' });
          });
      }
    });
  },

  /** 复制单码。 */
  onCopy(e) {
    const code = e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.code;
    if (!code) return;
    wx.setClipboardData({
      data: code,
      success: () => wx.showToast({ title: '已复制', icon: 'success' })
    });
  },

  onPullDownRefresh() {
    Promise.resolve(this.loadList(true)).finally(() => wx.stopPullDownRefresh());
  }
});
