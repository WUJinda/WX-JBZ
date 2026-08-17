// pages/activity/activity.js
// 活动主页（启动页，游客可见）—— 对齐 PRD F7 R7.1~R7.4，开发计划阶段 C2。
const { calcCountdown, calcProgress, deriveCta, shouldShowSettlement, formatDateTime, STATUS } = require('./activityCalc');
const { handleNotLoggedIn } = require('../../utils/authGuard');

// F2：空态活动（云函数失败/活动未发布时用，替代旧 mockActivity 的假时间窗 2026-07-01~07-21）。
const EMPTY_ACTIVITY = {
  activity_id: '', name: '', start_time: null, end_time: null, signup_deadline: null,
  terminated: false, status: 'pending', rules: '', settlement: null, overview: { total_steps: 0, participant_count: 0 }
};

// 结算公告会话标记（内存态，不落 storage）：每次小程序冷启动 JS 模块重新加载时重置为 false，
// 本次会话内首次在活动页弹出后置 true → 同一会话内重复进入活动页签不再弹；
// 切后台再回前台（小程序未销毁）不重置，不算「重新进入小程序」；重新打开小程序会再弹。
let settlementShownThisSession = false;

Page({
  data: {
    // 活动信息（来自 activity.current）
    activity: null, // { activity_id, name, start_time, end_time, signup_deadline, status, terminated, rules, overview }
    // 起止时间展示文本（固定东八区 yyyy-MM-dd HH:mm:ss）：原始串保留在 activity.start_time/end_time 供倒计时/进度计算。
    startTimeText: '',
    endTimeText: '',
    joinStatus: 'pending', // 当前用户报名状态（本地轨 mock；真实留 D1）
    // 派生展示
    status: STATUS.PENDING, // pending / active / ended
    statusText: '未开始',
    countdown: null, // { label, days, hours, minutes }
    progress: null, // { daysElapsed, daysTotal, percent }
    cta: { text: '活动未开始', action: 'none', disabled: true },
    overview: { total_steps: 0, participant_count: 0 },
    // 比赛结束结算公告弹窗（2026-08-17）：活动结束结算后展示一次，用户可关闭；新活动顶替后自动取消。
    settlementVisible: false,
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
    this.setData({
      activity,
      startTimeText: formatDateTime(activity.start_time),
      endTimeText: formatDateTime(activity.end_time),
      joinStatus: joinStatus === 'joined' ? 'joined' : 'pending'
    }, () => {
      this.refreshDerived();
      this.refreshSettlement(activity);
      this.setData({ loading: false });
    });
  },

  /**
   * 结算公告弹窗：结算摘要存在且有内容 → 弹（详见 activityCalc.shouldShowSettlement）。
   * 触发时机：每次打开小程序后的会话内，首次进入活动页签时弹出一次（会话标记拦截后续重复弹）；
   * 「我知道了」仅关闭当前弹窗，不做任何持久化记忆；新活动顶替后 settlement 不再下发 → 弹窗自然取消
   * （只作为本次比赛结束的结算通知）。
   */
  refreshSettlement(activity) {
    const act = activity || this.data.activity;
    // 本次小程序会话已弹过 → 不再弹（含用户已手动关闭的情形）。
    if (settlementShownThisSession) {
      this.setData({ settlementVisible: false });
      return;
    }
    // 首次进入且摘要有效 → 弹出并占用本会话唯一一次机会（数据未就绪/无结算则不占用，下次进页仍可弹）。
    const visible = shouldShowSettlement(act);
    if (visible) {
      settlementShownThisSession = true;
    }
    this.setData({ settlementVisible: visible });
  },

  /** 结算公告「我知道了」：仅关闭当前弹窗（不记忆，下次打开小程序首次进活动页仍会弹）。 */
  onSettlementClose() {
    this.setData({ settlementVisible: false });
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
      [STATUS.ENDED]: '已结束',
      [STATUS.TERMINATED]: '已终止'
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
      // 未报名 CTA：直接调 user.join（纯报名，不带部门；部门由注册时选定）。
      // 不依赖前端登录标志位作前置拦截——该标志仅 profile/home 调 user.profile 成功后才置位，
      // register→dept→activity 路径漏写会致新用户点「报名参加」被误判未登录跳回 login 死循环。
      // 登录态改由后端 assertUserExists 兜底：未注册（openid 无 User）→ join 抛 1002 →
      // handleNotLoggedIn 引导去注册向导；已注册未报名 → join 成功进 home。
      const app = getApp();
      if (this._joining) return; // 防双击
      const api = app && app.api;
      if (!api || typeof api.call !== 'function') {
        wx.showToast({ title: '云能力未就绪', icon: 'none' });
        return;
      }
      this._joining = true;
      api
        .call('user', { action: 'join' }, { loading: '正在报名...', silent: true })
        .then(() => {
          this._joining = false;
          // 先弹「报名成功」并给足展示时间（duration 1500ms）再跳转——原 700ms < toast 默认时长，
          // switchTab 会打断 toast，用户来不及看到成功反馈（join 冷启动慢、已等数秒时尤甚，
          // 易误以为没报上而提前点同步）。同步侧已用 assertJoinedFresh 吸收写后读，不必抢这几秒。
          wx.showToast({ title: '报名成功', icon: 'success', duration: 1500 });
          // join_status → joined：刷新派生，CTA 自动变「我的步数」。
          this.setData({ joinStatus: 'joined' }, () => this.refreshDerived());
          // 报名成功 → 进首页看步数（home 是 tabBar 页，必须用 switchTab）。
          // 延迟到 toast 展示完毕再跳，确保用户看到「报名成功」反馈。
          setTimeout(() => wx.switchTab({ url: '/pages/home/home' }), 1500);
        })
        .catch((err) => {
          this._joining = false;
          // 未注册（openid 无 User，1002）→ 引导走注册向导（注册向导内含选部门）。
          if (handleNotLoggedIn(err)) return;
          // 已报名 / 活动终止 / 报名截止 → 显示后端 message。
          wx.showToast({ title: (err && err.message) || '报名失败', icon: 'none' });
        });
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
