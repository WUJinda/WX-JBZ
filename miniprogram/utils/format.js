/**
 * 格式化纯函数集（可单测）。
 */

/**
 * 手机号脱敏：138****1234。
 * 非合法手机号（长度不为 11 或非数字）原样返回，不抛错（用于展示兜底）。
 * @param {string} phone
 * @returns {string}
 */
function maskPhone(phone) {
  if (typeof phone !== 'string' && typeof phone !== 'number') return phone;
  const s = String(phone);
  // 仅对 11 位纯数字做脱敏
  if (!/^\d{11}$/.test(s)) return s;
  return s.slice(0, 3) + '****' + s.slice(7);
}

/**
 * 昵称脱敏：保留首尾字符，中间以 * 占位（如「张*明」「李*」）。
 * 单字昵称不脱敏直接返回。
 * @param {string} name
 * @returns {string}
 */
function maskName(name) {
  if (typeof name !== 'string') return name;
  const len = name.length;
  if (len <= 1) return name;
  if (len === 2) return name[0] + '*';
  return name[0] + '*'.repeat(len - 2) + name[len - 1];
}

module.exports = { maskPhone, maskName };
