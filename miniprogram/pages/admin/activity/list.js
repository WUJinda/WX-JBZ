// pages/admin/activity/list.js
// 后台活动管理：活动列表 + 新建入口（对齐 PRD F8 后台活动管理）。
//
// 对接 activity.list（管理员）：返回全部活动 + 推算状态，active 优先排序。
//   - 顶部「新建活动」按钮 → 跳表单页（无 id，新建模式）；
//   - 点列表项整行 → 跳表单页（带 id，编辑模式，表单页内可改信息 / 终止）。
//
// 红线：
//   - 刷新放 onShow：从编辑页 navigateBack 回来自动拉新数据（新建/改名/终止结果立即可见）。
//   - 本地轨：getApp().api 不存在 → 空态占位；api.call 失败 → 静默 catch → 空态，不白屏不崩。
//   - 非管理员：enterAdminGuard 守卫踢登录页（与 dashboard/users 同）。
const { enterAdminGuard } = require('../../../utils/auth-guard');

/** 状态文案 + 标签 class（terminated 优先于 ended 单列「已终止」红标）。 */
function statusBadge(status, terminated) {
  if (terminated) return { text: '已终止', cls: 'badge-terminated' };
  if (status === 'active') return { text: '进行中', cls: 'badge-active' };
  if (status === 'pending') return { text: '未开始', cls: 'badge-pending' };
  return { text: '已结束', cls: 'badge-ended' };
}

/** ISO/日期串 → YYYY-MM-DD（取前 10 位）；空值返回 '—'。 */
function toDate(v) {
  if (!v || typeof v !== 'string') return '—';
  return v.slice(0, 10);
}

Page({
  data: {
    pageLabel: '活动管理',
    list: [],
    loading: true,
    errorMsg: ''
  },

  onShow() {
    if (!enterAdminGuard('/pages/admin/activity/list')) return;
    this.loadList();
  },

  onPullDownRefresh() {
    // 等异步加载结束再停刷新动画（与 dashboard 同）。
    Promise.resolve(this.loadList()).finally(() => {
      if (typeof wx !== 'undefined' && wx.stopPullDownRefresh) wx.stopPullDownRefresh();
    });
  },

  /** 拉活动列表。本地轨失败 → 占位空态，不弹错误。 */
  loadList() {
    const app = getApp();
    const api = app && app.api;
    if (!api || typeof api.call !== 'function') {
      // 无云能力 → 空态占位（不崩）。
      this.setData({ loading: false, list: [], errorMsg: '' });
      return Promise.resolve();
    }
    this.setData({ loading: true, errorMsg: '' });
    return api
      .call('activity', { action: 'list' }, { loading: false, silent: true })
      .then((data) => {
        const raw = (data && Array.isArray(data.list)) ? data.list : [];
        const list = raw.map((a) => ({
          activity_id: a.activity_id,
          name: a.name || '未命名活动',
          dateRange: toDate(a.start_time) + ' ~ ' + toDate(a.end_time),
          signupDeadline: a.signup_deadline ? toDate(a.signup_deadline) : '',
          badge: statusBadge(a.status, a.terminated)
        }));
        this.setData({ loading: false, list, errorMsg: '' });
      })
      .catch(() => {
        // 本地轨：云函数未部署/未实现 → 空态占位，不弹错误（照 dashboard.loadDashboard 模式）。
        this.setData({ loading: false, list: [], errorMsg: '' });
      });
  },

  /** 新建活动：跳表单页（无 id）。 */
  onCreateTap() {
    if (typeof wx === 'undefined' || !wx.navigateTo) return;
    wx.navigateTo({ url: '/pages/admin/activity/activity' });
  },

  /** 点列表项：跳表单页（带 id，编辑模式）。 */
  onItemTap(e) {
    const id = e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.id;
    if (!id) return;
    if (typeof wx === 'undefined' || !wx.navigateTo) return;
    wx.navigateTo({ url: '/pages/admin/activity/activity?id=' + id });
  }
});
