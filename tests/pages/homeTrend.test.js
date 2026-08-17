/**
 * 主页趋势图前端纯函数单测（F4）。
 * selectRange / normalizeBars / isEmptyTrend，纯函数不耦合 wx 运行时。
 */
const { selectRange, normalizeBars, isEmptyTrend, SHORT_RANGE, formatDateLabel, computeBarsWidth, computeActivityDays } = require('../../miniprogram/pages/home/homeTrend');

describe('selectRange 区间校正', () => {
  it('接受任意 ≥1 正整数', () => {
    expect(selectRange(7)).toBe(7);
    expect(selectRange(15)).toBe(15);
    expect(selectRange(30)).toBe(30);
  });

  it('非法值按默认 7 兜底', () => {
    expect(selectRange(0)).toBe(7);
    expect(selectRange(-1)).toBe(7);
    expect(selectRange('abc')).toBe(7);
    expect(selectRange(undefined)).toBe(7);
    expect(selectRange(null)).toBe(7);
  });

  it('数字字符串也能识别', () => {
    expect(selectRange('7')).toBe(7);
    expect(selectRange('15')).toBe(15);
    expect(selectRange('30')).toBe(30);
  });

  it('def 参数生效', () => {
    expect(selectRange(undefined, 15)).toBe(15);
    expect(selectRange('abc', 30)).toBe(30);
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

  it('保留 date/steps，附加 heightPct 和 dateLabel', () => {
    const out = normalizeBars([{ date: '2026-07-01', steps: 8000 }]);
    expect(out[0]).toEqual({ date: '2026-07-01', steps: 8000, heightPct: 100, dateLabel: '7.1' });
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

describe('formatDateLabel 日期格式化（去年份）', () => {
  it('YYYY-MM-DD → M.D', () => {
    expect(formatDateLabel('2026-08-01')).toBe('8.1');
    expect(formatDateLabel('2026-12-25')).toBe('12.25');
    expect(formatDateLabel('2026-01-05')).toBe('1.5');
  });

  it('空值/非字符串 → 空字符串', () => {
    expect(formatDateLabel('')).toBe('');
    expect(formatDateLabel(null)).toBe('');
    expect(formatDateLabel(undefined)).toBe('');
    expect(formatDateLabel(123)).toBe('');
  });

  it('格式异常 → 原样返回', () => {
    expect(formatDateLabel('2026/08/01')).toBe('2026/08/01');
    expect(formatDateLabel('hello')).toBe('hello');
  });
});

describe('computeBarsWidth 容器宽度计算', () => {
  it('7 条 → 100%（填满容器，flex 等分）', () => {
    expect(computeBarsWidth(7)).toBe('100%');
  });

  it('30 条 → 固定 rpx 宽度（触发 scroll-view 滑动）', () => {
    // 30 × 60rpx = 1800rpx > 638rpx 阈值
    expect(computeBarsWidth(30)).toBe('1800rpx');
  });

  it('0 条或空 → 100%', () => {
    expect(computeBarsWidth(0)).toBe('100%');
    expect(computeBarsWidth()).toBe('100%');
  });

  it('边界：10 条（600rpx < 638rpx 阈值）→ 100%', () => {
    expect(computeBarsWidth(10)).toBe('100%');
  });

  it('边界：11 条（660rpx > 638rpx 阈值）→ 660rpx', () => {
    expect(computeBarsWidth(11)).toBe('660rpx');
  });
});

describe('computeActivityDays 活动总天数计算', () => {
  it('正常区间：8/1 ~ 8/15 → 15 天', () => {
    expect(computeActivityDays({
      start_time: '2026-08-01T00:00:00+08:00',
      end_time: '2026-08-15T23:59:59+08:00'
    })).toBe(15);
  });

  it('同日：start === end → 1 天', () => {
    expect(computeActivityDays({
      start_time: '2026-08-01T00:00:00+08:00',
      end_time: '2026-08-01T23:59:59+08:00'
    })).toBe(1);
  });

  it('缺 start_time 或 end_time → 0', () => {
    expect(computeActivityDays({ end_time: '2026-08-15' })).toBe(0);
    expect(computeActivityDays({ start_time: '2026-08-01' })).toBe(0);
    expect(computeActivityDays({})).toBe(0);
    expect(computeActivityDays(null)).toBe(0);
  });

  it('end < start → 0（异常区间）', () => {
    expect(computeActivityDays({
      start_time: '2026-08-15T00:00:00+08:00',
      end_time: '2026-08-01T00:00:00+08:00'
    })).toBe(0);
  });
});
