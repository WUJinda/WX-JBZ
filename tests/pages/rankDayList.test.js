/**
 * 排行榜「今日榜」日期选择器纯函数单测（F5 按日切换）。
 * bjDateStr / bjLabel / buildDayList / defaultDayKey，纯函数不耦合 wx 运行时。
 *
 * 时间戳口径：北京时间 = UTC + 8h。故「北京 7.10 00:00」= Date.UTC(2026, 6, 9, 16)。
 */
const {
  bjDateStr,
  bjLabel,
  buildDayList,
  defaultDayKey,
  toMs
} = require('../../miniprogram/pages/rank/rankDayList');

// 北京 7.10 00:00 = 2026-07-09T16:00:00Z
const D7_10 = Date.UTC(2026, 6, 9, 16);
// 北京 7.14 23:59 = 2026-07-14T15:59:00Z（活动 end）
const D7_14_END = Date.UTC(2026, 6, 14, 15, 59);

describe('bjDateStr 毫秒→北京 YYYY-MM-DD', () => {
  it('UTC 16:00 = 次日北京 00:00', () => {
    expect(bjDateStr(Date.UTC(2026, 6, 9, 16))).toBe('2026-07-10');
  });

  it('UTC 00:00 = 当日北京 08:00（仍当日）', () => {
    expect(bjDateStr(Date.UTC(2026, 6, 10, 0))).toBe('2026-07-10');
  });

  it('UTC 15:59 = 当日北京 23:59（仍当日）', () => {
    expect(bjDateStr(Date.UTC(2026, 6, 10, 15, 59))).toBe('2026-07-10');
  });

  it('非法入参返回空串', () => {
    expect(bjDateStr(NaN)).toBe('');
    expect(bjDateStr(undefined)).toBe('');
  });
});

describe('bjLabel 毫秒→北京 M.D', () => {
  it('月日均不补零', () => {
    expect(bjLabel(Date.UTC(2026, 6, 9, 16))).toBe('7.10');
    // 北京 7.1 00:00 = 2026-06-30T16:00Z（6 月 30 日 16:00 UTC）
    expect(bjLabel(Date.UTC(2026, 5, 30, 16))).toBe('7.1');
  });

  it('非法入参返回空串', () => {
    expect(bjLabel(NaN)).toBe('');
  });
});

describe('buildDayList 活动期日期列表', () => {
  it('进行中：start~今天（含今天，今天标 isToday）', () => {
    // 活动 7.10~7.14，今天 7.12 12:00（北京）= 2026-07-12T04:00Z
    const now = Date.UTC(2026, 6, 12, 4);
    const list = buildDayList({ start_time: D7_10, end_time: D7_14_END }, now);
    expect(list.map((d) => d.key)).toEqual(['2026-07-10', '2026-07-11', '2026-07-12']);
    expect(list.map((d) => d.label)).toEqual(['7.10', '7.11', '7.12']);
    expect(list[2].isToday).toBe(true);
    expect(list[0].isToday).toBe(false);
  });

  it('已结束：start~end（今天已超活动期，无 isToday 项）', () => {
    // 活动 7.10~7.14，今天 7.20（北京）
    const now = Date.UTC(2026, 6, 20, 4);
    const list = buildDayList({ start_time: D7_10, end_time: D7_14_END }, now);
    expect(list.map((d) => d.key)).toEqual([
      '2026-07-10',
      '2026-07-11',
      '2026-07-12',
      '2026-07-13',
      '2026-07-14'
    ]);
    expect(list.every((d) => !d.isToday)).toBe(true);
  });

  it('未开始（start > 今天）→ 空数组', () => {
    const now = Date.UTC(2026, 6, 5, 4); // 7.5，活动 7.10 才开始
    const list = buildDayList({ start_time: D7_10, end_time: D7_14_END }, now);
    expect(list).toEqual([]);
  });

  it('单日活动（start 当天 = 今天）：返回 1 项且 isToday', () => {
    const now = Date.UTC(2026, 6, 10, 4); // 7.10 当天
    const list = buildDayList({ start_time: D7_10, end_time: D7_14_END }, now);
    expect(list.map((d) => d.key)).toEqual(['2026-07-10']);
    expect(list[0].isToday).toBe(true);
  });

  it('接受 ISO 字符串入参（与 globalData.currentActivity 透传值兼容）', () => {
    const list = buildDayList(
      { start_time: '2026-07-09T16:00:00Z', end_time: '2026-07-14T15:59:00Z' },
      Date.UTC(2026, 6, 11, 4) // 7.11
    );
    expect(list.map((d) => d.key)).toEqual(['2026-07-10', '2026-07-11']);
  });

  it('缺 start/end → 空数组', () => {
    expect(buildDayList({}, Date.UTC(2026, 6, 11, 4))).toEqual([]);
    expect(buildDayList({ start_time: D7_10 }, Date.UTC(2026, 6, 11, 4))).toEqual([]);
    expect(buildDayList(null, Date.UTC(2026, 6, 11, 4))).toEqual([]);
  });

  it('每项含 ts（毫秒，逐天递增 86400000）', () => {
    const list = buildDayList({ start_time: D7_10, end_time: D7_14_END }, Date.UTC(2026, 6, 11, 4));
    expect(list[1].ts - list[0].ts).toBe(86400000);
  });
});

describe('defaultDayKey 默认选中', () => {
  it('今天在列表 → 今天', () => {
    const list = buildDayList({ start_time: D7_10, end_time: D7_14_END }, Date.UTC(2026, 6, 12, 4));
    expect(defaultDayKey(list)).toBe('2026-07-12');
  });

  it('今天不在列表（活动已结束）→ 最后一项', () => {
    const list = buildDayList({ start_time: D7_10, end_time: D7_14_END }, Date.UTC(2026, 6, 20, 4));
    expect(defaultDayKey(list)).toBe('2026-07-14');
  });

  it('空列表 → 空串', () => {
    expect(defaultDayKey([])).toBe('');
    expect(defaultDayKey(null)).toBe('');
  });
});

describe('toMs 安全转毫秒', () => {
  it('数字原样返回', () => {
    expect(toMs(123)).toBe(123);
  });
  it('纯数字字符串转数字', () => {
    expect(toMs('123')).toBe(123);
  });
  it('ISO 字符串走 Date.parse', () => {
    expect(toMs('2026-07-09T16:00:00Z')).toBe(Date.parse('2026-07-09T16:00:00Z'));
  });
  it('null/非法 → NaN', () => {
    expect(Number.isNaN(toMs(null))).toBe(true);
    expect(Number.isNaN(toMs('abc'))).toBe(true);
  });
});
