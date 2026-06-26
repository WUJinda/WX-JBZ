/**
 * 昵称脱敏（对齐 PRD R5.3 / 技术架构 §6.6）。
 *
 * 规则：中间字以 * 替代，首尾保留。
 *   - "张小明" → "张*明"
 *   - "张三"   → "张*"
 *   - "张"     → "张"（单字不脱敏，边界安全）
 *   - ""       → ""（空串安全）
 *
 * 纯函数，无任何云 API 副作用。
 */

/**
 * 昵称脱敏：中间字替 *。
 * @param {string} name 原始昵称
 * @returns {string} 脱敏后昵称
 */
function maskNickname(name) {
  const s = typeof name === 'string' ? name : String(name == null ? '' : name);
  // 按 code point（Unicode 码点）拆分，避免 emoji 等代理对被拆成两半。
  const chars = Array.from(s);
  if (chars.length <= 1) return chars.join('');
  if (chars.length === 2) {
    // 两字：保留首字，末字替 *
    return chars[0] + '*';
  }
  // 三字及以上：保留首尾，中间全部替 *
  const head = chars[0];
  const tail = chars[chars.length - 1];
  const middle = '*'.repeat(chars.length - 2);
  return head + middle + tail;
}

/**
 * 手机号脱敏：138****1234（对齐 miniprogram/utils/format.js 的 maskPhone 实现）。
 * 非合法手机号（非字符串/数字、长度不为 11 或非数字）原样返回，不抛错（展示兜底）。
 *
 * 说明：云函数部署独立打包，无法 require 小程序目录下的 utils/format，
 * 故在此提供等价实现供云函数复用（避免部署后 MODULE_NOT_FOUND）。
 *
 * @param {string|number} phone
 * @returns {string|*}
 */
function maskPhone(phone) {
  if (typeof phone !== 'string' && typeof phone !== 'number') return phone;
  const s = String(phone);
  // 仅对 11 位纯数字做脱敏
  if (!/^\d{11}$/.test(s)) return s;
  return s.slice(0, 3) + '****' + s.slice(7);
}

module.exports = { maskNickname, maskPhone };
