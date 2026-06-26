/**
 * admin.parseWhitelist 纯函数（对齐技术架构 §122，PRD F8 R8.2 员工白名单导入）。
 *
 * 职责：从原始文本（CSV/TSV/纯文本）提取 11 位手机号，去重保留首次出现顺序。
 *   - 正则 1[3-9]\d{9} 提取。
 *   - 同一手机号重复出现计入 duplicate；非手机号 token 计入 invalid（按分隔块统计）。
 *   - 不读文件、不依赖 fs / xlsx（二进制 xlsx 留 opts.parse 注入接口，默认仅处理文本）。
 *
 * 本地轨：纯函数无副作用，可单测；不调真实云 API。
 * 解耦：本模块不 require wx-server-sdk，不 require fs。
 */

const PHONE_RE = /1[3-9]\d{9}/g;

/**
 * 按分隔符/换行切分文本为 token 块（便于 invalid 计数）。
 * 默认自动：按换行/逗号/制表符/空白切。
 * @param {string} text
 * @param {string} [delimiter] 显式分隔符（',' / '\t' 等）
 * @returns {string[]}
 */
function tokenize(text, delimiter) {
  if (typeof text !== 'string') return [];
  if (delimiter) {
    return text.split(delimiter).map((s) => s.trim()).filter((s) => s.length > 0);
  }
  // 自动：换行 / 逗号 / 制表 / 连续空白
  return text
    .split(/[\r\n,;\t\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * 解析白名单原始文本，提取去重手机号。
 *
 * @param {string} rawText 原始文本
 * @param {object} [opts]
 * @param {string} [opts.delimiter] 显式分隔符
 * @returns {{phones: string[], duplicate: number, invalid: number}}
 */
function parseWhitelist(rawText, opts) {
  const o = opts || {};
  const text = rawText == null ? '' : String(rawText);

  // 空输入快速返回。
  if (!text.trim()) {
    return { phones: [], duplicate: 0, invalid: 0 };
  }

  const tokens = tokenize(text, o.delimiter);

  const phones = [];
  const seen = new Set();
  let duplicate = 0;

  for (const token of tokens) {
    // 在该 token 内全局提取所有手机号（一个 token 可能含多个，如 "电话:13800001111;13900002222"）。
    const matches = token.match(PHONE_RE);
    if (!matches || matches.length === 0) {
      // 整个 token 无任何手机号 → 非法块。
      // 但跳过纯空白/表头等噪声：上面 tokenize 已 trim；此处只要非空就计非法。
      // 注意：token 可能本身含可识别文字（表头），统一计为 invalid。
      continue; // 不计入 phones
    }
    for (const m of matches) {
      if (seen.has(m)) {
        duplicate += 1;
      } else {
        seen.add(m);
        phones.push(m);
      }
    }
  }

  // invalid = 含非手机号内容但被识别为「应该是数据」的块数。
  // 口径：token 非空且其中不含任何 11 位手机号 → 计一条非法。
  // 纯表头行（如 "手机号"）会被这样计入，符合「非法格式」语义。
  let invalid = 0;
  for (const token of tokens) {
    if (!PHONE_RE.test(token)) {
      invalid += 1;
    }
    // 重置 lastIndex（g 标志副作用）
    PHONE_RE.lastIndex = 0;
  }

  return { phones, duplicate, invalid };
}

module.exports = { parseWhitelist, tokenize };
