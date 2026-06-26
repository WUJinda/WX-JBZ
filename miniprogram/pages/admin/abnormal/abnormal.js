// pages/admin/abnormal/abnormal.js
// 后台异常裁定：异常步数列表 + 忽略/置零裁定（对齐 PRD F8 R8.4，开发计划阶段 H3）。
//
// 对接 admin.abnormalList（queryAbnormal 输出 list:[{_id,user_id,date,steps,synced_at,abnormal,locked}], totalCount）。
// 裁定对接 admin.verdict（applyVerdict）：业务裁定用 verdict_action（'ignore'/'zero'），
//   event.action 仍为 'verdict' 用于 dispatch（修复 H1 遗留的 event.action 字段冲突 bug）。
//
// 红线：
//   - 本页只渲染后端下发的白名单字段（user_id/date/steps/abnormal），绝不渲染 _openid / phone / sync_count。
//   - 本地轨：getApp().api 不存在 → 提前 return 设空态；api.call 失败 → .catch 静默占位，不白屏不崩。
//   - admin 页是 navigateTo 进入（非 tabBar）。
const { hasMore, verdictLabel, formatSteps, DEFAULT_PAGE_SIZE } = require('./abnormalCalc');

const ACTIVITY_ID = 'a_demo_001';

Page({
  data: {
    pageLabel: '异常裁定',
    // 列表 + 分页
    list: [],
    page: 1,
    pageSize: DEFAULT_PAGE_SIZE,
    hasMore: true,
    totalCount: 0,
    loading: true,
    loadingMore: false
  },

  onShow() {
    this.loadAbnormal(true);
  },

  onPullDownRefresh() {
    this.loadAbnormal(true);
    wx.stopPullDownRefresh();
  },

  /** 上拉加载更多。 */
  onReachBottom() {
    if (!this.data.hasMore || this.data.loadingMore || this.data.loading) return;
    this.loadAbnormal(false);
  },

  /** 异常裁定：忽略 / 置零。dataset.verdict 为 'ignore' | 'zero'。 */
  onVerdict(e) {
    const recordId = e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.recordId;
    const verdict = e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.verdict;
    if (!recordId) return;
    // 非法 action 不处理（verdictLabel 兜底空字符串即非法）。
    if (verdictLabel(verdict) === '') return;

    const app = getApp();
    const api = app && app.api;
    if (!api || typeof api.call !== 'function') {
      // 无云能力 → 静默占位（不崩）。
      wx.showToast({ title: '云能力未就绪', icon: 'none' });
      return;
    }

    api
      .call(
        'admin',
        {
          action: 'verdict',
          record_id: recordId,
          verdict_action: verdict // 业务 action 用 verdict_action（修复 H1 冲突）
        },
        { loading: '处理中' }
      )
      .then(() => {
        wx.showToast({ title: '已处理', icon: 'success' });
        // 刷新列表（裁定后该记录应从异常列表移除：abnormal=false）。
        this.loadAbnormal(true);
      })
      .catch(() => {
        // 本地轨：云函数未部署 → 静默占位，不白屏。
        wx.showToast({ title: '处理失败，请重试', icon: 'none' });
      });
  },

  /** 加载异常步数列表。reset=true 重置到第 1 页。 */
  loadAbnormal(reset) {
    const app = getApp();
    const api = app && app.api;
    if (!api || typeof api.call !== 'function') {
      // 无云能力 → 空态占位（不崩）。
      this.setData({ loading: false, loadingMore: false, list: [], hasMore: false, totalCount: 0 });
      return;
    }
    const page = reset ? 1 : this.data.page;
    if (reset) {
      this.setData({ loading: true });
    } else {
      this.setData({ loadingMore: true });
    }
    api
      .call(
        'admin',
        {
          action: 'abnormalList',
          activity_id: ACTIVITY_ID,
          page,
          page_size: this.data.pageSize
        },
        { loading: false, silent: true }
      )
      .then((data) => {
        const d = data || {};
        const list = Array.isArray(d.list) ? d.list : [];
        // 附加展示文案（steps 格式化；user_id 直接用后端下发值，不暴露 _openid）。
        list.forEach((r) => {
          r.stepsText = formatSteps(r.steps);
        });
        const merged = reset ? list : this.data.list.concat(list);
        const totalCount = Number(d.totalCount) || merged.length;
        this.setData({
          list: merged,
          page: page + 1,
          hasMore: hasMore(list.length, this.data.pageSize),
          totalCount,
          loading: false,
          loadingMore: false
        });
      })
      .catch(() => {
        // 本地轨：云函数未部署 → 空态占位，不弹错误（照 rank.loadPersonal 模式）。
        this.setData({
          loading: false,
          loadingMore: false,
          list: reset ? [] : this.data.list,
          hasMore: false,
          totalCount: reset ? 0 : this.data.totalCount
        });
      });
  }
});
