const {
  STATUS,
  deriveStatus,
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
  });

  describe('projectActivity（脱敏下发）', () => {
    it('摘出活动信息 + 状态 + 概览，字段齐全', () => {
      const out = projectActivity(
        { _id: 'a_001', activity_id: 'a_001', name: '走起', cover_url: 'c.jpg',
          start_time: START, end_time: END, rules: '规则' },
        STATUS.ACTIVE,
        { total_steps: 12345, participant_count: 30 }
      );
      expect(out.activity_id).toBe('a_001');
      expect(out.name).toBe('走起');
      expect(out.cover_url).toBe('c.jpg');
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
      for (const k of ['activity_id', 'name', 'cover_url', 'start_time', 'end_time', 'status', 'rules', 'overview', 'join_status']) {
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
});
