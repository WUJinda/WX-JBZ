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

/**
 * 判定距上次成功同步是否仍在「写后读一致性窗口」内。
 *
 * loadStats 据此决定是否保留 sync 写入的即时 today/total——云库「写后立即查」存在最终一致性延迟，
 * 窗口内 user.stats 二次查库可能命中写入前旧快照，此时覆盖会表现为「同步成功 → 切 tab 回主页步数回退」。
 * 与 loadStats 的 keepSyncedSteps（sync 后立即那次调用置 true）互补：覆盖用户主动切走再切回主页
 * 触发的 loadStats（那次 keepSyncedSteps=false，若无窗口保护会用旧快照覆盖刚同步的新值）。
 *
 * @param {number} lastSyncTs 上次成功同步时间戳（ms，0=未同步）
 * @param {number} nowTs 当前时间戳（ms）
 * @param {number} freshMs 窗口（ms，默认 2 分钟——覆盖云库写后读最终一致性窗口）
 * @returns {boolean} true=仍在窗口内，loadStats 应保留 sync 即时值不覆盖
 */
function isSyncFresh(lastSyncTs, nowTs, freshMs) {
  const last = Number(lastSyncTs) || 0;
  const now = Number(nowTs) || 0;
  const ms = Number.isFinite(freshMs) ? freshMs : 2 * 60 * 1000;
  return last > 0 && now > 0 && now - last < ms;
}

/**
 * 判定微信运动（scope.werun）授权三态（对齐 wx.getSetting 返回的 authSetting）。
 *
 * 官方授权流程要求调 getWeRunData 前先 getSetting 查 scope.werun，据状态分流：
 *   - granted      已授权 → 直接 getWeRunData，不弹任何窗（已授权用户点同步不再被打扰）
 *   - undetermined 从未询问（authSetting 无此 key）→ getWeRunData 首次调用自动弹授权窗
 *   - denied       曾拒绝 → getWeRunData 会静默 fail，须 openSetting 引导重新授权
 *
 * 背景：此前 callWeRunData 直接盲调 getWeRunData，fail 回调不读 errMsg 一律当「拒绝授权」，
 *   导致已授权用户因隐私协议/网络等非授权原因 fail 时，被误判并反复引导去设置页「开通授权」
 *   （设置里本就开着 → 死循环）。先 getSetting 预检 + 三态分流可消除该误判。
 *
 * @param {object} authSetting wx.getSetting 返回的 res.authSetting（可能为空/缺 key）
 * @returns {'granted'|'denied'|'undetermined'}
 */
function classifyWerunAuth(authSetting) {
  const v = authSetting && authSetting['scope.werun'];
  if (v === true) return 'granted';
  if (v === false) return 'denied';
  return 'undetermined';
}

module.exports = { STATES, transition, shouldThrottle, isSyncFresh, classifyWerunAuth };
