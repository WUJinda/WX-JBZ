<div align="center">

<img src="docs/images/logo.png" width="120" alt="JBZ logo"/>

# JBZ · 企业健步走活动小程序

**单期限时企业健步走活动平台** —— 原生微信小程序 + 微信云开发，一套环境承载员工端与管理后台，覆盖「登录 → 报名 → 步数同步 → 排名结算」的完整闭环。

[![Platform](https://img.shields.io/badge/Platform-%E5%BE%AE%E4%BF%A1%E5%B0%8F%E7%A8%8B%E5%BA%8F-07c160?style=flat-square)](https://developers.weixin.qq.com/miniprogram/dev/framework/)
[![Backend](https://img.shields.io/badge/Backend-%E5%BE%AE%E4%BF%A1%E4%BA%91%E5%BC%80%E5%8F%91_CloudBase-368cff?style=flat-square)](https://developers.weixin.qq.com/miniprogram/dev/wxcloud/basis/getting-started.html)
[![Language](https://img.shields.io/badge/Language-JavaScript-F7DF1E?style=flat-square&logo=javascript&logoColor=black)](https://developer.mozilla.org/zh-CN/docs/Web/JavaScript)
[![Tests](https://img.shields.io/badge/Tests-Vitest%20%C2%B7%2062%20files%20%C2%B7%201.1k%2B%20cases-6e9f18?style=flat-square&logo=vitest&logoColor=white)](#-测试)

员工在微信内零门槛参与，管理员在小程序内置后台完成活动运营——**无服务器、无域名、无部署流水线，千级用户单期活动近乎零成本**。

</div>

---

## ✨ 特性

### 👤 员工端（7 个页面）

- **微信授权登录 + 一人一码准入** —— 邀请码全局一次消费（原子更新 + 唯一索引），彻底不收集手机号
- **活动报名** —— 单期限时活动，加入部门即可参赛
- **微信运动步数同步** —— `getWeRunData` 官方最短路径解密入库，含 30 日趋势
- **三视图排行榜** —— 个人 / 部门 / 总榜，日榜与累计榜
- **积分结算公告** —— 活动结束自动结算，「比赛结束」弹窗公示部门冠军与前十名

### 🛠 管理端（8 个页面，`is_admin` 识别自动路由）

- **数据看板** —— 参与人数、步数总量、异常数据一览
- **活动配置** —— 起止时间、状态管理（发布 / 终止 / 删除）
- **邀请码运营** —— 批量生成、状态筛选、禁用回收
- **用户与部门管理** —— 部门调整、成员归属
- **异常数据处理** —— 可疑步数记录人工裁决
- **积分规则与结算** —— 台账查询、手工调分、触发结算

### ⚙️ 平台侧

- **12 个云函数域**承载全部业务逻辑与鉴权，运行时自动注入调用者 `openid`，天然可信
- **云数据库**（NoSQL 文档型）：`User · Department · Activity · StepRecord · RankCache · InviteCode`
- **每 10 分钟统一调度器**：步数锁定 → 排行榜聚合 → 积分结算，幂等可重入
- **业务即纯函数**：核心逻辑 store 注入式设计，不依赖 `wx-server-sdk`，可脱离微信环境单测

## 🏗 架构

```text
┌─────────────────────────────────────────────┐
│           微信小程序（原生前端）              │
│   员工端页面    ·    管理员后台页面           │
└──────────────────┬──────────────────────────┘
                   │  wx.cloud.callFunction
┌──────────────────▼──────────────────────────┐
│           微信云开发环境（CloudBase）         │
│  云函数  auth / activity / steps / rank ...  │
│  云数据库  User · Department · Activity      │
│            StepRecord · RankCache            │
│            InviteCode（一人一码准入）         │
│  定时任务  步数锁定 · 排行榜聚合 · 积分结算   │
└─────────────────────────────────────────────┘
```

<details>
<summary><b>📊 积分结算规则（点击展开）</b></summary>

活动结束后按**最终累计榜单**一次性结算（幂等，`points_settled` 标记防重）：

- **个人榜前 10 名**：`+12 / +10 / +8 / +7 / +6 / +5 / +4 / +3 / +2 / +1`（平缓曲线，对标名次分制）
- **0 步门槛**：累计步数 ≤ 0 的名次直接跳过且**不递补**——有效步数人数不足时宁缺毋滥
- **部门榜冠军**：第一个非小样本部门的全员每人 `+2`（含 0 步成员，全员激励口径）
- **个人奖与部门奖可叠加**；所有部门均为小样本时跳过部门奖
- 结算数据读自 `RankCache` 聚合结果，不重算；活动结束后 `steps.sync` 拒绝写入，步数固化

</details>

## 📁 目录结构

```text
miniprogram/           小程序前端
├─ pages/              15 个页面（员工端 7 + 管理端 8）
├─ utils/              request · auth-guard · format · pagination
└─ assets/             tabbar 图标
cloudfunctions/        云函数源码（12 个域，逻辑与单测同仓）
├─ auth/               登录注册 · 一人一码邀请码准入
├─ steps/              微信运动解密 · 步数同步与趋势
├─ rank/               排行榜查询（日榜 / 累计榜）
├─ tasks/              定时调度：锁定 · 聚合 · 积分结算
├─ admin/              管理端聚合域（看板/用户/裁决/调分）
├─ schema/             集合与索引初始化（ensureSchema）
└─ activity/ dept/ user/ common/ ...
docs/                  PRD · 技术架构设计 · 邀请码机制
scripts/               sync-shared（共享层打包）· verify-dist（产物校验）
tests/                 Vitest 测试（62 文件 · 1100+ 用例）
```

## 🚀 快速开始

**前置条件**：企业主体小程序 · 已开通云开发环境 · 小程序后台已配置隐私协议（步数属个人信息）

```bash
git clone https://github.com/WUJinda/WX-JBZ.git
cd WX-JBZ
npm install
npm run sync:shared   # 同步公共代码至 cloudfunctions-dist/
```

1. 使用**微信开发者工具**导入项目根目录（`appid` 已在 `project.config.json` 配置），选择已开通的云开发环境；
2. 工具中逐个「上传并部署」`cloudfunctions-dist/` 下的云函数；
3. 云端调用 `admin.ensureSchema` 初始化集合与索引（`InviteCode` 唯一索引须在生码前存在）；
4. 在云开发控制台将自己的 `User.is_admin` 置 `true`，开通管理端入口。

## 🧪 测试

```bash
npm test              # Vitest 全量运行（1100+ 用例）
npm run verify:dist   # 校验云函数构建产物完整性
```

## 📚 文档

| 文档 | 说明 |
| --- | --- |
| [邀请码机制](docs/邀请码机制.md) | 现行准入方案：一人一码，替代早期手机号 + 白名单设计 |
| [技术架构设计](docs/技术架构设计.md) | 选型理由、云函数分层、数据模型、定时任务口径 |
| [PRD · P0 MVP](docs/PRD-P0-健步走小程序MVP.md) | 产品需求基线 |

---

<div align="center">

<sub>一套云开发环境，装下整个企业健步走活动。</sub>

</div>
