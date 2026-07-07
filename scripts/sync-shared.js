/**
 * sync-shared.js —— A1 共享层打包脚本（零侵入 dist 目录）
 *
 * 用途：
 *   把 cloudfunctions/ 下的 8 个云函数打包成可独立上传的产物目录
 *   cloudfunctions-dist/<name>/，把跨目录 require（../common/*、
 *   ../steps/stepsSync、../activity/activityStatus、../dept/deptList）
 *   改写为包内 `./_shared/...`，并把共享层按需注入到每个包的 `_shared/`。
 *
 *   源码 cloudfunctions/ 零侵入：所有改写只发生在 cloudfunctions-dist/ 副本里。
 *
 * 用法：
 *   node scripts/sync-shared.js
 *
 * 部署：
 *   上传 cloudfunctions-dist/<name>/（微信开发者工具把 cloudfunctionRoot
 *   临时指向 cloudfunctions-dist，或用 cloudbase CLI deploy）。
 *
 * 无外部依赖，仅用 Node 内置 fs/path。
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'cloudfunctions');
const DIST_DIR = path.join(ROOT, 'cloudfunctions-dist');

// 8 个云函数（common / schema 不是云函数，跳过）
const CLOUD_FUNCTIONS = [
  'auth',
  'user',
  'dept',
  'activity',
  'steps',
  'rank',
  'admin',
  'tasks'
];

// 文件后缀：原样复制的源文件（不含子目录，本仓库云函数目录均无嵌套子目录）
const COPY_EXTS = new Set(['.js', '.json']);

/**
 * 共享层注入 manifest：每个云函数显式声明它（含传递依赖）需要的共享模块。
 * 来源：cloudfunctions/ 下实际 require 的静态扫描结果（见任务简报依赖图 +
 *       grep 复核）。值是相对 cloudfunctions/ 的源文件路径（无后缀即目录文件）。
 *
 * 传递依赖已展开：
 *   - steps/stepsSync 依赖 common/errors + activity/activityStatus
 *   - common/authMiddleware、common/response、common/adminGuard 均依赖 common/errors
 *   故凡引入任一 common 模块的包都要带 common/errors；凡引入 stepsSync 的包
 *   都要带 common/errors + activity/activityStatus。
 *
 *   admin/adminGuard.js 是垫片（re-export ../common/adminGuard），不进 _shared；
 *   真正的实现在 common/adminGuard.js，由 _shared/common/adminGuard 提供。
 */
const SHARED_MANIFEST = {
  auth: [
    'common/errors',
    'common/mask',
    'common/authMiddleware',
    'common/response'
  ],
  user: [
    'common/errors',
    'common/mask',
    'common/authMiddleware',
    'common/response',
    'common/db',
    'activity/activityStatus',
    'activity/activityResolver', // F1 getActiveActivityId/getActiveActivity
    'steps/stepsSync', // 经 user/userStats 引入 -> 带来 activityStatus + common/errors（已在列）
    'dept/deptList'    // user/userJoin 动态 require
  ],
  dept: [
    'common/errors',
    'common/authMiddleware',
    'common/response',
    'common/db'
  ],
  activity: [
    'common/errors',
    'common/authMiddleware',
    'common/response',
    'common/adminGuard',
    'common/db'
    // activity/activityStatus + activity/activityResolver 是包内同目录文件，原样复制即随包带走
  ],
  steps: [
    'common/errors',
    'common/authMiddleware',
    'common/response',
    'common/db',
    'activity/activityStatus',   // steps/stepsSync 传递依赖
    'activity/activityResolver'  // steps/index.js sync handler 查活动文档（修复「累计步数过大」bug：活动期过滤生效）
  ],
  rank: [
    'common/errors',
    'common/authMiddleware',
    'common/response',
    'common/db',
    'activity/activityResolver',
    'activity/activityStatus'
  ],
  admin: [
    'common/errors',
    'common/authMiddleware',
    'common/response',
    'common/adminGuard',
    'common/db',
    'steps/stepsSync',         // 经 admin/dashboard 引入
    'activity/activityStatus', // steps/stepsSync 的传递依赖
    'schema/initIndexes',      // 经 admin.ensureSchema 运维 action 引入
    'schema/collections'       // initIndexes 的同目录依赖
  ],
  tasks: [
    'common/errors',
    'common/mask',
    'common/response',
    'common/db',
    'activity/activityResolver', // F1 getActiveActivityId（resolver 依赖 activityStatus，已在列）
    'steps/stepsSync',           // 经 tasks/rankAggregate + tasks/dailyLock 引入
    'activity/activityStatus'    // steps/stepsSync 的传递依赖
  ]
};

// 额外传递依赖：steps/stepsSync.js 源码里 require('../activity/activityStatus')，
// 注入 stepsSync 副本时必须同时注入 activityStatus，否则 stepsSync 自身装载就失败。
// errors 已由 manifest 显式列出。

/**
 * 递归删除目录（rm -rf 语义）。
 * Windows 上目录可能被进程占用（如微信开发者工具监视 cloudfunctions-dist），
 * rmSync 偶发 EBUSY/EPERM/ENOTEMPTY —— 靠 rmSync 原生 maxRetries + 外层重试等句柄释放。
 * 仍失败则由调用方（main 的逐包清理）兜底为覆盖式重建。
 */
function rmrf(target) {
  if (!fs.existsSync(target)) return;
  const RETRIES = 6;
  const DELAY_MS = 400;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    try {
      fs.rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      return;
    } catch (err) {
      const retryable = err && /^(EBUSY|EPERM|ENOTEMPTY|EMFILE)$/.test(err.code);
      if (!retryable || attempt === RETRIES) throw err;
      const end = Date.now() + DELAY_MS;
      while (Date.now() < end) { /* 同步等待句柄释放 */ }
    }
  }
}

/**
 * 递归复制目录（保留结构）。
 */
function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      copyDir(s, d);
    } else if (entry.isFile()) {
      fs.copyFileSync(s, d);
    }
  }
}

/**
 * 复制单个云函数目录下所有 .js / .json 源文件到 dist（平铺，本仓库无嵌套子目录）。
 */
function copyCloudFunctionFiles(fnName, dstFnDir) {
  const srcFnDir = path.join(SRC_DIR, fnName);
  fs.mkdirSync(dstFnDir, { recursive: true });
  for (const entry of fs.readdirSync(srcFnDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name);
    if (!COPY_EXTS.has(ext)) continue;
    fs.copyFileSync(path.join(srcFnDir, entry.name), path.join(dstFnDir, entry.name));
  }
}

/**
 * 把指定共享模块从 cloudfunctions/<modPath>.(js|json) 复制到
 * dist/<fn>/_shared/<modPath>.(js|json)。模块路径无后缀，自动补 .js。
 */
function injectSharedModule(fnDstDir, modPath) {
  const sharedDir = path.join(fnDstDir, '_shared');
  const srcFileJs = path.join(SRC_DIR, modPath + '.js');
  const srcFileJson = path.join(SRC_DIR, modPath + '.json');
  let srcFile = null;
  let ext = null;
  if (fs.existsSync(srcFileJs)) {
    srcFile = srcFileJs;
    ext = '.js';
  } else if (fs.existsSync(srcFileJson)) {
    srcFile = srcFileJson;
    ext = '.json';
  } else {
    throw new Error(`共享模块源文件不存在: ${modPath} (期望 ${srcFileJs} 或 ${srcFileJson})`);
  }
  const dstFile = path.join(sharedDir, modPath + ext);
  fs.mkdirSync(path.dirname(dstFile), { recursive: true });
  fs.copyFileSync(srcFile, dstFile);
}

/**
 * 改写单个文件内容里的跨目录 require 路径。
 * 规则（仅作用于副本，源码不动）：
 *   形如 require('../<dir>/<mod>') 或 require('./../<dir>/<mod>')
 *   其中 <dir> ∈ {common, steps, activity, dept}（指向其它云函数目录或 common）
 *   → 改写为相对【当前文件】指向 `_shared/<dir>/<mod>` 的正确相对路径。
 *
 * 关键：改写目标依赖当前文件在包内的位置——
 *   - 包根文件（如 index.js、userStats.js）：
 *       ../common/errors  ->  ./_shared/common/errors
 *   - _shared 子目录内文件（如 _shared/steps/stepsSync.js）：
 *       ../common/errors  ->  ../common/errors   （_shared/ 是统一共享根，
 *       _shared/steps/ 下一层即 _shared/，再进 common/ 即 ../common/errors）
 *   - _shared/common 内同目录互引（authMiddleware.js -> ./errors）：
 *       ./errors 保持不变（复制后仍同目录）
 *
 *   裸模块名（wx-server-sdk / crypto / ...）与 ./ 同目录引用一律不动。
 *
 * fileRelPath: 当前文件相对包根（cloudfunctions-dist/<name>/）的相对路径，
 *              用 posix 风格（/）。
 */
function rewriteRequires(content, fileRelPath) {
  // 匹配 require( '...' ) 或 require( "..." )，引号内捕获路径
  const requireRe = /(require\s*\(\s*)(['"])(\.{1,2}\/[^'"]+|[a-zA-Z@][^'"]*)(['"])(\s*\))/g;

  // 哪些"目录前缀"算跨目录共享：common/steps/activity/dept
  const SHARED_DIRS = ['common', 'steps', 'activity', 'dept', 'schema'];

  // 当前文件所在目录相对包根的深度（用于决定回退几层到包根）。
  // 包根文件：dirSegments = []，回退 0 层；
  // _shared/steps/x.js：dirSegments = ['_shared','steps']，回退 2 层到包根。
  const fileDir = posixDirname(fileRelPath);
  const dirSegments = fileDir === '' ? [] : fileDir.split('/');
  const isInShared = dirSegments[0] === '_shared';

  return content.replace(requireRe, (full, head, q1, raw, q2, tail) => {
    // 仅处理 ../ 开头（含 ./../ 变体）。裸模块、./ 同目录引用不改。
    // 直接用正则提取：必须以一个或多个 ../ （允许前置 ./）开头
    const leadMatch = raw.match(/^(?:\.\/)*((?:\.\.\/)+)(.+)$/);
    if (!leadMatch) return full; // 非 ../ 开头 -> 不改
    const upCount = leadMatch[1].match(/\.\.\//g).length;
    const rest = leadMatch[2]; // 去掉所有 ../ 后的剩余
    const firstSeg = rest.split('/')[0];
    if (!SHARED_DIRS.includes(firstSeg)) return full; // 不是共享目录

    // 计算目标相对路径：
    // 目标模块在包内的位置：_shared/<rest>（如 _shared/common/errors）
    // 当前文件目录：dirSegments（如 ['_shared','steps'] 或 []）
    // 用 path.relative 风格计算从当前文件目录到 _shared/<rest> 的相对 posix 路径。
    const targetSegments = ['_shared'].concat(rest.split('/'));
    const rel = posixRelative(dirSegments, targetSegments);
    return head + q1 + rel + q2 + tail;
  });
}

/** 取 posix 风格的 dirname（输入用 / 分隔）。 */
function posixDirname(p) {
  const idx = p.lastIndexOf('/');
  return idx === -1 ? '' : p.substring(0, idx);
}

/**
 * 计算从 fromDir（段数组，相对包根）到 toPath（段数组，相对包根）的相对 posix 路径。
 * 例：
 *   from=[] to=['_shared','common','errors']  -> './_shared/common/errors'
 *   from=['_shared','steps'] to=['_shared','common','errors'] -> '../common/errors'
 *   from=['_shared','common'] to=['_shared','common','errors'] -> './errors'
 */
function posixRelative(fromDir, toPath) {
  // 去掉共同前缀
  let i = 0;
  while (i < fromDir.length && i < toPath.length && fromDir[i] === toPath[i]) i++;
  const up = fromDir.length - i;
  const down = toPath.slice(i);
  const parts = [];
  for (let k = 0; k < up; k++) parts.push('..');
  if (down.length === 0) {
    // 目标就是当前目录的某个祖先目录本身 —— 不会发生在本场景（目标总带文件名段）
    parts.push('.');
    return parts.join('/');
  }
  for (const seg of down) parts.push(seg);
  let result = parts.join('/');
  // 保证以 ./ 或 ../ 开头（Node 相对路径要求显式前缀）
  if (!result.startsWith('.')) result = './' + result;
  return result;
}

/**
 * 处理一个云函数目录：复制源文件、注入共享层、改写 require。
 */
function buildOne(fnName) {
  const dstFnDir = path.join(DIST_DIR, fnName);
  fs.mkdirSync(dstFnDir, { recursive: true });

  // 1) 复制本函数所有源文件
  copyCloudFunctionFiles(fnName, dstFnDir);

  // 2) 注入共享层（manifest 声明，含传递依赖）
  const sharedList = SHARED_MANIFEST[fnName] || [];
  // 去重
  const uniqueShared = Array.from(new Set(sharedList));
  for (const modPath of uniqueShared) {
    injectSharedModule(dstFnDir, modPath);
  }

  // 3) 遍历副本所有 .js 文件，改写 require
  const allJs = collectJsFiles(dstFnDir);
  for (const absPath of allJs) {
    // 统一用 posix 风格（/），rewriteRequires 内部按 / 解析段
    const rel = path.relative(dstFnDir, absPath).split(path.sep).join('/');
    const original = fs.readFileSync(absPath, 'utf8');
    const rewritten = rewriteRequires(original, rel);
    if (rewritten !== original) {
      fs.writeFileSync(absPath, rewritten, 'utf8');
    }
  }
}

/**
 * 递归收集目录下所有 .js 文件（绝对路径）。
 */
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

function main() {
  // 逐包清理 + 构建（不再整体 rmrf DIST_DIR：Windows 下若某包目录被进程占用，
  // 整体 rmrf 会因一个包 EBUSY 而全建失败；逐包清理则只影响被占用的包，
  // 该包由 buildOne 覆盖式重建兜底——mkdir recursive 复用目录 + copyFileSync 覆盖源文件）。
  fs.mkdirSync(DIST_DIR, { recursive: true });

  let count = 0;
  for (const fn of CLOUD_FUNCTIONS) {
    try {
      rmrf(path.join(DIST_DIR, fn));
    } catch (err) {
      console.warn(`[sync-shared] 清理 ${fn} 失败（${(err && err.code) || err.message}），改为覆盖式重建`);
    }
    buildOne(fn);
    count++;
    console.log(`[sync-shared] 打包: ${fn}`);
  }
  console.log(`[sync-shared] 完成，共 ${count} 个云函数 -> ${path.relative(ROOT, DIST_DIR)}/`);
}

main();
