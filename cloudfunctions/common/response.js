/**
 * 统一出参封装（对齐技术架构 §4.2）。
 * 所有云函数最终返回 { code, message, data }。
 */
const { CODE } = require('./errors');

/**
 * 成功出参。
 * @param {*} [data]
 * @param {string} [message]
 * @returns {{code:number, message:string, data:*}}
 */
function ok(data, message) {
  return {
    code: CODE.OK,
    message: message || 'ok',
    data: data === undefined ? null : data
  };
}

/**
 * 失败出参。
 * @param {number} code 业务错误码（非 0）
 * @param {string} [message]
 * @param {*} [data]
 * @returns {{code:number, message:string, data:*}}
 */
function fail(code, message, data) {
  return {
    code: typeof code === 'number' ? code : CODE.SYS_DB_ERROR,
    message: message || 'error',
    data: data === undefined ? null : data
  };
}

/**
 * 从异常对象构造失败出参（兼容 BizError）。
 * @param {Error} err
 */
function failFromError(err) {
  if (err && typeof err.code === 'number') {
    return fail(err.code, err.message, err.data);
  }
  return fail(CODE.SYS_DB_ERROR, (err && err.message) || 'unknown error');
}

module.exports = { ok, fail, failFromError };
