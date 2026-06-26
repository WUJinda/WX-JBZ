// app.js
App({
  // 云开发环境 id 占位：联调/上线时替换为真实 envId（dev / prod）。
  // 用占位常量避免硬编码未开通的环境导致 init 失败。
  cloudEnvId: 'jbz-cloud-env-placeholder',

  onLaunch() {
    if (!wx.cloud) {
      console.error('请使用 2.2.3 或以上的基础库以使用云能力');
      return;
    }
    wx.cloud.init({
      env: this.cloudEnvId,
      traceUser: true
    });
  },

  globalData: {
    userInfo: null
  }
});
