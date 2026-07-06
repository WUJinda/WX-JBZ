// pages/home/home.js
// 个人主页 + 步数同步入口（对齐 PRD F3 R3.1~R3.6，开发计划阶段 E4）。
// F4：增量补齐步数展示（统计/趋势/参与天数/排名入口/空态），不破坏 E4 同步状态机。
const { STATES, transition, shouldThrottle } = require('./homeSync');
const { selectRange, normalizeBars, isEmptyTrend } = require('./homeTrend');
const { handleNotLoggedIn } = require('../../utils/authGuard');

Page({
  data: {
    pageLabel: '个人主页',
    // 步数同步状态机（homeSync.js 纯函数驱动）
    syncState: STATES.IDLE,
    errorMsg: '',
    todaySteps: 0,
    totalSteps: 0,
    lastSyncTs: 0,
    lastSyncText: '',
    // 同步所需数据（wx.login code + getWeRunData 结果）
    jsCode: '',
    encryptedData: '',
    iv: '',
    // F4：步数展示（统计 / 趋势 / 排名入口 / 空态）
    activeDays: 0,
    totalDays: 0,
    myRank: null,
    trendRange: 7,
    trendList: [],
    trendEmpty: true
  },

  onLoad() {
    // P1-10：不再预取 wx.login code——onSyncTap 时与 getWeRunData 同源获取
    //   （预取的 code 会过期/可能与 getWeRunData 不同登录态 → 解密失败 STEP_DECRYPT_FAILED）。
  },

  onShow() {
    this.refreshLastSyncText();
    // F4：进入主页主动加载统计 + 趋势（本地轨云函数未部署 → 失败占位，不阻塞同步功能）。
    this.loadStats();
    this.loadTrend(this.data.trendRange);
  },

  /**
   * 获取 wx.login code（用于 steps.sync 当次 code2Session，架构 §6.2）。
   *
   * @param {Function} [cb] 拿到 code（setData 完成）后的回调；login 不可用/失败时也会调用（code 可能为空）
   */
  refreshLoginCode(cb) {
    if (typeof wx === 'undefined' || !wx.login) {
      if (typeof cb === 'function') cb();
      return;
    }
    wx.login({
      success: (res) => {
        this.setData({ jsCode: res.code || '' });
        if (typeof cb === 'function') cb();
      },
      fail: () => {
        this.setData({ jsCode: '' });
        if (typeof cb === 'function') cb();
      }
    });
  },

  /** 计算并展示「最近同步时间」。 */
  refreshLastSyncText() {
    const ts = this.data.lastSyncTs;
    if (!ts) {
      this.setData({ lastSyncText: '' });
      return;
    }
    const diffMs = Date.now() - ts;
    const min = Math.floor(diffMs / 60000);
    const text = min < 1 ? '刚刚' : min < 60 ? min + ' 分钟前' : Math.floor(min / 60) + ' 小时前';
    this.setData({ lastSyncText: text });
  },

  /** 应用状态机转移。 */
  apply(event) {
    const next = transition(
      {
        syncState: this.data.syncState,
        errorMsg: this.data.errorMsg,
        todaySteps: this.data.todaySteps,
        totalSteps: this.data.totalSteps,
        lastSyncTs: this.data.lastSyncTs
      },
      event
    );
    this.setData({
      syncState: next.syncState,
      errorMsg: next.errorMsg,
      todaySteps: next.todaySteps || 0,
      totalSteps: next.totalSteps || 0,
      lastSyncTs: next.lastSyncTs || this.data.lastSyncTs
    });
    return next;
  },

  /** 同步入口：点击「同步步数」。 */
  onSyncTap() {
    // R3.3 前端节流：距上次 < 30min 读缓存不重复请求。
    if (shouldThrottle(this.data.lastSyncTs, Date.now(), 30)) {
      wx.showToast({ title: '最近已同步，请稍后再试', icon: 'none' });
      return;
    }
    this.apply({ type: 'SYNC_START' });
    // 关键：wx.login 与 wx.getWeRunData 必须同源——getWeRunData 的 encryptedData 用
    // 「当前登录态 session_key」加密，云函数靠 login 的 code 经 code2Session 换出同一
    // session_key 才能解密（decrypt.js AES-128-CBC）。故在此先 login 取 fresh code，
    // 紧接 getWeRunData；callCloudSync 不再重复 login，否则 code 与 encryptedData 可能
    // 分属不同登录态（login 触发会话刷新）→ 云端解密必败（STEP_DECRYPT_FAILED 3002）。
    this.refreshLoginCode(() => this.callWeRunData());
  },

  /** 调 wx.getWeRunData（首次需用户授权微信运动）。 */
  callWeRunData() {
    if (typeof wx === 'undefined' || !wx.getWeRunData) {
      this.apply({ type: 'WERUN_DENIED' });
      return;
    }
    wx.getWeRunData({
      success: (res) => {
        this.apply({
          type: 'WERUN_OK',
          payload: { encryptedData: res.encryptedData, iv: res.iv }
        });
        this.callCloudSync(res.encryptedData, res.iv);
      },
      fail: () => {
        this.apply({ type: 'WERUN_DENIED' });
      }
    });
  },

  /** 调 steps.sync（带最新 wx.login code）。 */
  callCloudSync(encryptedData, iv) {
    // 不再 refreshLoginCode：code 已在 onSyncTap 时与 getWeRunData 同源获取（见 onSyncTap 注释）。
    const code = this.data.jsCode;
    if (!code) {
      this.apply({ type: 'CLOUD_FAIL', payload: { message: '登录态失效，请重试' } });
      return;
    }
    const app = getApp();
    const api = app && app.api;
    if (!api || typeof api.call !== 'function') {
      this.apply({ type: 'CLOUD_FAIL', payload: { message: '云能力未就绪' } });
      return;
    }
    wx.showLoading({ title: '同步中...', mask: true });
    api
      .call(
        'steps',
        {
          action: 'sync',
          activity_id: getApp().getActivityId(),
          code,
          encrypted_data: encryptedData,
          iv
        },
        { loading: false, silent: true }
      )
      .then((data) => {
        wx.hideLoading();
        const today = (data && data.today) || {};
        this.apply({
          type: 'CLOUD_OK',
          payload: {
            todaySteps: today.steps || 0,
            totalSteps: (data && data.total) || 0,
            nowTs: Date.now()
          }
        });
        wx.showToast({ title: '同步成功', icon: 'success' });
      })
      .catch((err) => {
        wx.hideLoading();
        // 1002 未登录 → 守卫引导登录（sync 需登录态）。
        if (handleNotLoggedIn(err)) return;
        if (err && err.code === 3003) {
          // STEP_SYNC_LIMIT 频控（R3.3）
          this.apply({ type: 'CLOUD_RATE_LIMIT' });
        } else {
          this.apply({ type: 'CLOUD_FAIL', payload: { message: (err && err.message) || '同步失败' } });
        }
      });
  },

  /** 拒绝授权后「重新授权」入口：引导 openSetting 开启微信运动权限。 */
  onOpenSetting() {
    if (typeof wx === 'undefined' || !wx.openSetting) return;
    wx.openSetting({
      success: (res) => {
        // weRunData / werun 权限授予后重新走同步流程
        const granted = res.authSetting && (res.authSetting['scope.werun'] || res.authSetting['scope.werunData']);
        if (granted) {
          this.apply({ type: 'SETTING_GRANTED' });
          this.callWeRunData();
        }
      }
    });
  },

  /** 下拉刷新：重置 + 重新同步。 */
  onPullDownRefresh() {
    this.apply({ type: 'RESET' });
    this.refreshLastSyncText();
    this.loadStats();
    this.loadTrend(this.data.trendRange);
    wx.stopPullDownRefresh();
  },

  // ===== F4：步数展示（统计 / 趋势 / 排名入口） =====

  /** 加载个人统计（user.stats）。本地轨失败 → 占位，不阻塞同步。 */
  loadStats() {
    const app = getApp();
    const api = app && app.api;
    if (!api || typeof api.call !== 'function') return;
    api
      .call(
        'user',
        { action: 'stats', activity_id: getApp().getActivityId() },
        { loading: false, silent: true }
      )
      .then((data) => {
        const d = data || {};
        this.setData({
          activeDays: d.active_days || 0,
          totalDays: d.total_days || 0,
          myRank: d.my_rank == null ? null : d.my_rank,
          // 同步刷新累计/今日（与 stats 口径一致；不覆盖 sync 成功态的更即时值由 onShow 触发顺序保证）
          totalSteps: typeof d.total_steps === 'number' ? d.total_steps : this.data.totalSteps,
          todaySteps: typeof d.today_steps === 'number' ? d.today_steps : this.data.todaySteps
        });
      })
      .catch((err) => {
        // 1002 未登录 → 守卫引导登录（stats 需登录态）。
        if (handleNotLoggedIn(err)) return;
        // 本地轨：云函数未部署 → 占位空态，不弹错误（同步功能照常）。
      });
  },

  /** 加载趋势（steps.trend）。本地轨失败 → 占位。 */
  loadTrend(range) {
    const r = selectRange(range);
    const app = getApp();
    const api = app && app.api;
    if (!api || typeof api.call !== 'function') {
      this.applyTrend([], r);
      return;
    }
    api
      .call(
        'steps',
        { action: 'trend', activity_id: getApp().getActivityId(), range: r },
        { loading: false, silent: true }
      )
      .then((data) => {
        const list = (data && data.list) || [];
        this.applyTrend(list, r);
      })
      .catch((err) => {
        if (handleNotLoggedIn(err)) return;
        this.applyTrend([], r);
      });
  },

  /** 应用趋势到 data（归一化 + 空态）。 */
  applyTrend(list, range) {
    const r = selectRange(range);
    const bars = normalizeBars(list);
    this.setData({
      trendRange: r,
      trendList: bars,
      trendEmpty: isEmptyTrend(list)
    });
  },

  /** 区间切换 7↔30（R4.2）。 */
  onTrendRange(e) {
    const range = selectRange(e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.range);
    if (range === this.data.trendRange) return;
    this.loadTrend(range);
  },

  /** 我的排名入口：跳转 rank 页（R4.4）。rank 是 tabBar 页，必须用 switchTab（navigateTo 会报错）。 */
  onMyRankTap() {
    if (typeof wx === 'undefined' || !wx.switchTab) return;
    wx.switchTab({ url: '/pages/rank/rank' });
  }
});
