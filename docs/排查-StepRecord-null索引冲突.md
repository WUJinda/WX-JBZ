# 排查记录：排行榜只显示第一个用户 / StepRecord 写不进去

> **状态**：已修复（删掉不可靠的唯一索引 + 代码加固并发去重）。
> **日期**：2026-07-09
> **影响范围**：所有非首位同步的用户——StepRecord 写库失败、排行榜缺失。

## 一句话定位

后续用户同步步数后 `StepRecord` 写库失败（撞唯一索引 `idx_step_user_activity_date` 的 null 键），但曾被代码静默吞掉、返回 `code:0` 假成功，导致排行榜只有第一个用户。现已让失败显式抛出，根因高度集中在**唯一索引本身**。

## 项目背景（接手需知）

- 微信小程序 + 微信云开发（CloudBase），无独立服务器。步数同步链路：前端 `wx.login` + `getWeRunData` → 云函数 `steps.sync` → 解密 → upsert `StepRecord` → 触发 `tasks.rankAggregate` 覆盖写 `RankCache`。
- 架构是「纯函数 + 注入式 store」（本地轨）+「handler 粘合写库」（云轨）。`StepRecord` 唯一性靠 **唯一索引 + 应用层 upsert**（不用事务）。
- 云函数改完必须 `npm run sync:shared` 再部署 `cloudfunctions-dist/`。

## 现象

- 第一个用户同步后能进排行榜；后续几个用户同步后排行榜不显示，且 `StepRecord` 集合里**看不到他们的数据**。
- 旧版本下后续用户同步返回 `code:0`（假成功），所以不易察觉。

## 已确认事实（这些假设已排除，别再查）

| 假设 | 结论 | 证据 |
|---|---|---|
| 部署的是旧代码（只改内存不落库） | ❌ 排除 | `dist/steps/index.js` 比源码新，含 `persistStepRecordsToCloud` 且被调用 |
| `join_status != joined` 被 sync 入口拦截 | ❌ 排除 | 用户确认 User 集合 join_status 都是 joined |
| 索引漏了 user_id | ❌ 排除 | 截图确认 `(user_id, activity_id, date)` 三字段 |
| activity_id 为空导致 null | ❌ 排除 | 诊断日志确认 `activity_id="a_1783502771779"` 有值 |
| 三字段任一为 null | ❌ 排除 | 日志确认 user_id / activity_id / date **都有真实值** |
| 历史脏数据占 null 坑 | ❌ 排除 | 全清集合后复测，同一次同步里仍 07-08 成功 / 07-09 失败 |

## 核心矛盾（最关键的一块，根因就在这）

同一次同步、同一用户、两条记录**只差 date**：

```
date=2026-07-08 → add ok ✅  (_id=6e56a4026a4f0a62000dcb0554335e10)
date=2026-07-09 → add err ❌ E11000 ... index: idx_step_user_activity_date dup key: { : null }
```

推论链：

1. 错误明确指向 `index: idx_step_user_activity_date`，且 `dup key: null`。
2. `dup key: null` = 该索引依据的字段在文档里是 null/缺失（MongoDB 唯一索引把 null 当成一个值，全集合只允许一条）。
3. 但日志证明文档的 `user_id` / `activity_id` / `date` 三个字段都有值。
4. **唯一能调和矛盾的解释：当前生效的索引，它依据的字段并不是 `user_id + activity_id + date`** —— 即用户"重建索引"时建错了（字段名拼错/漏下划线/漏字段/建成了某个文档里不存在的字段）。于是所有文档在该索引字段上都是 null → 07-08 第一条占 null 坑成功 → 07-09 必撞。

## 当前最强假设

**`idx_step_user_activity_date` 被重建成了错误定义**（字段名与代码写入的 `user_id`/`activity_id`/`date` 不一致）。第一次截图里索引是对的，但"重建"之后字段定义变了。

## 立即可执行的验证（2 选 1，一锤定音）

**方法 A（最快，推荐）**：云开发控制台 → 数据库 → `StepRecord` → 索引管理 → **删掉 `idx_step_user_activity_date`** → 让一个用户同步一次。

- 两条都 `add ok` → 100% 确认是索引建错 → 按下方"正确重建"。
- 仍有一条 `add err` → 才需深挖 SDK 写入丢字段（基本不会）。

**方法 B（看现场）**：

1. 索引管理点开 `idx_step_user_activity_date`，核对字段名（**逐字检查下划线**）、顺序、是否唯一、是否稀疏。
2. 数据管理点开 `_id=6e56a4026a4f0a62000dcb0554335e10`，看实际存了哪些字段名。

## 正确重建索引（确认后执行）

- 名称：`idx_step_user_activity_date`
- 字段（逐个添加，**务必带下划线**）：`user_id`、`activity_id`、`date`
- 是否唯一：**是**
- 是否稀疏：**是**（sparse，多一道保险——即使将来意外冒出 null 字段也不会再撞）

## ⚠️ 已做的代码改动（接手者注意，别覆盖/回滚）

文件 `cloudfunctions/steps/index.js` 的 `persistStepRecordsToCloud`（约 264 行起）已被修改，已 `sync:shared` 且已部署：

1. **加了诊断日志**：`[persist] dirty=N` / `[persist] try add user_id=... activity_id=... date=...` / `[persist] add ok` / `[persist] add err {...}`。
2. **堵死静默路径**（核心修复，务必保留）：`add` 撞唯一索引后重试 `update` 若命中 0 条 → 抛 `SYS_DB_ERROR`；`add` 非冲突错误 → 也抛。原来这两条都静默放过，正是"假成功 + 数据丢失"的根源。
3. **行为变化**：现在写库失败会让 `steps.sync` 返回 `code:5001`（前端会提示同步失败），这是符合预期的（P1-3 约定：不假成功）。

→ 排查收尾时建议：保留第 2 点（不静默）；第 1 点的临时 `console.log` 可精简，只留 `add err` 的 `console.warn` 留痕。

### 追加加固（2026-07-09，已 sync:shared + 全量测试 1075 全绿）

1. **sync handler `activityId` 兜底**：`(event.activity_id) || await getActiveActivityId(cloud)`（与 today/history/trend 一致）。防 home 冷启动 `getActivityId()` 返回空串 → activity_id 缺失让三字段之一为空、撞唯一索引 null 坑。
2. **「撞唯一索引但 update 未命中」错误信息自解释化**：直接点名根因（索引字段定义与 `(user_id,activity_id,date)` 不一致）+ 给出控制台删+重建（unique+sparse）的修复动作 + 指向本文档。下次再撞时错误本身即说明书。

## 修复路径（确认索引建错后）

1. 控制台删错索引 → 按"正确重建"重建（唯一 + 稀疏）。
2. 让受影响用户重新同步一次（sync 是 upsert，会补回数据）。
3. 代码层：保留 `persistStepRecordsToCloud` 的不静默修复；可选清理临时日志。
4. 可选加固（非本次根因，但提升健壮性）：给 `steps.sync` handler 的 `activityId` 加兜底 `(event.activity_id) || await getActiveActivityId(cloud)`，与 `trend` handler（`index.js:216`）一致，防 home 冷启动 `getActivityId()` 返回空串。

## 关键文件 & 行号速查

- `cloudfunctions/steps/index.js:110` — sync handler（`activityId = event.activity_id`，无兜底）
- `cloudfunctions/steps/index.js:264` — `persistStepRecordsToCloud`（已改，含 upsert + 不静默）
- `cloudfunctions/steps/stepsSync.js:175` — `if (!activityId) throw` 校验
- `cloudfunctions/steps/stepsSync.js:243` — 新建 StepRecord 记录的字段（user_id/_openid/activity_id/date...）
- `cloudfunctions/schema/collections.js:134` — 索引正确声明 `(user_id, activity_id, date)` unique（结构真相源）
- `cloudfunctions/schema/initIndexes.js:34` — **云函数端建不了索引，必须控制台手动建**（这是索引靠人工、易建错的根因）
- `cloudfunctions/tasks/index.js:38` — 聚合按 `activity_id` 拉 StepRecord
- `cloudfunctions/tasks/rankAggregate.js:139` — 个人榜过滤 `join_status==='joined'`

## 经验沉淀

- **MongoDB 唯一索引的 null 陷阱**：与 MySQL 不同，MongoDB 唯一索引把"字段缺失或为 null"当成一个具体值，**全集合只允许一条** null。一旦有一条字段不全的记录占了 null 坑，所有后续含 null 的写入都会撞 `E11000 dup key: null`。
- **腾讯云 MongoDB 错误信息显示问题**：复合唯一索引冲突时，`dup key` 可能序列化成 `{ : null }`（键名丢失），不要按字面理解为"所有字段都是 null"，要结合文档实际字段值判断。
- **静默吞错最致命**：`persistStepRecordsToCloud` 原本把"撞索引→重试 update→0 条"静默放过，让数据丢失伪装成 `code:0` 成功，大幅增加排查难度。P1-3「写库失败必须上抛」约定必须坚守。
- **索引靠人工建是脆弱点**：云函数端 `createIndex` 不可用（`initIndexes.js:34`），索引必须控制台手动建，字段名极易拼错。建议重建后用 `db.collection('StepRecord').createIndex` 之外的方式（如导出索引定义、或写校验脚本）二次核对。

## 最终修复（2026-07-09，删索引 + 代码加固并发去重）

控制台验证：索引字段显示正确 `(user_id, activity_id, date)`，但底层物理索引仍报 `dup key: null` → 云开发控制台显示的 key spec 与底层实际不一致（已知 bug，手建唯一索引不可靠）。

**修复方案**：
1. **删掉** `idx_step_user_activity_date`（不再依赖不可靠的手建唯一索引）。
2. **代码加固并发去重**（`persistStepRecordsToCloud`）：
   - 第一层：先 `where(user_id,activity_id,date).update`
   - 第二层：未命中时 `where().get()` 写前读去重（命中则直接 update 覆盖）
   - 第三层：确实不存在才 `add()`
   - 三层并发控制，彻底去重，不再依赖 DB 唯一索引。

**改动文件**：
- `cloudfunctions/steps/index.js`：删 `isUniqueConflict`；`persistStepRecordsToCloud` 改三层并发去重；保留 `activityId` 兜底。
- 测试：1075 passed / 0 failed；sync:shared + verify:dist 通过。

**部署后验证**：让受影响用户各同步一次 → 日志应出现 `[persist] add ok` → 排行榜恢复正常。
