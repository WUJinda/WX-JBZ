const { maskName } = require('../../miniprogram/utils/format');

describe('utils/format', () => {
  describe('maskName', () => {
    it('两字昵称脱敏', () => {
      expect(maskName('张明')).toBe('张*');
    });

    it('三字及以上昵称保留首尾', () => {
      expect(maskName('诸葛亮')).toBe('诸*亮');
      expect(maskName('欧阳修文')).toBe('欧**文');
    });

    it('单字昵称不脱敏', () => {
      expect(maskName('明')).toBe('明');
    });
  });
});
