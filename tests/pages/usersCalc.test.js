/**
 * 后台用户管理前端纯函数单测（F8 R8.3，H3）。
 * buildDeptOptions / hasMore / formatJoinStatus，纯函数不耦合 wx 运行时。
 *
 * 红线验证：buildDeptOptions 仅摘取 dept_id/name（不下发 member_count 等多余字段供 picker）。
 */
const {
  buildDeptOptions,
  hasMore,
  formatJoinStatus,
  DEFAULT_PAGE_SIZE
} = require('../../miniprogram/pages/admin/users/usersCalc');

describe('buildDeptOptions 构造部门 picker 选项', () => {
  it('dept.list 返回结构 {list:[...]} → 摘取 dept_id/name', () => {
    const out = buildDeptOptions({
      list: [
        { dept_id: 'd_01', name: '研发部', member_count: 12 },
        { dept_id: 'd_02', name: '产品部', member_count: 8 }
      ]
    });
    expect(out).toEqual([
      { dept_id: 'd_01', name: '研发部' },
      { dept_id: 'd_02', name: '产品部' }
    ]);
  });

  it('直接传数组 → 同样摘取 dept_id/name', () => {
    const out = buildDeptOptions([{ dept_id: 'd_01', name: '研发部' }]);
    expect(out).toEqual([{ dept_id: 'd_01', name: '研发部' }]);
  });

  it('仅摘取 dept_id/name（不携带 member_count）', () => {
    const out = buildDeptOptions([{ dept_id: 'd_01', name: '研发部', member_count: 99 }]);
    expect(out[0]).not.toHaveProperty('member_count');
  });

  it('过滤掉无 dept_id 的项', () => {
    const out = buildDeptOptions([
      { dept_id: 'd_01', name: '研发部' },
      { name: '无 id 部门' },
      { dept_id: '', name: '空 id' }
    ]);
    expect(out).toEqual([{ dept_id: 'd_01', name: '研发部' }]);
  });

  it('空数组 / 空 list → []', () => {
    expect(buildDeptOptions([])).toEqual([]);
    expect(buildDeptOptions({ list: [] })).toEqual([]);
  });

  it('null / undefined / 非对象 → []', () => {
    expect(buildDeptOptions(null)).toEqual([]);
    expect(buildDeptOptions(undefined)).toEqual([]);
    expect(buildDeptOptions('xxx')).toEqual([]);
    expect(buildDeptOptions({})).toEqual([]);
  });

  it('缺 name → name 兜底空字符串', () => {
    const out = buildDeptOptions([{ dept_id: 'd_01' }]);
    expect(out).toEqual([{ dept_id: 'd_01', name: '' }]);
  });
});

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

describe('formatJoinStatus 报名状态文案', () => {
  it('joined → 已报名', () => {
    expect(formatJoinStatus('joined')).toBe('已报名');
  });
  it('quit → 已退出', () => {
    expect(formatJoinStatus('quit')).toBe('已退出');
  });
  it('pending → 待报名', () => {
    expect(formatJoinStatus('pending')).toBe('待报名');
  });
  it('空 / 非法 → 未报名（兜底）', () => {
    expect(formatJoinStatus('')).toBe('未报名');
    expect(formatJoinStatus(undefined)).toBe('未报名');
    expect(formatJoinStatus(null)).toBe('未报名');
    expect(formatJoinStatus('xxx')).toBe('未报名');
  });
});
