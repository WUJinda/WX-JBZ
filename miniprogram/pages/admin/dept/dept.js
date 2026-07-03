// pages/admin/dept/dept.js
// 后台部门管理：列表 + 新建/编辑/删除（对齐 PRD F8 部门管理，开发计划阶段 H3）。
//
// 对接 dept.list（listDepartments 输出 {list:[{dept_id,name,member_count}]}）。
// 增删改对接 admin.deptManage（createDept/updateDept/deleteDept，op 区分）。
//
// 红线：
//   - 本页只展示部门字段（dept_id/name/member_count），无敏感字段，绝不渲染 _openid / phone。
//   - 本地轨：getApp().api 不存在 → 提前 return 设空态；api.call 失败 → .catch 静默占位，不白屏不崩。
//   - admin 页是 navigateTo 进入（非 tabBar）。
const { validateDeptName, formatDept } = require('./deptCalc');
const { enterAdminGuard } = require('../../../utils/auth-guard');

Page({
  data: {
    pageLabel: '部门管理',
    // 列表
    list: [], // [{dept_id,name,memberCountText}]
    loading: true,
    // 弹窗态
    showForm: false,
    editingDept: '', // 空=新建；有值=编辑该 dept_id
    formName: '',
    formError: ''
  },

  onShow() {
    if (!enterAdminGuard('/pages/admin/dept/dept')) return;
    this.loadDeptList();
  },

  onPullDownRefresh() {
    this.loadDeptList();
    wx.stopPullDownRefresh();
  },

  /** 打开新建弹窗。 */
  onCreate() {
    this.setData({ showForm: true, editingDept: '', formName: '', formError: '' });
  },

  /** 打开编辑弹窗。 */
  onEdit(e) {
    const deptId = e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.deptId;
    const name = e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.name;
    if (!deptId) return;
    this.setData({ showForm: true, editingDept: deptId, formName: name || '', formError: '' });
  },

  /** 表单输入。 */
  onFormNameInput(e) {
    this.setData({ formName: (e && e.detail && e.detail.value) || '', formError: '' });
  },

  /** 取消表单。 */
  onFormCancel() {
    this.setData({ showForm: false, editingDept: '', formName: '', formError: '' });
  },

  /** 确认提交：新建或编辑 → admin.deptManage。 */
  onFormConfirm() {
    if (this._savingDept) return; // P2 防重锁
    const { valid, error } = validateDeptName(this.data.formName);
    if (!valid) {
      this.setData({ formError: error });
      return;
    }

    const editingDept = this.data.editingDept;
    const op = editingDept ? 'update' : 'create';

    const app = getApp();
    const api = app && app.api;
    if (!api || typeof api.call !== 'function') {
      // 无云能力 → 静默占位（不崩）。
      wx.showToast({ title: '云能力未就绪', icon: 'none' });
      this.setData({ showForm: false });
      return;
    }

    const params = { action: 'deptManage', op, activity_id: getApp().getActivityId(), name: this.data.formName };
    if (editingDept) params.dept_id = editingDept;

    this._savingDept = true; // P2 防重锁（避免快速双击重复 create/update）
    api
      .call('admin', params, { loading: '保存中' })
      .then(() => {
        this._savingDept = false;
        this.setData({ showForm: false, editingDept: '', formName: '', formError: '' });
        wx.showToast({ title: '已保存', icon: 'success' });
        this.loadDeptList();
      })
      .catch(() => {
        this._savingDept = false;
        // 本地轨：云函数未部署 → 静默占位，不白屏。
        this.setData({ showForm: false });
        wx.showToast({ title: '保存失败，请重试', icon: 'none' });
      });
  },

  /** 删除部门（二次确认）。 */
  onDelete(e) {
    const deptId = e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.deptId;
    if (!deptId) return;
    wx.showModal({
      title: '删除部门',
      content: '确认删除该部门？',
      success: (res) => {
        if (!res || !res.confirm) return;
        this.doDelete(deptId);
      }
    });
  },

  /** 执行删除 → admin.deptManage。 */
  doDelete(deptId) {
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
        { action: 'deptManage', op: 'delete', dept_id: deptId },
        { loading: '删除中' }
      )
      .then(() => {
        wx.showToast({ title: '已删除', icon: 'success' });
        this.loadDeptList();
      })
      .catch(() => {
        // 本地轨：云函数未部署 → 静默占位，不白屏。
        wx.showToast({ title: '删除失败，请重试', icon: 'none' });
      });
  },

  /** 加载部门列表（dept.list）。本地轨失败 → 静默空态。 */
  loadDeptList() {
    const app = getApp();
    const api = app && app.api;
    if (!api || typeof api.call !== 'function') {
      // 无云能力 → 空态占位（不崩）。
      this.setData({ loading: false, list: [] });
      return;
    }
    this.setData({ loading: true });
    api
      .call('dept', { action: 'list' }, { loading: false, silent: true })
      .then((data) => {
        const d = data || {};
        const list = Array.isArray(d.list) ? d.list.map(formatDept) : [];
        this.setData({ loading: false, list });
      })
      .catch(() => {
        // 本地轨：dept 云函数未部署 → 静默空态占位。
        this.setData({ loading: false, list: [] });
      });
  }
});
