// pages/activity/activity.js
// 活动主页（启动页，游客可见）—— 对齐 PRD F7 R7.1~R7.4，开发计划阶段 C2。
const { calcCountdown, calcProgress, deriveCta, STATUS } = require('./activityCalc');

// F2：空态活动（云函数失败/活动未发布时用，替代旧 mockActivity 的假时间窗 2026-07-01~07-21）。
const EMPTY_ACTIVITY = {
  activity_id: '', name: '', start_time: null, end_time: null, signup_deadline: null,
  terminated: false, status: 'pending', rules: '', overview: { total_steps: 0, participant_count: 0 }
};

Page({
  data: {
    // 活动信息（来自 activity.current）
    activity: null, // { activity_id, name, start_time, end_time, signup_deadline, status, terminated, rules, overview }
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
    // 标记加载时间，避免 onShow 紧随其后因 _lastLoadTs 未设再发一次 current——
    // onLoad + onShow 双发并发请求时，若一成功一失败，失败走 EMPTY_ACTIVITY 兜底，
    // 后返回的会覆盖先返回的真实态，造成状态横跳（修复「未开始 → 已结束」闪烁）。
    this._lastLoadTs = Date.now();
    this.loadActivity();
  },

  onShow() {
    // P1-9：每次展示刷新倒计时；距上次加载 >30s 重新拉活动（节流避免频繁打云函数）。
    this.refreshDerived();
    // admin 刚创建/编辑活动后置 _activityDirty → 强制重拉，绕过 30s 节流，确保看到最新活动。
    const app0 = getApp();
    if (app0 && app0.globalData && app0.globalData._activityDirty) {
      app0.globalData._activityDirty = false;
      this._lastLoadTs = Date.now();
      this.loadActivity();
      return;
    }
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
    const fallback = () => this.applyActivity(EMPTY_ACTIVITY, 'pending', { persist: false });

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
  applyActivity(data, joinStatus, options) {
    // 大字报模式：无头图，活动名直接为主视觉（cover_url 已下线）。
    const activity = data || EMPTY_ACTIVITY;
    const opts = options || {};
    // F1：写入全局活动上下文，供各页读 activity_id（替代硬编码 a_demo_001）。
    // persist=false（current 失败的 fallback 空态）跳过写回——避免覆盖 home 等其它页已成功
    // 获取的真实活动，导致 globalData 被空态污染（回 home 后误显示"暂无活动"）。
    const app = getApp();
    if (opts.persist !== false && app && app.globalData) {
      app.globalData.currentActivity = {
        activity_id: activity.activity_id || '',
        name: activity.name || '',
        // 写入时间窗口：home 用 start_time/end_time + 当前时间实时推算状态（与后端 deriveStatus 同口径），
        // 不再依赖 status 字符串快照——后者会过时（活动跨 end_time 后仍卡 pending）且 home 多次 onShow 时
        // 易与在途的 fetchActivityStatus 竞态（pending 一闪 → ended）。
        start_time: activity.start_time != null ? activity.start_time : null,
        end_time: activity.end_time != null ? activity.end_time : null,
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
    // 报名截止：仅当活动设了 signup_deadline 且当前已过（不填=活动结束前可报，由 status=ENDED 兜底）
    const signupEnded = !!(a.signup_deadline && Date.now() > Date.parse(a.signup_deadline));
    const cta = deriveCta(countdown.status, this.data.joinStatus, signupEnded);
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
      // 未报名 CTA：已登录未报名 → 直达 dept 选部门报名（少绕一次 login）；未登录 → 走 login 注册向导。
      const app = getApp();
      const loggedIn = !!(app && app.globalData && app.globalData.loggedIn);
      wx.redirectTo({ url: loggedIn ? '/pages/dept/dept' : '/pages/login/login' });
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
