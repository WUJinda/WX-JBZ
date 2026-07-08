// pages/admin/dashboard/dashboard.js
// 后台首页：模块导航 + 数据看板（对齐 PRD F8 R8.5，开发计划阶段 H2）。
//
// 看板对接 admin.dashboard（buildDashboard 输出：participated/whitelistTotal/rate/
// totalSteps/avgSteps/validParticipants/dailyActive/deptRank）。
// 5 个模块导航：activity / whitelist（H2 已实现）/ users / abnormal / dept（H3 填充，导航先就位）。
//
// 红线：
//   - 本页只渲染后端下发的非敏感字段（deptRank 等），绝不渲染 _openid/完整 phone/sync_count。
//   - 本地轨云函数未部署：getApp().api 不存在 → 提前 return 设空态；api.call 失败 → 静默 catch → 空态占位，不白屏不崩。
//   - admin 页是 navigateTo 进入（非 tabBar），onModuleTap 用 wx.navigateTo 跳子页。
const { formatRate, normalizeDailyActive, isEmptyDashboard } = require('./dashboardCalc');
const { enterAdminGuard } = require('../../../utils/auth-guard');

Page({
  data: {
    pageLabel: '数据看板',
    // 6 指标（F8 §420–428）
    participated: 0,
    whitelistTotal: 0,
    rateText: '0%',
    totalSteps: 0,
    avgSteps: 0,
    validParticipants: 0,
    // 日活趋势（纯 CSS 柱状）
    dailyActive: [],
    dailyActiveEmpty: true,
    // 部门榜（复用 RankCache，R8.5）
    deptRank: [],
    // 通用
    loading: true,
    errorMsg: '',
    empty: false,
    // 刷新排行榜按钮态（防双击 + 文案切换）
    refreshing: false
  },

  onShow() {
    if (!enterAdminGuard('/pages/admin/dashboard/dashboard')) return;
    this.loadDashboard();
  },

  onPullDownRefresh() {
    // 等异步加载结束再停刷新动画（此前立即 stop → 数据没回来动画已消失）。
    Promise.resolve(this.loadDashboard()).finally(() => wx.stopPullDownRefresh());
  },

  /** 加载数据看板。本地轨失败 → 占位空态，不弹错误。 */
  loadDashboard() {
    const app = getApp();
    const api = app && app.api;
    if (!api || typeof api.call !== 'function') {
      // 无云能力 → 空态占位（不崩）。
      this.setData({ loading: false, errorMsg: '', empty: true });
      return Promise.resolve();
    }
    this.setData({ loading: true, errorMsg: '' });
    return api
      .call(
        'admin',
        { action: 'dashboard', activity_id: getApp().getActivityId() },
        { loading: false, silent: true }
      )
      .then((data) => {
        const d = data || {};
        const metrics = {
          participated: d.participated,
          whitelistTotal: d.whitelistTotal,
          totalSteps: d.totalSteps,
          validParticipants: d.validParticipants,
          deptRank: d.deptRank
        };
        const daily = Array.isArray(d.dailyActive) ? d.dailyActive : [];
        this.setData({
          loading: false,
          errorMsg: '',
          participated: Number(d.participated) || 0,
          whitelistTotal: Number(d.whitelistTotal) || 0,
          rateText: formatRate(d.rate),
          totalSteps: Number(d.totalSteps) || 0,
          avgSteps: Math.round(Number(d.avgSteps) || 0),
          validParticipants: Number(d.validParticipants) || 0,
          dailyActive: normalizeDailyActive(daily),
          dailyActiveEmpty: !Array.isArray(daily) || daily.length === 0,
          deptRank: Array.isArray(d.deptRank) ? d.deptRank : [],
          empty: isEmptyDashboard(metrics)
        });
      })
      .catch(() => {
        // 本地轨：云函数未部署 → 空态占位，不弹错误（照 rank.loadPersonal 模式）。
        this.setData({
          loading: false,
          errorMsg: '',
          participated: 0,
          whitelistTotal: 0,
          rateText: '0%',
          totalSteps: 0,
          avgSteps: 0,
          validParticipants: 0,
          dailyActive: [],
          dailyActiveEmpty: true,
          deptRank: [],
          empty: true
        });
      });
  },

  /**
   * 一键刷新排行榜：调 admin.refreshRank（assertAdmin 守卫 + 转发 tasks.rankAggregate），
   * 覆盖写 RankCache。成功后重载看板（部门榜等同步更新）。
   * 场景：排查榜单问题 / 用户同步后榜单未即时更新时，管理员手动兜底刷新。
   */
  onRefreshRank() {
    const app = getApp();
    const api = app && app.api;
    if (!api || typeof api.call !== 'function') {
      wx.showToast({ title: '云能力未就绪', icon: 'none' });
      return;
    }
    if (this.data.refreshing) return; // 防双击
    this.setData({ refreshing: true });
    api
      .call(
        'admin',
        { action: 'refreshRank', activity_id: app.getActivityId() },
        { loading: false, silent: true }
      )
      .then((data) => {
        this.setData({ refreshing: false });
        const d = data || {};
        wx.showToast({
          title: '榜单已刷新（' + (d.personal_count || 0) + '人/' + (d.dept_count || 0) + '部门）',
          icon: 'none',
          duration: 2500
        });
        // 刷新成功 → 重载看板（部门榜 / 累计步数同步更新）。
        this.loadDashboard();
      })
      .catch((err) => {
        this.setData({ refreshing: false });
        wx.showToast({ title: (err && err.message) || '刷新失败', icon: 'none' });
      });
  },

  /** 模块导航：跳转后台子页（admin 页非 tab，用 navigateTo）。 */
  onModuleTap(e) {
    const mod = e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.mod;
    if (!mod) return;
    if (typeof wx === 'undefined' || !wx.navigateTo) return;
    const urlMap = {
      activity: '/pages/admin/activity/list',
      whitelist: '/pages/admin/whitelist/whitelist',
      users: '/pages/admin/users/users',
      abnormal: '/pages/admin/abnormal/abnormal',
      dept: '/pages/admin/dept/dept'
    };
    const url = urlMap[mod];
    if (!url) return;
    wx.navigateTo({ url });
  }
});
