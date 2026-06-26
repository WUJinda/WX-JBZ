// pages/activity/activity.js
Page({
  data: {
    pageLabel: '活动主页'
  },
  goHome() {
    wx.switchTab({ url: '/pages/home/home' });
  }
});
