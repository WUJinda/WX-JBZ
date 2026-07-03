/**
 * dept 云函数入口：部门（对齐技术架构 §4.1）。
 * Action: list
 */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const { authMiddleware } = require('../common/authMiddleware');
const { ok, fail } = require('../common/response');
const { CODE, notImplemented } = require('../common/errors');
const { listDepartments } = require('./deptList');
const { loadByWhere } = require('../common/db');

const handlers = {
  // D1: 部门列表（员工可见，member_count 展示用）。
  // 本地轨：listDepartments 走 mock；真实云读留云轨联调，member_count 真实聚合留阶段 G。
  // 注：dept.list 不强制 requireUser（部门列表对已登录员工可见，白名单已在登录阶段校验），
  //    但仍走 authMiddleware 取 OPENID 以确保身份来源可信（与 activity.current 游客通道区分）。
  list: async (event, context) => {
    // 云轨：读真实 Department 集合（管理员经 admin.deptManage 预设）。
    // listDepartments 纯函数在 source 缺省时走本地 mock（供本地轨/单测），
    // 此处显式注入真实集合，员工方能看到管理员维护的真实部门（修复硬伤：原直接走 mock）。
    // P0-5：Department 通常少量，全量拉取（无敏感字段）。
    const departments = await loadByWhere(cloud, 'Department');

    // 实时聚合「已报名人数」（PRD F2）：count User where dept_id=X && join_status='joined'，
    // 作为 counts 注入 listDepartments 覆盖 member_count。
    // 修复硬伤：Department.member_count 仅 createDept 时初始化 0、此后无任何更新 → 恒 0；
    // 实时聚合保证报名/换部门后立即反映，不依赖定时任务、不计数漂移。
    // TODO 云轨优化：改 db.collection('User').aggregate().group({dept_id, $sum:1}) DB 端聚合，
    //   避免全量拉 User（含 _openid/phone）入内存；当前全量+内存聚合与 rank/admin 范式一致，MVP 量小可接受。
    // P0-5：User 投影掉 phone/_openid（聚合 member_count 只用 dept_id + join_status）。
    const users = await loadByWhere(cloud, 'User', {}, { _id: 1, dept_id: 1, join_status: 1 });
    const counts = {};
    (Array.isArray(users) ? users : []).forEach((u) => {
      if (u && u.join_status === 'joined' && u.dept_id) {
        counts[u.dept_id] = (counts[u.dept_id] || 0) + 1;
      }
    });
    return listDepartments({ source: departments, counts });
  }
};

// loadCollection 已统一迁移至 common/db.js 的 loadByWhere（P0-5）；Department 全量、
// User 投影聚合字段（dept_id + join_status），避免 phone/_openid 入内存。

exports.main = async (event) => {
  const action = event && event.action;
  try {
    const handler = handlers[action];
    if (typeof handler !== 'function') {
      const err = notImplemented(action ? 'dept.' + action : 'dept.<empty>');
      return fail(err.code, err.message);
    }
    const context = authMiddleware({ getWXContext: cloud.getWXContext });
    const data = await handler(event, context);
    return ok(data);
  } catch (err) {
    if (err && typeof err.code === 'number') {
      return fail(err.code, err.message);
    }
    return fail(CODE.SYS_DB_ERROR, (err && err.message) || 'dept error');
  }
};

module.exports = exports;
