/**
 * common/db.createDb 单测。
 *
 * createDb 是云数据库初始化封装：依赖注入 cloud，返回 cloud.database()。
 * 依赖注入设计目的：便于在 Node 下注入 mock cloud 单测，不连真云。
 *
 * P0-5：分页查询 helper loadByWhere(cloud, name, where, field) 已抽到 common/db，
 *   替代各 handler 复制的裸 loadCollection（全量拉取）。本文件测 createDb（注入校验）
 *   + loadByWhere（where 过滤 / field 投影 / skip 分页 / 容错兜底），纯 mock 不连真云。
 */
const { createDb, loadByWhere } = require('../../cloudfunctions/common/db');
const { createMockDb } = require('../helpers/mockDb');

describe('createDb（云数据库初始化封装）', () => {
  it('cloud 缺失 → 抛错（cloud with database() is required）', () => {
    expect(() => createDb(undefined)).toThrow(/database\(\) is required/);
    expect(() => createDb(null)).toThrow(/database\(\) is required/);
  });

  it('cloud.database 非函数 → 抛错', () => {
    expect(() => createDb({})).toThrow(/database\(\) is required/);
    expect(() => createDb({ database: 'not-a-fn' })).toThrow(/database\(\) is required/);
  });

  it('正常：返回 cloud.database() 的结果（透传）', () => {
    const fakeDb = { __db: true };
    const cloud = { database: () => fakeDb };
    const db = createDb(cloud);
    expect(db).toBe(fakeDb);
  });

  it('database() 被调用一次（mock 记录）', () => {
    const database = function () { return { ok: 1 }; };
    let callCount = 0;
    const cloud = {
      get database() {
        callCount++;
        return database;
      }
    };
    // 注意：createDb 调 cloud.database（属性访问）—此处验证函数式 database 调用。
    const cloud2 = {
      database: function () {
        callCount++;
        return { ok: 1 };
      }
    };
    createDb(cloud2);
    expect(callCount).toBe(1);
  });
});

describe('createDb 注入的 database 句柄契约（mock 链式消费）', () => {
  // 验证：createDb 返回的 db 句柄可被消费方按 collection().skip().limit().get() 链式调用，
  // 即 createDb 不破坏 cloud.database() 返回对象的契约。
  it('返回的 db 句柄支持 collection(name).skip(n).limit(n).get() 链式调用', async () => {
    const got = [];
    const fakeDb = {
      collection(name) {
        return {
          skip(n) { return { limit(ps) { return { get: () => Promise.resolve({ data: got.slice() }) }; } }; }
        };
      }
    };
    const db = createDb({ database: () => fakeDb });
    const res = await db.collection('StepRecord').skip(0).limit(100).get();
    expect(res).toEqual({ data: [] });
  });

  it('cloud.database() 抛异常时 createDb 不吞（透传异常）', () => {
    const cloud = {
      database() { throw new Error('init failed'); }
    };
    // createDb 只调 database()，异常应原样抛出（不静默兜底，由 handler 层 try/catch 兜底）。
    expect(() => createDb(cloud)).toThrow('init failed');
  });
});

describe('loadByWhere（按 where + field 分页加载，P0-5）', () => {
  it('where 过滤：只返回匹配文档', async () => {
    const { db } = createMockDb({
      StepRecord: [
        { _id: '1', user_id: 'u1', activity_id: 'a1', steps: 100 },
        { _id: '2', user_id: 'u2', activity_id: 'a1', steps: 200 },
        { _id: '3', user_id: 'u1', activity_id: 'a2', steps: 300 }
      ]
    });
    const rows = await loadByWhere({ database: () => db }, 'StepRecord', { user_id: 'u1', activity_id: 'a1' });
    expect(rows).toHaveLength(1);
    expect(rows[0]._id).toBe('1');
  });

  it('field 投影：只返回白名单字段 + _id（敏感字段被剔除）', async () => {
    const { db } = createMockDb({
      StepRecord: [{ _id: '1', user_id: 'u1', steps: 100, date: '07-01', _openid: 'op', sync_count: 3 }]
    });
    const rows = await loadByWhere(
      { database: () => db }, 'StepRecord',
      { user_id: 'u1' },
      { steps: 1, date: 1 }
    );
    expect(rows[0].steps).toBe(100);
    expect(rows[0].date).toBe('07-01');
    expect(rows[0]._id).toBe('1'); // _id 始终保留
    expect(rows[0]._openid).toBeUndefined(); // 投影掉
    expect(rows[0].sync_count).toBeUndefined();
  });

  it('where 中 null/undefined 值被剔除（不进 DB 查询）', async () => {
    const { db } = createMockDb({
      StepRecord: [
        { _id: '1', user_id: 'u1', activity_id: 'a1', steps: 100 },
        { _id: '2', user_id: 'u1', activity_id: 'a2', steps: 200 }
      ]
    });
    // activity_id=undefined 被剔除 → 只按 user_id 过滤（返回 u1 全部 2 条）。
    const rows = await loadByWhere({ database: () => db }, 'StepRecord', { user_id: 'u1', activity_id: undefined });
    expect(rows).toHaveLength(2);
  });

  it('无 where/field：全量返回（admin 全量内存筛选语义）', async () => {
    const { db } = createMockDb({
      User: [
        { _id: '1', nickname: 'a', phone: '138' },
        { _id: '2', nickname: 'b', phone: '139' }
      ]
    });
    const rows = await loadByWhere({ database: () => db }, 'User');
    expect(rows).toHaveLength(2);
  });

  it('分页：超 100 条跨页全量拉取（skip+limit 循环）', async () => {
    const recs = [];
    for (let i = 0; i < 150; i++) recs.push({ _id: String(i), user_id: 'u1', n: i });
    const { db } = createMockDb({ StepRecord: recs });
    const rows = await loadByWhere({ database: () => db }, 'StepRecord', { user_id: 'u1' });
    expect(rows).toHaveLength(150); // PAGE=100 → 两轮拉取合并
  });

  it('集合未创建（errCode -502005）→ 返回空数组兜底', async () => {
    const cloud = {
      database: () => ({
        collection() {
          const e = new Error('database collection not exists');
          e.errCode = -502005;
          throw e;
        }
      })
    };
    const rows = await loadByWhere(cloud, 'NotExist', { x: 1 });
    expect(rows).toEqual([]);
  });

  it('其他 DB 异常（超时/权限等）→ 上抛，不静默返空（A1：防假成功）', async () => {
    const cloud = {
      database: () => ({
        collection() { throw new Error('db timeout'); }
      })
    };
    await expect(loadByWhere(cloud, 'User', { x: 1 })).rejects.toThrow('db timeout');
  });
});
