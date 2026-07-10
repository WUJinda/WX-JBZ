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
  contribution,
  switchMetric,
  formatUpdatedAt,
  DEFAULT_PAGE_SIZE
} = require('./rankCalc');
const { buildDayList, defaultDayKey } = require('./rankDayList');
const { hasMore } = require('../../utils/pagination');
const { handleNotLoggedIn } = require('../../utils/authGuard');

Page({
  data: {
    // Tab：个人榜 / 部门榜
    tab: 'personal',
    // 同页视图切换：list（榜单）/ members（部门明细）
    viewMode: 'list',
    // 个人榜二级 Tab：total 累计榜（现状）/ today 今日榜（按日，带日期选择器）
    subTab: 'total',
    // 个人榜
    personalList: [],
    personalPage: 1,
    personalPageSize: DEFAULT_PAGE_SIZE,
    personalHasMore: true,
    myRank: null, // {rank, user_id, total_steps, ...} | null
    // 今日榜日期选择器（仅 subTab==='today'）：活动期 start~今天 的日期列表
    dayList: [], // [{key:'YYYY-MM-DD', label:'M.D', ts, isToday}]
    selectedDay: '', // 选中日期 key（默认今天）
    dayScrollInto: '', // 日期选择器 scroll-into-view 目标 id
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
      this.ensureDayList(); // 今日榜日期列表（累计榜模式也预取，切「今日榜」即用）
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

  /** 切换二级 Tab：累计榜 / 今日榜（仅个人榜）。 */
  onSubTabSwitch(e) {
    const sub = e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.sub;
    if (sub !== 'total' && sub !== 'today') return;
    if (sub === this.data.subTab) return;
    this.setData({ subTab: sub });
    if (sub === 'today') {
      // 进入今日榜：日期列表未就绪则补拉；已就绪则把选中项滚进视口。
      if (this.data.dayList.length === 0) {
        this.ensureDayList();
      } else {
        this.setData({
          dayScrollInto: this.scrollIdForKey(this.data.dayList, this.data.selectedDay)
        });
      }
    }
    // 今日榜「按日榜单」数据后写：UI 外壳阶段复用累计 personalList 占位渲染，
    // 切二级 Tab / 切日期均不重新拉取列表，仅切换选中态。
  },

  /** 点日期：切换选中（UI 外壳；按日榜单数据后写）。 */
  onDayPick(e) {
    const key = e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.key;
    if (!key || key === this.data.selectedDay) return;
    this.setData({
      selectedDay: key,
      dayScrollInto: this.scrollIdForKey(this.data.dayList, key)
    });
  },

  /**
   * 生成今日榜日期列表（活动期 start~今天）。
   * 优先读 globalData.currentActivity；时间窗口缺失则兜底调 activity.current（游客可调，无 1002）。
   */
  ensureDayList() {
    const app = getApp();
    const ga = (app && app.globalData && app.globalData.currentActivity) || {};
    const list = buildDayList(ga, Date.now());
    if (list.length > 0) {
      this.applyDayList(list);
      return;
    }
    const api = app && app.api;
    if (!api || typeof api.call !== 'function') return;
    api
      .call('activity', { action: 'current' }, { loading: false, silent: true })
      .then((data) => {
        if (!data) return;
        // 回写 globalData（同 home.fetchActivityStatus，后续 onShow/他页复用，避免重复补拉）。
        if (app && app.globalData) {
          app.globalData.currentActivity = {
            activity_id: data.activity_id || ga.activity_id || '',
            name: data.name || ga.name || '',
            start_time: data.start_time != null ? data.start_time : ga.start_time,
            end_time: data.end_time != null ? data.end_time : ga.end_time,
            status: data.status || ga.status || ''
          };
        }
        this.applyDayList(buildDayList(data, Date.now()));
      })
      .catch(() => {
        // activity.current 游客可调、不抛 1002；失败静默（日期选择器维持空态）。
      });
  },

  /** 应用日期列表到 data：保留已选且仍存在的日期，否则取默认（今天/最近一天）。 */
  applyDayList(list) {
    const prev = this.data.selectedDay;
    const key = prev && list.some((d) => d.key === prev) ? prev : defaultDayKey(list);
    this.setData({
      dayList: list,
      selectedDay: key,
      dayScrollInto: this.scrollIdForKey(list, key)
    });
  },

  /** 日期项 scroll-into-view 目标 id（'day-<index>'；未命中 → ''）。 */
  scrollIdForKey(list, key) {
    const arr = Array.isArray(list) ? list : [];
    const idx = arr.findIndex((d) => d && d.key === key);
    return idx >= 0 ? 'day-' + idx : '';
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
        this.setData({
          personalList: merged,
          personalPage: page + 1,
          personalHasMore: hasMore(list.length, this.data.personalPageSize),
          myRank,
          updatedAt: formatUpdatedAt(d.updatedAt),
          loading: false,
          loadingMore: false,
          errorMsg: ''
        });
      })
      .catch((err) => {
        // 1002 未登录 → 守卫引导登录（rank.* 需登录态）。
        if (handleNotLoggedIn(err)) return;
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
        // 1002 未登录 → 守卫引导登录；否则占位（myRank 空，贡献占比 0）。
        if (handleNotLoggedIn(e)) return;
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
      .catch((err) => {
        if (handleNotLoggedIn(err)) return;
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
      .catch((err) => {
        if (handleNotLoggedIn(err)) return;
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
