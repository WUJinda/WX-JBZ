/**
 * 统一错误码常量（对齐技术架构 §12）
 * 0      成功
 * 1xxx   鉴权类（openid 无对应用户、非管理员、报名状态不符）
 * 2xxx   业务类（邀请码、活动未开始/已结束、部门不存在）
 * 3xxx   步数类（授权失败、解密失败、超同步次数、活动已终止禁止同步）
 * 5xxx   系统类（数据库/外部接口异常）
 */
const CODE = {
  OK: 0,

  // 鉴权类 1xxx
  AUTH_NO_OPENID: 1001,        // 取不到 openid
  AUTH_USER_NOT_FOUND: 1002,   // openid 无对应用户
  AUTH_NOT_ADMIN: 1003,        // 非管理员
  AUTH_JOIN_STATUS_DENIED: 1004, // 报名状态不符

  // 业务类 2xxx
  BIZ_ACTIVITY_NOT_STARTED: 2002,
  BIZ_ACTIVITY_ENDED: 2003,
  BIZ_DEPT_NOT_FOUND: 2004,
  BIZ_PARAM_MISSING: 2005,   // 缺少必要参数
  BIZ_SELF_DEMOTE_FORBIDDEN: 2006, // 禁止自我降级（管理员不能取消自己的管理员身份）
  BIZ_SIGNUP_ENDED: 2008,          // 报名已截止（超过活动 signup_deadline / end_time）
  BIZ_DEPT_LOCKED: 2009,           // 部门已选定不可换（注册向导选部门后固定，调整需联系管理员）
  BIZ_ACTIVITY_NOT_REMOVABLE: 2010, // 活动进行中/未开始，不可删除（仅已结束 ended 或已终止 terminated 可删）
  BIZ_INVITE_CODE_INVALID: 2011,   // 邀请码不存在或格式错误
  BIZ_INVITE_CODE_USED: 2012,      // 邀请码已被使用（一人一码，用即失效）
  BIZ_INVITE_CODE_DISABLED: 2013,  // 邀请码已被管理员禁用

  // 步数类 3xxx
  STEP_AUTH_FAILED: 3001,      // getWeRunData 授权失败
  STEP_DECRYPT_FAILED: 3002,   // 解密失败
  STEP_SYNC_LIMIT: 3003,       // 超同步次数
  STEP_ACTIVITY_CLOSED: 3004,  // 活动已终止禁止同步（2026-10-26 起：到期后仍可补同步活动期内步数，仅终止后拒绝）

  // 系统类 5xxx
  SYS_DB_ERROR: 5001,
  SYS_EXTERNAL_ERROR: 5002,
  SYS_NOT_IMPLEMENTED: 5003,
  SYS_CONFLICT: 5004 // 写冲突（唯一索引冲突，upsert 重试用）
};

/**
 * 业务错误对象。
 * @param {number} code 错误码
 * @param {string} message 错误信息
 * @param {*} [data] 可选附加数据
 */
function BizError(code, message, data) {
  const err = new Error(message || 'biz error');
  err.name = 'BizError';
  err.code = code;
  if (data !== undefined) err.data = data;
  return err;
}

/**
 * 根据错误码构造「未实现」错误，供骨架阶段占位 action 使用。
 * @param {string} [action]
 */
function notImplemented(action) {
  return BizError(
    CODE.SYS_NOT_IMPLEMENTED,
    'not implemented' + (action ? ': ' + action : '')
  );
}

module.exports = { CODE, BizError, notImplemented };
