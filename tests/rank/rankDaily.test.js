/**
 * rank.personalDaily 业务纯函数单测（F5 个人榜「今日榜」按日切换）。
 *
 * readPersonalDaily：按日实时聚合当天步数排名（不经 RankCache）。
 *   - 当日 steps desc 排序赋 rank / 按 user 去重取最大 / 同分 synced_at 升序
 *   - 进榜口径 A：仅当天有记录（已同步）的用户进榜（0 步有记录也进榜，未同步不在榜）
 *   - myRank 定位 / 分页 / updatedAt(当天最新 synced_at) / date 格式校验
 *   - 投影 projectPersonalDaily 不下发 _openid/phone/sync_count
 *
 * 时间口径：北京时间 = UTC + 8h。北京 7.12 12:00 = Date.UTC(2026,6,12,4) → today='2026-07-12'。
 */
const {
  readPersonalDaily,
  projectPersonalDaily,
  DEFAULT_PAGE_SIZE
} = require('../../cloudfunctions/rank/rankDaily');
const { CODE } = require('../../cloudfunctions/common/errors');

const ACTIVITY_ID = 'a_demo_001';
const DATE = '2026-07-12';
const NOW = new Date(Date.UTC(2026, 6, 12, 4)); // 北京 7.12 12:00 → today='2026-07-12'
const ACTIVITY = { start_time: '2026-07-10T00:00:00+08:00' }; // startDate='2026-07-10'

function rec(user_id, steps, opts) {
  const o = opts || {};
  return {
    activity_id: o.activity_id || ACTIVITY_ID,
    user_id,
    date: o.date || DATE,
    steps,
    synced_at: o.synced_at != null ? o.synced_at : '2026-07-12T08:00:00.000Z'
  };
}
function usr(openid, nickname, dept_id) {
  return { _openid: openid, nickname: nickname == null ? '' : nickname, dept_id: dept_id || '', join_status: 'joined' };
}
function dpt(dept_id, name) {
  return { dept_id, name, activity_id: ACTIVITY_ID };
}
function store(stepRecords, users, depts) {
  return { StepRecord: stepRecords || [], User: users || [], Department: depts || [] };
}

describe('projectPersonalDaily 投影脱敏', () => {
  it('不下发 _openid/phone/sync_count，当日步数映射 total_steps', () => {
    const out = projectPersonalDaily({
      rank: 1, user_id: 'u1', steps: 888, synced_at: 't',
      nickname: '张*明', dept_id: 'd1', dept_name: '一组',
      _openid: 'op', phone: '138', sync_count: 3
    });
    expect(out._openid).toBeUndefined();
    expect(out.phone).toBeUndefined();
    expect(out.sync_count).toBeUndefined();
    expect(out.total_steps).toBe(888); // 当日 steps → total_steps（复用前端模板）
    expect(out.ref_id).toBe('u1');
    expect(out.synced_at).toBe('t');
  });
});

describe('readPersonalDaily 当日排名', () => {
  it('默认分页大小 50', () => {
    expect(DEFAULT_PAGE_SIZE).toBe(50);
  });

  it('按当日 steps desc 排序赋 rank + totalCount', async () => {
    const s = store([rec('u1', 300), rec('u2', 500), rec('u3', 100)], [usr('u1', '甲'), usr('u2', '乙'), usr('u3', '丙')]);
    const r = await readPersonalDaily({ store: s, activityId: ACTIVITY_ID, date: DATE, activity: ACTIVITY, now: NOW });
    expect(r.list.map((x) => x.user_id)).toEqual(['u2', 'u1', 'u3']);
    expect(r.list.map((x) => x.rank)).toEqual([1, 2, 3]);
    expect(r.totalCount).toBe(3);
  });

  it('同分 synced_at 升序（先达者列前）', async () => {
    const s = store(
      [
        rec('u1', 500, { synced_at: '2026-07-12T03:00:00.000Z' }), // 晚达
        rec('u2', 500, { synced_at: '2026-07-12T01:00:00.000Z' }) // 先达
      ],
      [usr('u1', '甲'), usr('u2', '乙')]
    );
    const r = await readPersonalDaily({ store: s, activityId: ACTIVITY_ID, date: DATE, activity: ACTIVITY, now: NOW });
    expect(r.list.map((x) => x.user_id)).toEqual(['u2', 'u1']); // u2 先达列前
  });

  it('按 user 去重取最大 steps（防重复记录翻倍）', async () => {
    const s = store(
      [
        rec('u1', 200, { synced_at: '2026-07-12T01:00:00.000Z' }),
        rec('u1', 400, { synced_at: '2026-07-12T02:00:00.000Z' }), // 同 user 更大
        rec('u1', 300, { synced_at: '2026-07-12T03:00:00.000Z' }) // 同 user 更小
      ],
      [usr('u1', '甲')]
    );
    const r = await readPersonalDaily({ store: s, activityId: ACTIVITY_ID, date: DATE, activity: ACTIVITY, now: NOW });
    expect(r.totalCount).toBe(1);
    expect(r.list[0].total_steps).toBe(400); // 取最大，非累加
  });

  it('0 步用户有记录也进榜（排末尾）', async () => {
    const s = store([rec('u1', 0), rec('u2', 500)], [usr('u1', '甲'), usr('u2', '乙')]);
    const r = await readPersonalDaily({ store: s, activityId: ACTIVITY_ID, date: DATE, activity: ACTIVITY, now: NOW });
    expect(r.list.map((x) => x.user_id)).toEqual(['u2', 'u1']);
    expect(r.list[1].total_steps).toBe(0);
  });

  it('未同步用户不在榜（决策A：不遍历 User 表补 0 步/未同步用户）', async () => {
    const s = store([rec('u1', 500)], [usr('u1', '甲'), usr('u2', '乙'), usr('u3', '丙')]); // u2/u3 当天无记录
    const r = await readPersonalDaily({ store: s, activityId: ACTIVITY_ID, date: DATE, activity: ACTIVITY, now: NOW });
    expect(r.list.map((x) => x.user_id)).toEqual(['u1']);
    expect(r.totalCount).toBe(1);
  });

  it('只匹配当天 date（其他日期记录忽略）', async () => {
    const s = store(
      [rec('u1', 500, { date: DATE }), rec('u2', 999, { date: '2026-07-11' })],
      [usr('u1', '甲'), usr('u2', '乙')]
    );
    const r = await readPersonalDaily({ store: s, activityId: ACTIVITY_ID, date: DATE, activity: ACTIVITY, now: NOW });
    expect(r.list.map((x) => x.user_id)).toEqual(['u1']);
  });

  it('只匹配 activity_id（其他活动记录忽略）', async () => {
    const s = store(
      [rec('u1', 500), rec('u2', 999, { activity_id: 'a_other' })],
      [usr('u1', '甲'), usr('u2', '乙')]
    );
    const r = await readPersonalDaily({ store: s, activityId: ACTIVITY_ID, date: DATE, activity: ACTIVITY, now: NOW });
    expect(r.list.map((x) => x.user_id)).toEqual(['u1']);
  });

  it('myRank 在榜返回当日排名；当天未同步 → null', async () => {
    const s = store([rec('u1', 500), rec('u2', 300)], [usr('u1', '甲'), usr('u2', '乙'), usr('u3', '丙')]);
    const r = await readPersonalDaily({ store: s, activityId: ACTIVITY_ID, date: DATE, userId: 'u2', activity: ACTIVITY, now: NOW });
    expect(r.myRank).not.toBeNull();
    expect(r.myRank.rank).toBe(2);
    expect(r.myRank.user_id).toBe('u2');
    const r2 = await readPersonalDaily({ store: s, activityId: ACTIVITY_ID, date: DATE, userId: 'u3', activity: ACTIVITY, now: NOW });
    expect(r2.myRank).toBeNull();
  });

  it('分页 page/pageSize', async () => {
    const recs = [];
    for (let i = 0; i < 5; i++) recs.push(rec('u' + i, 500 - i * 10));
    const s = store(recs, ['u0', 'u1', 'u2', 'u3', 'u4'].map((u) => usr(u, 'n')));
    const r1 = await readPersonalDaily({ store: s, activityId: ACTIVITY_ID, date: DATE, page: 1, pageSize: 2, activity: ACTIVITY, now: NOW });
    expect(r1.list).toHaveLength(2);
    expect(r1.totalCount).toBe(5);
    const r3 = await readPersonalDaily({ store: s, activityId: ACTIVITY_ID, date: DATE, page: 3, pageSize: 2, activity: ACTIVITY, now: NOW });
    expect(r3.list).toHaveLength(1);
    expect(r3.list[0].user_id).toBe('u4');
  });

  it('updatedAt = 当天记录最新 synced_at', async () => {
    const s = store(
      [
        rec('u1', 500, { synced_at: '2026-07-12T02:00:00.000Z' }),
        rec('u2', 300, { synced_at: '2026-07-12T05:00:00.000Z' })
      ],
      [usr('u1', '甲'), usr('u2', '乙')]
    );
    const r = await readPersonalDaily({ store: s, activityId: ACTIVITY_ID, date: DATE, activity: ACTIVITY, now: NOW });
    expect(r.updatedAt).toBe('2026-07-12T05:00:00.000Z');
  });

  it('关联 User._openid 拿脱敏 nickname + dept_name', async () => {
    const s = store([rec('u1', 500)], [usr('u1', '张小明', 'd1')], [dpt('d1', '一组')]);
    const r = await readPersonalDaily({ store: s, activityId: ACTIVITY_ID, date: DATE, activity: ACTIVITY, now: NOW });
    expect(r.list[0].nickname).toBe('张*明'); // maskNickname 脱敏（三字保留首尾）
    expect(r.list[0].dept_name).toBe('一组');
    expect(r.list[0].dept_id).toBe('d1');
  });

  it('无数据 → 空列表 + totalCount=0 + myRank=null + updatedAt=null', async () => {
    const s = store([], [usr('u1', '甲')]);
    const r = await readPersonalDaily({ store: s, activityId: ACTIVITY_ID, date: DATE, activity: ACTIVITY, now: NOW });
    expect(r.list).toEqual([]);
    expect(r.totalCount).toBe(0);
    expect(r.myRank).toBeNull();
    expect(r.updatedAt).toBeNull();
  });

  it('date 格式非法抛 BIZ_PARAM_MISSING(2005)', async () => {
    const s = store([], []);
    await expect(
      readPersonalDaily({ store: s, activityId: ACTIVITY_ID, date: '2026-7-12', activity: ACTIVITY, now: NOW })
    ).rejects.toMatchObject({ code: CODE.BIZ_PARAM_MISSING });
    await expect(
      readPersonalDaily({ store: s, activityId: ACTIVITY_ID, date: '', activity: ACTIVITY, now: NOW })
    ).rejects.toMatchObject({ code: CODE.BIZ_PARAM_MISSING });
  });

  it('不下发 _openid/phone/sync_count', async () => {
    const s = store([rec('u1', 500)], [usr('u1', '甲')]);
    const r = await readPersonalDaily({ store: s, activityId: ACTIVITY_ID, date: DATE, activity: ACTIVITY, now: NOW });
    r.list.forEach((x) => {
      expect(x._openid).toBeUndefined();
      expect(x.phone).toBeUndefined();
      expect(x.sync_count).toBeUndefined();
    });
  });
});
