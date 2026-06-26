/**
 * 主页趋势图前端纯函数单测（F4）。
 * selectRange / normalizeBars / isEmptyTrend，纯函数不耦合 wx 运行时。
 */
const { selectRange, normalizeBars, isEmptyTrend, RANGES } = require('../../miniprogram/pages/home/homeTrend');

describe('selectRange 区间校正（R4.2）', () => {
  it('仅接受 7/30', () => {
    expect(RANGES).toEqual([7, 30]);
    expect(selectRange(7)).toBe(7);
    expect(selectRange(30)).toBe(30);
  });

  it('非法值按默认 7 兜底', () => {
    expect(selectRange(100)).toBe(7);
    expect(selectRange('abc')).toBe(7);
    expect(selectRange(undefined)).toBe(7);
    expect(selectRange(null)).toBe(7);
  });

  it('数字字符串也能识别', () => {
    expect(selectRange('7')).toBe(7);
    expect(selectRange('30')).toBe(30);
  });

  it('切换 7↔30 生效', () => {
    expect(selectRange(7)).toBe(7);
    expect(selectRange(30)).toBe(30);
  });
});

describe('normalizeBars 柱高归一化', () => {
  it('最大值 → 100% 高度', () => {
    const list = [
      { date: '2026-07-01', steps: 5000 },
      { date: '2026-07-02', steps: 10000 },
      { date: '2026-07-03', steps: 0 }
    ];
    const out = normalizeBars(list);
    expect(out[0].heightPct).toBe(50);
    expect(out[1].heightPct).toBe(100);
    expect(out[2].heightPct).toBe(0);
  });

  it('全 0 时给统一最小高度（1）避免塌陷', () => {
    const list = [
      { date: '2026-07-01', steps: 0 },
      { date: '2026-07-02', steps: 0 }
    ];
    const out = normalizeBars(list);
    expect(out.every((i) => i.heightPct === 1)).toBe(true);
  });

  it('保留 date/steps，附加 heightPct', () => {
    const out = normalizeBars([{ date: '2026-07-01', steps: 8000 }]);
    expect(out[0]).toEqual({ date: '2026-07-01', steps: 8000, heightPct: 100 });
  });

  it('不修改入参（纯函数）', () => {
    const list = [{ date: '2026-07-01', steps: 8000 }];
    const snapshot = JSON.stringify(list);
    normalizeBars(list);
    expect(JSON.stringify(list)).toBe(snapshot);
  });

  it('空数组 → 空数组', () => {
    expect(normalizeBars([])).toEqual([]);
  });

  it('非数字 steps 兜底 0', () => {
    const out = normalizeBars([{ date: 'x', steps: 'abc' }, { date: 'y', steps: 10 }]);
    expect(out[0].steps).toBe(0);
    expect(out[0].heightPct).toBe(0);
    expect(out[1].heightPct).toBe(100);
  });
});

describe('isEmptyTrend 空态判定（R4.3）', () => {
  it('全部为 0 → true', () => {
    expect(isEmptyTrend([{ date: 'x', steps: 0 }, { date: 'y', steps: 0 }])).toBe(true);
  });

  it('有非 0 → false', () => {
    expect(isEmptyTrend([{ date: 'x', steps: 0 }, { date: 'y', steps: 5 }])).toBe(false);
  });

  it('空数组 → true', () => {
    expect(isEmptyTrend([])).toBe(true);
  });

  it('null/undefined → true', () => {
    expect(isEmptyTrend(null)).toBe(true);
    expect(isEmptyTrend(undefined)).toBe(true);
  });
});
