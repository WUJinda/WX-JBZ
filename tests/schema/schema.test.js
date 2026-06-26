const fs = require('fs');
const path = require('path');
const { COLLECTIONS, ensureIndexes, ensureCollectionIndexes } = require('../../cloudfunctions/schema/initIndexes');

describe('集合 schema 定义（B1）', () => {
  it('COLLECTIONS 可被 require 且为对象', () => {
    expect(COLLECTIONS).toEqual(expect.any(Object));
  });

  it('User 集合结构合法（字段 + 索引）', () => {
    const u = COLLECTIONS.User;
    expect(u).toBeDefined();
    expect(Array.isArray(u.indexes)).toBe(true);
    // 字段齐全
    for (const f of ['_id', '_openid', 'nickname', 'avatar', 'phone', 'phone_masked', 'dept_id', 'join_status', 'is_admin', 'created_at', 'updated_at']) {
      expect(u.fields[f], `User 缺少字段: ${f}`).toBeDefined();
    }
  });

  it('User 含 _openid 与 phone 两个唯一索引', () => {
    const u = COLLECTIONS.User;
    const uniqueIdx = u.indexes.filter((i) => i.unique);
    const fields = uniqueIdx.map((i) => Object.keys(i.fields)[0]);
    expect(fields).toContain('_openid');
    expect(fields).toContain('phone');
  });

  it('Whitelist 集合结构合法（字段 + phone 唯一索引）', () => {
    const w = COLLECTIONS.Whitelist;
    expect(w).toBeDefined();
    expect(Array.isArray(w.indexes)).toBe(true);
    expect(w.fields.phone).toBeDefined();
    const phoneIdx = w.indexes.find((i) => i.fields.phone);
    expect(phoneIdx, 'Whitelist 缺少 phone 索引').toBeDefined();
    expect(phoneIdx.unique).toBe(true);
  });

  it('Activity 集合结构合法（字段 + status/start_time 索引）', () => {
    const a = COLLECTIONS.Activity;
    expect(a).toBeDefined();
    expect(Array.isArray(a.indexes)).toBe(true);
    // 字段齐全（PRD F7 字段定义）
    for (const f of ['_id', 'activity_id', 'name', 'cover_url', 'start_time', 'end_time', 'status', 'rules', 'total_steps', 'participant_count']) {
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
    // 字段齐全（PRD F2：dept_id / dept_name(name) / member_count）
    for (const f of ['_id', 'dept_id', 'name', 'activity_id', 'member_count', 'created_at']) {
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
    expect(COLLECTIONS.User.fields.phone.onlyServer).toBe(true);
    expect(COLLECTIONS.Whitelist.fields.phone.onlyServer).toBe(true);
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
    expect(out.Whitelist).toBeDefined();
    expect(out.Activity).toBeDefined();
    // 每个集合的索引数与声明一致
    expect(out.User.length).toBe(COLLECTIONS.User.indexes.length);
    expect(out.Whitelist.length).toBe(COLLECTIONS.Whitelist.indexes.length);
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
    const results = await ensureCollectionIndexes(db, 'Whitelist');
    expect(results.length).toBe(COLLECTIONS.Whitelist.indexes.length);
    results.forEach((r) => {
      expect(r.ok).toBe(false); // 已存在 → ok=false 但不抛
      expect(r.reason).toBeDefined();
    });
  });

  it('ensureIndexes 缺 cloud 抛错', async () => {
    await expect(ensureIndexes(null)).rejects.toThrow();
    await expect(ensureIndexes({})).rejects.toThrow();
  });
});
