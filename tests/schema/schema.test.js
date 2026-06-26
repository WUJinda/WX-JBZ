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
    // User 4 个索引 + Whitelist 1 个索引
    expect(out.User.length).toBe(COLLECTIONS.User.indexes.length);
    expect(out.Whitelist.length).toBe(COLLECTIONS.Whitelist.indexes.length);
    expect(created.length).toBe(COLLECTIONS.User.indexes.length + COLLECTIONS.Whitelist.indexes.length);
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
