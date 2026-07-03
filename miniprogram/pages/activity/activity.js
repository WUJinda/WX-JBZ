// pages/activity/activity.js
// 活动主页（启动页，游客可见）—— 对齐 PRD F7 R7.1~R7.4，开发计划阶段 C2。
const { calcCountdown, calcProgress, deriveCta, STATUS } = require('./activityCalc');

// F2：空态活动（云函数失败/活动未发布时用，替代旧 mockActivity 的假时间窗 2026-07-01~07-21）。
const EMPTY_ACTIVITY = {
  activity_id: '', name: '', cover_url: '', start_time: null, end_time: null,
  status: 'pending', rules: '', overview: { total_steps: 0, participant_count: 0 }
};

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
    // P1-9：每次展示刷新倒计时；距上次加载 >30s 重新拉活动（节流避免频繁打云函数）。
    this.refreshDerived();
    const now = Date.now();
    if (!this._lastLoadTs || now - this._lastLoadTs > 30000) {
      this._lastLoadTs = now;
      this.loadActivity();
    }
  },

  /**
   * 拉取当前活动。游客可见：无登录态也调用 current。
   * 本地轨：current 用 mock 数据；真实云函数调用在云轨联调生效。
   * 调用失败时用前端兜底 mock，保证页面可见（不阻断游客浏览）。
   */
  loadActivity() {
    const app = getApp();
    const api = app && app.api;
    // F2：失败/无 api 用空态（不再回退 mock 假活动时间窗），页面显示"活动未发布/加载失败"。
    const fallback = () => this.applyActivity(EMPTY_ACTIVITY, 'pending');

    if (!api || typeof api.call !== 'function') {
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
    const activity = data || EMPTY_ACTIVITY;
    // F1：写入全局活动上下文，供各页读 activity_id（替代硬编码 a_demo_001）。
    const app = getApp();
    if (app && app.globalData) {
      app.globalData.currentActivity = {
        activity_id: activity.activity_id || '',
        name: activity.name || '',
        status: activity.status || ''
      };
    }
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
  }
});
