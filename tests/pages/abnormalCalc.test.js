/**
 * 后台异常裁定前端纯函数单测（F8 R8.4，H3）。
 * hasMore / verdictLabel / formatSteps，纯函数不耦合 wx 运时。
 *
 * 红线验证：纯函数仅消费后端 admin.abnormalList 下发的白名单字段
 * （user_id/date/steps/synced_at/abnormal/locked），不下发 _openid / sync_count。
 */
const {
  hasMore,
  verdictLabel,
  formatSteps,
  DEFAULT_PAGE_SIZE
} = require('../../miniprogram/pages/admin/abnormal/abnormalCalc');

describe('hasMore 分页判定', () => {
  it('返回条数 >= pageSize → true（还有更多）', () => {
    expect(hasMore(50, 50)).toBe(true);
    expect(hasMore(60, 50)).toBe(true);
  });

  it('返回条数 < pageSize → false', () => {
    expect(hasMore(49, 50)).toBe(false);
    expect(hasMore(0, 50)).toBe(false);
  });

  it('默认 pageSize=50（pageSize 非法时兜底）', () => {
    expect(hasMore(50)).toBe(true);
    expect(hasMore(49)).toBe(false);
    expect(DEFAULT_PAGE_SIZE).toBe(50);
  });

  it('pageSize<1 → 兜底 50', () => {
    expect(hasMore(50, 0)).toBe(true);
    expect(hasMore(50, -1)).toBe(true);
  });

  it('非数字 returnedCount → 0 兜底 → false', () => {
    expect(hasMore(NaN, 50)).toBe(false);
    expect(hasMore('abc', 50)).toBe(false);
    expect(hasMore(null, 50)).toBe(false);
  });
});

describe('verdictLabel 裁定文案', () => {
  it('ignore → 忽略', () => {
    expect(verdictLabel('ignore')).toBe('忽略');
  });
  it('zero → 置零', () => {
    expect(verdictLabel('zero')).toBe('置零');
  });
  it('空 / 非法 → 空字符串（兜底，非法 action 不渲染）', () => {
    expect(verdictLabel('')).toBe('');
    expect(verdictLabel(undefined)).toBe('');
    expect(verdictLabel(null)).toBe('');
    expect(verdictLabel('xxx')).toBe('');
    expect(verdictLabel('verdict')).toBe(''); // 不能用 dispatch 字段当业务 action
  });
});

describe('formatSteps 步数格式化', () => {
  it('正整数 → 千分位 + 单位', () => {
    expect(formatSteps(12345)).toBe('12,345 步');
    expect(formatSteps(60000)).toBe('60,000 步');
  });

  it('1000 整 → 1,000 步', () => {
    expect(formatSteps(1000)).toBe('1,000 步');
  });

  it('0 → 0 步', () => {
    expect(formatSteps(0)).toBe('0 步');
  });

  it('负数 → 0 步（兜底）', () => {
    expect(formatSteps(-100)).toBe('0 步');
  });

  it('非数字 → 0 步（兜底）', () => {
    expect(formatSteps(NaN)).toBe('0 步');
    expect(formatSteps('abc')).toBe('0 步');
    expect(formatSteps(null)).toBe('0 步');
    expect(formatSteps(undefined)).toBe('0 步');
  });

  it('浮点数 → 向下取整', () => {
    expect(formatSteps(12345.9)).toBe('12,345 步');
  });

  it('数字字符串 → 解析为数字', () => {
    expect(formatSteps('12345')).toBe('12,345 步');
  });
});
