const {
  listDepartments,
  projectDept,
  MOCK_DEPARTMENTS
} = require('../../cloudfunctions/dept/deptList');
const { CODE } = require('../../cloudfunctions/common/errors');

describe('dept.list 纯函数（D1）', () => {
  describe('MOCK_DEPARTMENTS 本地轨数据', () => {
    it('含 3~5 个部门，字段齐全（dept_id/name/member_count）', () => {
      expect(MOCK_DEPARTMENTS.length).toBeGreaterThanOrEqual(3);
      expect(MOCK_DEPARTMENTS.length).toBeLessThanOrEqual(8);
      for (const d of MOCK_DEPARTMENTS) {
        expect(d.dept_id).toEqual(expect.any(String));
        expect(d.dept_id.length).toBeGreaterThan(0);
        expect(d.name).toEqual(expect.any(String));
        expect(typeof d.member_count).toBe('number');
      }
      // dept_id 唯一
      const ids = MOCK_DEPARTMENTS.map((d) => d.dept_id);
      expect(new Set(ids).size).toBe(ids.length);
    });
  });

  describe('projectDept 投影', () => {
    it('输出 dept_id/name/member_count，不带敏感字段', () => {
      const out = projectDept({
        dept_id: 'd_01',
        name: '研发部',
        member_count: 12,
        activity_id: 'a_01',
        _id: 'xxx',
        created_at: '2026-06-26'
      });
      expect(out).toEqual({ dept_id: 'd_01', name: '研发部', member_count: 12 });
      expect(out).not.toHaveProperty('_id');
      expect(out).not.toHaveProperty('activity_id');
    });

    it('member_count 缺失兜底 0，字符串数字向下取整', () => {
      expect(projectDept({ dept_id: 'd', name: 'n' }).member_count).toBe(0);
      expect(projectDept({ dept_id: 'd', name: 'n', member_count: '12.9' }).member_count).toBe(12);
      expect(projectDept({ dept_id: 'd', name: 'n', member_count: -1 }).member_count).toBe(0);
    });
  });

  describe('listDepartments 主逻辑', () => {
    it('默认走 mock 源，返回部门列表（含 member_count）', async () => {
      const { list } = await listDepartments();
      expect(list.length).toBe(MOCK_DEPARTMENTS.length);
      expect(list[0]).toHaveProperty('dept_id');
      expect(list[0]).toHaveProperty('name');
      expect(list[0]).toHaveProperty('member_count');
    });

    it('注入 source 时返回注入源的投影', async () => {
      const { list } = await listDepartments({
        source: [{ dept_id: 'x1', name: 'X1', member_count: 3 }]
      });
      expect(list).toEqual([{ dept_id: 'x1', name: 'X1', member_count: 3 }]);
    });
  });
});
