// pages/admin/activity/activity.js
// 后台活动配置：表单 + 发布 + 终止（对齐 PRD F8 R8.1，开发计划阶段 H2）。
//
// 对接 activity.save / activity.get / activity.terminate。
// 表单先经纯函数 validateActivityForm 校验，通过才调 api.call。
//
// 红线：
//   - 本页只展示/提交活动配置字段（name/start_time/end_time/signup_deadline/rules/publish），无敏感字段。
//   - 进入即调 activity.get 回填现有活动（修「无法修改」根因——此前 onLoad 只取 id 不回填）。
//   - 本地轨：getApp().api 不存在 → 占位提示；api.call 失败 → .catch 错误提示，不白屏。
const { validateActivityForm, formatPublishState, toDateTime } = require('./activityCalc');
const { enterAdminGuard } = require('../../../utils/auth-guard');

/** 后端 ISO/日期串 → picker 用的 YYYY-MM-DD（取前 10 位；空值返回空串）。 */
function toDate(v) {
  if (!v || typeof v !== 'string') return '';
  return v.slice(0, 10);
}

Page({
  data: {
    pageLabel: '活动配置',
    // 表单字段
    activityId: '',
    name: '',
    start_time: '', // YYYY-MM-DD
    end_time: '', // YYYY-MM-DD
    signup_deadline: '', // YYYY-MM-DD（可选，空=结束前可报）
    rules: '',
    publish: false,
    terminated: false, // 活动是否已手动终止（控制「终止活动」按钮显隐）
    // 状态
    submitting: false,
    terminating: false,
    deleting: false,
    errorMsg: '',
    formErrors: {}, // {name, startEnd, ...}
    publishText: '未发布'
  },

  onLoad(options) {
    if (!enterAdminGuard('/pages/admin/activity/activity')) return;
    // 列表页点「新建活动」进来无 id（新建模式）；点列表项带 ?id=xxx 进来（编辑模式，回填该活动）。
    const id = (options && options.id) || '';
    this.setData({
      activityId: id,
      pageLabel: id ? '编辑活动' : '新建活动'
    });
    this.refreshPublishText();
    this.loadDetail();
  },

  /** 拉取现有活动回填表单（修「无法修改」根因）。本地轨/未发布/无活动 → 留空表单当新建。 */
  loadDetail() {
    if (!this.data.activityId) return; // 无活动 → 新建模式，不回填
    const app = getApp();
    const api = app && app.api;
    if (!api || typeof api.call !== 'function') return; // 本地轨 → 留空
    api
      .call('activity', { action: 'get', activity_id: this.data.activityId }, { loading: false, silent: true })
      .then((d) => {
        if (!d) return;
        this.setData({
          name: d.name || '',
          start_time: toDate(d.start_time),
          end_time: toDate(d.end_time),
          signup_deadline: toDate(d.signup_deadline),
          rules: d.rules || '',
          terminated: d.terminated === true
        });
      })
      .catch(() => {
        // 回填失败不阻断（留空表单，管理员可当新建重填）。
      });
  },

  /** 名称输入。 */
  onNameInput(e) {
    this.setData({ name: (e && e.detail && e.detail.value) || '' });
  },

  /** 开始时间 picker。 */
  onStartChange(e) {
    this.setData({ start_time: (e && e.detail && e.detail.value) || '' });
  },

  /** 结束时间 picker。 */
  onEndChange(e) {
    this.setData({ end_time: (e && e.detail && e.detail.value) || '' });
  },

  /** 报名截止 picker（可选）。 */
  onSignupChange(e) {
    this.setData({ signup_deadline: (e && e.detail && e.detail.value) || '' });
  },

  /** 规则 textarea。 */
  onRulesInput(e) {
    this.setData({ rules: (e && e.detail && e.detail.value) || '' });
  },

  /** 发布 switch。 */
  onPublishChange(e) {
    const v = !!(e && e.detail && e.detail.value);
    this.setData({ publish: v, publishText: formatPublishState(v) });
  },

  refreshPublishText() {
    this.setData({ publishText: formatPublishState(this.data.publish) });
  },

  /** 保存：先前端校验，通过才调 activity.save。 */
  onSave() {
    if (this.data.submitting) return;
    const form = {
      name: this.data.name,
      start_time: this.data.start_time,
      end_time: this.data.end_time,
      signup_deadline: this.data.signup_deadline
    };
    const { valid, errors } = validateActivityForm(form);
    if (!valid) {
      this.setData({ formErrors: errors });
      return;
    }
    this.setData({ formErrors: {}, errorMsg: '' });

    const app = getApp();
    const api = app && app.api;
    if (!api || typeof api.call !== 'function') {
      // 无云能力 → 占位提示（不崩）。
      this.setData({ errorMsg: '云能力未就绪，无法保存' });
      return;
    }

    const isNew = !this.data.activityId; // 空 activity_id 视为新建（后端 save 为 upsert）
    this.setData({ submitting: true });
    api
      .call(
        'activity',
        {
          action: 'save',
          activity_id: this.data.activityId,
          name: this.data.name,
          // E1：picker 纯日期串补 +08:00 时区再传后端，否则 Date.parse 按 UTC 解析致活动
          //   在北京时间结束日早 8 点就翻 ENDED（同步被截断 / 排名提前冻结）。
          start_time: toDateTime(this.data.start_time, false),
          end_time: toDateTime(this.data.end_time, true),
          signup_deadline: this.data.signup_deadline ? toDateTime(this.data.signup_deadline, true) : null,
          rules: this.data.rules,
          publish: this.data.publish
        },
        { loading: '保存中' }
      )
      .then((data) => {
        const d = data || {};
        this.setData({ submitting: false, errorMsg: '', activityId: d.activity_id || this.data.activityId });
        // 刷新全局活动上下文：用 save 返回（优先）回写，让 home/activity 页立即感知新活动；
        // 置 _activityDirty：activity 页 onShow 探测到则强制重拉，绕过 30s 节流，跳过去即见最新。
        const app = getApp();
        if (app && app.globalData) {
          app.globalData.currentActivity = {
            activity_id: d.activity_id || this.data.activityId || '',
            name: d.name || this.data.name || '',
            start_time: d.start_time != null ? d.start_time : this.data.start_time,
            end_time: d.end_time != null ? d.end_time : this.data.end_time,
            // 2026-10-26：与 activity/home/rank 回写同口径补 terminated；save 投影未下发该字段
            // 时为 false（刚保存的活动非终止态），_activityDirty 触发的 current 重拉会立即纠偏。
            terminated: d.terminated === true,
            status: d.status || ''
          };
          app.globalData._activityDirty = true;
        }
        wx.showToast({ title: isNew ? '活动已创建' : '已保存', icon: 'success' });
        // 返回列表页（栈里必为列表页：dashboard→list→activity），列表 onShow 自动刷新见新数据。
        setTimeout(() => {
          if (typeof wx !== 'undefined' && wx.navigateBack) {
            wx.navigateBack({ delta: 1 });
          }
        }, 600);
      })
      .catch((err) => {
        // 本地轨：activity.save 后端缺口 / 云函数未部署 → 错误提示，不白屏。
        this.setData({
          submitting: false,
          errorMsg: (err && err.message) || '保存失败，请稍后重试'
        });
      });
  },

  /** 终止活动（不可恢复）：二次确认 → activity.terminate。 */
  onTerminate() {
    if (this.data.terminating) return;
    if (!this.data.activityId) return;
    if (typeof wx === 'undefined' || !wx.showModal) return;
    wx.showModal({
      title: '终止活动',
      content: '终止后活动立即结束、停止步数同步、榜单冻结，且不可恢复。确认终止？',
      confirmText: '终止',
      confirmColor: '#e64340',
      success: (res) => {
        if (!res || !res.confirm) return;
        this.doTerminate();
      }
    });
  },

  doTerminate() {
    const app = getApp();
    const api = app && app.api;
    if (!api || typeof api.call !== 'function') {
      this.setData({ errorMsg: '云能力未就绪，无法终止' });
      return;
    }
    this.setData({ terminating: true, errorMsg: '' });
    api
      .call('activity', { action: 'terminate', activity_id: this.data.activityId }, { loading: '终止中' })
      .then(() => {
        this.setData({ terminating: false, terminated: true });
        const app = getApp();
        if (app && app.globalData) {
          app.globalData._activityDirty = true; // activity 页重拉即见「已结束」
        }
        wx.showToast({ title: '活动已终止', icon: 'success' });
        // 返回列表页，列表 onShow 刷新即见红色「已终止」标签。
        setTimeout(() => {
          if (typeof wx !== 'undefined' && wx.navigateBack) {
            wx.navigateBack({ delta: 1 });
          }
        }, 600);
      })
      .catch((err) => {
        this.setData({
          terminating: false,
          errorMsg: (err && err.message) || '终止失败，请稍后重试'
        });
      });
  },

  /** 删除活动（硬删除，不可恢复，连带清步数/榜单/部门）：二次确认 → activity.delete。 */
  onDelete() {
    if (this.data.deleting) return;
    if (!this.data.activityId) return;
    if (typeof wx === 'undefined' || !wx.showModal) return;
    const name = this.data.name || '该活动';
    wx.showModal({
      title: '删除活动',
      content: '将永久删除活动「' + name + '」及其全部步数记录、榜单、部门，不可恢复。确定删除？',
      confirmText: '删除',
      confirmColor: '#e64340',
      success: (res) => {
        if (!res || !res.confirm) return;
        this.doDelete();
      }
    });
  },

  doDelete() {
    const app = getApp();
    const api = app && app.api;
    if (!api || typeof api.call !== 'function') {
      this.setData({ errorMsg: '云能力未就绪，无法删除' });
      return;
    }
    this.setData({ deleting: true, errorMsg: '' });
    api
      .call('activity', { action: 'delete', activity_id: this.data.activityId }, { loading: '删除中' })
      .then(() => {
        this.setData({ deleting: false });
        const app = getApp();
        if (app && app.globalData) {
          app.globalData._activityDirty = true; // activity 页重拉即见活动已消失
        }
        wx.showToast({ title: '已删除', icon: 'success' });
        // 返回列表页，列表 onShow 刷新即见该活动消失。
        setTimeout(() => {
          if (typeof wx !== 'undefined' && wx.navigateBack) {
            wx.navigateBack({ delta: 1 });
          }
        }, 600);
      })
      .catch((err) => {
        this.setData({
          deleting: false,
          errorMsg: (err && err.message) || '删除失败，请稍后重试'
        });
      });
  }
});
