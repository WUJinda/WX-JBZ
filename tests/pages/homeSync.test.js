/**
 * 步数同步授权状态机纯函数单测（E4）。
 */
const { STATES, transition, shouldThrottle } = require('../../miniprogram/pages/home/homeSync');

describe('homeSync 授权状态机 transition', () => {
  it('SYNC_START → authing', () => {
    const s = transition({ syncState: STATES.IDLE }, { type: 'SYNC_START' });
    expect(s.syncState).toBe(STATES.AUTHING);
    expect(s.errorMsg).toBe('');
  });

  it('WERUN_OK → syncing（携带 encryptedData/iv）', () => {
    const s = transition(
      { syncState: STATES.AUTHING },
      { type: 'WERUN_OK', payload: { encryptedData: 'enc', iv: 'iv==' } }
    );
    expect(s.syncState).toBe(STATES.SYNCING);
    expect(s.encryptedData).toBe('enc');
    expect(s.iv).toBe('iv==');
  });

  it('WERUN_DENIED → authDenied（提示需授权）', () => {
    const s = transition({ syncState: STATES.AUTHING }, { type: 'WERUN_DENIED' });
    expect(s.syncState).toBe(STATES.AUTH_DENIED);
    expect(s.errorMsg).toContain('授权');
  });

  it('SETTING_GRANTED → authing（重新走授权流程）', () => {
    const s = transition({ syncState: STATES.AUTH_DENIED }, { type: 'SETTING_GRANTED' });
    expect(s.syncState).toBe(STATES.AUTHING);
    expect(s.errorMsg).toBe('');
  });

  it('CLOUD_OK → done（记录今日/累计/最近同步时间）', () => {
    const s = transition(
      { syncState: STATES.SYNCING },
      { type: 'CLOUD_OK', payload: { todaySteps: 9000, totalSteps: 50000, nowTs: 1000 } }
    );
    expect(s.syncState).toBe(STATES.DONE);
    expect(s.todaySteps).toBe(9000);
    expect(s.totalSteps).toBe(50000);
    expect(s.lastSyncTs).toBe(1000);
  });

  it('CLOUD_RATE_LIMIT → rateLimited（频控提示）', () => {
    const s = transition({ syncState: STATES.SYNCING }, { type: 'CLOUD_RATE_LIMIT' });
    expect(s.syncState).toBe(STATES.RATE_LIMITED);
    expect(s.errorMsg).toContain('上限');
  });

  it('CLOUD_FAIL → failed（携带错误信息）', () => {
    const s = transition(
      { syncState: STATES.SYNCING },
      { type: 'CLOUD_FAIL', payload: { message: '解密失败' } }
    );
    expect(s.syncState).toBe(STATES.FAILED);
    expect(s.errorMsg).toBe('解密失败');
  });

  it('RESET → idle', () => {
    const s = transition({ syncState: STATES.FAILED, errorMsg: 'x' }, { type: 'RESET' });
    expect(s.syncState).toBe(STATES.IDLE);
    expect(s.errorMsg).toBe('');
  });

  it('不修改入参（纯函数）', () => {
    const input = { syncState: STATES.IDLE };
    transition(input, { type: 'SYNC_START' });
    expect(input.syncState).toBe(STATES.IDLE);
  });
});

describe('homeSync shouldThrottle 频控前端节流（R3.3）', () => {
  it('距上次 < 30min → true（读缓存）', () => {
    expect(shouldThrottle(1000000, 1000000 + 10 * 60 * 1000, 30)).toBe(true);
  });

  it('距上次 ≥ 30min → false（可同步）', () => {
    expect(shouldThrottle(1000000, 1000000 + 30 * 60 * 1000, 30)).toBe(false);
  });

  it('无上次同步记录 → false', () => {
    expect(shouldThrottle(0, Date.now(), 30)).toBe(false);
  });

  it('阈值可配置', () => {
    // 5 分钟间隔，阈值 10 分钟 → true
    expect(shouldThrottle(1000000, 1000000 + 5 * 60 * 1000, 10)).toBe(true);
    // 5 分钟间隔，阈值 3 分钟 → false
    expect(shouldThrottle(1000000, 1000000 + 5 * 60 * 1000, 3)).toBe(false);
  });
});
