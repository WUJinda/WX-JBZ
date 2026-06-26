const { maskPhone, maskName } = require('../../miniprogram/utils/format');

describe('utils/format', () => {
  describe('maskPhone', () => {
    it('11 位手机号脱敏为 138****1234', () => {
      expect(maskPhone('13812341234')).toBe('138****1234');
    });

    it('数字类型手机号同样脱敏', () => {
      expect(maskPhone(13812341234)).toBe('138****1234');
    });

    it('不同号段脱敏正确', () => {
      expect(maskPhone('15900001111')).toBe('159****1111');
      expect(maskPhone('18699998888')).toBe('186****8888');
    });

    it('位数非 11 原样返回', () => {
      expect(maskPhone('123')).toBe('123');
      expect(maskPhone('123456789012')).toBe('123456789012');
    });

    it('含非数字字符原样返回', () => {
      expect(maskPhone('138-1234-1234')).toBe('138-1234-1234');
    });

    it('空串原样返回', () => {
      expect(maskPhone('')).toBe('');
    });
  });

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
