/**
 * 后台部门管理前端纯函数单测（F8 部门管理，H3）。
 * validateDeptName / formatDept，纯函数不耦合 wx 运时。
 *
 * 红线验证：纯函数仅消费 dept.list / admin.deptManage 下发的字段
 * （dept_id/name/member_count），不下发 _openid / 任何敏感字段。
 */
const {
  validateDeptName,
  validateDeptSize,
  formatDept,
  MAX_DEPT_NAME_LEN
} = require('../../miniprogram/pages/admin/dept/deptCalc');

describe('validateDeptName 部门名校验', () => {
  it('合法名称 → valid=true', () => {
    expect(validateDeptName('研发部')).toEqual({ valid: true, error: '' });
    expect(validateDeptName('研发一部')).toEqual({ valid: true, error: '' });
  });

  it('带空白的名称 → 去空后校验', () => {
    expect(validateDeptName('  研发部  ')).toEqual({ valid: true, error: '' });
  });

  it('空字符串 → valid=false', () => {
    expect(validateDeptName('')).toEqual({ valid: false, error: '部门名不能为空' });
  });

  it('纯空白 → valid=false', () => {
    expect(validateDeptName('   ')).toEqual({ valid: false, error: '部门名不能为空' });
  });

  it('null / undefined → valid=false', () => {
    expect(validateDeptName(null)).toEqual({ valid: false, error: '部门名不能为空' });
    expect(validateDeptName(undefined)).toEqual({ valid: false, error: '部门名不能为空' });
  });

  it('长度等于上限 → valid=true（边界）', () => {
    const s = '部'.repeat(MAX_DEPT_NAME_LEN);
    expect(validateDeptName(s)).toEqual({ valid: true, error: '' });
  });

  it('长度超过上限 → valid=false（边界）', () => {
    const s = '部'.repeat(MAX_DEPT_NAME_LEN + 1);
    const r = validateDeptName(s);
    expect(r.valid).toBe(false);
    expect(r.error).toContain(String(MAX_DEPT_NAME_LEN));
  });

  it('MAX_DEPT_NAME_LEN 导出为正整数', () => {
    expect(typeof MAX_DEPT_NAME_LEN).toBe('number');
    expect(MAX_DEPT_NAME_LEN).toBeGreaterThan(0);
  });
});

describe('formatDept 部门展示格式化', () => {
  it('dept.list 下发结构 → 摘 dept_id/name + size + 成员数文案', () => {
    expect(formatDept({ dept_id: 'd_01', name: '研发部', member_count: 12, size: 9 })).toEqual({
      dept_id: 'd_01',
      name: '研发部',
      size: 9,
      memberCountText: '12 人'
    });
  });

  it('member_count=0 → 0 人', () => {
    expect(formatDept({ dept_id: 'd_02', name: '产品部', member_count: 0 }).memberCountText).toBe('0 人');
  });

  it('member_count 缺省 → 0 人兜底', () => {
    expect(formatDept({ dept_id: 'd_03', name: '市场部' }).memberCountText).toBe('0 人');
  });

  it('member_count 非数字 → 0 人兜底', () => {
    expect(formatDept({ dept_id: 'd_04', name: '财务部', member_count: 'abc' }).memberCountText).toBe('0 人');
  });

  it('member_count 为数字字符串 → 解析', () => {
    expect(formatDept({ dept_id: 'd_05', name: '行政部', member_count: '8' }).memberCountText).toBe('8 人');
  });

  it('member_count 负数 → 0 人兜底', () => {
    expect(formatDept({ dept_id: 'd_06', name: '测试部', member_count: -5 }).memberCountText).toBe('0 人');
  });

  it('member_count 浮点 → 向下取整', () => {
    expect(formatDept({ dept_id: 'd_07', name: '运营部', member_count: 7.9 }).memberCountText).toBe('7 人');
  });

  it('缺 dept_id / name → 兜底空字符串', () => {
    const out = formatDept({});
    expect(out.dept_id).toBe('');
    expect(out.name).toBe('');
    expect(out.memberCountText).toBe('0 人');
  });

  it('null / undefined / 非对象 → 兜底空对象', () => {
    expect(formatDept(null)).toEqual({ dept_id: '', name: '', size: 0, memberCountText: '0 人' });
    expect(formatDept(undefined)).toEqual({ dept_id: '', name: '', size: 0, memberCountText: '0 人' });
    expect(formatDept('xxx')).toEqual({ dept_id: '', name: '', size: 0, memberCountText: '0 人' });
  });
});

describe('validateDeptSize 部门人数校验', () => {
  it('空值（不填）= 未配置，合法 → value=0', () => {
    expect(validateDeptSize('')).toEqual({ valid: true, error: '', value: 0 });
    expect(validateDeptSize(null)).toEqual({ valid: true, error: '', value: 0 });
    expect(validateDeptSize(undefined)).toEqual({ valid: true, error: '', value: 0 });
  });

  it('合法整数 → value 取整', () => {
    expect(validateDeptSize('9')).toEqual({ valid: true, error: '', value: 9 });
    expect(validateDeptSize(10)).toEqual({ valid: true, error: '', value: 10 });
  });

  it('小数 → 向下取整合法', () => {
    expect(validateDeptSize('9.9')).toEqual({ valid: true, error: '', value: 9 });
  });

  it('负数 → 不合法', () => {
    const r = validateDeptSize('-1');
    expect(r.valid).toBe(false);
    expect(r.error).toBeTruthy();
  });

  it('非数字 → 不合法', () => {
    const r = validateDeptSize('abc');
    expect(r.valid).toBe(false);
    expect(r.error).toBeTruthy();
  });
});
