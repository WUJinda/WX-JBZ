const fs = require('fs');
const path = require('path');
const { COLLECTIONS, ensureIndexes, ensureCollectionIndexes, ensureCollections, ensureCollection, ensureSchema } = require('../../cloudfunctions/schema/initIndexes');

describe('集合 schema 定义（B1）', () => {
  it('COLLECTIONS 可被 require 且为对象', () => {
    expect(COLLECTIONS).toEqual(expect.any(Object));
  });

  it('User 集合结构合法（字段 + 索引）', () => {
    const u = COLLECTIONS.User;
    expect(u).toBeDefined();
    expect(Array.isArray(u.indexes)).toBe(true);
    // 字段齐全
    for (const f of ['_id', '_openid', 'nickname', 'avatar', 'invite_code', 'dept_id', 'join_status', 'is_admin', 'created_at', 'updated_at']) {
      expect(u.fields[f], `User 缺少字段: ${f}`).toBeDefined();
    }
  });

  it('User 含 _openid 唯一索引（手机号机制已移除，idx_user_phone 删除）', () => {
    const u = COLLECTIONS.User;
    const uniqueIdx = u.indexes.filter((i) => i.unique);
    const fields = uniqueIdx.map((i) => Object.keys(i.fields)[0]);
    expect(fields).toContain('_openid');
    // 手机号唯一索引已随手机号机制移除
    expect(fields).not.toContain('phone');
  });

  it('InviteCode 集合结构合法（code 唯一索引 + status 枚举 + used_by onlyServer）', () => {
    const ic = COLLECTIONS.InviteCode;
    expect(ic).toBeDefined();
    expect(Array.isArray(ic.indexes)).toBe(true);
    expect(ic.fields.code).toBeDefined();
    expect(ic.fields.status).toBeDefined();
    const codeIdx = ic.indexes.find((i) => i.fields.code);
    expect(codeIdx, 'InviteCode 缺少 code 唯一索引').toBeDefined();
    expect(codeIdx.unique).toBe(true);
    expect(ic.fields.status.enum).toContain('unused');
    expect(ic.fields.status.enum).toContain('used');
    expect(ic.fields.status.enum).toContain('disabled');
    // used_by 为 onlyServer（不下发原始 openid）
    expect(ic.fields.used_by.onlyServer).toBe(true);
  });

  it('Activity 集合结构合法（字段 + status/start_time 索引）', () => {
    const a = COLLECTIONS.Activity;
    expect(a).toBeDefined();
    expect(Array.isArray(a.indexes)).toBe(true);
    // 字段齐全（PRD F7 字段定义）
    for (const f of ['_id', 'activity_id', 'name', 'start_time', 'end_time', 'signup_deadline', 'status', 'terminated', 'terminated_at', 'rules', 'total_steps', 'participant_count']) {
      expect(a.fields[f], `Activity 缺少字段: ${f}`).toBeDefined();
    }
    // 索引：status / start_time（技术架构 §5.4）
    const statusIdx = a.indexes.find((i) => i.fields.status);
    const startIdx = a.indexes.find((i) => i.fields.start_time);
    expect(statusIdx, 'Activity 缺少 status 索引').toBeDefined();
    expect(startIdx, 'Activity 缺少 start_time 索引').toBeDefined();
  });

  it('Activity 敏感聚合字段标记 onlyServer', () => {
    expect(COLLECTIONS.Activity.fields.total_steps.onlyServer).toBe(true);
    expect(COLLECTIONS.Activity.fields.participant_count.onlyServer).toBe(true);
  });

  it('Department 集合结构合法（PRD F2 字段 dept_id/name/member_count + activity_id 索引）', () => {
    const d = COLLECTIONS.Department;
    expect(d).toBeDefined();
    expect(Array.isArray(d.indexes)).toBe(true);
    // 字段齐全（PRD F2：dept_id / dept_name(name) / member_count / size）
    for (const f of ['_id', 'dept_id', 'name', 'activity_id', 'member_count', 'size', 'created_at']) {
      expect(d.fields[f], `Department 缺少字段: ${f}`).toBeDefined();
    }
    // 索引：activity_id（技术架构 §5.2）
    const activityIdx = d.indexes.find((i) => i.fields.activity_id);
    expect(activityIdx, 'Department 缺少 activity_id 索引').toBeDefined();
    // dept_id 业务唯一索引
    const deptIdIdx = d.indexes.find((i) => i.fields.dept_id);
    expect(deptIdIdx, 'Department 缺少 dept_id 索引').toBeDefined();
    expect(deptIdIdx.unique).toBe(true);
  });

  it('每个索引声明含 name / fields 两要素', () => {
    for (const name of Object.keys(COLLECTIONS)) {
      for (const idx of COLLECTIONS[name].indexes) {
        expect(idx.name, `${name} 索引缺 name`).toEqual(expect.any(String));
        expect(idx.name.length).toBeGreaterThan(0);
        expect(idx.fields, `${name} 索引 ${idx.name} 缺 fields`).toEqual(expect.any(Object));
        expect(Object.keys(idx.fields).length).toBeGreaterThan(0);
      }
    }
  });

  it('敏感字段标记 onlyServer（不下发前端的依据）', () => {
    expect(COLLECTIONS.User.fields._openid.onlyServer).toBe(true);
    expect(COLLECTIONS.InviteCode.fields.used_by.onlyServer).toBe(true);
    expect(COLLECTIONS.InviteCode.fields.created_by.onlyServer).toBe(true);
  });

  it('StepRecord 集合结构合法（PRD F3 / 技术架构 §5.5：字段齐全 + (user_id,activity_id,date) 唯一索引）', () => {
    const s = COLLECTIONS.StepRecord;
    expect(s).toBeDefined();
    expect(Array.isArray(s.indexes)).toBe(true);
    // 字段齐全（E1）
    for (const f of ['_id', 'user_id', '_openid', 'activity_id', 'date', 'steps', 'abnormal', 'locked', 'synced_at', 'sync_count']) {
      expect(s.fields[f], `StepRecord 缺少字段: ${f}`).toBeDefined();
    }
    // (user_id, activity_id, date) 唯一索引（R3.2 去重依据）
    const uadIdx = s.indexes.find(
      (i) => i.fields.user_id && i.fields.activity_id && i.fields.date
    );
    expect(uadIdx, 'StepRecord 缺少 (user_id,activity_id,date) 索引').toBeDefined();
    expect(uadIdx.unique).toBe(true);
    // activity_id + date 聚合索引
    expect(s.indexes.find((i) => i.fields.activity_id && i.fields.date), '缺少 activity_id+date 索引').toBeDefined();
    // abnormal + activity_id 后台查询索引
    expect(s.indexes.find((i) => i.fields.abnormal && i.fields.activity_id), '缺少 abnormal+activity_id 索引').toBeDefined();
  });

  it('StepRecord 敏感字段标记 onlyServer（_openid / sync_count 不下发）', () => {
    expect(COLLECTIONS.StepRecord.fields._openid.onlyServer).toBe(true);
    expect(COLLECTIONS.StepRecord.fields.sync_count.onlyServer).toBe(true);
  });

  it('RankCache 集合结构合法（§5.6/§6.6 P0-3 单文档：type/activity_id/rows/updated_at + (type,activity_id) 唯一索引）', () => {
    const rc = COLLECTIONS.RankCache;
    expect(rc).toBeDefined();
    expect(Array.isArray(rc.indexes)).toBe(true);
    // 单文档顶层字段齐全（rank/ref_id/total_steps 等在 rows 数组内，见 rows.desc）
    for (const f of ['_id', 'type', 'activity_id', 'rows', 'updated_at']) {
      expect(rc.fields[f], `RankCache 缺少字段: ${f}`).toBeDefined();
    }
    // (type, activity_id) 唯一索引：每 type+activity 一个文档（P0-3 单文档覆盖写）
    const taIdx = rc.indexes.find((i) => i.fields.type && i.fields.activity_id);
    expect(taIdx, 'RankCache 缺少 (type,activity_id) 索引').toBeDefined();
    expect(taIdx.unique).toBe(true);
  });

  it('RankCache type 枚举含 personal/dept', () => {
    const rc = COLLECTIONS.RankCache;
    expect(rc.fields.type.enum).toContain('personal');
    expect(rc.fields.type.enum).toContain('dept');
  });
});

describe('索引初始化脚本（B1）', () => {
  it('initIndexes.js 文件存在', () => {
    const p = path.resolve(__dirname, '../../cloudfunctions/schema/initIndexes.js');
    expect(fs.existsSync(p), '缺少 initIndexes.js').toBe(true);
  });

  it('collections.js 文件存在', () => {
    const p = path.resolve(__dirname, '../../cloudfunctions/schema/collections.js');
    expect(fs.existsSync(p), '缺少 collections.js').toBe(true);
  });

  it('ensureIndexes 对 mock cloud 逐集合建索引（幂等不抛错）', async () => {
    const created = [];
    const fakeCollection = (name) => ({
      createIndex(spec) {
        created.push({ name, spec });
        return Promise.resolve();
      }
    });
    const mockCloud = {
      database: () => ({ collection: fakeCollection })
    };
    const out = await ensureIndexes(mockCloud);
    expect(out.User).toBeDefined();
    expect(out.InviteCode).toBeDefined();
    expect(out.Activity).toBeDefined();
    // 每个集合的索引数与声明一致
    expect(out.User.length).toBe(COLLECTIONS.User.indexes.length);
    expect(out.InviteCode.length).toBe(COLLECTIONS.InviteCode.indexes.length);
    expect(out.Activity.length).toBe(COLLECTIONS.Activity.indexes.length);
    // 总创建数 = 全部集合索引之和
    const totalDeclared = Object.keys(COLLECTIONS).reduce(
      (sum, n) => sum + COLLECTIONS[n].indexes.length, 0
    );
    expect(created.length).toBe(totalDeclared);
  });

  it('ensureCollectionIndexes 对已存在索引（createIndex 抛错）幂等不视为失败', async () => {
    const fakeCollection = () => ({
      createIndex() {
        const e = new Error('index already exists');
        e.errMsg = 'index already exists';
        return Promise.reject(e);
      }
    });
    const db = { collection: fakeCollection };
    const results = await ensureCollectionIndexes(db, 'InviteCode');
    expect(results.length).toBe(COLLECTIONS.InviteCode.indexes.length);
    results.forEach((r) => {
      expect(r.ok).toBe(false); // 已存在 → ok=false 但不抛
      expect(r.reason).toBeDefined();
    });
  });

  it('ensureCollectionIndexes 在 createIndex 不可用时返回 manual 清单（wx-server-sdk 云函数端无此 API）', async () => {
    // 真实云环境：db.collection(name) 返回的对象没有 createIndex 方法。
    const db = { collection: () => ({ /* 无 createIndex */ }) };
    const results = await ensureCollectionIndexes(db, 'InviteCode');
    expect(results.length).toBe(COLLECTIONS.InviteCode.indexes.length);
    results.forEach((r) => {
      expect(r.manual).toBe(true);
      expect(r.ok).toBe(false);
      expect(r.fields).toBeDefined();
      expect(typeof r.unique).toBe('boolean');
    });
  });

  it('ensureIndexes 缺 cloud 抛错', async () => {
    await expect(ensureIndexes(null)).rejects.toThrow();
    await expect(ensureIndexes({})).rejects.toThrow();
  });

  it('ensureCollection 成功创建集合 → ok/created=true', async () => {
    const calls = [];
    const db = {
      createCollection(name) { calls.push(name); return Promise.resolve(); }
    };
    const out = await ensureCollection(db, 'User');
    expect(out).toEqual({ collection: 'User', ok: true, created: true });
    expect(calls).toEqual(['User']);
  });

  it('ensureCollection 已存在（createCollection 抛 already exists）→ 幂等 ok=true/created=false', async () => {
    const db = {
      createCollection() {
        const e = new Error('collection already exists');
        e.errMsg = 'collection already exists';
        return Promise.reject(e);
      }
    };
    const out = await ensureCollection(db, 'User');
    expect(out.ok).toBe(true);
    expect(out.created).toBe(false);
    expect(out.reason).toMatch(/already|exist/i);
  });

  it('ensureCollection 其它错误 → ok=false 且带 reason（不抛）', async () => {
    const db = {
      createCollection() {
        const e = new Error('permission denied');
        e.errMsg = 'permission denied';
        return Promise.reject(e);
      }
    };
    const out = await ensureCollection(db, 'User');
    expect(out.ok).toBe(false);
    expect(out.created).toBe(false);
    expect(out.reason).toBe('permission denied');
  });

  it('ensureCollections 对全部声明集合各调一次 createCollection', async () => {
    const calls = [];
    const mockCloud = {
      database: () => ({
        createCollection(name) { calls.push(name); return Promise.resolve(); }
      })
    };
    const out = await ensureCollections(mockCloud);
    expect(Object.keys(out).sort()).toEqual(Object.keys(COLLECTIONS).sort());
    expect(calls.length).toBe(Object.keys(COLLECTIONS).length);
  });

  it('ensureSchema 合成 collections + indexes（幂等不抛错）', async () => {
    const mockCloud = {
      database: () => ({
        createCollection: () => Promise.resolve(),
        collection: () => ({ createIndex: () => Promise.resolve() })
      })
    };
    const out = await ensureSchema(mockCloud);
    expect(out.collections).toBeDefined();
    expect(out.indexes).toBeDefined();
    expect(Object.keys(out.collections).sort()).toEqual(Object.keys(COLLECTIONS).sort());
    expect(Object.keys(out.indexes).sort()).toEqual(Object.keys(COLLECTIONS).sort());
  });

  it('ensureCollections 缺 cloud 抛错', async () => {
    await expect(ensureCollections(null)).rejects.toThrow();
  });
});
