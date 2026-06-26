/**
 * 后台白名单导入页前端纯函数（对齐 PRD F8 R8.2，开发计划阶段 H2）。
 *
 * 把手机号预览解析、导入结果格式化抽成纯函数，便于在 Node 下单测，不耦合 wx 运行时。
 *
 * 红线（与后端 whitelistParse 口径严格一致，保证预览数 = 实际导入数）：
 *   - 手机号正则 1[3-9]\d{9}（与 cloudfunctions/admin/whitelistParse.js 同款）。
 *   - 去重保留首次出现顺序（同后端 parseWhitelist）。
 *   - 分隔块口径同后端 tokenize：按 [\r\n,;\t\s]+ 切分。
 *
 * 本模块不 require wx 运行时；正则与后端同源，避免预览/实际不一致。
 */

// 与后端 whitelistParse.js PHONE_RE 同款（1[3-9]\d{9}）。
const PHONE_RE = /1[3-9]\d{9}/g;

/**
 * 解析原始文本预览手机号（R8.2 前端预览，口径同后端 parseWhitelist）。
 * - 从 rawText 中提取所有 11 位手机号，去重保序。
 * - invalid = 含非手机号内容但被识别为「应该是数据」的块数（同后端口径：token 非空且不含手机号）。
 * - 返回 { phones, count, invalid }。
 *
 * 注意：phones 仅用于前端预览展示样本，**不向 wxml 绑定完整 phone**
 *（红线：wxml 不渲染完整 phone，仅展示数量/截断样本由页面层处理）。
 * @param {string} rawText 原始文本（CSV/TSV/纯文本）
 * @returns {{phones:string[], count:number, invalid:number}}
 */
function previewPhones(rawText) {
  const text = rawText == null ? '' : String(rawText);
  // 空输入快速返回。
  if (!text.trim()) {
    return { phones: [], count: 0, invalid: 0 };
  }

  // 按分隔块切分（与后端 tokenize 自动模式一致：换行/逗号/分号/制表/空白）。
  const tokens = text
    .split(/[\r\n,;\t\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const phones = [];
  const seen = new Set();
  for (const token of tokens) {
    // 在该 token 内全局提取所有手机号（与后端 token.match(PHONE_RE) 一致）。
    PHONE_RE.lastIndex = 0;
    const matches = token.match(PHONE_RE);
    if (!matches || matches.length === 0) continue;
    for (const m of matches) {
      if (!seen.has(m)) {
        seen.add(m);
        phones.push(m);
      }
    }
  }

  // invalid：token 非空且不含任何手机号 → 计一条非法（同后端口径）。
  let invalid = 0;
  for (const token of tokens) {
    PHONE_RE.lastIndex = 0;
    if (!PHONE_RE.test(token)) {
      invalid += 1;
    }
    PHONE_RE.lastIndex = 0;
  }

  return { phones, count: phones.length, invalid };
}

/**
 * 格式化导入结果文案（applyWhitelistImport 返回 {imported, updated}）。
 * - 新增 X 条，更新 Y 条（Y=0 时省略更新部分）。
 * - 全 0 → '未导入任何手机号'。
 * @param {{imported:number, updated:number}} result
 * @returns {string}
 */
function formatImportResult(result) {
  const r = result || {};
  const imported = Number(r.imported) || 0;
  const updated = Number(r.updated) || 0;
  if (imported === 0 && updated === 0) return '未导入任何手机号';
  const parts = [];
  if (imported > 0) parts.push('新增 ' + imported + ' 条');
  if (updated > 0) parts.push('更新 ' + updated + ' 条');
  return parts.join('，');
}

module.exports = { previewPhones, formatImportResult, PHONE_RE };
