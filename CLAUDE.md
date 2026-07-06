# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概览

**JBZ-app** — 企业单期限时「健步走」活动小程序。原生微信小程序前端 + 微信云开发(CloudBase)后端,无独立服务器、无自管 token。员工经微信授权 + 手机号白名单验证参赛,接入微信运动自动同步步数,按个人/部门排名。

权威需求与设计文档在 `docs/`(任何业务疑问先查这里):
- `docs/PRD-P0-健步走小程序MVP.md` — 功能需求、业务规则、验收标准(F1~F8)
- `docs/技术架构设计.md` — 分层、云函数设计、数据模型、时序流程、安全设计
- `docs/开发计划.md` — 任务拆分

## 常用命令

```bash
npm test                    # 跑全部测试(= npx vitest run)
npx vitest run tests/auth/  # 跑单目录/单文件
npx vitest run -t "用例名"   # 按用例名过滤
npm run sync:shared         # 把 cloudfunctions/ 打包成可上传的 cloudfunctions-dist/(改完云函数必跑)
npm run verify:dist         # 校验 dist 产物完整性(共享层注入 + require 改写)
```

- **测试运行器是 vitest**(见 `package.json`/`vitest.config.js`,`globals: true`)。测试文件无需 `require('vitest')`。**不要用 jest**(本地未装,旧版 jest 的 `expect` 不支持双参数断言,会造成系统性假失败)。
- 无 `lint` / `build` / `install` 脚本。云函数依赖在云环境安装,本地仅 vitest 一个 devDep。
- 部署:上传 `cloudfunctions-dist/<name>/`(微信开发者工具把 `cloudfunctionRoot` 指向 `cloudfunctions-dist`,或用 cloudbase CLI)。**直接改 `cloudfunctions-dist/` 无效**——它是产物,源在 `cloudfunctions/`,下次 `sync:shared` 会覆盖。

## 架构:大局观

### 双轨设计(理解全仓库的钥匙)

业务逻辑统一写成**纯函数 + 注入式 store**,与云 sdk 解耦:

- **本地轨(纯函数)**:`syncSteps({store, ...})`、`aggregateRanking({store, ...})`、`buildDashboard({store, ...})` 等只接收内存里的 `store`(普通对象数组),返回结果或就地改 store 并打 `_dirty` 标记。**单测直接调纯函数**,注入构造好的 store,不经云函数、不连云库。
- **云轨(handler 粘合)**:云函数 `index.js` 的 handler 负责「`loadByWhere` 拉相关集合到 store → 鉴权 → 调纯函数 → `...ToCloud` 写回库 → 返回」。写回函数(`persistStepRecordsToCloud` / `overwriteRankCacheToCloud` / `upsertWhitelistToCloud` …)只存在于 handler,单测不触达。

**改动业务规则时**:改纯函数 + 加/改单测;handler 一般不动。**改动落库/读库方式时**:改 handler 的 `...ToCloud` 函数,纯函数通常不动。

### 云函数调用约定(所有 8 个域统一)

入参 `{action, ...}` → 按 `event.action` 分发到 `handlers` 表 → 统一出参 `{code, message, data}`(`common/response.js` 的 `ok`/`fail`)。错误码见 `common/errors.js`(0 成功 / 1xxx 鉴权 / 2xxx 业务 / 3xxx 步数 / 5xxx 系统),用 `BizError(code, msg)` 抛、`main` 的 `catch` 统一转 `fail`。

8 个业务域:`auth` `user` `dept` `activity` `steps` `rank` `admin` `tasks`。每个域单入口 `index.js` + 每 action 一个同名文件(如 `stepsSync.js`)+ 必要的查询/工具文件。源码在 `cloudfunctions/`,共享层在 `cloudfunctions/common/`(6 个模块:`authMiddleware` / `adminGuard` / `errors` / `response` / `db` / `mask`)。

### 鉴权模型(无 token)

身份**完全信任** `cloud.getWXContext().OPENID`(微信侧注入、不可伪造),**不下发、不校验自管 token**。分层校验在 `common/authMiddleware.js`:
- `authMiddleware({getWXContext})` 同步取 OPENID(纯函数可单测);
- `assertUserExists(db, openid)`、`assertJoined(user)`、`assertAdmin(store, openid)` 在 handler 入口按需显式调用,各自抛对应 `BizError`。
- 入参里的 `user_id` **不可信**(防越权读写他人数据),用户身份一律用 `context.openid`。敏感字段(`_openid`/`sync_count`/`phone`)用 `loadByWhere` 的 field 投影剔除。

### 步数同步主路径(session_key 用后即弃)

`steps.sync`:前端每次带**最新** `wx.login` code + `getWeRunData` 的 encryptedData/iv → 云函数当次 `code2Session` 换新鲜 `session_key` → 立即解密 → **绝不落库、绝不下发**(微信规则下每次 `wx.login` 会让旧 key 失效,长存必然解密失败)。

⚠️ `code2Session` **不走 `cloud.openapi`**(云开发网关实测持续返回 -604100 "API not found"),改走 `https` 直接调 `api.weixin.qq.com/sns/jscode2session`,需在云函数环境变量配 `WX_APPID` + `WX_APP_SECRET`(**绝不入源码**)。见 `cloudfunctions/steps/index.js`。

`StepRecord` 的 `(user_id, activity_id, date)` 唯一性靠「唯一索引 + 应用层 upsert」(先 `where().update`,未命中再 `add`,撞唯一索引冲突再重试 update),**不用事务**(云开发事务内禁批量 API)。

### 排行榜与定时任务

读榜单只读 `RankCache` 中间表(不实时算)。`tasks` 云函数:
- 有 `event.action`(`rankAggregate` / `dailyLock`)→ 手动/测试触发;
- 无 `action` → 视为定时触发器,跑 `runScheduledTasks`(两个任务都幂等,每次都跑)。
- `rankAggregate`:按 activity 聚合 StepRecord → **覆盖写** `RankCache` 单文档(personal/dept 各一)。
- `dailyLock`:锁昨日 StepRecord(`where(date, locked:false).update`,幂等)。锁定时间默认次日 12:00(非 00:00),给上午补同步窗口。
- 排行榜同分按 `first_reach_at` 升序(更早达成者列前),定义见技术架构 §6.3。

### 前端

`miniprogram/`:员工端页(`activity`/`login`/`dept`/`home`/`rank`/`profile`)+ 内置后台(`pages/admin/*`,靠 `is_admin` 路由守卫)。`app.js` 在 `onLaunch` 初始化云开发并挂 `this.api = createApi(wx.cloud, hooks)`。
- `utils/request.js`:`createApi` 把 `wx.cloud.callFunction` Promise 化,统一 loading / 错误提示;返回 `result.data`,`code!==0` 转 reject。
- `utils/auth-guard.js` / `authGuard.js`:页面路由守卫(未登录跳 login、非 admin 拦 admin 页)。
- 云环境 id 在 `app.js` 的 `cloudEnvId`(占位时不挂 api,保留本地轨兜底)。

## 数据模型(云数据库,文档型)

`User`(`_openid` 唯一、`phone` 唯一)· `Department` · `Whitelist`(`phone` 唯一)· `Activity` · `StepRecord`(`user_id+activity_id+date` 唯一,`locked`/`abnormal`/`synced_at`)· `RankCache`(`type`∈personal/dept,聚合产物)。完整字段见技术架构 §5。索引由 `cloudfunctions/schema/initIndexes.js` 创建,可通过 `admin.ensureSchema` action 一键建(幂等)。

## 关键约定与陷阱

- **改云函数后必须 `npm run sync:shared` 再部署**,否则 `cloudfunctions-dist/` 过期。改 `cloudfunctions/common/`(共享层)尤其如此——它被注入到多个包。
- **`sync:shared` 的依赖图是手写 manifest**(`scripts/sync-shared.js` 的 `SHARED_MANIFEST`,含传递依赖)。新增「云函数 A 引入了新的跨目录 require」时,必须同步更新该 manifest,否则 dist 里缺包、运行时 `Cannot find module`。
- **写库失败必须上抛**(P1-3 约定):`...ToCloud` 函数收集失败计数/抛 `BizError(SYS_DB_ERROR)`,不静默 `console.warn` 吞掉,否则前端假成功。
- **裁定时不要写 `synced_at`**(`applyVerdictToCloud` 已修):它是同步时间,`rankAggregate` 的 `first_reach_at` 同分排序依赖它;裁定时间走独立的 `verdict_at`。
- **云数据库集合不会自动创建**,查询不存在集合报 -502005;新环境先调 `admin.ensureSchema`。
- 单测构造 store 时注意纯函数的 `_dirty`/`_isNew` 标记约定(写回库依赖它判断 upsert vs update)。

<!-- gitnexus:start -->
# GitNexus MCP

This project is indexed by GitNexus as **JBZ-app** (1114 symbols, 2938 relationships, 76 execution flows).

## Always Start Here

1. **Read `gitnexus://repo/{name}/context`** — codebase overview + check index freshness
2. **Match your task to a skill below** and **read that skill file**
3. **Follow the skill's workflow and checklist**

> If step 1 warns the index is stale, run `npx gitnexus analyze` in the terminal first.

## Skills

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
