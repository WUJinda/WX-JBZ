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

const { saveActivity } = require('../../cloudfunctions/activity/activitySave');
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
        cover_url: 'https://x/cover.png',
        start_time: START,
        end_time: END,
        rules: '规则'
      },
      now: new Date('2026-06-20T00:00:00Z')
    });
    expect(out.activity_id).toMatch(/^a_/);
    expect(out.name).toBe('2026 健步走');
    expect(out.cover_url).toBe('https://x/cover.png');
    expect(out.start_time).toBe(START);
    expect(out.end_time).toBe(END);
    expect(out.rules).toBe('规则');
    // 新建落库一条
    expect(store.Activity.length).toBe(1);
    const doc = store.Activity[0];
    expect(doc.activity_id).toBe(out.activity_id);
    expect(doc.created_at).toBeTruthy();
    expect(doc.updated_at).toBeTruthy();
  });

  it('更新：指定 activity_id 命中已有文档 → 原地更新（不新增），返回投影', () => {
    const existing = {
      activity_id: 'a_demo_001',
      name: '旧名',
      cover_url: '',
      start_time: '2026-07-05T00:00:00+08:00',
      end_time: '2026-07-15T00:00:00+08:00',
      status: STATUS.PENDING,
      rules: '旧规则',
      created_at: '2026-06-01T00:00:00Z',
      updated_at: '2026-06-01T00:00:00Z'
    };
    const store = makeStore([existing]);
    const out = saveActivity(store, {
      activity: {
        activity_id: 'a_demo_001',
        name: '新名',
        cover_url: 'https://x/2.png',
        start_time: START,
        end_time: END,
        rules: '新规则'
      },
      now: '2026-06-20T00:00:00Z'
    });
    // 不新增文档
    expect(store.Activity.length).toBe(1);
    expect(out.activity_id).toBe('a_demo_001');
    expect(out.name).toBe('新名');
    expect(out.cover_url).toBe('https://x/2.png');
    expect(out.rules).toBe('新规则');
    // 原文档被更新
    expect(existing.name).toBe('新名');
    expect(existing.start_time).toBe(START);
    expect(existing.updated_at).toBe('2026-06-20T00:00:00.000Z');
    // created_at 保留
    expect(existing.created_at).toBe('2026-06-01T00:00:00Z');
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
  });
});

describe('saveActivity（校验）', () => {
  it('name 空 → SYS_DB_ERROR', () => {
    const store = makeStore([]);
    let err;
    try {
      saveActivity(store, { activity: { name: '  ', start_time: START, end_time: END } });
    } catch (e) {
      err = e;
    }
    expect(err).toBeTruthy();
    expect(err.code).toBe(CODE.SYS_DB_ERROR);
    // 不应落库
    expect(store.Activity.length).toBe(0);
  });

  it('name 缺失 → SYS_DB_ERROR', () => {
    let err;
    try {
      saveActivity(makeStore([]), { activity: { start_time: START, end_time: END } });
    } catch (e) {
      err = e;
    }
    expect(err.code).toBe(CODE.SYS_DB_ERROR);
  });

  it('start_time/end_time 倒序（start>=end）→ SYS_DB_ERROR', () => {
    let err;
    try {
      saveActivity(makeStore([]), {
        activity: { name: 'x', start_time: END, end_time: START }
      });
    } catch (e) {
      err = e;
    }
    expect(err.code).toBe(CODE.SYS_DB_ERROR);
  });

  it('start_time 缺失 → SYS_DB_ERROR', () => {
    let err;
    try {
      saveActivity(makeStore([]), { activity: { name: 'x', end_time: END } });
    } catch (e) {
      err = e;
    }
    expect(err.code).toBe(CODE.SYS_DB_ERROR);
  });

  it('start_time 非法（无法解析）→ SYS_DB_ERROR', () => {
    let err;
    try {
      saveActivity(makeStore([]), {
        activity: { name: 'x', start_time: 'not-a-date', end_time: END }
      });
    } catch (e) {
      err = e;
    }
    expect(err.code).toBe(CODE.SYS_DB_ERROR);
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
