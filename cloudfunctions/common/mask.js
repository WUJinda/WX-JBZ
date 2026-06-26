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

module.exports = { maskNickname };
