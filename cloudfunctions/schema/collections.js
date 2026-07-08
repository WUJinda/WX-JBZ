/**
 * 集合 schema 定义（对齐技术架构 §5 数据模型）。
 *
 * 文档型存储（微信云开发数据库），字段以 JSON 表示。
 * 此文件是「结构真相源」，用于：
 *   1) 索引初始化脚本（initIndexes.js）按此声明建唯一/普通索引；
 *   2) 单测做结构合法性校验（字段名、类型、索引唯一性声明齐全）；
 *   3) 后续轮次写其它集合时在此补充。
 *
 * 约定：
 *   - unique: true 的索引在初始化时按云数据库要求建为唯一索引。
 *   - 🔒 字段标记 onlyServer: true，表示仅后端存用、不下发前端（脱敏见各 action）。
 */

const COLLECTIONS = {
  User: {
    description: '用户（对齐技术架构 §5.1）',
    indexes: [
      { name: 'idx_user_openid', fields: { _openid: 1 }, unique: true },
      // phone 唯一索引：建号时 phone 必填非空（auth.register 一次性提交），无 phone='' 空占位，
      // 故旧「空串撞键致新用户登录失败」问题已消除。唯一性 = 此 DB 索引 + register 应用层查重双保险。
      { name: 'idx_user_phone', fields: { phone: 1 }, unique: true },
      { name: 'idx_user_dept', fields: { dept_id: 1 }, unique: false },
      { name: 'idx_user_admin', fields: { is_admin: 1 }, unique: false }
    ],
    fields: {
      _id: { type: 'string', desc: '主键（云数据库自动生成）' },
      _openid: { type: 'string', onlyServer: true, desc: '微信 openid（唯一），鉴权身份键' },
      unionid: { type: 'string', optional: true, onlyServer: true, desc: '微信 unionid（可选，预留）' },
      nickname: { type: 'string', desc: '昵称（取微信昵称或自填）' },
      avatar: { type: 'string', desc: '头像 URL（取微信头像或自传）' },
      phone: { type: 'string', onlyServer: true, desc: '🔒 完整手机号（注册必填、唯一；由 auth.register 写入，唯一性=DB索引+应用层查重）' },
      phone_masked: { type: 'string', desc: '脱敏手机号（138****1234），前端展示' },
      dept_id: { type: 'string', optional: true, desc: '部门 id（报名后写入）' },
      join_status: {
        type: 'string',
        enum: ['pending', 'joined'],
        default: 'pending',
        desc: '报名状态：pending 未报名 / joined 已报名'
      },
      joined_at: { type: 'date', optional: true, desc: '报名时间' },
      is_admin: { type: 'boolean', default: false, desc: '是否管理员' },
      created_at: { type: 'date', desc: '创建时间' },
      updated_at: { type: 'date', desc: '更新时间' }
    }
  },

  Whitelist: {
    description: '员工白名单（对齐技术架构 §5.3）',
    indexes: [
      { name: 'idx_whitelist_phone', fields: { phone: 1 }, unique: true }
    ],
    fields: {
      _id: { type: 'string', desc: '主键' },
      phone: { type: 'string', onlyServer: true, desc: '🔒 完整手机号，仅后端匹配' },
      imported_at: { type: 'date', desc: '导入时间' }
    }
  },

  Department: {
    description: '部门（对齐技术架构 §5.2，PRD F2 部门选择）',
    indexes: [
      { name: 'idx_dept_activity', fields: { activity_id: 1 }, unique: false },
      { name: 'idx_dept_activity_name', fields: { activity_id: 1, name: 1 }, unique: true },
      { name: 'idx_dept_id', fields: { dept_id: 1 }, unique: true }
    ],
    fields: {
      _id: { type: 'string', desc: '主键（云数据库自动生成）' },
      dept_id: { type: 'string', desc: '部门唯一标识（业务键，如 d_01）' },
      name: { type: 'string', desc: '部门名称（即团队名，PRD dept_name）' },
      activity_id: { type: 'string', desc: '所属活动 ID（P0 单期，预留多期）' },
      member_count: {
        type: 'int',
        default: 0,
        desc: '部门已报名人数（展示用，聚合写回；真实聚合留阶段 G）'
      },
      created_at: { type: 'date', desc: '创建时间' }
    }
  },

  Activity: {
    description: '活动（对齐技术架构 §5.4，PRD F7）',
    indexes: [
      // activity_id 是活动业务主键，必须唯一——防 save upsert 的 TOCTOU 窗口产生重复活动文档
      // （current 取 activities[0] 与 save 编辑的可能不是同一文档，导致显示/编辑错位）。
      { name: 'idx_activity_id', fields: { activity_id: 1 }, unique: true },
      { name: 'idx_activity_status', fields: { status: 1 }, unique: false },
      { name: 'idx_activity_start', fields: { start_time: 1 }, unique: false }
    ],
    fields: {
      _id: { type: 'string', desc: '主键' },
      activity_id: { type: 'string', desc: '活动 ID（P0 单期，预留多期）' },
      name: { type: 'string', desc: '活动名称' },
      start_time: { type: 'date', desc: '开始时间' },
      end_time: { type: 'date', desc: '结束时间' },
      signup_deadline: {
        type: 'date',
        optional: true,
        desc: '报名截止时间（可选；不填=活动结束前都可报名；填了须 ≤ end_time）。user.join 据此拦截逾期报名'
      },
      status: {
        type: 'string',
        enum: ['pending', 'active', 'ended'],
        desc: '活动状态：由时间推算冗余写入（pending 未开始 / active 进行中 / ended 已结束）；terminated=true 时优先为 ended；真实判定以 deriveStatus 为准'
      },
      terminated: {
        type: 'boolean',
        default: false,
        desc: '是否已手动终止（管理员提前结束，不可恢复；deriveStatus 优先判此字段，命中即 ended）'
      },
      terminated_at: { type: 'date', optional: true, desc: '手动终止时间（terminated=true 时写入）' },
      rules: { type: 'string', desc: '规则说明（richtext）' },
      total_steps: {
        type: 'int',
        onlyServer: true,
        desc: '🔒 全员累计步数（聚合写回，不下发原始值，概览中按需下发）'
      },
      participant_count: {
        type: 'int',
        onlyServer: true,
        desc: '🔒 已报名人数（聚合写回，概览中按需下发）'
      },
      created_at: { type: 'date', desc: '创建时间' },
      updated_at: { type: 'date', desc: '更新时间' }
    }
  },

  StepRecord: {
    description: '步数记录（对齐技术架构 §5.5 / §6.2，PRD F3 R3.1~R3.6）',
    indexes: [
      // R3.2 去重依据：同一 (user_id, activity_id, date) 仅一条。
      // 云数据库无原生唯一约束，由 sync 逻辑用先查后写/事务保证 upsert；
      // 此处声明为唯一索引作为「结构真相源」（建索引脚本据此建唯一索引）。
      {
        name: 'idx_step_user_activity_date',
        fields: { user_id: 1, activity_id: 1, date: 1 },
        unique: true
      },
      { name: 'idx_step_activity_date', fields: { activity_id: 1, date: 1 }, unique: false },
      { name: 'idx_step_abnormal_activity', fields: { abnormal: 1, activity_id: 1 }, unique: false }
    ],
    fields: {
      _id: { type: 'string', desc: '主键（云数据库自动生成）' },
      user_id: { type: 'string', desc: '用户 id（业务键，= 用户 openid；rankAggregate 以 User._openid 关联，非 User._id）' },
      _openid: { type: 'string', onlyServer: true, desc: '🔒 微信 openid（冗余便于聚合，不下发原始值）' },
      activity_id: { type: 'string', desc: '所属活动 ID' },
      date: { type: 'string', desc: '步数日期 YYYY-MM-DD（北京时间）' },
      steps: { type: 'int', default: 0, desc: '当日步数' },
      abnormal: { type: 'boolean', default: false, desc: '是否异常标记（单日 > 阈值，仅标记不剔除，R3.6）' },
      locked: { type: 'boolean', default: false, desc: '每日锁定标记（次日 12:00 锁定后置 true，锁定后 sync 不覆盖，§6.4）' },
      synced_at: { type: 'date', desc: '最近同步时间（也用于同分排序 first_reach_at 计算，§6.3）' },
      sync_count: { type: 'int', default: 0, onlyServer: true, desc: '🔒 当日同步计数（频控用，≤6 次/日，R3.3）' }
    }
  },

  RankCache: {
    description: '排行榜缓存（对齐技术架构 §5.6/§6.6，PRD R5/R6，由 tasks.rankAggregate 覆盖写）。P0-3 单文档：每 (type, activity_id) 一个文档，rows 为整榜行数组；覆盖写 = 一次原子 update，无并发 double（替代旧每排名一行文档的「先 add 后 remove」非原子流程）。',
    indexes: [
      // 单文档定位主索引：每 (type, activity_id) 唯一一个文档。
      { name: 'idx_rankcache_type_activity', fields: { type: 1, activity_id: 1 }, unique: true }
    ],
    fields: {
      _id: { type: 'string', desc: '主键（云数据库自动生成）' },
      type: {
        type: 'string',
        enum: ['personal', 'dept'],
        desc: '缓存类型：personal 个人榜 / dept 部门榜'
      },
      activity_id: { type: 'string', desc: '所属活动 ID' },
      rows: {
        type: 'array',
        desc:
          '整榜行数组（按 rank 升序；覆盖写时整体替换）。每行结构：' +
          '{rank, ref_id, total_steps, first_reach_at(仅personal), nickname(仅personal), user_id(仅personal,=ref_id), ' +
          'dept_id(personal:deptMembers过滤/dept:=ref_id), dept_name, member_count(仅dept), avg_steps(仅dept), small_sample(仅dept)}'
      },
      updated_at: { type: 'date', desc: '最近聚合时间（覆盖写时更新）' }
    }
  }
};

module.exports = { COLLECTIONS };
