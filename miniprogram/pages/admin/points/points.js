// pages/admin/points/points.js
// 后台积分台账：查看全员积分 + 手动调整 + 手动触发结算（积分规则：个人榜前10名 +12/10/8/7/6/5/4/3/2/1（0步跳过不递补），部门榜第1名部门成员每人 +2）。
//
// 对接 admin.points（queryPoints 输出 list:[{_id,nickname,dept_id,dept_name,points,total_steps}], totalCount）
// 调整对接 admin.adjustPoints（adjustPoints 输出 {userId,points,delta,updatedAt}）
// 结算对接 admin.settlePoints（转发 tasks.pointSettle，按最终榜单结算）
//
// 红线：
//   - 本页只渲染后端下发的非敏感字段（nickname/dept_name/points/total_steps），绝不渲染 _openid / phone / sync_count。
//   - 本地轨：getApp().api 不存在 → 提前 return 设空态；api.call 失败 → .catch 静默占位，不白屏不崩。
//   - admin 页是 navigateTo 进入（非 tabBar）。
const { buildDeptOptions, hasMore, formatPoints, DEFAULT_PAGE_SIZE } = require('./pointsCalc');
const { enterAdminGuard } = require('../../../utils/auth-guard');

Page({
  data: {
    pageLabel: '积分台账',
    // 列表 + 分页
    list: [],
    page: 1,
    pageSize: DEFAULT_PAGE_SIZE,
    hasMore: true,
    totalCount: 0,
    loading: true,
    loadingMore: false,
    // 筛选态
    keyword: '',
    deptId: '',
    deptOptions: [],
    deptPickerRange: [],
    deptPickerIndex: 0,
    // 调整弹窗态
    showAdjustSheet: false,
    currentUserId: '',
    currentUserNickname: '',
    currentPoints: 0,
    deltaInput: ''
  },

  onShow() {
    if (!enterAdminGuard('/pages/admin/points/points')) return;
    this.loadDeptOptions();
    this.loadPoints(true);
  },

  onPullDownRefresh() {
    // 等异步加载结束再停刷新动画。
    Promise.resolve(this.loadPoints(true)).finally(() => wx.stopPullDownRefresh());
  },

  /** 上拉加载更多。 */
  onReachBottom() {
    if (!this.data.hasMore || this.data.loadingMore || this.data.loading) return;
    this.loadPoints(false);
  },

  /** 关键字输入（不立即查询，点搜索才查）。 */
  onKeywordInput(e) {
    this.setData({ keyword: (e && e.detail && e.detail.value) || '' });
  },

  /** 关键字搜索（重置 page=1）。 */
  onKeywordSearch() {
    this.loadPoints(true);
  },

  /** 筛选部门 picker 变化（重置 page=1）。 */
  onDeptFilterChange(e) {
    const idx = Number((e && e.detail && e.detail.value) || 0);
    const options = this.data.deptOptions;
    const deptId = idx === 0 ? '' : (options[idx - 1] && options[idx - 1].dept_id) || '';
    this.setData({ deptPickerIndex: idx, deptId });
    this.loadPoints(true);
  },

  /** 打开「调整积分」弹窗。 */
  onOpenAdjust(e) {
    const ds = (e && e.currentTarget && e.currentTarget.dataset) || {};
    const userId = ds.userId;
    if (!userId) return;
    this.setData({
      showAdjustSheet: true,
      currentUserId: userId,
      currentUserNickname: ds.nickname || '',
      currentPoints: Number(ds.points) || 0,
      deltaInput: ''
    });
  },

  /** 输入变动值。 */
  onDeltaInput(e) {
    this.setData({ deltaInput: (e && e.detail && e.detail.value) || '' });
  },

  /** 取消调整。 */
  onAdjustCancel() {
    this.setData({ showAdjustSheet: false, currentUserId: '', deltaInput: '' });
  },

  /** 确认调整 → 二次确认 → admin.adjustPoints。 */
  onAdjustConfirm() {
    if (this._adjusting) return; // 防重锁
    const userId = this.data.currentUserId;
    if (!userId) return;
    // 解析 delta：允许 3 / +3 / -5 形式，须为整数。
    const raw = String(this.data.deltaInput || '').trim();
    if (!raw) {
      // 空输入会被 Number('')=0 当作合法 delta 通过，弹「加 0 分」无意义确认框且浪费一次云调用。
      wx.showToast({ title: '请输入变动值', icon: 'none' });
      return;
    }
    const deltaNum = Number(raw);
    if (!Number.isInteger(deltaNum)) {
      wx.showToast({ title: '请输入整数（可带正负号）', icon: 'none' });
      return;
    }
    const newPoints = (Number(this.data.currentPoints) || 0) + deltaNum;

    const app = getApp();
    const api = app && app.api;
    if (!api || typeof api.call !== 'function') {
      wx.showToast({ title: '云能力未就绪', icon: 'none' });
      return;
    }

    const run = () => {
      this._adjusting = true;
      this.setData({ showAdjustSheet: false });
      api
        .call('admin', { action: 'adjustPoints', user_id: userId, delta: deltaNum }, { loading: '保存中' })
        .then(() => {
          this._adjusting = false;
          // 本地刷新该行（不整表重拉，保留分页/筛选态）。
          const list = this.data.list.map((u) =>
            u && u._id === userId ? Object.assign({}, u, { points: (Number(u.points) || 0) + deltaNum, pointsText: formatPoints((Number(u.points) || 0) + deltaNum) }) : u
          );
          this.setData({ list, currentUserId: '', deltaInput: '' });
          wx.showToast({ title: '已调整（当前 ' + newPoints + ' 分）', icon: 'none' });
        })
        .catch((err) => {
          this._adjusting = false;
          this.setData({ currentUserId: '', deltaInput: '' });
          wx.showToast({ title: (err && err.message) || '调整失败，请重试', icon: 'none' });
        });
    };

    // 二次确认（积分误操作代价高）。
    wx.showModal({
      title: '调整积分',
      content:
        '确定给「' +
        (this.data.currentUserNickname || '该用户') +
        '」' +
        (deltaNum >= 0 ? '加 ' : '减 ') +
        Math.abs(deltaNum) +
        ' 分？',
      success: (res) => {
        if (res.confirm) run();
      }
    });
  },

  /**
   * 立即结算：调 admin.settlePoints（转发 tasks.pointSettle，按最终榜单结算）。
   * 活动未结束 / 已结算 / 榜单缺失均会被后端跳过，前端据返回态提示。
   */
  onSettle() {
    if (this._settling) return; // 防重锁
    const app = getApp();
    const api = app && app.api;
    if (!api || typeof api.call !== 'function') {
      wx.showToast({ title: '云能力未就绪', icon: 'none' });
      return;
    }
    // 必须锁定目标活动：activity_id 为空时后端回退 getActiveActivityId 可能结算到非目标活动（ended 活动往往已不是 current）。
    const settleActivityId = app.getActivityId && app.getActivityId();
    if (!settleActivityId) {
      wx.showToast({ title: '请先选择活动', icon: 'none' });
      return;
    }
    wx.showModal({
      title: '积分结算',
      content: '按当前最终榜单结算（个人榜前10名 +12/10/8/7/6/5/4/3/2/1，0步不发分；部门榜第1名部门成员每人 +2）。活动未结束将自动跳过。确定？',
      success: (res) => {
        if (!res.confirm) return;
        this._settling = true;
        api
          .call('admin', { action: 'settlePoints', activity_id: settleActivityId }, { loading: '结算中' })
          .then((data) => {
            this._settling = false;
            const d = data || {};
            const awardCount = (d.awards && d.awards.length) || 0;
            if (d.settled) {
              wx.showToast({ title: '已结算（' + awardCount + '笔奖励）', icon: 'none', duration: 2500 });
              this.loadPoints(true); // 结算后刷新台账
            } else if (d.alreadySettled) {
              wx.showToast({ title: '该活动积分已结算过', icon: 'none' });
            } else if (d.skipped === 'not-ended') {
              wx.showToast({ title: '活动未结束，暂不结算', icon: 'none' });
            } else if (d.skipped === 'no-rankcache') {
              wx.showToast({ title: '榜单数据缺失，请先刷新排行榜', icon: 'none' });
            } else {
              wx.showToast({ title: '结算完成', icon: 'none' });
            }
          })
          .catch((err) => {
            this._settling = false;
            wx.showToast({ title: (err && err.message) || '结算失败', icon: 'none' });
          });
      }
    });
  },

  /** 拉取部门选项（dept.list）。本地轨失败 → 静默空选项。 */
  loadDeptOptions() {
    const app = getApp();
    const api = app && app.api;
    if (!api || typeof api.call !== 'function') {
      this.setData({ deptOptions: [], deptPickerRange: ['全部'] });
      return;
    }
    api
      .call('dept', { action: 'list' }, { loading: false, silent: true })
      .then((data) => {
        const options = buildDeptOptions(data);
        const range = ['全部'].concat(options.map((o) => o.name));
        this.setData({ deptOptions: options, deptPickerRange: range });
      })
      .catch(() => {
        this.setData({ deptOptions: [], deptPickerRange: ['全部'] });
      });
  },

  /** 加载积分台账列表。reset=true 重置到第 1 页。 */
  loadPoints(reset) {
    const app = getApp();
    const api = app && app.api;
    if (!api || typeof api.call !== 'function') {
      this.setData({ loading: false, loadingMore: false, list: [], hasMore: false, totalCount: 0 });
      return;
    }
    const page = reset ? 1 : this.data.page;
    if (reset) {
      this.setData({ loading: true });
    } else {
      this.setData({ loadingMore: true });
    }
    return api
      .call(
        'admin',
        {
          action: 'points',
          activity_id: app.getActivityId(),
          dept_id: this.data.deptId,
          keyword: this.data.keyword,
          page,
          page_size: this.data.pageSize
        },
        { loading: false, silent: true }
      )
      .then((data) => {
        const d = data || {};
        const list = Array.isArray(d.list) ? d.list : [];
        // 附加展示文案（pointsText / totalStepsText）。
        list.forEach((u) => {
          u.pointsText = formatPoints(u.points);
          u.totalStepsText = String(u.total_steps || 0);
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
        // 本地轨：云函数未部署 → 空态占位，不弹错误。
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
