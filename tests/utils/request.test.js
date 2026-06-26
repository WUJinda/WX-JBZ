const { createApi } = require('../../miniprogram/utils/request');

/**
 * 构造一个 mock wx.cloud，callFunction 行为可控。
 */
function mockWxCloud(impl) {
  return {
    callFunction(options) {
      const { success, fail } = options;
      const { result, error } = impl(options);
      if (error) {
        setTimeout(() => fail(error), 0);
      } else {
        setTimeout(() => success({ result }), 0);
      }
    }
  };
}

describe('utils/request 封装', () => {
  it('成功时 resolve 出参中的 data', async () => {
    const wxCloud = mockWxCloud(() => ({
      result: { code: 0, message: 'ok', data: { steps: 100 } }
    }));
    const api = createApi(wxCloud);
    const data = await api.call('steps', { action: 'today' });
    expect(data).toEqual({ steps: 100 });
  });

  it('code 非 0 时 reject 带错误码', async () => {
    const wxCloud = mockWxCloud(() => ({
      result: { code: 1003, message: 'forbidden', data: null }
    }));
    const api = createApi(wxCloud);
    await expect(api.call('admin', { action: 'x' })).rejects.toMatchObject({
      code: 1003,
      message: 'forbidden'
    });
  });

  it('callFunction fail 走错误处理（reject）', async () => {
    const wxCloud = mockWxCloud(() => ({ error: { errMsg: 'network down' } }));
    const api = createApi(wxCloud);
    await expect(api.call('rank', {})).rejects.toMatchObject({
      message: 'network down'
    });
  });

  it('成功路径触发 showLoading / hideLoading', async () => {
    const calls = [];
    const wxCloud = mockWxCloud(() => ({ result: { code: 0, message: 'ok', data: 1 } }));
    const api = createApi(wxCloud, {
      showLoading: (t) => calls.push('show:' + t),
      hideLoading: () => calls.push('hide')
    });
    await api.call('user', {});
    expect(calls).toContain('show:加载中...');
    expect(calls).toContain('hide');
  });

  it('失败路径也触发 hideLoading', async () => {
    const calls = [];
    const wxCloud = mockWxCloud(() => ({ error: { errMsg: 'e' } }));
    const api = createApi(wxCloud, {
      showLoading: () => calls.push('show'),
      hideLoading: () => calls.push('hide'),
      showError: () => calls.push('showError')
    });
    await expect(api.call('user', {})).rejects.toThrow();
    expect(calls).toContain('show');
    expect(calls).toContain('hide');
  });

  it('options.loading=false 不触发 loading', async () => {
    const calls = [];
    const wxCloud = mockWxCloud(() => ({ result: { code: 0, message: 'ok', data: 1 } }));
    const api = createApi(wxCloud, {
      showLoading: () => calls.push('show'),
      hideLoading: () => calls.push('hide')
    });
    await api.call('user', {}, { loading: false });
    expect(calls).toEqual([]);
  });

  it('options.silent=true 失败时不调用 showError', async () => {
    let showErrorCalled = false;
    const wxCloud = mockWxCloud(() => ({ error: { errMsg: 'boom' } }));
    const api = createApi(wxCloud, { showError: () => { showErrorCalled = true; } });
    await expect(api.call('user', {}, { silent: true })).rejects.toThrow();
    expect(showErrorCalled).toBe(false);
  });

  it('缺少 wx.cloud 抛配置错误', () => {
    expect(() => createApi(null)).toThrow();
    expect(() => createApi({})).toThrow();
  });
});
