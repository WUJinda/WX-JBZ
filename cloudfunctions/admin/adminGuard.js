/**
 * admin.assertAdmin 守卫（re-export 自 common/adminGuard）。
 *
 * 实现（assertAdmin）已提取到 cloudfunctions/common/adminGuard.js，供多云函数
 * （admin / activity）共享。此文件保留为「一行 re-export」：
 *   - 保持 admin/index.js 与 tests/admin/adminGuard.test.js 的既有 require 路径不变；
 *   - 跨云函数 require common 是既有范式（admin/tasks 已如此）。
 *
 * 真相源 / 实现注释见 cloudfunctions/common/adminGuard.js。
 */
module.exports = require('../common/adminGuard');
