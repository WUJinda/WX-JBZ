/**
 * 步数同步授权状态机纯函数（对齐开发计划 E4，PRD F3 R3.1）。
 *
 * 把同步页面的状态流转逻辑抽出成纯函数，便于在 Node 下单测，
 * 不耦合 wx 运行时。页面 Page() 内部按这些转移驱动 data.syncState。
 *
 * 状态：
 *   idle          初始（未同步 / 空闲）
 *   authing       授权微信运动数据中（wx.getWeRunData）
 *   syncing       云端同步中（callFunction steps.sync）
 *   done          同步成功
 *   authDenied    getWeRunData 被拒（需 openSetting 重授权）
 *   failed        同步失败（非授权类，可重试）
 *   rateLimited   频控超限（R3.3，提示稍后再试）
 *
 * 外部事件：
 *   SYNC_START     开始同步（触发 getWeRunData）
 *   WERUN_OK       wx.getWeRunData 成功（携带 encryptedData/iv）
 *   WERUN_DENIED   wx.getWeRunData 被拒
 *   SETTING_GRANTED openSetting 后用户授予微信运动权限
 *   CLOUD_OK       steps.sync 成功（携带 today/total）
 *   CLOUD_RATE_LIMIT steps.sync 频控超限（3003）
 *   CLOUD_FAIL     steps.sync 其它失败
 *   RESET          回到 idle（重试入口）
 */

const STATES = {
  IDLE: 'idle',
  AUTHING: 'authing',
  SYNCING: 'syncing',
  DONE: 'done',
  AUTH_DENIED: 'authDenied',
  FAILED: 'failed',
  RATE_LIMITED: 'rateLimited'
};

/**
 * 频控缓存判定（R3.3）：距上次同步 < minIntervalMinutes 则读缓存不重复请求。
 * @param {number} lastSyncTs 上次同步时间戳（ms，0 表示无）
 * @param {number} nowTs 当前时间戳（ms）
 * @param {number} minIntervalMinutes 最小间隔（分钟，默认 30）
 * @returns {boolean} true 表示需要节流（读缓存，不重复同步）
 */
function shouldThrottle(lastSyncTs, nowTs, minIntervalMinutes) {
  const last = Number(lastSyncTs) || 0;
  const now = Number(nowTs) || 0;
  const min = Number(minIntervalMinutes);
  const intervalMs = (Number.isFinite(min) ? min : 30) * 60 * 1000;
  if (last <= 0 || now <= 0) return false;
  return now - last < intervalMs;
}

/**
 * 状态转移：返回新的状态对象（含 syncState + 相关派生字段）。
 * 纯函数：不修改入参。
 *
 * @param {object} state 当前状态快照 { syncState, ... }
 * @param {{type:string, [payload]:object}} event
 * @returns {object} 新状态
 */
function transition(state, event) {
  const s = Object.assign({}, state || {});
  const e = event || {};

  switch (e.type) {
    case 'SYNC_START':
      s.syncState = STATES.AUTHING;
      s.errorMsg = '';
      break;
    case 'WERUN_OK':
      s.syncState = STATES.SYNCING;
      if (e.payload) {
        s.encryptedData = e.payload.encryptedData || '';
        s.iv = e.payload.iv || '';
      }
      break;
    case 'WERUN_DENIED':
      s.syncState = STATES.AUTH_DENIED;
      s.errorMsg = '需授权微信运动才能参与排名';
      break;
    case 'SETTING_GRANTED':
      // openSetting 授予后重新进入授权流程
      s.syncState = STATES.AUTHING;
      s.errorMsg = '';
      break;
    case 'CLOUD_OK':
      s.syncState = STATES.DONE;
      s.errorMsg = '';
      if (e.payload) {
        s.todaySteps = e.payload.todaySteps;
        s.totalSteps = e.payload.totalSteps;
        s.lastSyncTs = e.payload.nowTs || Date.now();
      }
      break;
    case 'CLOUD_RATE_LIMIT':
      s.syncState = STATES.RATE_LIMITED;
      s.errorMsg = '今日同步次数已达上限，请稍后再试';
      break;
    case 'CLOUD_FAIL':
      s.syncState = STATES.FAILED;
      s.errorMsg = (e.payload && e.payload.message) || '同步失败，请重试';
      break;
    case 'RESET':
      s.syncState = STATES.IDLE;
      s.errorMsg = '';
      break;
    default:
      break;
  }
  return s;
}

module.exports = { STATES, transition, shouldThrottle };
