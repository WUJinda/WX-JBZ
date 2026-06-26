/**
 * verify-dist.js —— 部署前自检：cloudfunctions-dist/ 包内相对 require 可解析性
 *
 * 对每个 cloudfunctions-dist/<name>/，遍历包内所有 .js 文件，解析其中的
 * 相对 require（./  ../），用 path.resolve + fs.existsSync 确认每个都能在
 * 包内解析到真实文件（自动尝试 .js / .json / /index.js）。
 *
 * 裸模块包名（wx-server-sdk / crypto 等）跳过——它们由云环境或 npm 提供，
 * 本地无 node_modules 不影响此校验。
 *
 * 任一相对 require 解析失败 -> 打印 <file>:<line> <req> MODULE_NOT_FOUND
 * 并以非零退出。等价于云端装载的可解析性验证（不真 require index，避开
 * wx-server-sdk 缺失）。
 *
 * 用法：node scripts/verify-dist.js
 *
 * 无外部依赖，仅用 Node 内置 fs/path。
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIST_DIR = path.join(ROOT, 'cloudfunctions-dist');

// require 调用正则：捕获 (1)前置 (2)引号1 (3)说明符 (4)引号2 (5)后置
// 说明符分支：相对路径（./  ../ 开头）或裸模块名。我们只关心相对路径。
const REQUIRE_RE = /(require\s*\(\s*)(['"])([^'"]+)(['"])(\s*\))/g;

/** 是否为相对路径说明符（./ 或 ../ 开头，含 ./../ 变体）。 */
function isRelative(spec) {
  return /^\.\.?\//.test(spec);
}

/** 是否为裸模块名（非相对、非绝对）。如 wx-server-sdk / crypto / lodash/get。 */
function isBare(spec) {
  return !isRelative(spec) && !path.isAbsolute(spec);
}

/**
 * 尝试按 Node 规则解析一个相对说明符到真实文件绝对路径。
 * @param {string} fromFile 当前 .js 文件绝对路径
 * @param {string} spec require 的说明符
 * @returns {string|null} 命中文件的绝对路径，未命中返回 null
 */
function resolveRequire(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  // 候选：原样（带后缀）/ 补 .js / 补 .json / 当目录 -> /index.js / /index.json
  const candidates = [
    base,
    base + '.js',
    base + '.json',
    path.join(base, 'index.js'),
    path.join(base, 'index.json')
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    } catch (_) {
      // ignore
    }
  }
  return null;
}

/** 收集目录下所有 .js 文件（绝对路径），递归。 */
function collectJsFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectJsFiles(full));
    } else if (entry.isFile() && path.extname(entry.name) === '.js') {
      out.push(full);
    }
  }
  return out;
}

/** 读取文件并返回每行匹配 require 的 { line, spec } 列表。 */
function extractRequires(absFile) {
  const content = fs.readFileSync(absFile, 'utf8');
  const lines = content.split(/\r?\n/);
  const out = [];
  lines.forEach((line, idx) => {
    let m;
    const re = new RegExp(REQUIRE_RE.source, 'g');
    while ((m = re.exec(line)) !== null) {
      out.push({ line: idx + 1, spec: m[3] });
    }
  });
  return out;
}

function main() {
  if (!fs.existsSync(DIST_DIR)) {
    console.error(`[verify-dist] dist 目录不存在: ${DIST_DIR}`);
    console.error('[verify-dist] 请先运行 `npm run sync:shared`');
    process.exit(2);
  }

  const fnDirs = fs.readdirSync(DIST_DIR, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name)
    .sort();

  if (fnDirs.length === 0) {
    console.error('[verify-dist] dist 目录为空');
    process.exit(2);
  }

  let totalFiles = 0;
  let totalReqs = 0;
  let failures = 0;

  for (const fn of fnDirs) {
    const fnDir = path.join(DIST_DIR, fn);
    const jsFiles = collectJsFiles(fnDir);
    for (const absFile of jsFiles) {
      totalFiles++;
      const reqs = extractRequires(absFile);
      for (const r of reqs) {
        if (isBare(r.spec)) continue; // 裸模块跳过
        if (!isRelative(r.spec)) continue; // 绝对路径不校验（本仓库无）
        totalReqs++;
        const resolved = resolveRequire(absFile, r.spec);
        if (!resolved) {
          const rel = path.relative(ROOT, absFile).split(path.sep).join('/');
          console.error(`${rel}:${r.line} ${r.spec} MODULE_NOT_FOUND`);
          failures++;
        }
      }
    }
  }

  console.log(`[verify-dist] 扫描 ${fnDirs.length} 个包 / ${totalFiles} 个 .js / ${totalReqs} 个相对 require`);
  if (failures > 0) {
    console.error(`[verify-dist] 失败 ${failures} 处`);
    process.exit(1);
  }
  console.log('[verify-dist] 通过：所有相对 require 均可在包内解析');
  process.exit(0);
}

main();
