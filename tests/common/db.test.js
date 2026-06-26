/**
 * common/db.createDb 单测。
 *
 * createDb 是云数据库初始化封装：依赖注入 cloud，返回 cloud.database()。
 * 依赖注入设计目的：便于在 Node 下注入 mock cloud 单测，不连真云。
 *
 * 注意：分页 loadCollection 的实现实际位于各云函数 index.js handler 层
 * （cloudfunctions/{admin,activity,rank,tasks,steps}/index.js），未抽到 common/db。
 * 本文件只测 common/db.js 导出的 createDb 本身（注入校验 + database() 透传 + 异常分支），
 * 并用 mock cloud 验证「注入的 database 句柄」可被消费的契约（collection/skip/limit/get 链式）。
 * 纯 mock，不连真云。
 */
const { createDb } = require('../../cloudfunctions/common/db');

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
