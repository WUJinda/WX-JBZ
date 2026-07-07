/**
 * activity.current 业务纯函数（对齐技术架构 §5.4 / §4.1，开发计划阶段 C1，PRD F7 R7.1~R7.4）。
 *
 * 本地轨：与 wx-server-sdk 解耦，db 以依赖注入方式传入（mock 集合可单测）。
 * 身份仅取 OPENID（游客无 OPENID 也可取活动信息——活动主页游客可见）。
 *
 * 状态推算（R7.1）：
 *   - now < start_time  → 未开始（pending）
 *   - start_time ≤ now ≤ end_time → 进行中（active）
 *   - now > end_time → 已结束（ended）
 *
 * status 为「时间推算结果」，不读库里的冗余 status 字段（冗余字段仅做查询索引用）。
 */

const STATUS = {
  PENDING: 'pending', // 未开始
  ACTIVE: 'active', // 进行中
  ENDED: 'ended' // 已结束
};

/**
 * 状态档位权重（「选当前活动」与列表排序共用，数字越小越靠前）：
 *   active 进行中(0) → pending 未开始(1) → ended 已结束(2)。
 * 提取到此处统一导出，供 pickCurrentActivity / activityList.listActivities 复用，避免口径分叉。
 */
const RANK_WEIGHT = {};
RANK_WEIGHT[STATUS.ACTIVE] = 0;
RANK_WEIGHT[STATUS.PENDING] = 1;
RANK_WEIGHT[STATUS.ENDED] = 2;

/**
 * 安全转时间戳。入参支持 Date / number(毫秒) / string(可解析) / null。
 * 非法值返回 NaN。
 * @param {Date|number|string|null} t
 * @returns {number}
 */
function toTs(t) {
  if (t == null) return NaN;
  if (typeof t === 'number') return t;
  if (t instanceof Date) return t.getTime();
  const n = Number(t);
  if (Number.isFinite(n) && /^\d+$/.test(String(t).trim())) return n;
  const ms = Date.parse(t);
  return ms;
}

/**
 * 活动状态推算（R7.1）。
 * 纯函数：注入 now 便于单测。
 *
 * @param {object} activity { start_time, end_time }
 * @param {Date|number} [now] 当前时间（默认 new Date()）
 * @returns {string} STATUS.PENDING / STATUS.ACTIVE / STATUS.ENDED
 */
function deriveStatus(activity, now) {
  const a = activity || {};
  // 手动终止优先（管理员提前结束，不可恢复）：terminated=true 一律 ended，忽略时间窗。
  if (a.terminated === true) return STATUS.ENDED;
  const start = toTs(a.start_time);
  const end = toTs(a.end_time);
  const cur = toTs(now === undefined ? new Date() : now);
  if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(cur)) {
    // 缺时间信息，保守视为未开始
    return STATUS.PENDING;
  }
  if (cur < start) return STATUS.PENDING;
  if (cur > end) return STATUS.ENDED;
  return STATUS.ACTIVE;
}

/**
 * 从活动集合里选「当前活动」（current / getActiveActivityId / getActiveActivity 共用口径）。
 *
 * 业务规则（与 listActivities 排序同源，对齐用户诉求）：
 *   - terminated=true 一律排除——终止活动不再展示在活动页 / 个人页顶部，也不再作为
 *     rank / stats / tasks 聚合的「当前活动」（终止即冻结，见 terminateActivity）；
 *   - 剩余按 deriveStatus 推算状态，档位权重升序（active → pending → ended），
 *     即「进行中 → 未开始 → 已结束」优先；这样新增活动（无论 active/pending）都会
 *     顶替已结束的旧活动，且不会有多个活动时仍取到 activities[0] 的旧顺序问题；
 *   - 同档按 start_time 降序（更晚开始的靠前，新增活动优先于同档旧活动）；
 *   - 库空 / 非数组 / 全终止 → 返回 null（调用方据此返回空态 / 空榜 / 空统计）。
 *
 * 纯函数：注入 now 便于单测；不改入参。宽容：不抛错（current/getActiveActivity 在
 *   handler 层已保证拿到数组，此处与 listActivities 的 SYS_DB_ERROR 不同，返 null 即可）。
 *
 * @param {object[]} activities Activity 文档数组
 * @param {Date|number} [now] 当前时间（注入便于单测；缺省 deriveStatus 内部取 new Date()）
 * @returns {object|null} 选中的原始活动文档（未投影，含 start_time/end_time 供 stats 等用），或 null
 */
function pickCurrentActivity(activities, now) {
  if (!Array.isArray(activities)) return null;
  const cur = now === undefined ? undefined : now;
  const items = activities
    .filter((a) => a && typeof a === 'object' && a.terminated !== true)
    .map((a) => ({ item: a, status: deriveStatus(a, cur), startTs: toTs(a.start_time) }));
  items.sort((x, y) => {
    const wx = RANK_WEIGHT[x.status] != null ? RANK_WEIGHT[x.status] : 99;
    const wy = RANK_WEIGHT[y.status] != null ? RANK_WEIGHT[y.status] : 99;
    if (wx !== wy) return wx - wy;
    // 同档：start_time 降序（更晚开始的靠前）；非法时间（NaN）排末尾
    const sx = Number.isFinite(x.startTs) ? x.startTs : -Infinity;
    const sy = Number.isFinite(y.startTs) ? y.startTs : -Infinity;
    return sy - sx;
  });
  return items.length ? items[0].item : null;
}

/**
 * current 下发投影：从 Activity 文档摘出可下发前端的字段。
 * 红线：不下发 onlyServer 敏感字段；status 由时间推算（不读库冗余）。
 *
 * @param {object} activity Activity 文档
 * @param {string} status 推算出的状态（pending/active/ended）
 * @param {object} [overview] 全员概览 { total_steps, participant_count }
 * @returns {object}
 */
function projectActivity(activity, status, overview) {
  const a = activity || {};
  const ov = overview || {};
  return {
    activity_id: a.activity_id || a._id || '',
    name: a.name || '',
    start_time: a.start_time,
    end_time: a.end_time,
    signup_deadline: a.signup_deadline || null,
    status: status || deriveStatus(a),
    // 必须下发 terminated：员工端 activity 页 statusText/CTA 由 calcCountdown 重算（不读 status 字段），
    // calcCountdown 靠 a.terminated===true 判「已终止」→ ended。若不下发，手动终止后前端仍按时间窗算成「进行中」。
    terminated: a.terminated === true,
    rules: a.rules || '',
    overview: {
      total_steps: typeof ov.total_steps === 'number' && ov.total_steps >= 0
        ? Math.floor(ov.total_steps)
        : 0,
      participant_count: typeof ov.participant_count === 'number' && ov.participant_count >= 0
        ? Math.floor(ov.participant_count)
        : 0
    }
  };
}

/**
 * current 主逻辑（纯函数 + 注入式 db）。
 * 游客可调：openid 可空（无 OPENID 也能取活动信息）。
 *
 * 本地轨：当前活动 + 概览用 mock 取值（真实聚合留阶段 G tasks.rankAggregate）。
 * 当前用户报名状态（join_status）由调用方注入（本地轨 mock；真实 user.join 留 D1）。
 *
 * @param {object} params
 * @param {object} [params.db] 数据库句柄（本地轨可缺省，走 mock 当前活动）
 * @param {string} [params.openid] 当前用户 openid（游客为空）
 * @param {function} [params.now] 时间工厂，便于测试
 * @param {string} [params.joinStatus] 当前用户报名状态（mock：pending/joined）
 * @returns {Promise<object>} projectActivity 结果（含 join_status）
 */
async function getCurrent(params) {
  const p = params || {};
  const now = p.now;

  // 本地轨：mock 当前活动（P0 单期活动仅一个实例，R7.2）
  const activity = p.activity || mockCurrentActivity();
  const status = deriveStatus(activity, now === undefined ? undefined : now);
  const overview = p.overview || { total_steps: 0, participant_count: 0 };

  const out = projectActivity(activity, status, overview);
  // join_status：游客为 pending（未报名）；本地轨由调用方注入（真实留 D1）
  out.join_status = p.joinStatus === 'joined' ? 'joined' : 'pending';
  return out;
}

/**
 * 本地轨 mock 当前活动（不调真实云数据库）。
 * 时间窗口：2026-07-01 00:00 ~ 2026-07-21 23:59:59（与 PRD 示例对齐）。
 */
function mockCurrentActivity() {
  return {
    activity_id: 'a_demo_001',
    name: '2026 员工健步走',
    rules: '活动规则示例：活动期间每日同步微信运动步数，累计计入个人与部门排行。',
    start_time: '2026-07-01T00:00:00+08:00',
    end_time: '2026-07-21T23:59:59+08:00',
    signup_deadline: null,
    total_steps: 0,
    participant_count: 0
  };
}

module.exports = {
  STATUS,
  RANK_WEIGHT,
  deriveStatus,
  pickCurrentActivity,
  projectActivity,
  getCurrent,
  mockCurrentActivity,
  // 导出便于其它模块/测试复用
  _toTs: toTs
};
