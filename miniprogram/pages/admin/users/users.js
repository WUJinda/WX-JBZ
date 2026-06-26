// pages/admin/users/users.js
// 后台用户管理：列表 + 筛选（关键字/部门）+ 分页 + 改部门（对齐 PRD F8 R8.3，开发计划阶段 H3）。
//
// 对接 admin.users（queryUsers 输出 list:[{_id,nickname,avatar,phone_masked,dept_id,join_status,joined_at,created_at}], totalCount）
// 改部门对接 admin.changeDept（changeUserDept 输出 {userId, deptId, updatedAt}）。
// 部门选项复用 dept.list（员工可见的同一数据源）。
//
// 红线：
//   - 本页只渲染后端下发的脱敏字段 phone_masked（非完整 phone），绝不渲染 _openid / sync_count。
//   - 本地轨：getApp().api 不存在 → 提前 return 设空态；api.call 失败 → .catch 静默占位，不白屏不崩。
//   - admin 页是 navigateTo 进入（非 tabBar）。
const { buildDeptOptions, hasMore, formatJoinStatus, DEFAULT_PAGE_SIZE } = require('./usersCalc');

const ACTIVITY_ID = 'a_demo_001';

Page({
  data: {
    pageLabel: '用户管理',
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
    deptId: '', // 筛选部门 id（空=全部）
    deptOptions: [], // [{dept_id,name}]（dept.list 投影）
    deptPickerRange: [], // picker 显示用：['全部', '研发部', ...]
    deptPickerIndex: 0, // 当前 picker 选中下标（0=全部）
    // 改部门弹窗态
    showDeptPicker: false,
    currentUserId: '', // 正在改部门的用户 _id
    currentDeptId: '', // 正在改部门的用户当前 dept_id
    changeDeptRange: [], // picker 显示用：['研发部', ...]（不含「全部」）
    changeDeptIndex: 0
  },

  onShow() {
    // 首次进入：同时拉用户列表与部门选项。
    this.loadDeptOptions();
    this.loadUsers(true);
  },

  onPullDownRefresh() {
    this.loadUsers(true);
    wx.stopPullDownRefresh();
  },

  /** 上拉加载更多。 */
  onReachBottom() {
    if (!this.data.hasMore || this.data.loadingMore || this.data.loading) return;
    this.loadUsers(false);
  },

  /** 关键字输入（不立即查询，点搜索才查）。 */
  onKeywordInput(e) {
    this.setData({ keyword: (e && e.detail && e.detail.value) || '' });
  },

  /** 关键字搜索（重置 page=1）。 */
  onKeywordSearch() {
    this.loadUsers(true);
  },

  /** 筛选部门 picker 变化（重置 page=1）。 */
  onDeptFilterChange(e) {
    const idx = Number((e && e.detail && e.detail.value) || 0);
    const options = this.data.deptOptions;
    // 下标 0 = 全部（deptId 空）；其余下标对应 deptOptions。
    const deptId = idx === 0 ? '' : (options[idx - 1] && options[idx - 1].dept_id) || '';
    this.setData({ deptPickerIndex: idx, deptId });
    this.loadUsers(true);
  },

  /** 打开「改部门」picker。 */
  onOpenDeptPicker(e) {
    const userId = e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.userId;
    const deptId = e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.deptId;
    if (!userId) return;
    const options = this.data.deptOptions;
    const range = options.map((d) => d.name);
    let idx = options.findIndex((d) => d.dept_id === deptId);
    if (idx < 0) idx = 0;
    this.setData({
      showDeptPicker: true,
      currentUserId: userId,
      currentDeptId: deptId || '',
      changeDeptRange: range,
      changeDeptIndex: idx
    });
  },

  /** 改部门 picker 变化。 */
  onChangeDeptPickerChange(e) {
    const idx = Number((e && e.detail && e.detail.value) || 0);
    this.setData({ changeDeptIndex: idx });
  },

  /** 取消改部门。 */
  onChangeDeptCancel() {
    this.setData({ showDeptPicker: false, currentUserId: '', currentDeptId: '' });
  },

  /** 确认改部门 → admin.changeDept。 */
  onChangeDeptConfirm() {
    const userId = this.data.currentUserId;
    if (!userId) return;
    const options = this.data.deptOptions;
    const deptId = (options[this.data.changeDeptIndex] && options[this.data.changeDeptIndex].dept_id) || '';
    if (!deptId) {
      this.setData({ showDeptPicker: false });
      return;
    }

    const app = getApp();
    const api = app && app.api;
    if (!api || typeof api.call !== 'function') {
      // 无云能力 → 静默占位（不崩）。
      wx.showToast({ title: '云能力未就绪', icon: 'none' });
      this.setData({ showDeptPicker: false });
      return;
    }

    api
      .call(
        'admin',
        { action: 'changeDept', user_id: userId, dept_id: deptId },
        { loading: '保存中' }
      )
      .then(() => {
        this.setData({ showDeptPicker: false, currentUserId: '', currentDeptId: '' });
        wx.showToast({ title: '已更新', icon: 'success' });
        // 刷新当前列表（重置到第 1 页，保持筛选态）。
        this.loadUsers(true);
      })
      .catch(() => {
        // 本地轨：云函数未部署 → 静默占位，不白屏。
        this.setData({ showDeptPicker: false });
        wx.showToast({ title: '更新失败，请重试', icon: 'none' });
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
        const d = data || {};
        const options = buildDeptOptions(d);
        const range = ['全部'].concat(options.map((o) => o.name));
        this.setData({ deptOptions: options, deptPickerRange: range });
      })
      .catch(() => {
        // 本地轨：dept 云函数未部署 → 静默空选项。
        this.setData({ deptOptions: [], deptPickerRange: ['全部'] });
      });
  },

  /** 加载用户列表。reset=true 重置到第 1 页。 */
  loadUsers(reset) {
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
          action: 'users',
          activity_id: ACTIVITY_ID,
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
        // 为每条记录附加状态文案（phone_masked 直接用后端下发脱敏值，不再二次掩码）。
        list.forEach((u) => {
          u.joinStatusText = formatJoinStatus(u.join_status);
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
