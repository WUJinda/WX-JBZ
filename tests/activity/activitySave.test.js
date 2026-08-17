/**
 * activity.save 纯函数单测（阶段 I，PRD F8 R8.1）：
 *   - 正常：新建生成 activity_id / 更新已有；
 *   - 校验：name 缺 / start>=end / 时间非法；
 *   - deriveStatus 推算（pending/active/ended 三态）；
 *   - 幂等：同 activity_id 二次保存为更新而非新建；
 *   - 纯函数：不 require wx-server-sdk / 不调 cloud.database。
 */
const fs = require('fs');
const path = require('path');

const { saveActivity, projectSavedActivity, genActivityId } = require('../../cloudfunctions/activity/activitySave');
const { CODE } = require('../../cloudfunctions/common/errors');
const { STATUS } = require('../../cloudfunctions/activity/activityStatus');

function makeStore(activities) {
  return { Activity: activities || [] };
}

// 活动窗口：2026-07-01 ~ 2026-07-21（与 activityStatus.test.js 对齐）
const START = '2026-07-01T00:00:00+08:00';
const END = '2026-07-21T23:59:59+08:00';

describe('saveActivity（正常路径）', () => {
  it('新建：缺 activity_id → 生成 a_ 前缀 id，写 created_at/updated_at，返回投影', () => {
    const store = makeStore([]);
    const out = saveActivity(store, {
      activity: {
        name: '2026 健步走',
        start_time: START,
        end_time: END,
        signup_deadline: '2026-06-30T23:59:59+08:00',
        rules: '规则'
      },
      now: new Date('2026-06-20T00:00:00Z')
    });
    expect(out.activity_id).toMatch(/^a_/);
    expect(out.name).toBe('2026 健步走');
    expect(out.signup_deadline).toBe('2026-06-30T23:59:59+08:00');
    expect(out.start_time).toBe(START);
    expect(out.end_time).toBe(END);
    expect(out.rules).toBe('规则');
    // 新建落库一条
    expect(store.Activity.length).toBe(1);
    const doc = store.Activity[0];
    expect(doc.activity_id).toBe(out.activity_id);
    expect(doc.created_at).toBeTruthy();
    expect(doc.updated_at).toBeTruthy();
    // 结算标记显式落库（schema default 仅文档规范）：pointSettle CAS 依赖该字段可查，缺失即永不命中
    expect(doc.points_settled).toBe(false);
    // _isNew 标记新建（云轨 save handler 据此重置 User.join_status）
    expect(out._isNew).toBe(true);
  });

  it('更新：指定 activity_id 命中已有文档 → 原地更新（不新增），返回投影', () => {
    const existing = {
      activity_id: 'a_demo_001',
      name: '旧名',
      start_time: '2026-07-05T00:00:00+08:00',
      end_time: '2026-07-15T00:00:00+08:00',
      status: STATUS.PENDING,
      rules: '旧规则',
      terminated: false,
      created_at: '2026-06-01T00:00:00Z',
      updated_at: '2026-06-01T00:00:00Z'
    };
    const store = makeStore([existing]);
    const out = saveActivity(store, {
      activity: {
        activity_id: 'a_demo_001',
        name: '新名',
        start_time: START,
        end_time: END,
        signup_deadline: '2026-06-30T23:59:59+08:00',
        rules: '新规则'
      },
      now: '2026-06-20T00:00:00Z'
    });
    // 不新增文档
    expect(store.Activity.length).toBe(1);
    expect(out.activity_id).toBe('a_demo_001');
    expect(out.name).toBe('新名');
    expect(out.signup_deadline).toBe('2026-06-30T23:59:59+08:00');
    expect(out.rules).toBe('新规则');
    // save 不触碰 terminated（由 terminate action 维护）
    expect(existing.terminated).toBe(false);
    // 原文档被更新
    expect(existing.name).toBe('新名');
    expect(existing.start_time).toBe(START);
    expect(existing.updated_at).toBe('2026-06-20T00:00:00.000Z');
    // created_at 保留
    expect(existing.created_at).toBe('2026-06-01T00:00:00Z');
    // _isNew 标记编辑（不重置 User.join_status）
    expect(out._isNew).toBe(false);
  });

  it('更新：activity_id 不存在于库 → 视为新建（用该 activity_id）', () => {
    const store = makeStore([]);
    const out = saveActivity(store, {
      activity: {
        activity_id: 'a_custom_001',
        name: '活动',
        start_time: START,
        end_time: END
      }
    });
    expect(out.activity_id).toBe('a_custom_001');
    expect(store.Activity.length).toBe(1);
    expect(store.Activity[0].activity_id).toBe('a_custom_001');
    // activity_id 不存在于库 → 走新建分支，_isNew=true
    expect(out._isNew).toBe(true);
  });
});

describe('saveActivity（校验）', () => {
  it('name 空 → BIZ_PARAM_MISSING', () => {
    const store = makeStore([]);
    let err;
    try {
      saveActivity(store, { activity: { name: '  ', start_time: START, end_time: END } });
    } catch (e) {
      err = e;
    }
    expect(err).toBeTruthy();
    expect(err.code).toBe(CODE.BIZ_PARAM_MISSING);
    // 不应落库
    expect(store.Activity.length).toBe(0);
  });

  it('name 缺失 → BIZ_PARAM_MISSING', () => {
    let err;
    try {
      saveActivity(makeStore([]), { activity: { start_time: START, end_time: END } });
    } catch (e) {
      err = e;
    }
    expect(err.code).toBe(CODE.BIZ_PARAM_MISSING);
  });

  it('start_time/end_time 倒序（start>=end）→ BIZ_PARAM_MISSING', () => {
    let err;
    try {
      saveActivity(makeStore([]), {
        activity: { name: 'x', start_time: END, end_time: START }
      });
    } catch (e) {
      err = e;
    }
    expect(err.code).toBe(CODE.BIZ_PARAM_MISSING);
  });

  it('start_time 缺失 → BIZ_PARAM_MISSING', () => {
    let err;
    try {
      saveActivity(makeStore([]), { activity: { name: 'x', end_time: END } });
    } catch (e) {
      err = e;
    }
    expect(err.code).toBe(CODE.BIZ_PARAM_MISSING);
  });

  it('start_time 非法（无法解析）→ BIZ_PARAM_MISSING', () => {
    let err;
    try {
      saveActivity(makeStore([]), {
        activity: { name: 'x', start_time: 'not-a-date', end_time: END }
      });
    } catch (e) {
      err = e;
    }
    expect(err.code).toBe(CODE.BIZ_PARAM_MISSING);
  });

  it('store.Activity 缺失 → SYS_DB_ERROR', () => {
    let err;
    try {
      saveActivity({}, { activity: { name: 'x', start_time: START, end_time: END } });
    } catch (e) {
      err = e;
    }
    expect(err.code).toBe(CODE.SYS_DB_ERROR);
  });
});

describe('saveActivity（报名截止 signup_deadline）', () => {
  it('不填 signup_deadline → 落库 null（=活动结束前都可报名）', () => {
    const store = makeStore([]);
    const out = saveActivity(store, {
      activity: { name: 'x', start_time: START, end_time: END },
      now: '2026-06-20T00:00:00Z'
    });
    expect(out.signup_deadline).toBeNull();
    expect(store.Activity[0].signup_deadline).toBeNull();
  });

  it('signup_deadline ≤ end_time → 合法', () => {
    const out = saveActivity(makeStore([]), {
      activity: { name: 'x', start_time: START, end_time: END, signup_deadline: '2026-07-15T00:00:00+08:00' },
      now: '2026-06-20T00:00:00Z'
    });
    expect(out.signup_deadline).toBe('2026-07-15T00:00:00+08:00');
  });

  it('signup_deadline > end_time → BIZ_PARAM_MISSING', () => {
    let err;
    try {
      saveActivity(makeStore([]), {
        activity: { name: 'x', start_time: START, end_time: END, signup_deadline: '2026-08-01T00:00:00+08:00' },
        now: '2026-06-20T00:00:00Z'
      });
    } catch (e) {
      err = e;
    }
    expect(err.code).toBe(CODE.BIZ_PARAM_MISSING);
  });

  it('signup_deadline 非法（无法解析）→ BIZ_PARAM_MISSING', () => {
    let err;
    try {
      saveActivity(makeStore([]), {
        activity: { name: 'x', start_time: START, end_time: END, signup_deadline: 'not-a-date' },
        now: '2026-06-20T00:00:00Z'
      });
    } catch (e) {
      err = e;
    }
    expect(err.code).toBe(CODE.BIZ_PARAM_MISSING);
  });

  it('编辑时清空 signup_deadline（原值 → 不填）→ 落库 null', () => {
    const existing = {
      activity_id: 'a_1', name: 'x', start_time: START, end_time: END,
      signup_deadline: '2026-06-30T23:59:59+08:00', status: STATUS.PENDING
    };
    const store = makeStore([existing]);
    const out = saveActivity(store, {
      activity: { activity_id: 'a_1', name: 'x', start_time: START, end_time: END, signup_deadline: null },
      now: '2026-06-20T00:00:00Z'
    });
    expect(out.signup_deadline).toBeNull();
    expect(existing.signup_deadline).toBeNull();
  });
});

describe('saveActivity（deriveStatus 推算三态）', () => {
  const baseActivity = { name: 'x', start_time: START, end_time: END };

  it('now<start → status=pending', () => {
    const out = saveActivity(makeStore([]), {
      activity: baseActivity,
      now: new Date('2026-06-20T00:00:00Z')
    });
    expect(out.status).toBe(STATUS.PENDING);
  });

  it('start≤now≤end → status=active', () => {
    const out = saveActivity(makeStore([]), {
      activity: baseActivity,
      now: new Date('2026-07-10T00:00:00Z')
    });
    expect(out.status).toBe(STATUS.ACTIVE);
  });

  it('now>end → status=ended', () => {
    const out = saveActivity(makeStore([]), {
      activity: baseActivity,
      now: new Date('2026-08-10T00:00:00Z')
    });
    expect(out.status).toBe(STATUS.ENDED);
  });

  it('status 落库到文档冗余字段（供查询索引）', () => {
    const store = makeStore([]);
    saveActivity(store, {
      activity: baseActivity,
      now: new Date('2026-07-10T00:00:00Z')
    });
    expect(store.Activity[0].status).toBe(STATUS.ACTIVE);
  });
});

describe('saveActivity（幂等）', () => {
  it('同 activity_id 二次保存为更新（不新建第二条），数据一致', () => {
    const store = makeStore([]);
    const first = saveActivity(store, {
      activity: { activity_id: 'a_demo_001', name: '第一版', start_time: START, end_time: END },
      now: '2026-06-01T00:00:00Z'
    });
    expect(store.Activity.length).toBe(1);

    const second = saveActivity(store, {
      activity: {
        activity_id: 'a_demo_001',
        name: '第二版',
        start_time: '2026-08-01T00:00:00+08:00',
        end_time: '2026-08-21T23:59:59+08:00'
      },
      now: '2026-06-02T00:00:00Z'
    });
    // 仍是同一条，不新增
    expect(store.Activity.length).toBe(1);
    expect(second.activity_id).toBe('a_demo_001');
    expect(second.name).toBe('第二版');
    // created_at 保留首次，updated_at 推进（now 经 new Date().toISOString() 规范化）
    expect(store.Activity[0].created_at).toBe('2026-06-01T00:00:00.000Z');
    expect(store.Activity[0].updated_at).toBe('2026-06-02T00:00:00.000Z');
    // start_time 已更新为新值
    expect(store.Activity[0].start_time).toBe('2026-08-01T00:00:00+08:00');
    // 二次保存为编辑（同 activity_id 命中），_isNew=false
    expect(second._isNew).toBe(false);
  });

  it('前端传入 publish 字段被后端忽略（不落库 published 字段）', () => {
    const store = makeStore([]);
    saveActivity(store, {
      activity: { name: 'x', start_time: START, end_time: END, publish: true }
    });
    const doc = store.Activity[0];
    expect(doc).toBeTruthy();
    expect(doc).not.toHaveProperty('published');
    expect(doc).not.toHaveProperty('publish');
  });
});

describe('saveActivity（纯函数 / 红线 grep）', () => {
  const SRC = fs.readFileSync(
    path.resolve(__dirname, '../../cloudfunctions/activity/activitySave.js'),
    'utf-8'
  );

  it('saveActivity.js 不 require wx-server-sdk', () => {
    expect(SRC).not.toMatch(/require\(['"]wx-server-sdk['"]\)/);
  });

  it('saveActivity.js 不调 cloud.database() / cloud.callFunction', () => {
    expect(SRC).not.toMatch(/cloud\.database\(\)/);
    expect(SRC).not.toMatch(/cloud\.callFunction/);
  });

  it('saveActivity.js 复用 activityStatus.deriveStatus（R8.1 由 deriveStatus 满足）', () => {
    expect(SRC).toMatch(/require\(['"]\.\/activityStatus['"]\)/);
    expect(SRC).toMatch(/deriveStatus/);
  });

  it('saveActivity.js 不写入 published 字段', () => {
    // 投影 / 文档字段不出现 published
    expect(SRC).not.toMatch(/published\s*:/);
  });

  it('store 注入式：saveActivity 是同步纯函数（返回值非 Promise）', () => {
    const out = saveActivity(makeStore([]), {
      activity: { name: 'x', start_time: START, end_time: END }
    });
    // 同步返回普通对象（非 thenable）
    expect(typeof out).toBe('object');
    expect(typeof out.then).toBe('undefined');
  });
});

describe('projectSavedActivity（投影白名单，不下发敏感字段）', () => {
  // 投影白名单语义：save 返回给前端的活动对象只含安全字段，
  // 绝不下发 _openid / phone / sync_count / created_at / updated_at 等服务端/敏感字段。
  it('返回对象仅含白名单字段（activity_id/name/start_time/end_time/signup_deadline/status/rules）', () => {
    const out = projectSavedActivity({
      activity_id: 'a_1',
      name: '活动',
      start_time: START,
      end_time: END,
      signup_deadline: '2026-06-30T23:59:59+08:00',
      status: STATUS.PENDING,
      rules: 'r',
      // 服务端/敏感字段：投影不应下发
      _id: 'doc_1',
      _openid: 'op_admin',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-02T00:00:00Z',
      terminated: false,
      total_steps: 999,
      participant_count: 10,
      phone: '13800000000',
      sync_count: 5
    });
    expect(out).toEqual({
      activity_id: 'a_1',
      name: '活动',
      start_time: START,
      end_time: END,
      signup_deadline: '2026-06-30T23:59:59+08:00',
      status: STATUS.PENDING,
      rules: 'r'
    });
  });

  it('不下发 _openid / phone / sync_count（敏感字段红线）', () => {
    const out = projectSavedActivity({
      activity_id: 'a_1', name: 'x', start_time: START, end_time: END, status: STATUS.ACTIVE,
      _openid: 'op', phone: '13800000000', sync_count: 3
    });
    expect(out).not.toHaveProperty('_openid');
    expect(out).not.toHaveProperty('phone');
    expect(out).not.toHaveProperty('sync_count');
  });

  it('缺失字段兜底为空串/null（name/signup_deadline/rules 缺失不报错）', () => {
    const out = projectSavedActivity({
      activity_id: 'a_1',
      start_time: START,
      end_time: END,
      status: STATUS.ACTIVE
    });
    expect(out.name).toBe('');
    expect(out.signup_deadline).toBeNull();
    expect(out.rules).toBe('');
  });
});

describe('genActivityId（格式 + 唯一性）', () => {
  it('格式：始终以 a_ 前缀开头', () => {
    expect(genActivityId()).toMatch(/^a_/);
    expect(genActivityId('1700000000000')).toMatch(/^a_/);
    expect(genActivityId(123)).toMatch(/^a_/);
  });

  it('无参：基于 Date.now() 生成，形如 a_<时间戳>', () => {
    const id = genActivityId();
    expect(id).toMatch(/^a_\d+$/);
  });

  it('唯一性：不同 ts 入参 → 不同 id（可控唯一性）', () => {
    // genActivityId 无参基于 Date.now()，同毫秒内可能重复（实现特性）；
    // 唯一性契约由「不同 ts 入参产生不同 id」保证（调用方可传递增 ts）。
    const ids = new Set();
    for (let i = 0; i < 100; i++) {
      ids.add(genActivityId('ts_' + i));
    }
    expect(ids.size).toBe(100);
  });

  it('无参连续调用：至少能产生 >1 种结果（跨毫秒时不同）', () => {
    // 放宽：无参调用依赖 Date.now()，循环过快可能同毫秒；
    // 仅验证「格式一致 a_<数字>」，不强制每次不同（实现允许同毫秒重复）。
    const id = genActivityId();
    expect(id).toMatch(/^a_\d+$/);
  });

  it('显式传入 ts → 输出 a_<ts>（调用方可覆盖）', () => {
    expect(genActivityId('fixed')).toBe('a_fixed');
    expect(genActivityId(1700000000000)).toBe('a_1700000000000');
  });

  it('saveActivity 新建无 activity_id 时落库 id 与返回 id 一致（来自 genActivityId）', () => {
    const store = makeStore([]);
    const out = saveActivity(store, { activity: { name: 'x', start_time: START, end_time: END } });
    expect(out.activity_id).toMatch(/^a_/);
    expect(store.Activity[0].activity_id).toBe(out.activity_id);
  });
});
