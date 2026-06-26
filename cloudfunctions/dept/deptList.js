/**
 * dept.list 业务纯函数（对齐技术架构 §4.1/§5.2，开发计划阶段 D1，PRD F2）。
 *
 * 红线：
 *   - 部门列表对已登录员工可见（白名单已在登录阶段校验，list 不再校验）；
 *   - 不下发任何敏感字段（Department 无敏感字段，但仅投影 dept_id/name/member_count）。
 *
 * 本地轨：mock 部门数据（3~5 个）。真实云读留云轨联调；member_count 真实聚合留阶段 G。
 */

/**
 * 本地轨 mock 部门数据（PRD F2 字段：dept_id / name / member_count）。
 * 由管理员后台预设（R2.3），员工不可新增部门（R2.3）。
 */
const MOCK_DEPARTMENTS = [
  { dept_id: 'd_01', name: '研发部', member_count: 12 },
  { dept_id: 'd_02', name: '产品部', member_count: 8 },
  { dept_id: 'd_03', name: '市场部', member_count: 6 },
  { dept_id: 'd_04', name: '人事行政部', member_count: 5 },
  { dept_id: 'd_05', name: '财务部', member_count: 4 }
];

/**
 * 部门下发投影：从 Department 文档摘出可下发前端字段。
 * 纯函数：不写库。
 * @param {object} dept
 * @returns {{dept_id: string, name: string, member_count: number}}
 */
function projectDept(dept) {
  const d = dept || {};
  const mc = typeof d.member_count === 'number'
    ? d.member_count
    : Number(d.member_count);
  return {
    dept_id: d.dept_id || '',
    name: d.name || '',
    member_count: Number.isFinite(mc) && mc >= 0 ? Math.floor(mc) : 0
  };
}

/**
 * dept.list 主逻辑（纯函数 + 注入式源）。
 *
 * @param {object} [params]
 * @param {object} [params.source] 部门数据源；缺省时用本地 mock（云轨可注入 db 查询结果）
 * @returns {Promise<{list: object[]}>} 部门列表（已投影）
 */
async function listDepartments(params) {
  const opts = params || {};
  const source = Array.isArray(opts.source) ? opts.source : MOCK_DEPARTMENTS;
  const list = source.map(projectDept);
  return { list };
}

module.exports = { listDepartments, projectDept, MOCK_DEPARTMENTS };
