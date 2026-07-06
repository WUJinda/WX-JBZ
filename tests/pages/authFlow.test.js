const { STATES, transition } = require('../../miniprogram/pages/login/authFlow');

describe('login 授权状态机（B4）', () => {
  const initial = { authState: STATES.INIT, authDenied: false, phoneDenied: false };

  it('LOGIN_START：init → logging', () => {
    const s = transition(initial, { type: 'LOGIN_START' });
    expect(s.authState).toBe(STATES.LOGGING);
    expect(s.authDenied).toBe(false);
  });

  it('LOGIN_OK：logging → logged，携带 userInfo', () => {
    const s = transition({ authState: STATES.LOGGING }, {
      type: 'LOGIN_OK',
      payload: { userInfo: { nickName: '张明' } }
    });
    expect(s.authState).toBe(STATES.LOGGED);
    expect(s.userInfo.nickName).toBe('张明');
  });

  it('LOGIN_DENIED：logging → init 并标记 authDenied', () => {
    const s = transition({ authState: STATES.LOGGING }, { type: 'LOGIN_DENIED' });
    expect(s.authState).toBe(STATES.INIT);
    expect(s.authDenied).toBe(true);
  });

  it('SETTING_GRANTED：重置 authDenied 并重新进入 logging', () => {
    const s = transition({ authState: STATES.INIT, authDenied: true }, { type: 'SETTING_GRANTED' });
    expect(s.authDenied).toBe(false);
    expect(s.authState).toBe(STATES.LOGGING);
  });

  it('PHONE_START：logged → phoneVerifying', () => {
    const s = transition({ authState: STATES.LOGGED }, { type: 'PHONE_START' });
    expect(s.authState).toBe(STATES.PHONE_VERIFYING);
  });

  it('PHONE_OK：phoneVerifying → phoneVerified，携带脱敏手机号', () => {
    const s = transition({ authState: STATES.PHONE_VERIFYING }, {
      type: 'PHONE_OK',
      payload: { phoneMasked: '138****1234' }
    });
    expect(s.authState).toBe(STATES.PHONE_VERIFIED);
    expect(s.phoneMasked).toBe('138****1234');
    expect(s.inWhitelist).toBe(true);
  });

  it('PHONE_DENIED：phoneVerifying → logged 并标记 phoneDenied', () => {
    const s = transition({ authState: STATES.PHONE_VERIFYING }, { type: 'PHONE_DENIED' });
    expect(s.authState).toBe(STATES.LOGGED);
    expect(s.phoneDenied).toBe(true);
  });

  it('PHONE_START 在未登录态不触发手机验证（防越序）', () => {
    const s = transition({ authState: STATES.INIT }, { type: 'PHONE_START' });
    expect(s.authState).toBe(STATES.INIT);
  });

  it('PROFILE_START：logged → profile', () => {
    const s = transition({ authState: STATES.LOGGED }, { type: 'PROFILE_START' });
    expect(s.authState).toBe(STATES.PROFILE);
    expect(s.profileDenied).toBe(false);
  });

  it('PROFILE_OK：profile → phoneVerifying', () => {
    const s = transition({ authState: STATES.PROFILE }, { type: 'PROFILE_OK' });
    expect(s.authState).toBe(STATES.PHONE_VERIFYING);
    expect(s.phoneDenied).toBe(false);
  });

  it('PROFILE_DENIED：留在 profile 并标记 profileDenied', () => {
    const s = transition({ authState: STATES.PROFILE }, { type: 'PROFILE_DENIED' });
    expect(s.authState).toBe(STATES.PROFILE);
    expect(s.profileDenied).toBe(true);
  });

  it('PROFILE_START 在非 logged 不触发（防越序）', () => {
    const s = transition({ authState: STATES.INIT }, { type: 'PROFILE_START' });
    expect(s.authState).toBe(STATES.INIT);
  });

  it('完整正向流程：init → logging → logged → profile → phoneVerifying → phoneVerified', () => {
    let s = initial;
    s = transition(s, { type: 'LOGIN_START' });
    expect(s.authState).toBe(STATES.LOGGING);
    s = transition(s, { type: 'LOGIN_OK', payload: { userInfo: {} } });
    expect(s.authState).toBe(STATES.LOGGED);
    s = transition(s, { type: 'PROFILE_START' });
    expect(s.authState).toBe(STATES.PROFILE);
    s = transition(s, { type: 'PROFILE_OK' });
    expect(s.authState).toBe(STATES.PHONE_VERIFYING);
    s = transition(s, { type: 'PHONE_OK', payload: { phoneMasked: '159****1111' } });
    expect(s.authState).toBe(STATES.PHONE_VERIFIED);
    expect(s.phoneMasked).toBe('159****1111');
  });

  it('完整拒绝→重试流程：denied → setting → logged → verified', () => {
    let s = initial;
    s = transition(s, { type: 'LOGIN_START' });
    s = transition(s, { type: 'LOGIN_DENIED' });
    expect(s.authDenied).toBe(true);
    s = transition(s, { type: 'SETTING_GRANTED' });
    expect(s.authDenied).toBe(false);
    s = transition(s, { type: 'LOGIN_OK', payload: { userInfo: {} } });
    s = transition(s, { type: 'PHONE_START' });
    s = transition(s, { type: 'PHONE_DENIED' });
    expect(s.phoneDenied).toBe(true);
    s = transition(s, { type: 'PHONE_START' });
    s = transition(s, { type: 'PHONE_OK', payload: { phoneMasked: '138****1234' } });
    expect(s.authState).toBe(STATES.PHONE_VERIFIED);
  });

  it('纯函数：不修改原状态对象', () => {
    const orig = { authState: STATES.INIT, authDenied: false };
    transition(orig, { type: 'LOGIN_START' });
    expect(orig.authState).toBe(STATES.INIT);
  });

  it('未知事件类型不变更状态', () => {
    const s = transition({ authState: STATES.LOGGED }, { type: 'UNKNOWN' });
    expect(s.authState).toBe(STATES.LOGGED);
  });
});
