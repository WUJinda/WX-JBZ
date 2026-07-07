// pages/home/home.js
// 个人主页 + 步数同步入口（对齐 PRD F3 R3.1~R3.6，开发计划阶段 E4）。
// F4：增量补齐步数展示（统计/趋势/参与天数/排名入口/空态），不破坏 E4 同步状态机。
// 活动状态感知（homeStatus 纯函数）：按 active/ended/pending/none 切换显示模式——
//   active 进行中（完整展示）/ ended 战绩归档（最终累计+趋势+排名，禁同步）/
//   pending 未开始（空态预告）/ none 无活动（空态）。状态来自 globalData.currentActivity。
const { STATES, transition, shouldThrottle, isSyncFresh } = require('./homeSync');
const { selectRange, normalizeBars, isEmptyTrend } = require('./homeTrend');
const { handleNotLoggedIn } = require('../../utils/authGuard');
const { STATUS: ACT_STATUS, deriveHomeStatus, needsFetchStatus, shouldLoadData } = require('./homeStatus');

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
    trendEmpty: true,
    // 活动状态感知（homeStatus 纯函数驱动）：unknown/active/ended/pending/none
    activityStatus: ACT_STATUS.UNKNOWN,
    activityName: '',
    // 管理员快捷入口（仅 is_admin=true 显示）：顶部「管理后台」+ 空态「去创建活动」
    isAdmin: false
  },

  onLoad() {
    // P1-10：不再预取 wx.login code——onSyncTap 时与 getWeRunData 同源获取
    //   （预取的 code 会过期/可能与 getWeRunData 不同登录态 → 解密失败 STEP_DECRYPT_FAILED）。
    // 3004 兜底标志：服务端判 ended 但本地时间窗口未到时强制 ended，下拉刷新时清除。
    this._forceEnded = false;
  },

  onShow() {
    this.refreshLastSyncText();
    this.loadAdminFlag();
    // 按活动状态决定显示模式（active/ended 加载数据；pending/none 空态；unknown 补调 current）。
    this.ensureActivityStatus();
  },

  /**
   * 加载管理员标识（决定首页是否显示管理入口）。
   * 优先读 globalData.isAdmin（profile 已写入），命中即不请求；
   * 冷启动 home 先于 profile 时兜底调一次 user.profile。
   */
  loadAdminFlag() {
    const app = getApp();
    if (app && app.globalData && typeof app.globalData.isAdmin === 'boolean') {
      this.setData({ isAdmin: app.globalData.isAdmin });
      return;
    }
    const api = app && app.api;
    if (!api || typeof api.call !== 'function') return;
    api
      .call('user', { action: 'profile' }, { loading: false, silent: true })
      .then((data) => {
        const isAdmin = !!(data && data.is_admin === true);
        // 与 profile.js 同口径：user.profile 成功 = User 存在 = 已登录，须同步写 loggedIn，
        // 否则冷启动从首页「管理后台」入口直进 admin 页会被 enterAdminGuard 拦回登录页
        // （loggedIn 全项目仅 profile.js 写入；home 绕过 profile 时会漏写）。
        if (app && app.globalData) {
          app.globalData.isAdmin = isAdmin;
          app.globalData.loggedIn = true;
        }
        this.setData({ isAdmin });
      })
      .catch(() => {
        // 未登录 / 本地轨：保持 isAdmin=false（管理入口不显示）。
      });
  },

  /**
   * 推导当前活动状态并按态分发加载。
   * 状态来源 globalData.currentActivity（activity 页 applyActivity 写入）；
   * 冷启动 home 先于 activity 异步返回时 status 缺失 → 补调 activity.current 兜底。
   */
  ensureActivityStatus() {
    const app = getApp();
    // admin 刚创建/编辑/终止活动后置 _activityDirty → 强制重拉 current，绕过 globalData
    // 缓存推算（否则 home 用缓存的旧活动，不会感知新增活动 / 不会隐藏已终止活动，即
    // 「个人页顶部活动信息不更新」根因）。与 activity.js onShow 同模式；同步清 _forceEnded：
    // 新活动可能 active，重新探测真实状态，避免卡在 3004 强制 ended。
    if (app && app.globalData && app.globalData._activityDirty) {
      app.globalData._activityDirty = false;
      this._forceEnded = false;
      this.fetchActivityStatus();
      return;
    }
    // 3004 兜底：服务端判 ended 但本地时间窗口未到时（管理员提前改 end_time / 时钟偏差），
    // _forceEnded 保持 ended 态到下次主动下拉刷新——避免 onShow 用 globalData 旧时间窗口
    // 重算回 active（同步按钮反复横跳 → 再点再 3004）。
    if (this._forceEnded) {
      const ga0 = (app && app.globalData && app.globalData.currentActivity) || {};
      this.setData({ activityStatus: ACT_STATUS.ENDED, activityName: ga0.name || this.data.activityName });
      this.loadStats();
      this.loadTrend(this.data.trendRange);
      return;
    }
    const ga = (app && app.globalData && app.globalData.currentActivity) || {};
    const status = deriveHomeStatus(ga, Date.now());
    this.setData({ activityStatus: status, activityName: ga.name || '' });
    if (needsFetchStatus(ga)) {
      this.fetchActivityStatus();
      return;
    }
    if (shouldLoadData(status)) {
      this.loadStats();
      this.loadTrend(this.data.trendRange);
    }
  },

  /**
   * 静默拉取当前活动并回写 globalData（activity.current 游客可调，无 1002）。
   * 成功后重新推导状态并按态加载；失败 → 空态（home 不依赖活动信息也能渲染空态）。
   */
  fetchActivityStatus() {
    const app = getApp();
    const api = app && app.api;
    if (!api || typeof api.call !== 'function') {
      this.setData({ activityStatus: ACT_STATUS.NONE });
      return;
    }
    api
      .call('activity', { action: 'current' }, { loading: false, silent: true })
      .then((data) => {
        const d = data || {};
        if (app && app.globalData) {
          app.globalData.currentActivity = {
            activity_id: d.activity_id || '',
            name: d.name || '',
            start_time: d.start_time != null ? d.start_time : null,
            end_time: d.end_time != null ? d.end_time : null,
            status: d.status || ''
          };
        }
        const status = deriveHomeStatus(d, Date.now());
        this.setData({ activityStatus: status, activityName: d.name || '' });
        if (shouldLoadData(status)) {
          this.loadStats();
          this.loadTrend(this.data.trendRange);
        }
      })
      .catch(() => {
        // current 游客可调、不抛 1002；失败统一空态（不阻断 home 渲染）。
        this.setData({ activityStatus: ACT_STATUS.NONE });
      });
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
        // 同步成功后刷新排名/天数/趋势。
        // keepSyncedSteps=true：today/total 保留 sync 返回的最即时值，不让 stats 的二次查询覆盖
        // （云库「写后立即查」的最终一致性会读到旧快照，致刚显示的新步数「闪回」成旧值）。
        this.loadStats({ keepSyncedSteps: true });
        this.loadTrend(this.data.trendRange);
        wx.showToast({ title: '同步成功', icon: 'success' });
      })
      .catch((err) => {
        wx.hideLoading();
        // 1002 未登录 → 守卫引导登录（sync 需登录态）。
        if (handleNotLoggedIn(err)) return;
        if (err && err.code === 3004) {
          // STEP_ACTIVITY_CLOSED（R3.5）：活动已结束禁同步。状态过时仍点到同步的兜底。
          // 置 _forceEnded：保持 ended 态到下次下拉刷新，避免 onShow 用 globalData 旧
          // 时间窗口回滚到 active（同步按钮反复横跳 → 再点再 3004）。
          this._forceEnded = true;
          this.apply({ type: 'CLOUD_FAIL', payload: { message: '活动已结束，无法同步' } });
          this.setData({ activityStatus: ACT_STATUS.ENDED });
        } else if (err && err.code === 3003) {
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

  /** 下拉刷新：重置 + 重新探测活动状态（pending→active 跨态切换），成功后按态加载。 */
  onPullDownRefresh() {
    // 主动刷新：清除 3004 兜底的强制 ended，重新探测真实状态（允许 ended→active 恢复）。
    this._forceEnded = false;
    this.apply({ type: 'RESET' });
    this.refreshLastSyncText();
    this.fetchActivityStatus();
    wx.stopPullDownRefresh();
  },

  // ===== F4：步数展示（统计 / 趋势 / 排名入口） =====

  /**
   * 加载个人统计（user.stats）。本地轨失败 → 占位，不阻塞同步。
   *
   * @param {object} [opts]
   * @param {boolean} [opts.keepSyncedSteps] true=保留 sync 刚写入的 today/total 不覆盖（sync 成功后调用）。
   *   背景：sync 返回的 today/total 来自当次解密写入的内存 store，是最即时值；而 stats 是对 StepRecord
   *   的二次查询，云数据库「写后立即查」存在最终一致性延迟，可能命中写入前的旧快照。用它覆盖 sync 值，
   *   刚显示的新步数会「闪回」成旧值（表现为同步成功后一秒内数据回退）。故 sync 后调用置 true，
   *   stats 只刷 myRank/天数（sync 不返回这些），today/total 留给 sync 的即时值。
   */
  loadStats(opts) {
    const app = getApp();
    const api = app && app.api;
    if (!api || typeof api.call !== 'function') return;
    // 请求序号：丢弃过期响应。多个 loadStats 并发时（如 onShow 触发的旧请求因云函数冷启动延迟，
    // 晚于 sync 后的新请求返回），仅采纳最后一次响应，避免旧值覆盖新值。
    this._statsSeq = (this._statsSeq || 0) + 1;
    const seq = this._statsSeq;
    const keepSyncedSteps = !!(opts && opts.keepSyncedSteps);
    // 写后读一致性窗口：距上次成功同步 < 2min 内，user.stats 二次查库可能命中写入前旧快照，
    // 此时保留 sync 写入的即时 today/total（切回主页 loadStats 不覆盖）；窗口外按稳态处理，
    // stats 值即真实当前值正常覆盖。与 sync 后立即那次（keepSyncedSteps=true）互补——
    // 后者只覆盖「sync 完紧接着的 loadStats」，保护不到用户主动切走再切回主页触发的 loadStats。
    const recentSync = isSyncFresh(this.data.lastSyncTs, Date.now());
    api
      .call(
        'user',
        { action: 'stats', activity_id: getApp().getActivityId() },
        { loading: false, silent: true }
      )
      .then((data) => {
        if (seq !== this._statsSeq) return; // 过期响应，丢弃
        const d = data || {};
        const patch = {
          activeDays: d.active_days || 0,
          totalDays: d.total_days || 0,
          myRank: d.my_rank == null ? null : d.my_rank
        };
        if (!keepSyncedSteps && !recentSync) {
          // 稳态刷新（窗口外的 onShow / 下拉刷新）：stats 的 today/total 即真实当前值，正常覆盖。
          patch.totalSteps = typeof d.total_steps === 'number' ? d.total_steps : this.data.totalSteps;
          patch.todaySteps = typeof d.today_steps === 'number' ? d.today_steps : this.data.todaySteps;
        }
        this.setData(patch);
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
  },

  /** 管理员：空态直达创建/编辑活动（活动配置页）。 */
  onCreateActivity() {
    if (typeof wx === 'undefined' || !wx.navigateTo) return;
    wx.navigateTo({ url: '/pages/admin/activity/activity' });
  },

  /** 全员：直达活动详情/报名。activity 为 tabBar 页，必须用 switchTab（navigateTo 报错）。 */
  onActivityEntry() {
    if (typeof wx === 'undefined' || !wx.switchTab) return;
    wx.switchTab({ url: '/pages/activity/activity' });
  }
});
