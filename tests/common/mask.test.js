/**
 * maskNickname 单测（R5.3 昵称脱敏）。
 */
const { maskNickname } = require('../../cloudfunctions/common/mask');

describe('maskNickname 昵称脱敏（R5.3）', () => {
  it('三字：中间字替 *（张小明 → 张*明）', () => {
    expect(maskNickname('张小明')).toBe('张*明');
  });

  it('两字：末字替 *（张三 → 张*）', () => {
    expect(maskNickname('张三')).toBe('张*');
  });

  it('单字：不脱敏（边界安全）', () => {
    expect(maskNickname('张')).toBe('张');
  });

  it('空串：返回空（边界安全）', () => {
    expect(maskNickname('')).toBe('');
  });

  it('四字及以上：保留首尾，中间全部替 *（欧阳小花 → 欧**花）', () => {
    expect(maskNickname('欧阳小花')).toBe('欧**花');
  });

  it('五字：中间三字替 *（张三李四王 → 张***王）', () => {
    expect(maskNickname('张三李四王')).toBe('张***王');
  });

  it('英文昵称同样适用（John → J**n）', () => {
    expect(maskNickname('John')).toBe('J**n');
  });

  it('null / undefined 边界安全（返回空串）', () => {
    expect(maskNickname(null)).toBe('');
    expect(maskNickname(undefined)).toBe('');
  });

  it('非字符串入参（数字）转为字符串后脱敏', () => {
    // 1234 → '1**4'
    expect(maskNickname(1234)).toBe('1**4');
  });
});
