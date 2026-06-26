// pages/activity/activity.js
// 活动主页（启动页，游客可见）—— 对齐 PRD F7 R7.1~R7.4，开发计划阶段 C2。
const { calcCountdown, calcProgress, deriveCta, STATUS } = require('./activityCalc');

Page({
  data: {
    // 活动信息（来自 activity.current）
    activity: null, // { activity_id, name, cover_url, start_time, end_time, status, rules, overview }
    joinStatus: 'pending', // 当前用户报名状态（本地轨 mock；真实留 D1）
    // 派生展示
    status: STATUS.PENDING, // pending / active / ended
    statusText: '未开始',
    countdown: null, // { label, days, hours, minutes }
    progress: null, // { daysElapsed, daysTotal, percent }
    cta: { text: '活动未开始', action: 'none', disabled: true },
    overview: { total_steps: 0, participant_count: 0 },
    loading: true
  },

  onLoad() {
    this.loadActivity();
  },

  onShow() {
    // 每次展示刷新倒计时（时间在推进）
    if (this.data.activity) this.refreshDerived();
  },

  /**
   * 拉取当前活动。游客可见：无登录态也调用 current。
   * 本地轨：current 用 mock 数据；真实云函数调用在云轨联调生效。
   * 调用失败时用前端兜底 mock，保证页面可见（不阻断游客浏览）。
   */
  loadActivity() {
    const app = getApp();
    const api = app && app.api;
    const fallback = () => this.applyActivity(this.mockActivity(), 'pending');

    if (!api || typeof api.call !== 'function') {
      // 本地轨 / 无 api 句柄：直接用 mock
      fallback();
      return;
    }
    api
      .call('activity', { action: 'current' }, { loading: false, silent: true })
      .then((data) => {
        this.applyActivity(data, data && data.join_status);
      })
      .catch(() => {
        fallback();
      });
  },

  /**
   * 应用活动数据并刷新派生展示。
   * @param {object} data activity.current 出参
   * @param {string} [joinStatus]
   */
  applyActivity(data, joinStatus) {
    const activity = data || this.mockActivity();
    this.setData({ activity, joinStatus: joinStatus === 'joined' ? 'joined' : 'pending' }, () => {
      this.refreshDerived();
      this.setData({ loading: false });
    });
  },

  /** 刷新倒计时 / 进度 / CTA（纯函数计算）。 */
  refreshDerived() {
    const a = this.data.activity;
    if (!a) return;
    const countdown = calcCountdown(a);
    const progress = calcProgress(a);
    const cta = deriveCta(countdown.status, this.data.joinStatus);
    const statusText = {
      [STATUS.PENDING]: '未开始',
      [STATUS.ACTIVE]: '进行中',
      [STATUS.ENDED]: '已结束'
    }[countdown.status];
    this.setData({
      status: countdown.status,
      statusText,
      countdown,
      progress,
      cta,
      overview: (a.overview && { ...a.overview }) || { total_steps: 0, participant_count: 0 }
    });
  },

  /** CTA 点击：按 action 跳转。 */
  onCtaTap() {
    const action = this.data.cta && this.data.cta.action;
    if (this.data.cta.disabled || action === 'none') return;
    if (action === 'login') {
      wx.redirectTo({ url: '/pages/login/login' });
      return;
    }
    if (action === 'home') {
      wx.switchTab({ url: '/pages/home/home' });
      return;
    }
    if (action === 'rank') {
      wx.switchTab({ url: '/pages/rank/rank' });
      return;
    }
  },

  /** 本地轨兜底 mock 活动（与 activityStatus.mockCurrentActivity 对齐）。 */
  mockActivity() {
    return {
      activity_id: 'a_demo_001',
      name: '2026 员工健步走',
      cover_url: '',
      start_time: '2026-07-01T00:00:00+08:00',
      end_time: '2026-07-21T23:59:59+08:00',
      status: 'pending',
      rules: '活动规则示例：活动期间每日同步微信运动步数，累计计入个人与部门排行。',
      overview: { total_steps: 0, participant_count: 0 },
      join_status: 'pending'
    };
  }
});
