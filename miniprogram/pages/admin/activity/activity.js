// pages/admin/activity/activity.js
// 后台活动配置：表单 + 发布（对齐 PRD F8 R8.1，开发计划阶段 H2）。
//
// 对接 activity.save（后端 H1 为已知缺口，本轮前端先对接；本地轨 getApp().api 不存在 → 占位提示）。
// 表单先经纯函数 validateActivityForm 校验，通过才调 api.call。
//
// 红线：
//   - 本页只展示/提交活动配置字段（name/cover_url/start_time/end_time/rules/publish），无敏感字段。
//   - 本地轨：getApp().api 不存在 → 提前 return 占位提示；api.call 失败 → .catch 错误提示，不白屏。
const { validateActivityForm, formatPublishState } = require('./activityCalc');
const { enterAdminGuard } = require('../../../utils/auth-guard');

Page({
  data: {
    pageLabel: '活动配置',
    // 表单字段
    activityId: '',
    name: '',
    cover_url: '',
    start_time: '', // YYYY-MM-DD
    end_time: '', // YYYY-MM-DD
    rules: '',
    publish: false,
    // 状态
    submitting: false,
    errorMsg: '',
    formErrors: {}, // {name, startEnd, ...}
    publishText: '未发布'
  },

  onLoad() {
    if (!enterAdminGuard('/pages/admin/activity/activity')) return;
    // F1：编辑当前活动（从全局上下文取 activity_id）；空则视为新建（save 时后端处理）。
    this.setData({ activityId: getApp().getActivityId() });
    this.refreshPublishText();
  },

  /** 名称输入。 */
  onNameInput(e) {
    this.setData({ name: (e && e.detail && e.detail.value) || '' });
  },

  /** 头图 URL 输入。 */
  onCoverInput(e) {
    this.setData({ cover_url: (e && e.detail && e.detail.value) || '' });
  },

  /** 开始时间 picker。 */
  onStartChange(e) {
    this.setData({ start_time: (e && e.detail && e.detail.value) || '' });
  },

  /** 结束时间 picker。 */
  onEndChange(e) {
    this.setData({ end_time: (e && e.detail && e.detail.value) || '' });
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
      end_time: this.data.end_time
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
          cover_url: this.data.cover_url,
          start_time: this.data.start_time,
          end_time: this.data.end_time,
          rules: this.data.rules,
          publish: this.data.publish
        },
        { loading: '保存中' }
      )
      .then((data) => {
        this.setData({ submitting: false, errorMsg: '' });
        // 刷新全局活动上下文：用 save 返回（优先）回写，让 home/activity 页立即感知新活动；
        // 置 _activityDirty：activity 页 onShow 探测到则强制重拉，绕过 30s 节流，跳过去即见最新。
        const app = getApp();
        if (app && app.globalData) {
          const d = data || {};
          app.globalData.currentActivity = {
            activity_id: d.activity_id || this.data.activityId || '',
            name: d.name || this.data.name || '',
            start_time: d.start_time != null ? d.start_time : this.data.start_time,
            end_time: d.end_time != null ? d.end_time : this.data.end_time,
            status: d.status || ''
          };
          app.globalData._activityDirty = true;
        }
        wx.showToast({ title: isNew ? '活动已创建' : '已保存', icon: 'success' });
        // 跳活动详情页看成果（switchTab 自动关闭 admin 非标签页栈）。
        setTimeout(() => {
          if (typeof wx !== 'undefined' && wx.switchTab) {
            wx.switchTab({ url: '/pages/activity/activity' });
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
  }
});
