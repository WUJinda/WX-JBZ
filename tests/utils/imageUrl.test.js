/**
 * imageUrl 纯函数单测：cover_url 渲染兜底校验。
 * 防 <image src="ssss"> 被解析为页面相对路径 /pages/activity/ssss → 渲染层 500（实测回归）。
 */
const { isValidImageUrl } = require('../../miniprogram/utils/imageUrl');

describe('isValidImageUrl 图片 URL 合法性校验', () => {
  it('https / http 网络图 → true', () => {
    expect(isValidImageUrl('https://example.com/a.png')).toBe(true);
    expect(isValidImageUrl('http://example.com/a.jpg')).toBe(true);
  });

  it('cloud:// 云存储文件 ID → true', () => {
    expect(isValidImageUrl('cloud://env-xxx.xxxx/a.png')).toBe(true);
  });

  it('wxfile:// 本地临时文件 → true', () => {
    expect(isValidImageUrl('wxfile://tmp_xxx.png')).toBe(true);
  });

  it('纯文本（如误填 "ssss"）→ false（正是本次 500 回归的输入）', () => {
    expect(isValidImageUrl('ssss')).toBe(false);
    expect(isValidImageUrl('活动头图')).toBe(false);
  });

  it('页面相对路径 → false（活动头图不允许，防 /pages/activity/xxx 解析）', () => {
    expect(isValidImageUrl('/images/x.png')).toBe(false);
    expect(isValidImageUrl('x.png')).toBe(false);
  });

  it('空串 / 纯空白 / null / undefined / 非字符串 → false（调用方据此走 placeholder）', () => {
    expect(isValidImageUrl('')).toBe(false);
    expect(isValidImageUrl('   ')).toBe(false);
    expect(isValidImageUrl(null)).toBe(false);
    expect(isValidImageUrl(undefined)).toBe(false);
    expect(isValidImageUrl(123)).toBe(false);
  });

  it('前后含空白 → trim 后判断', () => {
    expect(isValidImageUrl('  https://x.com/a.png  ')).toBe(true);
    expect(isValidImageUrl('  ssss  ')).toBe(false);
  });
});
