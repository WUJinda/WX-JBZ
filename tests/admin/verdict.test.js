/**
 * admin.applyVerdict 单测（H1 R8.4）：
 *   - ignore：清 abnormal 保留 steps；
 *   - zero：steps 置 0 + abnormal=false；
 *   - 幂等：重复 zero / 重复 ignore 不报错；
 *   - 非法 action / record 不存在抛错。
 */
const { applyVerdict, VALID_ACTIONS } = require('../../cloudfunctions/admin/verdict');
const { CODE } = require('../../cloudfunctions/common/errors');

function makeStore() {
  return {
    StepRecord: [
      { _id: 'r1', user_id: 'u1', activity_id: 'a1', date: '2026-06-01', steps: 60000, abnormal: true, locked: false, synced_at: 'old' },
      { _id: 'r2', user_id: 'u2', activity_id: 'a1', date: '2026-06-01', steps: 70000, abnormal: true, locked: false, synced_at: 'old' }
    ]
  };
}

describe('applyVerdict（异常裁定）', () => {
  it('ignore：清 abnormal=false，保留 steps，写 verdict 留痕', () => {
    const store = makeStore();
    const r = applyVerdict(store, { recordId: 'r1', action: 'ignore', now: 'NEW' });
    expect(r).toEqual({
      recordId: 'r1',
      action: 'ignore',
      steps: 60000,
      abnormal: false,
      verdict_action: 'ignore',
      verdict_at: 'NEW'
    });
    expect(store.StepRecord[0].abnormal).toBe(false);
    expect(store.StepRecord[0].steps).toBe(60000); // 保留
    // 裁定留痕：区分同步为0 vs 裁定置0
    expect(store.StepRecord[0].verdict_action).toBe('ignore');
    expect(store.StepRecord[0].verdict_at).toBe('NEW');
  });

  it('zero：steps 置 0 + abnormal=false，写 verdict 留痕', () => {
    const store = makeStore();
    const r = applyVerdict(store, { recordId: 'r1', action: 'zero', now: 'NEW' });
    expect(r).toEqual({
      recordId: 'r1',
      action: 'zero',
      steps: 0,
      abnormal: false,
      verdict_action: 'zero',
      verdict_at: 'NEW'
    });
    expect(store.StepRecord[0].steps).toBe(0);
    expect(store.StepRecord[0].abnormal).toBe(false);
    // 裁定留痕
    expect(store.StepRecord[0].verdict_action).toBe('zero');
    expect(store.StepRecord[0].verdict_at).toBe('NEW');
  });

  it('幂等：重复 zero 不报错（值仍 0）', () => {
    const store = makeStore();
    applyVerdict(store, { recordId: 'r1', action: 'zero', now: 'NEW1' });
    const r2 = applyVerdict(store, { recordId: 'r1', action: 'zero', now: 'NEW2' });
    expect(r2.steps).toBe(0);
    expect(r2.abnormal).toBe(false);
  });

  it('幂等：重复 ignore 不报错', () => {
    const store = makeStore();
    applyVerdict(store, { recordId: 'r1', action: 'ignore', now: 'NEW1' });
    const r2 = applyVerdict(store, { recordId: 'r1', action: 'ignore', now: 'NEW2' });
    expect(r2.abnormal).toBe(false);
    expect(r2.steps).toBe(60000);
  });

  it('非法 action 抛 SYS_DB_ERROR', () => {
    const store = makeStore();
    let err;
    try {
      applyVerdict(store, { recordId: 'r1', action: 'delete', now: 'NEW' });
    } catch (e) {
      err = e;
    }
    expect(err.code).toBe(CODE.SYS_DB_ERROR);
  });

  it('record 不存在抛 SYS_DB_ERROR', () => {
    const store = makeStore();
    let err;
    try {
      applyVerdict(store, { recordId: 'nope', action: 'ignore', now: 'NEW' });
    } catch (e) {
      err = e;
    }
    expect(err.code).toBe(CODE.SYS_DB_ERROR);
  });

  it('recordId 缺失抛 SYS_DB_ERROR', () => {
    const store = makeStore();
    let err;
    try {
      applyVerdict(store, { recordId: '', action: 'ignore', now: 'NEW' });
    } catch (e) {
      err = e;
    }
    expect(err.code).toBe(CODE.SYS_DB_ERROR);
  });

  it('裁定不改 synced_at（保护 first_reach_at 排序），裁定时间写 verdict_at（P1-5）', () => {
    const store = makeStore();
    applyVerdict(store, { recordId: 'r1', action: 'ignore', now: 'JUDGE_TIME' });
    // synced_at 保持原值 'old'——它是同步时间，被 rankAggregate 的 first_reach_at 排序依赖，裁定不污染。
    expect(store.StepRecord[0].synced_at).toBe('old');
    // 裁定时间走独立 verdict_at 字段。
    expect(store.StepRecord[0].verdict_at).toBe('JUDGE_TIME');
  });
});

describe('VALID_ACTIONS 契约（合法裁定 action 集合锁定）', () => {
  // 语义说明：锁定 verdict 合法 action 集合 = {ignore, zero}，
  // 防止误改（如新增 delete / warn 等）导致 applyVerdict 守卫失效或前端契约漂移。
  it('VALID_ACTIONS 是 Set，且仅含 ignore / zero 两个值', () => {
    expect(VALID_ACTIONS).toBeInstanceOf(Set);
    expect(Array.from(VALID_ACTIONS).sort()).toEqual(['ignore', 'zero']);
    expect(VALID_ACTIONS.size).toBe(2);
  });

  it('ignore / zero 均为合法（VALID_ACTIONS.has 返回 true）', () => {
    expect(VALID_ACTIONS.has('ignore')).toBe(true);
    expect(VALID_ACTIONS.has('zero')).toBe(true);
  });

  it('非法 action 不在集合中（delete/warn/publish/空串/undefined）', () => {
    expect(VALID_ACTIONS.has('delete')).toBe(false);
    expect(VALID_ACTIONS.has('warn')).toBe(false);
    expect(VALID_ACTIONS.has('publish')).toBe(false);
    expect(VALID_ACTIONS.has('')).toBe(false);
    expect(VALID_ACTIONS.has(undefined)).toBe(false);
    expect(VALID_ACTIONS.has(null)).toBe(false);
  });

  it('VALID_ACTIONS 与 applyVerdict 守卫一致：集合外的 action 均被拒', () => {
    const store = makeStore();
    const invalidActions = ['delete', 'warn', 'publish', '', 'IGNORE', 'Zero'];
    for (const act of invalidActions) {
      let err;
      try {
        applyVerdict(store, { recordId: 'r1', action: act, now: 'NEW' });
      } catch (e) {
        err = e;
      }
      // 非法 action（含大小写敏感）均应被守卫拒绝
      expect(err, `action "${act}" 应被拒绝`).toBeTruthy();
      expect(err.code).toBe(CODE.SYS_DB_ERROR);
    }
  });
});
