// pages/home/home.js
// 个人主页 + 步数同步入口（对齐 PRD F3 R3.1~R3.6，开发计划阶段 E4）。
const { STATES, transition, shouldThrottle } = require('./homeSync');

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
    activityId: 'a_demo_001'
  },

  onLoad() {
    this.refreshLoginCode();
  },

  onShow() {
    this.refreshLastSyncText();
  },

  /**
   * 预取 wx.login code（用于 steps.sync 当次 code2Session，架构 §6.2）。
   * 每次同步前刷新，保证 code 新鲜。
   */
  refreshLoginCode() {
    if (typeof wx === 'undefined' || !wx.login) return;
    wx.login({
      success: (res) => {
        this.setData({ jsCode: res.code || '' });
      },
      fail: () => {
        this.setData({ jsCode: '' });
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
    this.callWeRunData();
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
    this.refreshLoginCode();
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
          activity_id: this.data.activityId,
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
    wx.stopPullDownRefresh();
  }
});
