/**
 * 后台数据看板前端纯函数单测（F8 R8.5，H2）。
 * formatRate / isEmptyDashboard，纯函数不耦合 wx 运行时。
 */
const { formatRate, isEmptyDashboard } = require('../../miniprogram/pages/admin/dashboard/dashboardCalc');

describe('formatRate 参与率格式化', () => {
  it('正常小数 → 整数百分比', () => {
    expect(formatRate(0.42)).toBe('42%');
    expect(formatRate(0.5)).toBe('50%');
    expect(formatRate(0)).toBe('0%');
    expect(formatRate(1)).toBe('100%');
  });

  it('四舍五入取整', () => {
    expect(formatRate(0.425)).toBe('43%');
    expect(formatRate(0.334)).toBe('33%');
    expect(formatRate(0.995)).toBe('100%');
  });

  it('非数字 / NaN / Infinity → 0%', () => {
    expect(formatRate(NaN)).toBe('0%');
    expect(formatRate(Infinity)).toBe('0%');
    expect(formatRate(-Infinity)).toBe('0%');
    expect(formatRate('abc')).toBe('0%');
    expect(formatRate(undefined)).toBe('0%');
    expect(formatRate(null)).toBe('0%');
  });

  it('负数 → 0%（兜底）', () => {
    expect(formatRate(-0.5)).toBe('0%');
  });

  it('超过 1 → 100%（兜底）', () => {
    expect(formatRate(1.5)).toBe('100%');
    expect(formatRate(2)).toBe('100%');
  });
});

describe('isEmptyDashboard 看板空态判定', () => {
  it('全 0 → true', () => {
    expect(
      isEmptyDashboard({
        participated: 0,
        inviteCodesTotal: 0,
        totalSteps: 0,
        validParticipants: 0
      })
    ).toBe(true);
  });

  it('有参与人数 → false', () => {
    expect(
      isEmptyDashboard({
        participated: 10,
        inviteCodesTotal: 20,
        totalSteps: 0,
        validParticipants: 0
      })
    ).toBe(false);
  });

  it('有累计步数 → false', () => {
    expect(
      isEmptyDashboard({
        participated: 0,
        inviteCodesTotal: 0,
        totalSteps: 1000,
        validParticipants: 0
      })
    ).toBe(false);
  });

  it('null / undefined → true', () => {
    expect(isEmptyDashboard(null)).toBe(true);
    expect(isEmptyDashboard(undefined)).toBe(true);
    expect(isEmptyDashboard({})).toBe(true);
  });

  it('字符串数字也能识别（如 "0"）', () => {
    expect(
      isEmptyDashboard({
        participated: '0',
        inviteCodesTotal: '0',
        totalSteps: '0',
        validParticipants: '0'
      })
    ).toBe(true);
  });
});
