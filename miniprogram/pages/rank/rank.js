// pages/rank/rank.js
// 排行榜页（对齐 PRD F5/F6，开发计划阶段 G2）。
// F5 个人榜：Tab 切换、Top 列表、分页上拉、我的排名条固定底部、更新时间、空态。
// F6 部门榜：部门列表、metric avg/total 切换、small_sample 标注、我的部门卡（排名+贡献占比）。
// F6 部门明细：点部门切同页 members 视图，本人 is_me 高亮。
//
// 红线：
//   - 本页只渲染后端下发的脱敏字段（nickname 已脱敏），绝不渲染 _openid/完整 phone/sync_count。
//   - 本地轨云函数未部署：加载失败 → 静默 catch → 空态占位，不白屏不崩（照 home.loadStats 模式）。
//   - rank 页是 tabBar 页（app.json tabBar.list），不使用 navigateTo 进入。
const {
  pickNeighbors,
  contribution,
  switchMetric,
  formatUpdatedAt,
  DEFAULT_PAGE_SIZE
} = require('./rankCalc');
const { hasMore } = require('../../utils/pagination');

Page({
  data: {
    // Tab：个人榜 / 部门榜
    tab: 'personal',
    // 同页视图切换：list（榜单）/ members（部门明细）
    viewMode: 'list',
    // 个人榜
    personalList: [],
    personalPage: 1,
    personalPageSize: DEFAULT_PAGE_SIZE,
    personalHasMore: true,
    myRank: null, // {rank, user_id, total_steps, ...} | null
    myNeighbors: [], // 我的排名条前后相邻名次（pickNeighbors 输出）
    // 部门榜
    deptList: [],
    deptPage: 1,
    deptPageSize: DEFAULT_PAGE_SIZE,
    deptHasMore: true,
    metric: 'avg', // avg | total
    myDeptRank: null, // {rank, dept_id, total_steps, avg_steps, member_count, ...} | null
    myDeptContribution: 0, // 我的贡献占比 %
    // 部门明细
    currentDept: null, // {dept_id, dept_name}
    memberList: [],
    memberPage: 1,
    memberPageSize: DEFAULT_PAGE_SIZE,
    memberHasMore: true,
    // 通用
    updatedAt: '',
    loading: false,
    loadingMore: false,
    errorMsg: ''
  },

  onShow() {
    // 进入 tab 首次加载对应榜；切换 tab 时由 switchTab 触发加载。
    if (this.data.tab === 'personal') {
      this.loadPersonal(true);
    } else {
      this.loadDept(true);
    }
  },

  onPullDownRefresh() {
    if (this.data.viewMode === 'members') {
      this.loadDeptMembers(true);
    } else if (this.data.tab === 'personal') {
      this.loadPersonal(true);
    } else {
      this.loadDept(true);
    }
    wx.stopPullDownRefresh();
  },

  /** 切换 Tab：个人榜 / 部门榜。 */
  onTabSwitch(e) {
    const tab = e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.tab;
    if (tab !== 'personal' && tab !== 'dept') return;
    if (tab === this.data.tab) return;
    this.setData({ tab, viewMode: 'list' });
    if (tab === 'personal') {
      this.loadPersonal(true);
    } else {
      this.loadDept(true);
    }
  },

  /** 上拉加载更多：按当前 Tab/视图分页。 */
  onReachBottom() {
    if (this.data.viewMode === 'members') {
      if (!this.data.memberHasMore || this.data.loadingMore) return;
      this.loadDeptMembers(false);
      return;
    }
    if (this.data.tab === 'personal') {
      if (!this.data.personalHasMore || this.data.loadingMore) return;
      this.loadPersonal(false);
    } else {
      if (!this.data.deptHasMore || this.data.loadingMore) return;
      this.loadDept(false);
    }
  },

  /** 切换 metric：avg / total（仅部门榜）。 */
  onMetricSwitch(e) {
    const m = e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.metric;
    const metric = switchMetric(m);
    if (metric === this.data.metric) return;
    this.setData({ metric });
    this.loadDept(true);
  },

  /** 点部门 → 切到明细视图并加载成员。 */
  onDeptTap(e) {
    const deptId = e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.deptId;
    const deptName = e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.deptName;
    if (!deptId) return;
    this.setData({
      viewMode: 'members',
      currentDept: { dept_id: deptId, dept_name: deptName || '' },
      memberList: [],
      memberPage: 1,
      memberHasMore: true
    });
    this.loadDeptMembers(true);
  },

  /** 返回部门列表。 */
  onBackToList() {
    this.setData({ viewMode: 'list', currentDept: null, memberList: [] });
  },

  /** 加载个人榜。reset=true 重新加载第 1 页。 */
  loadPersonal(reset) {
    const app = getApp();
    const api = app && app.api;
    if (!api || typeof api.call !== 'function') {
      // 无云能力 → 空态占位（不崩）。
      this.setData({
        personalList: [],
        personalHasMore: false,
        errorMsg: ''
      });
      return;
    }
    const page = reset ? 1 : this.data.personalPage;
    if (reset) {
      this.setData({ loading: true, errorMsg: '' });
    } else {
      this.setData({ loadingMore: true });
    }
    api
      .call(
        'rank',
        {
          action: 'personal',
          activity_id: app.getActivityId(),
          page,
          page_size: this.data.personalPageSize
        },
        { loading: false, silent: true }
      )
      .then((data) => {
        const d = data || {};
        const list = Array.isArray(d.list) ? d.list : [];
        const merged = reset ? list : this.data.personalList.concat(list);
        const myRank = d.myRank || null;
        // 我的排名条前后相邻：基于已加载列表 + myRank.user_id 定位。
        const myUserId = myRank && myRank.user_id;
        const neighbors = myUserId ? pickNeighbors(merged, myUserId, 1) : [];
        this.setData({
          personalList: merged,
          personalPage: page + 1,
          personalHasMore: hasMore(list.length, this.data.personalPageSize),
          myRank,
          myNeighbors: neighbors,
          updatedAt: formatUpdatedAt(d.updatedAt),
          loading: false,
          loadingMore: false,
          errorMsg: ''
        });
      })
      .catch(() => {
        // 本地轨：云函数未部署 → 空态占位，不弹错误（照 home.loadStats 模式）。
        this.setData({
          loading: false,
          loadingMore: false,
          personalList: reset ? [] : this.data.personalList,
          personalHasMore: false,
          myRank: reset ? null : this.data.myRank,
          updatedAt: ''
        });
      });
  },

  /** 加载部门榜。reset=true 重新加载第 1 页。 */
  async loadDept(reset) {
    const app = getApp();
    const api = app && app.api;
    if (!api || typeof api.call !== 'function') {
      this.setData({ deptList: [], deptHasMore: false, errorMsg: '' });
      return;
    }
    // P1-12：部门榜「我的贡献」依赖 myRank.total_steps；若空（用户直进 dept tab 未加载 personal），
    //   先单独查 personal 拿本人 total_steps，避免贡献占比恒 0。
    if (!(this.data.myRank && this.data.myRank.total_steps != null)) {
      try {
        const pd = await api.call(
          'rank',
          { action: 'personal', activity_id: app.getActivityId(), page: 1, page_size: 1 },
          { loading: false, silent: true }
        );
        const myRank = (pd && pd.myRank) || null;
        if (myRank) this.setData({ myRank });
      } catch (e) {
        // 占位：myRank 保持空，贡献占比显示 0。
      }
    }
    const page = reset ? 1 : this.data.deptPage;
    if (reset) {
      this.setData({ loading: true, errorMsg: '' });
    } else {
      this.setData({ loadingMore: true });
    }
    api
      .call(
        'rank',
        {
          action: 'dept',
          activity_id: app.getActivityId(),
          metric: this.data.metric,
          page,
          page_size: this.data.deptPageSize
        },
        { loading: false, silent: true }
      )
      .then((data) => {
        const d = data || {};
        const list = Array.isArray(d.list) ? d.list : [];
        const merged = reset ? list : this.data.deptList.concat(list);
        const myDeptRank = d.myDeptRank || null;
        // 我的贡献占比：myRank.total_steps / myDeptRank.total_steps（同口径累计）。
        let myDeptContribution = 0;
        const mySteps = this.data.myRank && this.data.myRank.total_steps;
        const deptTotal = myDeptRank && myDeptRank.total_steps;
        if (mySteps != null && deptTotal != null) {
          myDeptContribution = contribution(mySteps, deptTotal);
        }
        this.setData({
          deptList: merged,
          deptPage: page + 1,
          deptHasMore: hasMore(list.length, this.data.deptPageSize),
          myDeptRank,
          myDeptContribution,
          updatedAt: formatUpdatedAt(d.updatedAt),
          loading: false,
          loadingMore: false,
          errorMsg: ''
        });
      })
      .catch(() => {
        this.setData({
          loading: false,
          loadingMore: false,
          deptList: reset ? [] : this.data.deptList,
          deptHasMore: false,
          myDeptRank: reset ? null : this.data.myDeptRank,
          updatedAt: ''
        });
      });
  },

  /** 加载部门明细（部门内成员排名）。reset=true 重新加载第 1 页。 */
  loadDeptMembers(reset) {
    const deptId = this.data.currentDept && this.data.currentDept.dept_id;
    if (!deptId) return;
    const app = getApp();
    const api = app && app.api;
    if (!api || typeof api.call !== 'function') {
      this.setData({ memberList: [], memberHasMore: false, errorMsg: '' });
      return;
    }
    const page = reset ? 1 : this.data.memberPage;
    if (reset) {
      this.setData({ loading: true, errorMsg: '' });
    } else {
      this.setData({ loadingMore: true });
    }
    api
      .call(
        'rank',
        {
          action: 'deptMembers',
          activity_id: app.getActivityId(),
          dept_id: deptId,
          page,
          page_size: this.data.memberPageSize
        },
        { loading: false, silent: true }
      )
      .then((data) => {
        const d = data || {};
        const list = Array.isArray(d.list) ? d.list : [];
        const merged = reset ? list : this.data.memberList.concat(list);
        this.setData({
          memberList: merged,
          memberPage: page + 1,
          memberHasMore: hasMore(list.length, this.data.memberPageSize),
          updatedAt: formatUpdatedAt(d.updatedAt),
          loading: false,
          loadingMore: false,
          errorMsg: ''
        });
      })
      .catch(() => {
        this.setData({
          loading: false,
          loadingMore: false,
          memberList: reset ? [] : this.data.memberList,
          memberHasMore: false,
          updatedAt: ''
        });
      });
  }
});
