/**
 * 测试辅助：构造可注入的 mock db，行为对齐 wx-server-sdk 数据库的最小子集。
 *
 * 支持的形态（纯内存实现，便于单测）：
 *   db.collection(name).where(cond).get()    -> Promise<{ data: object[] }>
 *   db.collection(name).where(cond).update({ data }) -> Promise<{ stats: { updated: n } }>
 *   db.collection(name).add({ data })        -> Promise<{ _id }>
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

let _idSeq = 0;
function nextId(prefix) {
  _idSeq += 1;
  return (prefix || 'id') + '_' + _idSeq;
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
    return {
      // 链式：先 where 再 get/update
      where(cond) {
        return {
          get: () =>
            Promise.resolve({ data: store[name].filter((d) => matchDoc(d, cond)) }),
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
          }
        };
      },
      add: ({ data }) => {
        const id = nextId(name);
        const doc = Object.assign({ _id: id }, data);
        store[name].push(doc);
        return Promise.resolve({ _id: id });
      },
      // 兜底：直接拿引用（仅测试观察用）
      _store: store[name]
    };
  }

  const db = { collection };
  return { db, store };
}

module.exports = { createMockDb };
