# JBZ · 企业健步走活动小程序

> 单期限时企业健步走活动平台 —— 原生微信小程序 + 微信云开发，一套环境承载员工端与管理后台。

[![Platform](https://img.shields.io/badge/Platform-%E5%BE%AE%E4%BF%A1%E5%B0%8F%E7%A8%8B%E5%BA%8F-07c160)](https://developers.weixin.qq.com/miniprogram/dev/framework/)
[![Backend](https://img.shields.io/badge/Backend-%E5%BE%AE%E4%BF%A1%E4%BA%91%E5%BC%80%E5%8F%91-368cff)](https://developers.weixin.qq.com/miniprogram/dev/wxcloud/basis/getting-started.html)
[![Tests](https://img.shields.io/badge/Tests-vitest-6e9f18)](#测试)

登录 → 报名 → 步数同步 → 排名结算的完整活动闭环。员工在微信内零门槛参与，管理员在小程序内置后台完成活动运营，无需独立 Web 站点与服务器运维。

## 功能

**员工端** —— 微信授权 + 手机号登录 · 活动报名 · 微信运动步数同步 · 个人 / 部门 / 总榜排名 · 积分与荣誉勋章 · 个人中心

**管理端**（`is_admin` 识别自动路由）—— 数据看板 · 活动配置与起止管理 · 邀请码发放 · 用户与部门管理 · 异常数据处理 · 积分规则与结算

**后端** —— 云函数承载全部业务逻辑与鉴权（运行时注入 openid，天然可信）· 云数据库（NoSQL 文档型）· 定时触发器驱动步数锁定与排行榜聚合

## 架构

```text
┌─────────────────────────────────────────────┐
│           微信小程序（原生前端）              │
│   员工端页面    ·    管理员后台页面           │
└──────────────────┬──────────────────────────┘
                   │  wx.cloud.callFunction
┌──────────────────▼──────────────────────────┐
│           微信云开发环境（CloudBase）         │
│  云函数  auth / activity / steps / rank ...  │
│  云数据库  User / Department / StepRecord    │
│  定时任务  步数锁定 · 排行榜聚合 · 积分结算   │
└─────────────────────────────────────────────┘
```

无服务器、无域名、无部署流水线；千级用户单期活动近乎零成本。

## 目录结构

```text
miniprogram/          小程序前端（pages / utils / assets）
cloudfunctions/       云函数源码（业务逻辑 + 单测同仓）
cloudfunctions-dist/  云函数构建产物（sync:shared 生成）
docs/                 PRD · 技术架构设计 · 使用说明书
scripts/              构建与校验脚本
tests/                Vitest 测试
```

## 快速开始

```bash
git clone https://github.com/WUJinda/WX-JBZ.git
cd WX-JBZ
npm install
npm run sync:shared   # 同步公共代码至 cloudfunctions-dist/
```

使用**微信开发者工具**导入项目根目录（`appid` 已在 `project.config.json` 配置），选择已开通的云开发环境即可预览。

## 测试

```bash
npm test              # Vitest 全量运行
npm run verify:dist   # 校验构建产物完整性
```

## 文档

- [PRD · P0 MVP](docs/PRD-P0-健步走小程序MVP.md)
- [技术架构设计](docs/技术架构设计.md)
- [用户使用说明书](docs/用户使用说明书.md)

---

© JBZ Team
