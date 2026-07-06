/**
 * editCalc 纯函数单测（昵称头像表单校验 + 云存储路径生成）。
 * validateNickname 与后端 userAccount.validateNickname 同口径（前后端一致）。
 */
const {
  validateNickname,
  buildAvatarCloudPath,
  isAvatarChanged,
  NICKNAME_MAX_LEN
} = require('../../miniprogram/pages/profile/edit/editCalc');

describe('editCalc 昵称头像表单纯函数', () => {
  describe('validateNickname（与后端同口径）', () => {
    it('正常昵称合法', () => {
      expect(validateNickname('张明')).toBe(true);
    });
    it('前后空白被 trim', () => {
      expect(validateNickname('  张明  ')).toBe(true);
    });
    it('空串 / 纯空白非法', () => {
      expect(validateNickname('')).toBe(false);
      expect(validateNickname('   ')).toBe(false);
    });
    it('达到上限合法', () => {
      expect(validateNickname('a'.repeat(NICKNAME_MAX_LEN))).toBe(true);
    });
    it('超过上限非法', () => {
      expect(validateNickname('a'.repeat(NICKNAME_MAX_LEN + 1))).toBe(false);
    });
    it('emoji 按码点计数', () => {
      expect(validateNickname('😀😄')).toBe(true);
    });
    it('非字符串非法', () => {
      expect(validateNickname(null)).toBe(false);
      expect(validateNickname(123)).toBe(false);
    });
  });

  describe('buildAvatarCloudPath', () => {
    it('传 filename → avatars/<filename>.jpg', () => {
      expect(buildAvatarCloudPath('abc123')).toBe('avatars/abc123.jpg');
    });
    it('不传 → avatars/ 前缀 + .jpg 后缀（具体名随机）', () => {
      const p = buildAvatarCloudPath();
      expect(p.indexOf('avatars/')).toBe(0);
      expect(p.indexOf('.jpg')).toBe(p.length - 4);
    });
  });

  describe('isAvatarChanged', () => {
    it('不同 → true', () => {
      expect(isAvatarChanged('cloud://old', 'wxfile://new')).toBe(true);
    });
    it('相同 → false', () => {
      expect(isAvatarChanged('cloud://same', 'cloud://same')).toBe(false);
    });
    it('任一非字符串 → false', () => {
      expect(isAvatarChanged(null, 'a')).toBe(false);
      expect(isAvatarChanged('a', undefined)).toBe(false);
    });
  });
});
