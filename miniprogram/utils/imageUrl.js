/**
 * 图片 URL 合法性校验（前端渲染兜底用，纯函数，可在 Node 单测）。
 *
 * 背景：活动 cover_url 等字段来自管理员自由输入，若误填非 URL 文本（如 "ssss"），
 *   <image src="ssss"> 会被解析为页面相对路径 /pages/activity/ssss → 渲染层 500 刷屏。
 *   故渲染前需校验：仅合法 URL 才交给 <image>，否则视为无图（走 placeholder）。
 *
 * 合法前缀：
 *   - https:// / http://   网络图（生产环境 http 需在小程序后台配 request/legalDomain 域名）
 *   - cloud://              云存储文件 ID（云开发默认图床）
 *   - wxfile://             本地临时文件（wx.chooseImage 等返回）
 *
 * 空串 / null / 非字符串 → false（调用方据此走 placeholder，不渲染 <image>）。
 *
 * @param {*} url
 * @returns {boolean}
 */
function isValidImageUrl(url) {
  if (typeof url !== 'string') return false;
  const s = url.trim();
  if (!s) return false;
  return (
    /^https?:\/\//i.test(s) ||
    /^cloud:\/\//i.test(s) ||
    /^wxfile:\/\//i.test(s)
  );
}

module.exports = { isValidImageUrl };
