/**
 * dept.list 业务纯函数（对齐技术架构 §4.1/§5.2，开发计划阶段 D1，PRD F2）。
 *
 * 红线：
 *   - 部门列表对已登录员工可见（白名单已在登录阶段校验，list 不再校验）；
 *   - 不下发任何敏感字段（Department 无敏感字段，但仅投影 dept_id/name/member_count）。
 *
 * 本地轨：mock 部门数据（source 缺省时兜底，供本地轨/单测）。云轨 handler 注入真实 Department 集合；
 * member_count 真实聚合留阶段 G。
 */

/**
 * 本地轨 mock 部门数据（PRD F2 字段：dept_id / name / member_count）。
 * 由管理员后台预设（R2.3），员工不可新增部门（R2.3）。
 */

const { CODE, BizError } = require('../common/errors');

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
 * @param {object} [params.counts] 各部门「已报名人数」映射 {dept_id: number}（云轨 handler 实时聚合
 *   User where dept_id && join_status='joined'）；注入时覆盖 doc.member_count。
 *   缺省时回退 doc.member_count（本地轨 mock 兜底/单测）。
 * @returns {Promise<{list: object[]}>} 部门列表（已投影）
 */
async function listDepartments(params) {
  const opts = params || {};
  // F5：source 必须是数组（云轨 handler 注入真实 Department；本地轨单测显式传 MOCK_DEPARTMENTS）。
  //   不再回退 MOCK_DEPARTMENTS——避免管理员未录部门时员工看到假部门（d_01 等假数据）。
  if (!Array.isArray(opts.source)) {
    throw BizError(CODE.BIZ_DEPT_NOT_FOUND, 'listDepartments: source 部门数据源必传（数组）');
  }
  const source = opts.source;
  const counts = opts.counts && typeof opts.counts === 'object' ? opts.counts : null;
  const list = source.map((d) => {
    // counts 注入：用实时聚合的「已报名人数」覆盖 doc.member_count（云轨）；
    // counts 缺省或该部门无记录时回退 doc.member_count（本地轨 mock 兜底/单测）。
    // 修复硬伤：原 Department.member_count 仅 createDept 时初始化 0、此后无任何更新 → 恒 0。
    const useCount =
      counts && d && d.dept_id && Object.prototype.hasOwnProperty.call(counts, d.dept_id);
    const merged = useCount ? Object.assign({}, d, { member_count: counts[d.dept_id] }) : d;
    return projectDept(merged);
  });
  return { list };
}

module.exports = { listDepartments, projectDept, MOCK_DEPARTMENTS };
