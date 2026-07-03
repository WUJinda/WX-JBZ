/**
 * 测试辅助：构造可注入的 mock db，行为对齐 wx-server-sdk 数据库的最小子集。
 *
 * 支持的链式形态（方法顺序无关，均返回同一 chain；纯内存实现便于单测）：
 *   db.collection(name).where(cond).get()             -> Promise<{ data: object[] }>
 *   db.collection(name).where(cond).limit(n).get()     -> 限量
 *   db.collection(name).where(cond).field(proj).get()  -> 白名单投影（对齐 .field({k:true})）
 *   db.collection(name).where(cond).update({ data })   -> Promise<{ stats: { updated } }>
 *   db.collection(name).where(cond).remove()           -> Promise<{ stats: { removed } }>
 *   db.collection(name).skip(n).limit(n).get()         -> 分页全量（无 where；loadByWhere 用）
 *   db.collection(name).add({ data })                  -> Promise<{ _id }>
 *
 * 数据通过 store（{ [collection]: object[] }）共享，测试可预设初始数据。
 */

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a && b && typeof a === 'object') {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

function matchDoc(doc, cond) {
  if (!cond) return true;
  return Object.keys(cond).every((k) => {
    if (cond[k] && typeof cond[k] === 'object' && !Array.isArray(cond[k])) {
      // 简单嵌套对象相等
      return doc[k] && deepEqual(doc[k], cond[k]);
    }
    return doc[k] === cond[k];
  });
}

/**
 * field 白名单投影（对齐 wx-server-sdk .field({k:true})：仅返回 _id + 标记为 true 的字段）。
 */
function applyField(doc, proj) {
  if (!proj) return doc;
  const out = {};
  if (doc._id !== undefined) out._id = doc._id;
  Object.keys(proj).forEach((k) => {
    if (proj[k] && doc[k] !== undefined) out[k] = doc[k];
  });
  return out;
}

let _idSeq = 0;
function nextId(prefix) {
  _idSeq += 1;
  return (prefix || 'id') + '_' + _idSeq;
}

/**
 * 构造可链式累积的查询 chain（cond=null 表示无 where 全量）。
 * where 返回新 chain（携带 cond）；skip/limit/field 累积到当前 chain。
 */
function makeChain(store, name, cond) {
  let skipN = 0;
  let limitN = null;
  let fieldProj = null;
  const chain = {
    where(c) {
      return makeChain(store, name, c);
    },
    skip(n) {
      skipN = Number(n) || 0;
      return chain;
    },
    limit(n) {
      limitN = n == null ? null : Number(n);
      return chain;
    },
    field(proj) {
      fieldProj = proj;
      return chain;
    },
    get: () => {
      let data = store[name].filter((d) => matchDoc(d, cond));
      if (fieldProj) data = data.map((d) => applyField(d, fieldProj));
      if (skipN > 0) data = data.slice(skipN);
      if (limitN != null) data = data.slice(0, limitN);
      return Promise.resolve({ data });
    },
    update: ({ data }) => {
      let updated = 0;
      store[name] = store[name].map((d) => {
        if (matchDoc(d, cond)) {
          updated += 1;
          return Object.assign({}, d, data);
        }
        return d;
      });
      return Promise.resolve({ stats: { updated } });
    },
    remove: () => {
      const before = store[name].length;
      store[name] = store[name].filter((d) => !matchDoc(d, cond));
      return Promise.resolve({ stats: { removed: before - store[name].length } });
    },
    add: ({ data }) => {
      const id = nextId(name);
      const doc = Object.assign({ _id: id }, data);
      store[name].push(doc);
      return Promise.resolve({ _id: id });
    },
    // 兜底：直接拿当前数组引用（仅测试观察用；注意 update 会替换数组，此引用会过期）。
    get _store() {
      return store[name];
    }
  };
  return chain;
}

/**
 * 构造 mock db。
 * @param {object} [initialStore] { CollectionName: object[] }
 * @returns {{ db: object, store: object }}
 */
function createMockDb(initialStore) {
  const store = initialStore || {};

  function ensureCol(name) {
    if (!Array.isArray(store[name])) store[name] = [];
    return store[name];
  }

  function collection(name) {
    ensureCol(name);
    return makeChain(store, name, null);
  }

  const db = { collection };
  return { db, store };
}

module.exports = { createMockDb };
