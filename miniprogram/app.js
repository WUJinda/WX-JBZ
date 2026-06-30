// app.js
const { createApi } = require('./utils/request');

App({
  // 云开发环境 ID（B0.1 已回填）。onLaunch 的占位守卫：含 'placeholder' 时不挂 api。
  // 当前为免费云环境（开发联调用）；上线后再按需转付费 / 加 prod 环境。
  cloudEnvId: 'cloud1-d1gtq8mlla5f94c43',

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
