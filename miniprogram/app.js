// app.js
const { createApi } = require('./utils/request');

App({
  // TODO B0.1：用户开通云开发环境后回填真实 envId（dev/prod 两套），
  //   回填后下方 init+api 挂载才生效；占位期间各页 getApp().api 仍为 undefined，
  //   走本地轨守卫兜底（行为不变）。
  cloudEnvId: 'jbz-cloud-env-placeholder',

  onLaunch() {
    if (!wx.cloud) {
      console.error('请使用 2.2.3 或以上的基础库以使用云能力');
      return;
    }
    // 占位守卫：envId 仍为占位时不 init、不挂 api，保留本地轨兜底。
    // 回填真实 envId 后自动 init 并挂载 api，进入云轨（平滑过渡）。
    if (!this.cloudEnvId || this.cloudEnvId.includes('placeholder')) {
      return;
    }
    wx.cloud.init({
      env: this.cloudEnvId,
      traceUser: true
    });
    // 挂载统一请求封装：对齐 utils/request.js 的 createApi(wxCloud, hooks) 契约。
    // hooks 三件套（均可选，见 request.js）：showLoading(text) / hideLoading() / showError(msg)。
    this.api = createApi(wx.cloud, {
      showLoading: (text) => wx.showLoading({ title: text, mask: true }),
      hideLoading: () => wx.hideLoading(),
      showError: (msg) => wx.showToast({ title: msg, icon: 'none', duration: 2500 })
    });
  },

  globalData: {
    userInfo: null
  }
});
