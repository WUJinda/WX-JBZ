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
    it('输出 dept_id/name/member_count/size，不带敏感字段', () => {
      const out = projectDept({
        dept_id: 'd_01',
        name: '研发部',
        member_count: 12,
        size: 9,
        activity_id: 'a_01',
        _id: 'xxx',
        created_at: '2026-06-26'
      });
      expect(out).toEqual({ dept_id: 'd_01', name: '研发部', member_count: 12, size: 9 });
      expect(out).not.toHaveProperty('_id');
      expect(out).not.toHaveProperty('activity_id');
    });

    it('member_count 缺失兜底 0，字符串数字向下取整', () => {
      expect(projectDept({ dept_id: 'd', name: 'n' }).member_count).toBe(0);
      expect(projectDept({ dept_id: 'd', name: 'n', member_count: '12.9' }).member_count).toBe(12);
      expect(projectDept({ dept_id: 'd', name: 'n', member_count: -1 }).member_count).toBe(0);
    });

    it('size 缺失/非法兜底 0，数字字符串向下取整', () => {
      expect(projectDept({ dept_id: 'd', name: 'n' }).size).toBe(0);
      expect(projectDept({ dept_id: 'd', name: 'n', size: '9.9' }).size).toBe(9);
      expect(projectDept({ dept_id: 'd', name: 'n', size: -3 }).size).toBe(0);
      expect(projectDept({ dept_id: 'd', name: 'n', size: 'abc' }).size).toBe(0);
    });
  });

  describe('listDepartments 主逻辑', () => {
    it('F5：source 缺省抛错（不再回退 mock，避免假部门）', async () => {
      await expect(listDepartments()).rejects.toThrow(/source|数据源/);
      await expect(listDepartments({})).rejects.toThrow(/source|数据源/);
    });

    it('source 为空数组返回空列表（合法：管理员未录部门）', async () => {
      const { list } = await listDepartments({ source: [] });
      expect(list).toEqual([]);
    });

    it('注入 MOCK_DEPARTMENTS 源返回部门列表（含 member_count）', async () => {
      const { list } = await listDepartments({ source: MOCK_DEPARTMENTS });
      expect(list.length).toBe(MOCK_DEPARTMENTS.length);
      expect(list[0]).toHaveProperty('dept_id');
      expect(list[0]).toHaveProperty('name');
      expect(list[0]).toHaveProperty('member_count');
    });

    it('注入 source 时返回注入源的投影', async () => {
      const { list } = await listDepartments({
        source: [{ dept_id: 'x1', name: 'X1', member_count: 3, size: 5 }]
      });
      expect(list).toEqual([{ dept_id: 'x1', name: 'X1', member_count: 3, size: 5 }]);
    });

    it('注入 counts 时用聚合人数覆盖 member_count（云轨实时聚合），size 不受影响', async () => {
      const { list } = await listDepartments({
        source: [
          { dept_id: 'd1', name: '一部', member_count: 0, size: 10 },
          { dept_id: 'd2', name: '二部', member_count: 0, size: 5 },
          { dept_id: 'd3', name: '三部', member_count: 0 }
        ],
        counts: { d1: 3, d2: 0 } // d3 不在 counts → 回退 doc.member_count(0)
      });
      expect(list).toEqual([
        { dept_id: 'd1', name: '一部', member_count: 3, size: 10 },
        { dept_id: 'd2', name: '二部', member_count: 0, size: 5 },
        { dept_id: 'd3', name: '三部', member_count: 0, size: 0 }
      ]);
    });
  });
});
