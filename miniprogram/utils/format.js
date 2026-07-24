/**
 * 格式化纯函数集（可单测）。
 */

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

module.exports = { maskName };
