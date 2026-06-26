/**
 * 排行榜页前端纯函数单测（G2，PRD F5/F6）。
 * paginate / pickNeighbors / contribution / switchMetric / isEmptyRank / formatUpdatedAt，
 * 纯函数不耦合 wx 运行时。
 */
const {
  paginate,
  pickNeighbors,
  contribution,
  switchMetric,
  isEmptyRank,
  formatUpdatedAt,
  DEFAULT_PAGE_SIZE,
  VALID_METRICS
} = require('../../miniprogram/pages/rank/rankCalc');

describe('paginate 分页切片', () => {
  it('默认每页 50（与后端口径一致）', () => {
    const list = Array.from({ length: 120 }, (_, i) => i);
    expect(paginate(list, 1).length).toBe(50);
    expect(paginate(list, 3).length).toBe(20); // 120 - 100 = 20
  });

  it('第 1 页返回前 pageSize 条', () => {
    const list = [1, 2, 3, 4, 5];
    expect(paginate(list, 1, 2)).toEqual([1, 2]);
  });

  it('第 2 页跨段', () => {
    const list = [1, 2, 3, 4, 5];
    expect(paginate(list, 2, 2)).toEqual([3, 4]);
  });

  it('末页不足 pageSize 时返回剩余', () => {
    const list = [1, 2, 3, 4, 5];
    expect(paginate(list, 3, 2)).toEqual([5]);
  });

  it('超出总长 → 空数组', () => {
    const list = [1, 2, 3];
    expect(paginate(list, 5, 2)).toEqual([]);
  });

  it('page<1 兜底为 1', () => {
    const list = [1, 2, 3];
    expect(paginate(list, 0, 2)).toEqual([1, 2]);
    expect(paginate(list, -3, 2)).toEqual([1, 2]);
  });

  it('pageSize<1 兜底为默认 50', () => {
    const list = Array.from({ length: 60 }, (_, i) => i);
    expect(paginate(list, 1, 0).length).toBe(50);
    expect(paginate(list, 1, -5).length).toBe(50);
  });

  it('非数字入参兜底', () => {
    const list = [1, 2, 3, 4, 5];
    expect(paginate(list, 'abc', 2)).toEqual([1, 2]);
    expect(paginate(list, 1, 'x')).toEqual([1, 2, 3, 4, 5]); // 兜底 50 → 全部
  });

  it('null/undefined list → 空数组', () => {
    expect(paginate(null, 1, 2)).toEqual([]);
    expect(paginate(undefined, 1, 2)).toEqual([]);
  });

  it('不修改入参（纯函数）', () => {
    const list = [1, 2, 3];
    const snap = JSON.stringify(list);
    paginate(list, 1, 2);
    expect(JSON.stringify(list)).toBe(snap);
  });

  it('导出默认页大小常量', () => {
    expect(DEFAULT_PAGE_SIZE).toBe(50);
  });
});

describe('pickNeighbors 前后相邻名次', () => {
  const list = [
    { user_id: 'u1', rank: 1 },
    { user_id: 'u2', rank: 2 },
    { user_id: 'u3', rank: 3 },
    { user_id: 'u4', rank: 4 },
    { user_id: 'u5', rank: 5 }
  ];

  it('我在中间：取前后各 1 名（共 3 条）', () => {
    const out = pickNeighbors(list, 'u3', 1);
    expect(out.map((i) => i.user_id)).toEqual(['u2', 'u3', 'u4']);
  });

  it('我在首位：前不足，只取本人+后 1', () => {
    const out = pickNeighbors(list, 'u1', 1);
    expect(out.map((i) => i.user_id)).toEqual(['u1', 'u2']);
  });

  it('我在末位：后不足，只取前 1+本人', () => {
    const out = pickNeighbors(list, 'u5', 1);
    expect(out.map((i) => i.user_id)).toEqual(['u4', 'u5']);
  });

  it('我在中间取前后各 2 名（共 5 条）', () => {
    const out = pickNeighbors(list, 'u3', 2);
    expect(out.map((i) => i.user_id)).toEqual(['u1', 'u2', 'u3', 'u4', 'u5']);
  });

  it('我在第 2 位取前后各 2 名：前不足裁剪', () => {
    const out = pickNeighbors(list, 'u2', 2);
    expect(out.map((i) => i.user_id)).toEqual(['u1', 'u2', 'u3', 'u4']);
  });

  it('本人不在列表 → 空数组', () => {
    expect(pickNeighbors(list, 'uX', 1)).toEqual([]);
  });

  it('myUserId 为空 → 空数组', () => {
    expect(pickNeighbors(list, '', 1)).toEqual([]);
    expect(pickNeighbors(list, null, 1)).toEqual([]);
  });

  it('n 默认/非法 → 0（仅返回本人？取 cnt 兜底 0 → 仅本人）', () => {
    const out = pickNeighbors(list, 'u3');
    expect(out.map((i) => i.user_id)).toEqual(['u3']);
  });

  it('保持原顺序', () => {
    const out = pickNeighbors(list, 'u3', 1);
    expect(out.map((i) => i.rank)).toEqual([2, 3, 4]);
  });

  it('不修改入参（纯函数）', () => {
    const snap = JSON.stringify(list);
    pickNeighbors(list, 'u3', 1);
    expect(JSON.stringify(list)).toBe(snap);
  });

  it('空列表 → 空数组', () => {
    expect(pickNeighbors([], 'u1', 1)).toEqual([]);
  });
});

describe('contribution 贡献占比（除零保护）', () => {
  it('正常占比，保留 1 位小数', () => {
    expect(contribution(1000, 4000)).toBe(25);
    expect(contribution(1, 3)).toBe(33.3);
    expect(contribution(2, 3)).toBe(66.7);
  });

  it('本人即为全部 → 100', () => {
    expect(contribution(5000, 5000)).toBe(100);
  });

  it('部门总数为 0 → 0（除零保护）', () => {
    expect(contribution(1000, 0)).toBe(0);
  });

  it('部门总数为负 → 0', () => {
    expect(contribution(1000, -100)).toBe(0);
  });

  it('本人步数为 0 → 0', () => {
    expect(contribution(0, 5000)).toBe(0);
  });

  it('本人步数为负 → 0', () => {
    expect(contribution(-100, 5000)).toBe(0);
  });

  it('非数字兜底 0', () => {
    expect(contribution('abc', 5000)).toBe(0);
    expect(contribution(1000, 'x')).toBe(0);
  });
});

describe('switchMetric 排序口径校正', () => {
  it('仅接受 avg/total', () => {
    expect(VALID_METRICS).toEqual(['avg', 'total']);
    expect(switchMetric('avg')).toBe('avg');
    expect(switchMetric('total')).toBe('total');
  });

  it('非法值按默认 avg 兜底', () => {
    expect(switchMetric('sum')).toBe('avg');
    expect(switchMetric('')).toBe('avg');
    expect(switchMetric(null)).toBe('avg');
    expect(switchMetric(undefined)).toBe('avg');
    expect(switchMetric(123)).toBe('avg');
  });

  it('自定义默认 total', () => {
    expect(switchMetric('xxx', 'total')).toBe('total');
  });

  it('合法值不受 def 影响', () => {
    expect(switchMetric('avg', 'total')).toBe('avg');
    expect(switchMetric('total', 'avg')).toBe('total');
  });
});

describe('isEmptyRank 空态判定', () => {
  it('空数组 → true', () => {
    expect(isEmptyRank([])).toBe(true);
  });

  it('有数据 → false', () => {
    expect(isEmptyRank([{ rank: 1 }])).toBe(false);
  });

  it('null/undefined → true', () => {
    expect(isEmptyRank(null)).toBe(true);
    expect(isEmptyRank(undefined)).toBe(true);
  });

  it('非数组 → true', () => {
    expect(isEmptyRank('xxx')).toBe(true);
    expect(isEmptyRank({})).toBe(true);
  });
});

describe('formatUpdatedAt 更新时间格式化', () => {
  const NOW = new Date('2026-06-26T12:00:00Z').getTime();

  it('无 ts → 空串', () => {
    expect(formatUpdatedAt(null, NOW)).toBe('');
    expect(formatUpdatedAt(undefined, NOW)).toBe('');
    expect(formatUpdatedAt('', NOW)).toBe('');
  });

  it('刚刚（< 1 分钟）', () => {
    expect(formatUpdatedAt(NOW - 30 * 1000, NOW)).toBe('刚刚');
    expect(formatUpdatedAt(NOW, NOW)).toBe('刚刚');
  });

  it('N 分钟前', () => {
    expect(formatUpdatedAt(NOW - 5 * 60000, NOW)).toBe('5 分钟前');
    expect(formatUpdatedAt(NOW - 59 * 60000, NOW)).toBe('59 分钟前');
  });

  it('N 小时前', () => {
    expect(formatUpdatedAt(NOW - 1 * 3600000, NOW)).toBe('1 小时前');
    expect(formatUpdatedAt(NOW - 23 * 3600000, NOW)).toBe('23 小时前');
  });

  it('N 天前（>= 24 小时）', () => {
    expect(formatUpdatedAt(NOW - 24 * 3600000, NOW)).toBe('1 天前');
    expect(formatUpdatedAt(NOW - 3 * 24 * 3600000, NOW)).toBe('3 天前');
  });

  it('ISO 字符串入参', () => {
    expect(formatUpdatedAt('2026-06-26T11:55:00Z', NOW)).toBe('5 分钟前');
  });

  it('Date 对象入参', () => {
    expect(formatUpdatedAt(new Date(NOW - 10 * 60000), NOW)).toBe('10 分钟前');
  });

  it('非法时间戳 → 空串', () => {
    expect(formatUpdatedAt('not-a-date', NOW)).toBe('');
  });

  it('时钟漂移（未来时间）→ 刚刚', () => {
    expect(formatUpdatedAt(NOW + 60000, NOW)).toBe('刚刚');
  });

  it('不传 now 默认用 Date.now（不报错）', () => {
    expect(formatUpdatedAt(Date.now() - 60000)).toBe('1 分钟前');
  });
});
