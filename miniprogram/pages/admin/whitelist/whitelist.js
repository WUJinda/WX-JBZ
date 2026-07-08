// pages/admin/whitelist/whitelist.js
// 后台白名单导入：粘贴 + 预览 + 导入（对齐 PRD F8 R8.2，开发计划阶段 H2）。
//
// 对接 admin.whitelistImport（applyWhitelistImport 输出 {imported, updated}；入参 raw_text）。
// 前端 previewPhones 与后端 whitelistParse 口径一致（正则 1[3-9]\d{9}），保证预览数 = 实际导入数。
//
// 红线：
//   - wxml 不渲染完整 phone：预览样本在 js 层掩码后（保留前 3 后 2，中间 ****）再 setData。
//   - 本地轨：getApp().api 不存在 → 提前 return 占位提示；api.call 失败 → .catch 错误提示，不白屏。
const { previewPhones, formatImportResult } = require('./whitelistCalc');
const { maskPhone } = require('../../../utils/format');
const { enterAdminGuard } = require('../../../utils/auth-guard');

Page({
  data: {
    pageLabel: '白名单导入',
    rawText: '',
    previewCount: 0,
    previewInvalid: 0,
    previewSample: [], // 掩码后的前 5 条样本（不暴露完整 phone）
    importing: false,
    resultText: '',
    errorMsg: ''
  },

  onLoad() {
    if (!enterAdminGuard('/pages/admin/whitelist/whitelist')) return;
  },

  /** 文本变化：实时算预览（数量 + 掩码样本）。 */
  onTextChange(e) {
    const rawText = (e && e.detail && e.detail.value) || '';
    const { phones, count, invalid } = previewPhones(rawText);
    // 掩码前 5 条样本，确保 wxml 不渲染完整 phone。
    const sample = phones.slice(0, 5).map(maskPhone);
    this.setData({
      rawText,
      previewCount: count,
      previewInvalid: invalid,
      previewSample: sample
    });
  },

  /** 导入：调 admin.whitelistImport。 */
  onImport() {
    if (this.data.importing) return;
    if (this.data.previewCount === 0) {
      this.setData({ errorMsg: '请先粘贴有效的邀请码' });
      return;
    }
    this.setData({ errorMsg: '', resultText: '' });

    const app = getApp();
    const api = app && app.api;
    if (!api || typeof api.call !== 'function') {
      // 无云能力 → 占位提示（不崩）。
      this.setData({ errorMsg: '云能力未就绪，无法导入' });
      return;
    }

    this.setData({ importing: true });
    api
      .call(
        'admin',
        { action: 'whitelistImport', raw_text: this.data.rawText },
        { loading: '导入中' }
      )
      .then((data) => {
        const d = data || {};
        this.setData({
          importing: false,
          errorMsg: '',
          resultText: formatImportResult({ imported: d.imported, updated: d.updated })
        });
        wx.showToast({ title: '导入完成', icon: 'success' });
      })
      .catch((err) => {
        // 本地轨：云函数未部署 → 错误提示，不白屏。
        this.setData({
          importing: false,
          errorMsg: (err && err.message) || '导入失败，请稍后重试'
        });
      });
  }
});
