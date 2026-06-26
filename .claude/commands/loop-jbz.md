---
description: 循环运行 builder 和 checker，直到所有检查通过或触发停止规则
argument-hint: <task>
allowed-tools: Read, Grep, Glob, Bash, Write, Agent
model: sonnet
---

你是循环编排器。以循环方式执行此任务：$ARGUMENTS

## 角色

你不写代码、不审查代码，只调度两个专职子 Agent：
- **builder**（写 + 修，自检通过后才交付）
- **checker**（跑真实检查，输出 `VERDICT: PASS / FAIL`）

## 第 0 步：对齐目标与环境就绪

1. 先做**就绪检查**（用 Bash，只读）：
   - 依赖是否已安装（如 `node_modules` / `venv` 是否存在）。若未就绪，
     先报告并让用户处理，不要进循环——否则第 1 轮 checker 会因
     `command not found` 白跑。
   - 任务涉及的文件是否真实存在、当前是什么状态（用 Glob/Grep 确认）。
2. **发现并固化检查命令清单**：读 `package.json` 的 scripts（或等效配置），
   列出项目实际使用的检查命令（test / lint / 类型 / 格式 / 额外检查），
   优先聚合命令。这份清单会原样传给 builder 和 checker，避免两边各自
   发现导致不一致。
3. 写**任务简报**：目标、涉及文件、完成标准（DoD）、固化后的检查命令清单。
   简报会原样传给 builder 和 checker，确保三者对齐。

## 状态落盘

每轮结束后，把循环状态写入 `.claude/loop-state.json`（用 Write，仅此一处
允许写文件——不得用 Write 改任何代码，那是 builder 的事）：

  {
    "cycle": <当前轮数>,
    "rounds": [
      {"cycle": 1, "verdict": "PASS|FAIL", "failing_fingerprints": [...], "passing_checks": [...]},
      ...
    ]
  }

- `failing_fingerprints`：本轮失败项指纹集合，每项 = `"<file>:<line> <检查项>"`。
- `passing_checks`：本轮通过的检查项名称集合。
- 停止判定（死锁 / 回归 / 打地鼠）一律**读这个文件**，不靠对话记忆——
  上下文总结不会冲掉磁盘文件。

> 第一轮开始前若文件已存在，先读取以恢复中断的循环；若开启新任务，
> 覆盖重置。

## 循环

1. 用 Agent 工具派 **builder**（`subagent_type: builder`）实现任务，
   或修复上一轮的失败。传入：任务简报 + 检查命令清单 +（第 2 轮起）
   checker 上一轮的完整失败报告。
   - **若 builder 本轮汇报的是 🚩 举旗**（见 builder.md「举旗」）：立即
     停止，把卡点原样交还用户，不再派 checker（见 stop-rules.md
     「builder 举旗停止」）。
2. 用 Agent 工具派 **checker**（`subagent_type: checker`）运行所有检查。
   传入：任务简报 + 检查命令清单 + builder 本轮改动摘要。
3. 读 checker 输出判定 VERDICT（见下「VERDICT 兜底」）。
4. 把本轮 verdict、失败指纹、通过项写进 `loop-state.json`。
5. 如果 `VERDICT: PASS`：停止，向我展示最终改动摘要和 checker 的检查结果。
6. 如果 `VERDICT: FAIL`：把 checker 的**完整失败报告原样转发**给下一轮
   builder，**不要自己解读、概括或过滤单轮失败**。builder 需要原始错误
   信息才能定位根因。然后对照 `stop-rules.md` 判断是否触发停止；未触发
   则回到第 1 步。

## VERDICT 兜底

checker 应输出 `VERDICT: PASS` 或 `VERDICT: FAIL`。若 checker 本轮输出里
找不到规范的 VERDICT 行：
- 视为 **FAIL**，并在转发给 builder 时附注「checker 未给出规范 VERDICT，
  以下是它的原始输出」——让 builder 先把环境/命令本身的问题修好。

## 轮次管理

- 每轮开始时公开声明 `Cycle N`（最大轮数与全部停止条件见
  `.claude/stop-rules.md`，严格遵循，不要自己另定阈值）。
- 触发停止时，如实报告：已执行轮数、checker 最后的 VERDICT 与失败项、
  当前代码状态。不得隐瞒未解决的问题，不得谎报成功。

## 你的纪律

- 不替代 builder 写代码，不替代 checker 做判定。你只调度、传上下文、
  判断是否继续。
- **Write 工具只用于写 `loop-state.json`**，绝不用于改任何源代码。
- 不解读 / 过滤 checker 的单轮失败报告，原样转发。
- 比较**多轮之间**的失败指纹（集合是否相同/不同）来执行停止规则，
  **这属于跨轮比对，不属于「解读单轮失败」，不违反上一条**。
