/**
 * 后台活动配置页前端纯函数（对齐 PRD F8 R8.1，开发计划阶段 H2）。
 *
 * 把表单校验、发布态文案抽成纯函数，便于在 Node 下单测，不耦合 wx 运行时。
 *
 * 校验规则（R8.1：活动创建后即可发布）：
 *   - name 必填（非空字符串）。
 *   - start_time / end_time 必填，且 start_time < end_time（起止不可倒序）。
 *   - 时间格式合法（YYYY-MM-DD 或 YYYY-MM-DD HH:mm，可被 Date.parse 解析）。
 *   - signup_deadline 可选；留空 = 活动结束前都可报名；填了须合法且 ≤ end_time。
 *
 * 发布态文案：publish=true → '已发布'，否则 → '未发布'（草稿）。
 */

/** 时间格式校验：能被 Date.parse 解析为有效时间戳即合法。 */
function isValidTime(t) {
  if (t === null || t === undefined || t === '') return false;
  if (typeof t !== 'string' && typeof t !== 'number') return false;
  const ts = Date.parse(t);
  return Number.isFinite(ts);
}

/**
 * 活动表单校验（R8.1）。
 * @param {object} form { name, start_time, end_time, signup_deadline?, rules, publish }
 * @returns {{valid:boolean, errors:{name?:string, startEnd?:string, startTime?:string, endTime?:string, signup_deadline?:string}}}
 */
function validateActivityForm(form) {
  const f = form || {};
  const errors = {};

  // name 必填
  const name = typeof f.name === 'string' ? f.name.trim() : '';
  if (!name) {
    errors.name = '活动名称不能为空';
  }

  // 起止时间必填 + 格式合法 + 不可倒序
  const startOk = isValidTime(f.start_time);
  const endOk = isValidTime(f.end_time);
  if (!startOk && !endOk) {
    errors.startEnd = '请填写起止时间';
  } else if (!startOk) {
    errors.startTime = '开始时间格式不合法';
  } else if (!endOk) {
    errors.endTime = '结束时间格式不合法';
  } else if (Date.parse(f.end_time) <= Date.parse(f.start_time)) {
    errors.startEnd = '结束时间必须晚于开始时间';
  }

  // 报名截止（可选）：留空 = 活动结束前都可报名；填了须合法且 ≤ end_time
  const hasSignup = f.signup_deadline !== undefined && f.signup_deadline !== null && f.signup_deadline !== '';
  if (hasSignup) {
    if (!isValidTime(f.signup_deadline)) {
      errors.signup_deadline = '报名截止格式不合法';
    } else if (endOk && Date.parse(f.signup_deadline) > Date.parse(f.end_time)) {
      errors.signup_deadline = '报名截止不得晚于结束时间';
    }
  }

  return { valid: Object.keys(errors).length === 0, errors };
}

/**
 * 格式化发布态文案（R8.1：发布前用户端看不到活动）。
 * @param {*} publish
 * @returns {string} '已发布' | '未发布'
 */
function formatPublishState(publish) {
  return publish === true || publish === 'true' ? '已发布' : '未发布';
}

/**
 * picker 纯日期串（YYYY-MM-DD）→ 后端带时区 ISO 串（修时区 bug E1）。
 * 纯日期串 Date.parse 按 UTC 解析，会导致活动在北京时间结束日早 8 点就翻 ENDED：
 *   end_time='2026-07-21' → Date.parse 按 UTC 00:00 = 北京 08:00，cur>end 在结束日早 8 点即成立
 *   → 同步被提前截断 / 排名提前冻结。补 +08:00 后前后端 Date.parse 均按北京时间正确翻转。
 * @param {string} dateStr YYYY-MM-DD（picker 产出）
 * @param {boolean} endOfDay true=当日 23:59:59（end_time/signup_deadline 截止），false=当日 00:00:00（start_time）
 * @returns {string} 形如 '2026-07-21T23:59:59+08:00'；空入参返回 ''
 */
function toDateTime(dateStr, endOfDay) {
  if (!dateStr) return '';
  return endOfDay ? dateStr + 'T23:59:59+08:00' : dateStr + 'T00:00:00+08:00';
}

module.exports = { validateActivityForm, formatPublishState, isValidTime, toDateTime };
