/**
 * 后台数据看板前端纯函数单测（F8 R8.5，H2）。
 * formatRate / normalizeDailyActive / isEmptyDashboard，纯函数不耦合 wx 运行时。
 */
const { formatRate, normalizeDailyActive, isEmptyDashboard } = require('../../miniprogram/pages/admin/dashboard/dashboardCalc');

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

describe('normalizeDailyActive 日活趋势柱高归一化', () => {
  it('最大 count → 100% 高度', () => {
    const list = [
      { date: '2026-06-01', count: 5 },
      { date: '2026-06-02', count: 10 },
      { date: '2026-06-03', count: 0 }
    ];
    const out = normalizeDailyActive(list);
    expect(out[0].heightPct).toBe(50);
    expect(out[1].heightPct).toBe(100);
    expect(out[2].heightPct).toBe(0);
  });

  it('全 0 时给统一最小高度（1）避免塌陷', () => {
    const out = normalizeDailyActive([
      { date: 'd1', count: 0 },
      { date: 'd2', count: 0 }
    ]);
    expect(out.every((i) => i.heightPct === 1)).toBe(true);
  });

  it('保留 date/count，附加 heightPct', () => {
    const out = normalizeDailyActive([{ date: 'd1', count: 8 }]);
    expect(out[0]).toEqual({ date: 'd1', count: 8, heightPct: 100 });
  });

  it('非数字 count 兜底 0', () => {
    const out = normalizeDailyActive([{ date: 'x', count: 'abc' }, { date: 'y', count: 10 }]);
    expect(out[0].count).toBe(0);
    expect(out[0].heightPct).toBe(0);
    expect(out[1].heightPct).toBe(100);
  });

  it('空数组 → 空数组', () => {
    expect(normalizeDailyActive([])).toEqual([]);
  });

  it('非数组 → 空数组', () => {
    expect(normalizeDailyActive(null)).toEqual([]);
    expect(normalizeDailyActive(undefined)).toEqual([]);
  });

  it('不修改入参（纯函数）', () => {
    const list = [{ date: 'd1', count: 5 }];
    const snap = JSON.stringify(list);
    normalizeDailyActive(list);
    expect(JSON.stringify(list)).toBe(snap);
  });
});

describe('isEmptyDashboard 看板空态判定', () => {
  it('全 0 + 部门榜空 → true', () => {
    expect(
      isEmptyDashboard({
        participated: 0,
        inviteCodesTotal: 0,
        totalSteps: 0,
        validParticipants: 0,
        deptRank: []
      })
    ).toBe(true);
  });

  it('有参与人数 → false', () => {
    expect(
      isEmptyDashboard({
        participated: 10,
        inviteCodesTotal: 20,
        totalSteps: 0,
        validParticipants: 0,
        deptRank: []
      })
    ).toBe(false);
  });

  it('有部门榜 → false', () => {
    expect(
      isEmptyDashboard({
        participated: 0,
        inviteCodesTotal: 0,
        totalSteps: 0,
        validParticipants: 0,
        deptRank: [{ rank: 1, dept_id: 'd1' }]
      })
    ).toBe(false);
  });

  it('有累计步数 → false', () => {
    expect(
      isEmptyDashboard({
        participated: 0,
        inviteCodesTotal: 0,
        totalSteps: 1000,
        validParticipants: 0,
        deptRank: []
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
        validParticipants: '0',
        deptRank: null
      })
    ).toBe(true);
  });
});
