/**
 * admin 域邀请码管理纯函数（生成 / 列表 / 禁用）。
 *
 * 与 auth/inviteCode.js 分离（sync-shared SHARED_DIRS 不含 admin/auth，跨域 require
 * 须改 manifest）；Crockford 生成逻辑本域独立实现。
 *
 * 职责拆分：
 *   - 本模块（纯函数轨，store 注入）：generateCodes / listCodes / disableCode；
 *   - handler（admin/index.js）：真实库读写（generateInviteCodesToCloud / disableInviteCodeToCloud）。
 *
 * 本地轨：store 注入式（mockDb 构造 store 可单测）；不 require wx-server-sdk。
 * rand 注入：generateCodes 用 rand 生成随机码，单测注入确定性 rand。
 */

const { CODE, BizError } = require('../common/errors');

const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH = 6;
/** 单次批量生成上限。 */
const MAX_BATCH = 500;

/**
 * 生成单个随机码（Crockford Base32，CODE_LENGTH 位）。
 * @param {function} [rand] 返回 [0,1) 随机数的函数（默认 Math.random）
 * @returns {string}
 */
function generateOneCode(rand) {
  const r = typeof rand === 'function' ? rand : Math.random;
  let s = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    s += CROCKFORD_ALPHABET[Math.floor(r() * CROCKFORD_ALPHABET.length)];
  }
  return s;
}

/**
 * 批量生成邀请码（纯函数，store 注入）。
 * 在 store.InviteCode 已有码集合 + 本次批次内去重，生成 count 个新码文档。
 *
 * @param {object} params
 * @param {object} params.store { InviteCode: Array } 已有邀请码（用于查重）
 * @param {number} params.count 生成数量
 * @param {string} [params.batchId] 批次号（缺省自动生成 b_<timestamp>）
 * @param {string} [params.createdBy] 生成者 openid
 * @param {Date|Function} [params.now] 时间
 * @param {function} [params.rand] 随机源（单测注入）
 * @returns {{generated: number, codes: string[], duplicate: number, docs: Array, batchId: string}}
 * @throws {BizError} SYS_DB_ERROR / BIZ_PARAM_MISSING
 */
function generateCodes(params) {
  const { store, count, batchId, createdBy, now, rand } = params || {};
  if (!store || !Array.isArray(store.InviteCode)) {
    throw BizError(CODE.SYS_DB_ERROR, 'generateCodes: store.InviteCode array required');
  }
  const n = Math.floor(Number(count));
  if (!Number.isFinite(n) || n <= 0) {
    throw BizError(CODE.BIZ_PARAM_MISSING, 'generateCodes: count must be a positive integer');
  }
  if (n > MAX_BATCH) {
    throw BizError(CODE.BIZ_PARAM_MISSING, 'generateCodes: count exceeds max batch ' + MAX_BATCH);
  }
  const ts = now instanceof Date ? now : typeof now === 'function' ? now() : new Date();
  const bid = batchId || ('b_' + ts.getTime());

  // 已有码集合（含 used/unused/disabled 全部，避免与历史码碰撞）
  const existing = new Set(store.InviteCode.map((c) => c && c.code).filter(Boolean));
  const codes = [];
  const docs = [];
  let duplicate = 0;
  // 防无限循环：码空间 32^6 远大于 n，极小概率重复；设上限保护。
  let guard = 0;
  const guardMax = n * 20;

  while (codes.length < n && guard < guardMax) {
    guard++;
    const c = generateOneCode(rand);
    if (existing.has(c)) {
      duplicate += 1;
      continue;
    }
    existing.add(c);
    codes.push(c);
    docs.push({
      code: c,
      status: 'unused',
      batch_id: bid,
      created_by: createdBy || '',
      created_at: ts,
      note: ''
    });
  }
  return { generated: codes.length, codes, duplicate, docs, batchId: bid };
}

/**
 * 投影邀请码文档为可下发字段（红线：不下发 used_by 原始 openid）。
 * @param {object} doc
 * @returns {object|null}
 */
function projectInviteCode(doc) {
  if (!doc) return null;
  return {
    code: doc.code,
    status: doc.status,
    batch_id: doc.batch_id || '',
    used_at: doc.used_at || null,
    created_at: doc.created_at || null,
    note: doc.note || ''
  };
}

/**
 * 列表查询（纯函数，store 注入，本地过滤 + 分页）。
 * @param {object} store { InviteCode: Array }
 * @param {object} [opts] { status?, batchId?, page=1, pageSize=20 }
 * @returns {{list: Array, totalCount: number, page: number, pageSize: number}}
 * @throws {BizError} SYS_DB_ERROR
 */
function listCodes(store, opts) {
  const o = opts || {};
  if (!store || !Array.isArray(store.InviteCode)) {
    throw BizError(CODE.SYS_DB_ERROR, 'listCodes: store.InviteCode array required');
  }
  let rows = store.InviteCode.slice();
  if (o.status) rows = rows.filter((c) => c && c.status === o.status);
  if (o.batchId) rows = rows.filter((c) => c && c.batch_id === o.batchId);

  const toTs = (d) => {
    if (!d) return 0;
    if (d instanceof Date) return d.getTime();
    const t = new Date(d).getTime();
    return Number.isFinite(t) ? t : 0;
  };
  // 按 created_at 降序（新生成在前）
  rows.sort((a, b) => toTs(b && b.created_at) - toTs(a && a.created_at));

  const totalCount = rows.length;
  const page = Math.max(1, Number(o.page) || 1);
  const pageSize = Math.max(1, Number(o.pageSize) || 20);
  const start = (page - 1) * pageSize;
  const slice = rows.slice(start, start + pageSize).map(projectInviteCode);
  return { list: slice, totalCount, page, pageSize };
}

/**
 * 禁用邀请码（纯函数，store 注入）：仅 unused 可禁用；used 不可改（已绑定用户）。
 * 返回 {code, status:'disabled'}，handler 据此 where({code, status:'unused'}).update 落库。
 *
 * @param {object} params { store, code, now }
 * @returns {{code: string, status: 'disabled'}}
 * @throws {BizError} 码不存在 → INVALID；used → USED；已禁用 → DISABLED
 */
function disableCode(params) {
  const { store, code } = params || {};
  if (!store || !Array.isArray(store.InviteCode)) {
    throw BizError(CODE.SYS_DB_ERROR, 'disableCode: store.InviteCode array required');
  }
  if (!code || typeof code !== 'string') {
    throw BizError(CODE.BIZ_PARAM_MISSING, 'disableCode: code required');
  }
  const found = store.InviteCode.find((c) => c && c.code === code);
  if (!found) {
    throw BizError(CODE.BIZ_INVITE_CODE_INVALID, '邀请码不存在');
  }
  if (found.status === 'used') {
    throw BizError(CODE.BIZ_INVITE_CODE_USED, '已使用的邀请码不可禁用');
  }
  if (found.status === 'disabled') {
    throw BizError(CODE.BIZ_INVITE_CODE_DISABLED, '邀请码已禁用');
  }
  return { code, status: 'disabled' };
}

module.exports = {
  generateCodes,
  listCodes,
  disableCode,
  projectInviteCode,
  generateOneCode,
  CROCKFORD_ALPHABET,
  CODE_LENGTH,
  MAX_BATCH
};
