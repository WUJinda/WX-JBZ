/**
 * 后台活动配置前端纯函数单测（F8 R8.1，H2）。
 * validateActivityForm / formatPublishState / isValidTime，纯函数不耦合 wx 运行时。
 * 注意：本文件测的是 pages/admin/activity/activityCalc.js（后台配置），
 * 与 pages/activity/activityCalc.js（活动详情页 C2）不同模块。
 */
const { validateActivityForm, formatPublishState, isValidTime, toDateTime } = require('../../miniprogram/pages/admin/activity/activityCalc');

describe('validateActivityForm 活动表单校验（R8.1）', () => {
  it('合法表单 → valid', () => {
    const r = validateActivityForm({
      name: '健步走大赛',
      start_time: '2026-07-01',
      end_time: '2026-07-31'
    });
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual({});
  });

  it('name 必填：空字符串 → 报错', () => {
    const r = validateActivityForm({ name: '   ', start_time: '2026-07-01', end_time: '2026-07-31' });
    expect(r.valid).toBe(false);
    expect(r.errors.name).toBeTruthy();
  });

  it('name 缺失 → 报错', () => {
    const r = validateActivityForm({ start_time: '2026-07-01', end_time: '2026-07-31' });
    expect(r.valid).toBe(false);
    expect(r.errors.name).toBeTruthy();
  });

  it('起止都缺 → startEnd 报错', () => {
    const r = validateActivityForm({ name: '大赛' });
    expect(r.valid).toBe(false);
    expect(r.errors.startEnd).toBeTruthy();
  });

  it('结束时间早于开始 → startEnd 报错', () => {
    const r = validateActivityForm({
      name: '大赛',
      start_time: '2026-07-31',
      end_time: '2026-07-01'
    });
    expect(r.valid).toBe(false);
    expect(r.errors.startEnd).toBeTruthy();
  });

  it('结束时间等于开始 → startEnd 报错', () => {
    const r = validateActivityForm({
      name: '大赛',
      start_time: '2026-07-01',
      end_time: '2026-07-01'
    });
    expect(r.valid).toBe(false);
    expect(r.errors.startEnd).toBeTruthy();
  });

  it('开始时间格式非法 → startTime 报错', () => {
    const r = validateActivityForm({
      name: '大赛',
      start_time: 'not-a-date',
      end_time: '2026-07-31'
    });
    expect(r.valid).toBe(false);
    expect(r.errors.startTime).toBeTruthy();
  });

  it('结束时间格式非法 → endTime 报错', () => {
    const r = validateActivityForm({
      name: '大赛',
      start_time: '2026-07-01',
      end_time: ''
    });
    expect(r.valid).toBe(false);
    expect(r.errors.endTime).toBeTruthy();
  });

  it('支持带时间的格式（YYYY-MM-DD HH:mm）', () => {
    const r = validateActivityForm({
      name: '大赛',
      start_time: '2026-07-01 09:00',
      end_time: '2026-07-31 18:00'
    });
    expect(r.valid).toBe(true);
  });

  it('null / undefined 表单 → name + startEnd 报错', () => {
    const r = validateActivityForm(null);
    expect(r.valid).toBe(false);
    expect(r.errors.name).toBeTruthy();
    expect(r.errors.startEnd).toBeTruthy();
  });

  // signup_deadline 校验（可选；填了须 ≤ end_time）
  it('signup_deadline 留空 → valid（可选，=结束前可报）', () => {
    const r = validateActivityForm({
      name: '大赛',
      start_time: '2026-07-01',
      end_time: '2026-07-31'
    });
    expect(r.valid).toBe(true);
    expect(r.errors.signup_deadline).toBeUndefined();
  });

  it('signup_deadline ≤ end_time → valid', () => {
    const r = validateActivityForm({
      name: '大赛',
      start_time: '2026-07-01',
      end_time: '2026-07-31',
      signup_deadline: '2026-07-15'
    });
    expect(r.valid).toBe(true);
    expect(r.errors.signup_deadline).toBeUndefined();
  });

  it('signup_deadline > end_time → signup_deadline 报错', () => {
    const r = validateActivityForm({
      name: '大赛',
      start_time: '2026-07-01',
      end_time: '2026-07-31',
      signup_deadline: '2026-08-10'
    });
    expect(r.valid).toBe(false);
    expect(r.errors.signup_deadline).toBeTruthy();
  });

  it('signup_deadline 格式非法 → signup_deadline 报错', () => {
    const r = validateActivityForm({
      name: '大赛',
      start_time: '2026-07-01',
      end_time: '2026-07-31',
      signup_deadline: 'not-a-date'
    });
    expect(r.valid).toBe(false);
    expect(r.errors.signup_deadline).toBeTruthy();
  });
});

describe('formatPublishState 发布态文案', () => {
  it('true → 已发布', () => {
    expect(formatPublishState(true)).toBe('已发布');
  });

  it('字符串 "true" → 已发布', () => {
    expect(formatPublishState('true')).toBe('已发布');
  });

  it('false → 未发布', () => {
    expect(formatPublishState(false)).toBe('未发布');
  });

  it('undefined / null / 0 → 未发布', () => {
    expect(formatPublishState(undefined)).toBe('未发布');
    expect(formatPublishState(null)).toBe('未发布');
    expect(formatPublishState(0)).toBe('未发布');
  });
});

describe('isValidTime 时间格式校验', () => {
  it('合法日期字符串 → true', () => {
    expect(isValidTime('2026-07-01')).toBe(true);
    expect(isValidTime('2026-07-01 09:00')).toBe(true);
  });

  it('非法字符串 → false', () => {
    expect(isValidTime('not-a-date')).toBe(false);
    expect(isValidTime('')).toBe(false);
  });

  it('null / undefined / 对象 → false', () => {
    expect(isValidTime(null)).toBe(false);
    expect(isValidTime(undefined)).toBe(false);
    expect(isValidTime({})).toBe(false);
  });
});

describe('toDateTime 纯日期串补时区（E1：修活动提前 8h 结束）', () => {
  it('start（endOfDay=false）→ 当日 00:00:00+08:00', () => {
    expect(toDateTime('2026-07-01', false)).toBe('2026-07-01T00:00:00+08:00');
  });

  it('end/signup（endOfDay=true）→ 当日 23:59:59+08:00', () => {
    expect(toDateTime('2026-07-21', true)).toBe('2026-07-21T23:59:59+08:00');
  });

  it('空入参 → 空串', () => {
    expect(toDateTime('', true)).toBe('');
    expect(toDateTime(null, false)).toBe('');
    expect(toDateTime(undefined, true)).toBe('');
  });

  it('补时区后 end 晚于北京时间结束日早 8 点（不再提前结束）', () => {
    // end='2026-07-21' 补 +08:00 → 北京 07-21 23:59:59 = UTC 07-21 15:59:59
    const endTs = Date.parse(toDateTime('2026-07-21', true));
    // 北京 07-21 08:00 = UTC 07-21 00:00（旧 bug 的翻转点）
    const beijing8am = Date.parse('2026-07-21T00:00:00Z');
    expect(endTs).toBeGreaterThan(beijing8am);
  });

  it('对照：纯日期串（旧实现透传）Date.parse = UTC 00:00 = 北京早 8 点（提前结束根因）', () => {
    const oldEndTs = Date.parse('2026-07-21');
    const beijing8am = Date.parse('2026-07-21T00:00:00Z');
    expect(oldEndTs).toBe(beijing8am);
  });
});
