/**
 * 后台活动配置页前端纯函数（对齐 PRD F8 R8.1，开发计划阶段 H2）。
 *
 * 把表单校验、发布态文案抽成纯函数，便于在 Node 下单测，不耦合 wx 运行时。
 *
 * 校验规则（R8.1：活动创建后即可发布）：
 *   - name 必填（非空字符串）。
 *   - start_time / end_time 必填，且 start_time < end_time（起止不可倒序）。
 *   - 时间格式合法（YYYY-MM-DD 或 YYYY-MM-DD HH:mm，可被 Date.parse 解析）。
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
 * @param {object} form { name, start_time, end_time, cover_url, rules, publish }
 * @returns {{valid:boolean, errors:{name?:string, startEnd?:string, startTime?:string, endTime?:string}}}
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

module.exports = { validateActivityForm, formatPublishState, isValidTime };
