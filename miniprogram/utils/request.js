/**
 * 前端统一请求封装（对齐技术架构 §3 前端请求封装）。
 *
 * 把 wx.cloud.callFunction 回调 Promise 化，统一 loading 与错误处理。
 * 返回 Promise<result.data>：成功 resolve 出参中的 data，失败 reject 标准化错误。
 *
 * 依赖注入：wx.cloud 通过 createApi(wxCloud) 注入，便于 Node 下单测 mock。
 */

const DEFAULT_LOADING_TEXT = '加载中...';

/**
 * 工厂：传入 wx.cloud 句柄，产出 call 函数。
 * @param {object} wxCloud wx.cloud 实例（含 callFunction）
 * @param {object} [hooks] 可选钩子，便于测试或自定义 loading 行为
 * @param {(text:string)=>void} [hooks.showLoading]
 * @param {()=>void} [hooks.hideLoading]
 * @param {(msg:string)=>void} [hooks.showError]
 * @returns {{call: (name:string, data?:object, options?:object) => Promise<*>}}
 */
function createApi(wxCloud, hooks) {
  if (!wxCloud || typeof wxCloud.callFunction !== 'function') {
    throw new Error('createApi: wx.cloud with callFunction is required');
  }
  const h = hooks || {};
  const showLoading = typeof h.showLoading === 'function' ? h.showLoading : null;
  const hideLoading = typeof h.hideLoading === 'function' ? h.hideLoading : null;
  const showError = typeof h.showError === 'function' ? h.showError : null;

  /**
   * 调用云函数。
   * @param {string} name 云函数名
   * @param {object} [data] 入参（按约定 {action, data} 形态由调用方组织或本封装透传）
   * @param {object} [options] { loading?: boolean|string, silent?: boolean }
   * @returns {Promise<*>} resolve 出参中的 data
   */
  function call(name, data, options) {
    const opts = options || {};
    const loadingFlag = opts.loading === undefined ? true : opts.loading;
    const loadingText = typeof loadingFlag === 'string' ? loadingFlag : DEFAULT_LOADING_TEXT;
    const showLoadingNow = loadingFlag !== false && showLoading;

    if (showLoadingNow) showLoading(loadingText);

    return new Promise((resolve, reject) => {
      wxCloud.callFunction({
        name,
        data: data || {},
        success(res) {
          if (showLoadingNow && hideLoading) hideLoading();
          // 出参 { code, message, data }
          const result = (res && res.result) || {};
          if (result.code === 0) {
            resolve(result.data === undefined ? null : result.data);
          } else {
            const err = new Error(result.message || 'request failed');
            err.code = result.code;
            err.data = result.data;
            if (!opts.silent && showError) showError(err.message);
            reject(err);
          }
        },
        fail(e) {
          if (showLoadingNow && hideLoading) hideLoading();
          const err = new Error((e && e.errMsg) || 'callFunction failed');
          err.raw = e;
          if (!opts.silent && showError) showError(err.message);
          reject(err);
        }
      });
    });
  }

  return { call };
}

module.exports = { createApi };
