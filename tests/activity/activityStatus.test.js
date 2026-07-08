const {
  STATUS,
  RANK_WEIGHT,
  deriveStatus,
  pickCurrentActivity,
  projectActivity,
  getCurrent,
  mockCurrentActivity
} = require('../../cloudfunctions/activity/activityStatus');
const { CODE } = require('../../cloudfunctions/common/errors');

describe('activity.current 纯函数（C1）', () => {
  // 活动窗口：2026-07-01 00:00 ~ 2026-07-21 23:59:59（UTC 整点便于断言）
  const START = Date.parse('2026-07-01T00:00:00Z');
  const END = Date.parse('2026-07-21T23:59:59Z');
  const activity = { start_time: START, end_time: END };

  describe('deriveStatus（状态推算 R7.1 三态）', () => {
    it('now < start → 未开始（pending）', () => {
      const before = Date.parse('2026-06-20T12:00:00Z');
      expect(deriveStatus(activity, before)).toBe(STATUS.PENDING);
    });

    it('start ≤ now ≤ end → 进行中（active）', () => {
      const mid = Date.parse('2026-07-10T12:00:00Z');
      expect(deriveStatus(activity, mid)).toBe(STATUS.ACTIVE);
      // 边界：等于 start
      expect(deriveStatus(activity, START)).toBe(STATUS.ACTIVE);
      // 边界：等于 end
      expect(deriveStatus(activity, END)).toBe(STATUS.ACTIVE);
    });

    it('now > end → 已结束（ended）', () => {
      const after = Date.parse('2026-08-01T00:00:00Z');
      expect(deriveStatus(activity, after)).toBe(STATUS.ENDED);
    });

    it('注入字符串时间同样判定', () => {
      expect(deriveStatus(activity, '2026-06-01T00:00:00Z')).toBe(STATUS.PENDING);
      expect(deriveStatus(activity, '2026-07-15T00:00:00Z')).toBe(STATUS.ACTIVE);
      expect(deriveStatus(activity, '2026-09-01T00:00:00Z')).toBe(STATUS.ENDED);
    });

    it('注入 Date 实例同样判定', () => {
      expect(deriveStatus(activity, new Date(START - 1000))).toBe(STATUS.PENDING);
      expect(deriveStatus(activity, new Date(END + 1000))).toBe(STATUS.ENDED);
    });

    it('时间信息缺失保守视为未开始', () => {
      expect(deriveStatus({}, '2026-07-10T00:00:00Z')).toBe(STATUS.PENDING);
      expect(deriveStatus({ start_time: START }, '2026-07-10T00:00:00Z')).toBe(STATUS.PENDING);
    });

    it('纯函数：不修改入参', () => {
      const a = { start_time: START, end_time: END };
      const snapshot = JSON.stringify(a);
      deriveStatus(a, '2026-07-10T00:00:00Z');
      expect(JSON.stringify(a)).toBe(snapshot);
    });

    it('terminated=true 一律 ended（手动终止优先于时间窗）', () => {
      // 即便时间窗仍在进行中，terminated 也直接判 ended
      expect(deriveStatus({ start_time: START, end_time: END, terminated: true }, Date.parse('2026-07-10T00:00:00Z'))).toBe(STATUS.ENDED);
      // 未开始时段终止也判 ended
      expect(deriveStatus({ start_time: START, end_time: END, terminated: true }, Date.parse('2026-06-10T00:00:00Z'))).toBe(STATUS.ENDED);
    });

    it('terminated 非 true（false/缺省）走正常时间推算', () => {
      expect(deriveStatus({ start_time: START, end_time: END, terminated: false }, Date.parse('2026-07-10T00:00:00Z'))).toBe(STATUS.ACTIVE);
      expect(deriveStatus({ start_time: START, end_time: END }, Date.parse('2026-07-10T00:00:00Z'))).toBe(STATUS.ACTIVE);
    });
  });

  describe('projectActivity（脱敏下发）', () => {
    it('摘出活动信息 + 状态 + 概览，字段齐全', () => {
      const out = projectActivity(
        { _id: 'a_001', activity_id: 'a_001', name: '走起',
          start_time: START, end_time: END, signup_deadline: '2026-06-30T23:59:59+08:00', rules: '规则' },
        STATUS.ACTIVE,
        { total_steps: 12345, participant_count: 30 }
      );
      expect(out.activity_id).toBe('a_001');
      expect(out.name).toBe('走起');
      expect(out.signup_deadline).toBe('2026-06-30T23:59:59+08:00');
      expect(out).not.toHaveProperty('cover_url');
      expect(out.status).toBe(STATUS.ACTIVE);
      expect(out.rules).toBe('规则');
      expect(out.overview.total_steps).toBe(12345);
      expect(out.overview.participant_count).toBe(30);
    });

    it('overview 缺失兜底为 0', () => {
      const out = projectActivity({ start_time: START, end_time: END }, STATUS.PENDING);
      expect(out.overview.total_steps).toBe(0);
      expect(out.overview.participant_count).toBe(0);
    });

    it('overview 非法值兜底为 0（向下取整）', () => {
      const out = projectActivity({}, STATUS.ACTIVE, { total_steps: -5, participant_count: 3.9 });
      expect(out.overview.total_steps).toBe(0);
      expect(out.overview.participant_count).toBe(3);
    });

    it('不下发 onlyServer 敏感原始字段（_openid / phone 等）', () => {
      const out = projectActivity({ _openid: 'oSECRET', phone: '13812341234' }, STATUS.ACTIVE);
      expect(out).not.toHaveProperty('_openid');
      expect(out).not.toHaveProperty('phone');
    });

    it('下发 terminated（前端 calcCountdown 据此识别「已终止」）', () => {
      // terminated=true：即使仍在时间窗内（status 传 ACTIVE），terminated 也照实下发
      const out = projectActivity(
        { activity_id: 'a_001', start_time: START, end_time: END, terminated: true },
        STATUS.ACTIVE
      );
      expect(out.terminated).toBe(true);
      // 未 terminated：下发 false（而非 undefined，便于前端直接判等）
      const out2 = projectActivity({ start_time: START, end_time: END }, STATUS.ACTIVE);
      expect(out2.terminated).toBe(false);
    });

    it('activity_id 缺失时回退 _id，再缺失为空串', () => {
      expect(projectActivity({ _id: 'x1' }, STATUS.ACTIVE).activity_id).toBe('x1');
      expect(projectActivity({}, STATUS.ACTIVE).activity_id).toBe('');
    });
  });

  describe('getCurrent（游客可调 + 契约）', () => {
    it('游客（无 openid）也能取活动信息，不抛错', async () => {
      const out = await getCurrent({
        now: '2026-07-10T00:00:00Z',
        overview: { total_steps: 100, participant_count: 5 }
      });
      expect(out.status).toBe(STATUS.ACTIVE);
      expect(out.overview.total_steps).toBe(100);
      // 游客 join_status 恒 pending
      expect(out.join_status).toBe('pending');
    });

    it('返回结构含 activity_id / name / start_time / end_time / status / rules / overview / join_status', async () => {
      const out = await getCurrent({ now: '2026-07-10T00:00:00Z' });
      for (const k of ['activity_id', 'name', 'start_time', 'end_time', 'signup_deadline', 'status', 'terminated', 'rules', 'overview', 'join_status']) {
        expect(out, `缺少字段: ${k}`).toHaveProperty(k);
      }
    });

    it('join_status 可由调用方注入（joined）', async () => {
      const out = await getCurrent({ now: '2026-07-10T00:00:00Z', joinStatus: 'joined' });
      expect(out.join_status).toBe('joined');
    });

    it('未注入 activity 时用 mockCurrentActivity', async () => {
      const mock = mockCurrentActivity();
      const out = await getCurrent({ now: '2026-06-20T00:00:00Z' });
      expect(out.activity_id).toBe(mock.activity_id);
      expect(out.status).toBe(STATUS.PENDING);
    });

    it('用 mock 当前活动三态正确推算', async () => {
      expect((await getCurrent({ now: '2026-06-20T00:00:00Z' })).status).toBe(STATUS.PENDING);
      expect((await getCurrent({ now: '2026-07-10T00:00:00Z' })).status).toBe(STATUS.ACTIVE);
      expect((await getCurrent({ now: '2026-08-10T00:00:00Z' })).status).toBe(STATUS.ENDED);
    });

    it('不抛 SYS_DB_ERROR / AUTH_NO_OPENID（不强制 db / openid）', async () => {
      // 不传 db、不传 openid，应正常返回而非抛错
      const out = await getCurrent({ now: '2026-07-10T00:00:00Z' });
      expect(out).toHaveProperty('status');
      expect(CODE.AUTH_NO_OPENID).toBeDefined();
    });
  });

  describe('pickCurrentActivity（选当前活动：非终止优先 active→pending→ended，全终止回退最近终止）', () => {
    // 时间窗：active 在期中 / pending 未开始 / ended 已结束；now 锚 07-10（active 期中）
    const active = { activity_id: 'a_active', name: '进行中', start_time: '2026-07-01T00:00:00Z', end_time: '2026-07-21T23:59:59Z' };
    const pending = { activity_id: 'a_pending', name: '未开始', start_time: '2026-08-01T00:00:00Z', end_time: '2026-08-21T23:59:59Z' };
    const ended = { activity_id: 'a_ended', name: '已结束', start_time: '2026-05-01T00:00:00Z', end_time: '2026-05-21T23:59:59Z' };
    const now = '2026-07-10T00:00:00Z';

    it('非数组 / 库空 → null（宽容，不抛错）', () => {
      expect(pickCurrentActivity(undefined, now)).toBeNull();
      expect(pickCurrentActivity(null, now)).toBeNull();
      expect(pickCurrentActivity([], now)).toBeNull();
      expect(pickCurrentActivity('x', now)).toBeNull();
    });

    it('单个 active 活动 → 返回该原始文档', () => {
      expect(pickCurrentActivity([active], now)).toBe(active);
    });

    it('active 优先于 pending / ended（输入顺序打乱也选 active）', () => {
      expect(pickCurrentActivity([ended, pending, active], now)).toBe(active);
      expect(pickCurrentActivity([pending, ended, active], now)).toBe(active);
    });

    it('terminated 不挡非终止活动：与 active 并存 → 跳过 terminated 选 active', () => {
      const termActive = { activity_id: 'a_term', name: '已终止', start_time: '2026-07-01T00:00:00Z', end_time: '2026-07-21T23:59:59Z', terminated: true };
      expect(pickCurrentActivity([termActive, active], now)).toBe(active);
    });

    it('唯一活动 terminated → 回退该终止活动（员工端展示「已终止」tag，非空态）', () => {
      const termActive = { activity_id: 'a_term', name: '已终止', start_time: '2026-07-01T00:00:00Z', end_time: '2026-07-21T23:59:59Z', terminated: true };
      expect(pickCurrentActivity([termActive], now)).toBe(termActive);
    });

    it('全部 terminated → 回退最近终止活动（按 terminated_at 降序）', () => {
      const t1 = { activity_id: 't1', start_time: '2026-07-01T00:00:00Z', end_time: '2026-07-21T23:59:59Z', terminated: true, terminated_at: '2026-07-10T00:00:00Z' };
      const t2 = { activity_id: 't2', start_time: '2026-05-01T00:00:00Z', end_time: '2026-05-21T23:59:59Z', terminated: true, terminated_at: '2026-07-15T00:00:00Z' };
      // t2 的 terminated_at 更晚 → 回退 t2；顺序打乱仍选 t2
      expect(pickCurrentActivity([t1, t2], now)).toBe(t2);
      expect(pickCurrentActivity([t2, t1], now)).toBe(t2);
    });

    it('全部 terminated 且无 terminated_at → 回退按 updated_at 降序', () => {
      const t1 = { activity_id: 't1', start_time: '2026-07-01T00:00:00Z', end_time: '2026-07-21T23:59:59Z', terminated: true, updated_at: '2026-07-10T00:00:00Z' };
      const t2 = { activity_id: 't2', start_time: '2026-05-01T00:00:00Z', end_time: '2026-05-21T23:59:59Z', terminated: true, updated_at: '2026-07-15T00:00:00Z' };
      expect(pickCurrentActivity([t1, t2], now)).toBe(t2);
    });

    it('无 active 时选 pending（未开始）优先于 ended', () => {
      expect(pickCurrentActivity([ended, pending], now)).toBe(pending);
    });

    it('无 active/pending 时选 ended（自然结束仍可作当前/归档）', () => {
      expect(pickCurrentActivity([ended], now)).toBe(ended);
    });

    it('同档按 start_time 降序（更晚开始的靠前，新增活动优先于同档旧活动）', () => {
      const early = { activity_id: 'a_early', start_time: '2026-07-01T00:00:00Z', end_time: '2026-07-21T23:59:59Z' };
      const late = { activity_id: 'a_late', start_time: '2026-07-05T00:00:00Z', end_time: '2026-07-25T23:59:59Z' };
      // 两者在 07-10 均 active → start 晚的(late 07-05) 靠前
      expect(pickCurrentActivity([early, late], now)).toBe(late);
    });

    it('过滤非对象脏数据（null / 基本类型不入选）', () => {
      expect(pickCurrentActivity([null, 'junk', undefined, active], now)).toBe(active);
    });

    it('档位权重：active < pending < ended（与 listActivities 同口径）', () => {
      expect(RANK_WEIGHT[STATUS.ACTIVE]).toBeLessThan(RANK_WEIGHT[STATUS.PENDING]);
      expect(RANK_WEIGHT[STATUS.PENDING]).toBeLessThan(RANK_WEIGHT[STATUS.ENDED]);
    });

    it('纯函数：不修改入参', () => {
      const arr = [ended, active, pending];
      const snapshot = JSON.stringify(arr);
      pickCurrentActivity(arr, now);
      expect(JSON.stringify(arr)).toBe(snapshot);
    });
  });
});
