/**
 * admin.applyVerdict 单测（H1 R8.4）：
 *   - ignore：清 abnormal 保留 steps；
 *   - zero：steps 置 0 + abnormal=false；
 *   - 幂等：重复 zero / 重复 ignore 不报错；
 *   - 非法 action / record 不存在抛错。
 */
const { applyVerdict } = require('../../cloudfunctions/admin/verdict');
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
  it('ignore：清 abnormal=false，保留 steps', () => {
    const store = makeStore();
    const r = applyVerdict(store, { recordId: 'r1', action: 'ignore', now: 'NEW' });
    expect(r).toEqual({ recordId: 'r1', action: 'ignore', steps: 60000, abnormal: false });
    expect(store.StepRecord[0].abnormal).toBe(false);
    expect(store.StepRecord[0].steps).toBe(60000); // 保留
  });

  it('zero：steps 置 0 + abnormal=false', () => {
    const store = makeStore();
    const r = applyVerdict(store, { recordId: 'r1', action: 'zero', now: 'NEW' });
    expect(r).toEqual({ recordId: 'r1', action: 'zero', steps: 0, abnormal: false });
    expect(store.StepRecord[0].steps).toBe(0);
    expect(store.StepRecord[0].abnormal).toBe(false);
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

  it('裁定后写 synced_at（追溯裁定时间）', () => {
    const store = makeStore();
    applyVerdict(store, { recordId: 'r1', action: 'ignore', now: 'JUDGE_TIME' });
    expect(store.StepRecord[0].synced_at).toBe('JUDGE_TIME');
  });
});
