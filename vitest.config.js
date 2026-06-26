const { defineConfig } = require('vitest/config');

module.exports = defineConfig({
  test: {
    // 测试文件约定放在 tests/ 下，按模块分子目录
    include: ['tests/**/*.test.js'],
    environment: 'node',
    // 全局注入 describe/it/expect 等，测试文件无需 require('vitest')
    // （vitest 的 CJS 入口不支持 require 导入，故用 globals）
    globals: true
  }
});
