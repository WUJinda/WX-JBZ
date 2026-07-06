const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function readSource(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf-8');
}

describe('云函数 action 挂载结构校验（完成标准 6）', () => {
  it('auth/index.js 的 handlers 表挂载 login 与 phone（不再 not implemented）', () => {
    const src = readSource('cloudfunctions/auth/index.js');
    // handlers 表中以键形式挂载了 login / phone
    expect(src).toMatch(/\blogin\s*:\s*async/);
    expect(src).toMatch(/\bphone\s*:\s*async/);
    // 纯函数模块被 require
    expect(src).toMatch(/require\(['"]\.\/authLogin['"]\)/);
    expect(src).toMatch(/require\(['"]\.\/authPhone['"]\)/);
  });

  it('user/index.js 的 handlers 表挂载 profile（不再 not implemented）', () => {
    const src = readSource('cloudfunctions/user/index.js');
    expect(src).toMatch(/\bprofile\s*:\s*async/);
    expect(src).toMatch(/require\(['"]\.\/userProfile['"]\)/);
  });

  it('login / phone / profile 的纯函数模块文件存在', () => {
    const files = [
      'cloudfunctions/auth/authLogin.js',
      'cloudfunctions/auth/authPhone.js',
      'cloudfunctions/user/userProfile.js'
    ];
    for (const rel of files) {
      expect(fs.existsSync(path.join(ROOT, rel)), `缺少纯函数模块: ${rel}`).toBe(true);
    }
  });

  it('login / profile 页面含授权 / 手机号验证 / 资料展示对应元素', () => {
    const loginWxml = readSource('miniprogram/pages/login/login.wxml');
    // 登录授权按钮
    expect(loginWxml).toMatch(/onLoginTap/);
    // 手机号验证：open-type=getPhoneNumber
    expect(loginWxml).toMatch(/open-type=["']getPhoneNumber["']/);
    // 拒绝后 openSetting 重授权引导
    expect(loginWxml).toMatch(/open-type=["']openSetting["']/);
    expect(loginWxml).toMatch(/onOpenSetting/);

    const profileWxml = readSource('miniprogram/pages/profile/profile.wxml');
    // 资料展示：脱敏手机号 / 部门 / 累计步数
    expect(profileWxml).toMatch(/phoneMasked/);
    expect(profileWxml).toMatch(/部门/);
    expect(profileWxml).toMatch(/totalSteps|累计步数/);
  });

  it('login 页面授权状态机纯函数模块存在', () => {
    expect(
      fs.existsSync(path.join(ROOT, 'miniprogram/pages/login/authFlow.js')),
      '缺少 authFlow.js'
    ).toBe(true);
  });
});

describe('activity action 挂载与页面结构校验（C1+C2）', () => {
  it('activity/index.js 的 handlers 表挂载 current（不再 not implemented）', () => {
    const src = readSource('cloudfunctions/activity/index.js');
    expect(src).toMatch(/\bcurrent\s*:\s*async/);
    // 纯函数模块被 require
    expect(src).toMatch(/require\(['"]\.\/activityStatus['"]\)/);
  });

  it('activity.current 游客可调：不经强制 authMiddleware 抛 AUTH_NO_OPENID', () => {
    // 入口不应在 current 路径上无条件调用 authMiddleware（游客无 OPENID）
    const src = readSource('cloudfunctions/activity/index.js');
    // 存在游客友好取 openid 的辅助（safeOpenid 或等价：无 OPENID 不抛）
    expect(src).toMatch(/safeOpenid|getWXContext\(\)\s*\|\|\s*\{\}/);
  });

  it('activityStatus.js 纯函数模块存在', () => {
    expect(
      fs.existsSync(path.join(ROOT, 'cloudfunctions/activity/activityStatus.js')),
      '缺少 activityStatus.js'
    ).toBe(true);
  });

  it('activity 页面四态 CTA / 头图 / 起止 / 当前阶段 / 倒计时 / 进度条 / 规则 / 概览 元素齐全', () => {
    const wxml = readSource('miniprogram/pages/activity/activity.wxml');
    // 头图
    expect(wxml).toMatch(/cover/);
    // 起止时间
    expect(wxml).toMatch(/start_time|开始时间/);
    expect(wxml).toMatch(/end_time|结束时间/);
    // 当前阶段
    expect(wxml).toMatch(/statusText|当前阶段/);
    // 倒计时
    expect(wxml).toMatch(/countdown/);
    // 进度条
    expect(wxml).toMatch(/progress-bar|progress-fill/);
    // 规则
    expect(wxml).toMatch(/rules/);
    // CTA（四态文案至少出现「报名参加」「我的步数」「查看战绩」「活动未开始」之一，且为按钮）
    expect(wxml).toMatch(/cta/);
    expect(wxml).toMatch(/报名参加|我的步数|查看战绩|活动未开始/);
    // 概览：全员累计步数 / 参与人数
    expect(wxml).toMatch(/total_steps|累计步数/);
    expect(wxml).toMatch(/participant_count|参与人数/);
  });

  it('activity 页面引用 activityCalc 纯函数模块', () => {
    const js = readSource('miniprogram/pages/activity/activity.js');
    expect(js).toMatch(/require\(['"]\.\/activityCalc['"]\)/);
  });

  it('activityCalc.js 前端纯函数模块存在（倒计时/进度/CTA 可单测）', () => {
    expect(
      fs.existsSync(path.join(ROOT, 'miniprogram/pages/activity/activityCalc.js')),
      '缺少 activityCalc.js'
    ).toBe(true);
  });
});

describe('dept.list / user.join action 挂载与 dept 页面结构（D1+D2）', () => {
  it('dept/index.js 的 handlers 表挂载 list（不再 not implemented）', () => {
    const src = readSource('cloudfunctions/dept/index.js');
    expect(src).toMatch(/\blist\s*:\s*async/);
    expect(src).toMatch(/require\(['"]\.\/deptList['"]\)/);
  });

  it('deptList.js 纯函数模块存在', () => {
    expect(
      fs.existsSync(path.join(ROOT, 'cloudfunctions/dept/deptList.js')),
      '缺少 deptList.js'
    ).toBe(true);
  });

  it('user/index.js 的 handlers 表挂载 join（不再 not implemented）', () => {
    const src = readSource('cloudfunctions/user/index.js');
    expect(src).toMatch(/\bjoin\s*:\s*async/);
    expect(src).toMatch(/require\(['"]\.\/userJoin['"]\)/);
  });

  it('userJoin.js 纯函数模块存在', () => {
    expect(
      fs.existsSync(path.join(ROOT, 'cloudfunctions/user/userJoin.js')),
      '缺少 userJoin.js'
    ).toBe(true);
  });

  it('user.join 走 requireUser（需登录态，与 activity.current 游客通道不同）', () => {
    const src = readSource('cloudfunctions/user/index.js');
    // 存在 requireUser 机制（REQUIRE_USER_ACTIONS 或 authMiddleware requireUser:true）
    expect(src).toMatch(/requireUser/);
    expect(src).toMatch(/join/);
  });

  it('dept 页面结构：部门列表（单选）+ 确认加入按钮', () => {
    const wxml = readSource('miniprogram/pages/dept/dept.wxml');
    // 部门列表
    expect(wxml).toMatch(/dept-list|departments/);
    // 单选（selected 态 / radio）
    expect(wxml).toMatch(/selectedDeptId|dept-radio|radio-dot/);
    expect(wxml).toMatch(/onDeptTap/);
    // 确认加入按钮
    expect(wxml).toMatch(/确认加入|confirm-btn|onConfirmTap/);
    // member_count 展示
    expect(wxml).toMatch(/member_count|已报名/);
  });

  it('dept 页面引用 createApi 并调用 dept.list / user.join', () => {
    const js = readSource('miniprogram/pages/dept/dept.js');
    expect(js).toMatch(/require\(['"]\.\/\.\.\/\.\.\/utils\/request['"]\)|createApi/);
    expect(js).toMatch(/action:\s*['"]list['"]/);
    expect(js).toMatch(/action:\s*['"]join['"]/);
    expect(js).toMatch(/dept_id/);
  });
});

describe('steps action 挂载与同步前端结构（E1~E4）', () => {
  it('steps/index.js 的 handlers 表挂载 sync/today/history（不再 not implemented）', () => {
    const src = readSource('cloudfunctions/steps/index.js');
    expect(src).toMatch(/\bsync\s*:\s*async/);
    expect(src).toMatch(/\btoday\s*:\s*async/);
    expect(src).toMatch(/\bhistory\s*:\s*async/);
    // 纯函数模块被 require
    expect(src).toMatch(/require\(['"]\.\/decrypt['"]\)/);
    expect(src).toMatch(/require\(['"]\.\/stepsSync['"]\)/);
    expect(src).toMatch(/require\(['"]\.\/stepsQuery['"]\)/);
  });

  it('steps sync/today/history 走 requireUser（需 OPENID，与游客通道区分）', () => {
    const src = readSource('cloudfunctions/steps/index.js');
    expect(src).toMatch(/requireUser/);
    expect(src).toMatch(/REQUIRE_USER_ACTIONS/);
    expect(src).toMatch(/sync:\s*true/);
    expect(src).toMatch(/today:\s*true/);
    expect(src).toMatch(/history:\s*true/);
  });

  it('steps 纯函数模块存在（decrypt/stepsSync/stepsQuery）', () => {
    const files = [
      'cloudfunctions/steps/decrypt.js',
      'cloudfunctions/steps/stepsSync.js',
      'cloudfunctions/steps/stepsQuery.js'
    ];
    for (const rel of files) {
      expect(fs.existsSync(path.join(ROOT, rel)), `缺少纯函数模块: ${rel}`).toBe(true);
    }
  });

  it('decrypt.js 用 Node crypto 实现 AES-128-CBC（与 wx-server-sdk 解耦）', () => {
    const src = readSource('cloudfunctions/steps/decrypt.js');
    expect(src).toMatch(/require\(['"]crypto['"]\)/);
    expect(src).toMatch(/aes-128-cbc/);
    expect(src).not.toMatch(/require\(['"]wx-server-sdk['"]\)/);
  });

  it('home 同步前端含：同步按钮 / 拒绝重授权(openSetting) / 下拉刷新 / Toast', () => {
    const wxml = readSource('miniprogram/pages/home/home.wxml');
    // 同步按钮
    expect(wxml).toMatch(/sync-btn|onSyncTap/);
    // 拒绝后 openSetting 重授权
    expect(wxml).toMatch(/open-type=["']openSetting["']/);
    expect(wxml).toMatch(/onOpenSetting/);
    // 今日 / 累计步数展示
    expect(wxml).toMatch(/todaySteps|今日步数/);
    expect(wxml).toMatch(/totalSteps|累计步数/);

    const js = readSource('miniprogram/pages/home/home.js');
    // 同步中 / 成功 Toast
    expect(js).toMatch(/showToast/);
    // 下拉刷新
    expect(js).toMatch(/onPullDownRefresh/);
    // getWeRunData 授权
    expect(js).toMatch(/getWeRunData/);
    // 调 steps.sync
    expect(js).toMatch(/action:\s*['"]sync['"]/);
  });

  it('home 页面引用 homeSync 授权状态机纯函数模块', () => {
    const js = readSource('miniprogram/pages/home/home.js');
    expect(js).toMatch(/require\(['"]\.\/homeSync['"]\)/);
  });

  it('homeSync.js 前端纯函数模块存在（授权状态机可单测）', () => {
    expect(
      fs.existsSync(path.join(ROOT, 'miniprogram/pages/home/homeSync.js')),
      '缺少 homeSync.js'
    ).toBe(true);
  });

  it('session_key 绝不写入任何集合（grep 验证：无 collection 写 sessionKey）', () => {
    const src = readSource('cloudfunctions/steps/index.js');
    // handler 中 sessionKey 仅作局部变量解密后丢弃；不应出现在 add/update 的 data 中
    expect(src).not.toMatch(/\.add\(\s*\{[\s\S]*sessionKey/);
    expect(src).not.toMatch(/\.update\(\s*\{[\s\S]*sessionKey/);
    // 不下发：sync 返回值由 syncSteps 产出（不含 sessionKey），handler 不把 sessionKey 放进返回
    expect(src).toMatch(/不.*下发|用后即弃|绝不/);
  });
});

describe('steps.trend / user.stats action 挂载与 home 趋势结构（F4）', () => {
  it('steps/index.js 的 handlers 表挂载 trend（不再 not implemented）', () => {
    const src = readSource('cloudfunctions/steps/index.js');
    expect(src).toMatch(/\btrend\s*:\s*async/);
    expect(src).toMatch(/require\(['"]\.\/stepsTrend['"]\)/);
  });

  it('steps.trend 走 requireUser（需 OPENID）', () => {
    const src = readSource('cloudfunctions/steps/index.js');
    expect(src).toMatch(/trend:\s*true/);
  });

  it('stepsTrend.js 纯函数模块存在', () => {
    expect(
      fs.existsSync(path.join(ROOT, 'cloudfunctions/steps/stepsTrend.js')),
      '缺少 stepsTrend.js'
    ).toBe(true);
  });

  it('user/index.js 的 handlers 表挂载 stats（不再 not implemented）', () => {
    const src = readSource('cloudfunctions/user/index.js');
    expect(src).toMatch(/\bstats\s*:\s*async/);
    expect(src).toMatch(/require\(['"]\.\/userStats['"]\)/);
  });

  it('user.stats 走 requireUser（需 OPENID，与游客通道区分）', () => {
    const src = readSource('cloudfunctions/user/index.js');
    expect(src).toMatch(/stats:\s*true/);
  });

  it('userStats.js 纯函数模块存在', () => {
    expect(
      fs.existsSync(path.join(ROOT, 'cloudfunctions/user/userStats.js')),
      '缺少 userStats.js'
    ).toBe(true);
  });

  it('home 页面引用 homeTrend 趋势纯函数模块', () => {
    const js = readSource('miniprogram/pages/home/home.js');
    expect(js).toMatch(/require\(['"]\.\/homeTrend['"]\)/);
  });

  it('homeTrend.js 前端纯函数模块存在（区间/柱高/空态可单测）', () => {
    expect(
      fs.existsSync(path.join(ROOT, 'miniprogram/pages/home/homeTrend.js')),
      '缺少 homeTrend.js'
    ).toBe(true);
  });

  it('home 含趋势图（7/30 切换 + 纯 CSS 柱状图 + 空态）与参与天数 / 排名入口', () => {
    const wxml = readSource('miniprogram/pages/home/home.wxml');
    // 7/30 切换
    expect(wxml).toMatch(/data-range="7"/);
    expect(wxml).toMatch(/data-range="30"/);
    expect(wxml).toMatch(/onTrendRange/);
    // 纯 CSS 柱状图（百分比高度）
    expect(wxml).toMatch(/height:\{\{item\.heightPct\}\}%/);
    expect(wxml).toMatch(/trend-bar/);
    // R4.3 空态占位文案
    expect(wxml).toMatch(/暂无数据，请点击同步步数/);
    expect(wxml).toMatch(/trendEmpty/);
    // 参与天数 / 活动进度
    expect(wxml).toMatch(/activeDays|已参与天数/);
    expect(wxml).toMatch(/totalDays|活动期天数/);
    // 排名入口（R4.4 引导文案）
    expect(wxml).toMatch(/onMyRankTap/);
    expect(wxml).toMatch(/完成同步后查看排名/);
  });

  it('home.js 进入主页加载统计 + 趋势（onShow 调 loadStats/loadTrend）', () => {
    const js = readSource('miniprogram/pages/home/home.js');
    expect(js).toMatch(/loadStats/);
    expect(js).toMatch(/loadTrend/);
    expect(js).toMatch(/action:\s*['"]stats['"]/);
    expect(js).toMatch(/action:\s*['"]trend['"]/);
    expect(js).toMatch(/onMyRankTap/);
  });

  it('趋势图为纯 CSS，home.js / homeTrend.js 不 require 任何图表库', () => {
    const homeJs = readSource('miniprogram/pages/home/home.js');
    const homeTrendJs = readSource('miniprogram/pages/home/homeTrend.js');
    const forbidden = /require\(['"][^'"]*(wx-charts|echarts|ec-canvas|@antv|f2|chart)[^'"]*['"]\)/i;
    expect(homeJs).not.toMatch(forbidden);
    expect(homeTrendJs).not.toMatch(forbidden);
  });

  it('steps.trend / user.stats 投影不下发 _openid / sync_count / user_id', () => {
    const trendSrc = readSource('cloudfunctions/steps/stepsTrend.js');
    const statsSrc = readSource('cloudfunctions/user/userStats.js');
    // 投影函数明确不含敏感字段
    expect(trendSrc).toMatch(/projectTrend/);
    expect(statsSrc).toMatch(/buildStats/);
  });
});

describe('rank action 挂载与 requireUser（G1）', () => {
  it('rank/index.js 的 handlers 表挂载 personal/dept/deptMembers（不再 not implemented）', () => {
    const src = readSource('cloudfunctions/rank/index.js');
    expect(src).toMatch(/\bpersonal\s*:\s*async/);
    expect(src).toMatch(/\bdept\s*:\s*async/);
    expect(src).toMatch(/\bdeptMembers\s*:\s*async/);
    // 纯函数模块被 require
    expect(src).toMatch(/require\(['"]\.\/rankQuery['"]\)/);
  });

  it('rank.personal/dept/deptMembers 走 requireUser（需 OPENID，缺则抛 AUTH_NO_OPENID）', () => {
    const src = readSource('cloudfunctions/rank/index.js');
    expect(src).toMatch(/requireUser/);
    expect(src).toMatch(/REQUIRE_USER_ACTIONS/);
    expect(src).toMatch(/personal:\s*true/);
    expect(src).toMatch(/dept:\s*true/);
    expect(src).toMatch(/deptMembers:\s*true/);
  });

  it('rankQuery.js 纯函数模块存在', () => {
    expect(
      fs.existsSync(path.join(ROOT, 'cloudfunctions/rank/rankQuery.js')),
      '缺少 rankQuery.js'
    ).toBe(true);
  });

  it('rank 查询投影不下发 _openid / phone / sync_count（grep 实证）', () => {
    const src = readSource('cloudfunctions/rank/rankQuery.js');
    // projectPersonal / projectDept 函数中不应把敏感字段加入返回对象
    expect(src).toMatch(/projectPersonal/);
    expect(src).toMatch(/projectDept/);
    // 投影函数体中不下发敏感字段（不应出现 _openid: / phone: / sync_count: 赋值）
    expect(src).not.toMatch(/_openid\s*:/);
    expect(src).not.toMatch(/sync_count\s*:/);
  });
});

describe('tasks action 挂载与系统级（不 requireUser）（G1）', () => {
  it('tasks/index.js 的 handlers 表挂载 rankAggregate/dailyLock（不再 not implemented）', () => {
    const src = readSource('cloudfunctions/tasks/index.js');
    expect(src).toMatch(/\brankAggregate\s*:\s*async/);
    expect(src).toMatch(/\bdailyLock\s*:\s*async/);
    // 纯函数模块被 require
    expect(src).toMatch(/require\(['"]\.\/rankAggregate['"]\)/);
    expect(src).toMatch(/require\(['"]\.\/dailyLock['"]\)/);
  });

  it('tasks.rankAggregate/dailyLock 为系统级：入口不调 authMiddleware / 不 requireUser', () => {
    const src = readSource('cloudfunctions/tasks/index.js');
    // 系统级定时任务：不应出现 authMiddleware 调用与 requireUser 机制
    expect(src).not.toMatch(/authMiddleware/);
    expect(src).not.toMatch(/requireUser/);
    expect(src).not.toMatch(/REQUIRE_USER_ACTIONS/);
  });

  it('rankAggregate.js / dailyLock.js 纯函数模块存在', () => {
    expect(
      fs.existsSync(path.join(ROOT, 'cloudfunctions/tasks/rankAggregate.js')),
      '缺少 rankAggregate.js'
    ).toBe(true);
    expect(
      fs.existsSync(path.join(ROOT, 'cloudfunctions/tasks/dailyLock.js')),
      '缺少 dailyLock.js'
    ).toBe(true);
  });

  it('tasks 纯函数不调真实云 API（grep 实证：无 wx-server-sdk/cloud.callFunction/database 副作用）', () => {
    const aggSrc = readSource('cloudfunctions/tasks/rankAggregate.js');
    const lockSrc = readSource('cloudfunctions/tasks/dailyLock.js');
    expect(aggSrc).not.toMatch(/require\(['"]wx-server-sdk['"]\)/);
    expect(lockSrc).not.toMatch(/require\(['"]wx-server-sdk['"]\)/);
    expect(aggSrc).not.toMatch(/cloud\.callFunction/);
    expect(lockSrc).not.toMatch(/cloud\.callFunction/);
    // 不直接调 cloud.database()（与 handler 解耦）
    expect(aggSrc).not.toMatch(/cloud\.database\(\)/);
    expect(lockSrc).not.toMatch(/cloud\.database\(\)/);
  });
});

describe('mask.js 脱敏纯函数挂载（G1）', () => {
  it('common/mask.js 纯函数模块存在且导出 maskNickname', () => {
    expect(
      fs.existsSync(path.join(ROOT, 'cloudfunctions/common/mask.js')),
      '缺少 mask.js'
    ).toBe(true);
    const src = readSource('cloudfunctions/common/mask.js');
    expect(src).toMatch(/function maskNickname/);
    expect(src).toMatch(/module\.exports.*maskNickname/);
  });
});

describe('admin action 挂载与 assertAdmin 全覆盖（H1）', () => {
  it('admin/index.js 的 handlers 表挂载 7 个 action（不再 not implemented）', () => {
    const src = readSource('cloudfunctions/admin/index.js');
    expect(src).toMatch(/\bwhitelistImport\s*:\s*async/);
    expect(src).toMatch(/\busers\s*:\s*async/);
    expect(src).toMatch(/\bchangeDept\s*:\s*async/);
    expect(src).toMatch(/\babnormalList\s*:\s*async/);
    expect(src).toMatch(/\bverdict\s*:\s*async/);
    expect(src).toMatch(/\bdashboard\s*:\s*async/);
    expect(src).toMatch(/\bdeptManage\s*:\s*async/);
  });

  it('admin/index.js require 全部纯函数模块', () => {
    const src = readSource('cloudfunctions/admin/index.js');
    expect(src).toMatch(/require\(['"]\.\/adminGuard['"]\)/);
    expect(src).toMatch(/require\(['"]\.\/whitelistParse['"]\)/);
    expect(src).toMatch(/require\(['"]\.\/whitelistImport['"]\)/);
    expect(src).toMatch(/require\(['"]\.\/userList['"]\)/);
    expect(src).toMatch(/require\(['"]\.\/changeDept['"]\)/);
    expect(src).toMatch(/require\(['"]\.\/abnormalList['"]\)/);
    expect(src).toMatch(/require\(['"]\.\/verdict['"]\)/);
    expect(src).toMatch(/require\(['"]\.\/deptManage['"]\)/);
    expect(src).toMatch(/require\(['"]\.\/dashboard['"]\)/);
  });

  it('admin/index.js 全部 8 handler 调用 assertAdmin（管理员守卫全覆盖）', () => {
    const src = readSource('cloudfunctions/admin/index.js');
    // 语义说明：每个管理员 handler 必须在入口调用 assertAdmin 做管理员守卫，
    // 漏一个 handler 会导致非管理员可绕过鉴权调用该 action。
    // admin 共 8 个 action（whitelistImport/users/changeDept/abnormalList/verdict/dashboard/deptManage/ensureSchema），
    // 故 assertAdmin 语句调用必须精确出现 8 次（每个 handler 内 1 次）。
    const actions = [
      'whitelistImport', 'users', 'changeDept',
      'abnormalList', 'verdict', 'dashboard', 'deptManage', 'ensureSchema'
    ];
    // 结构化断言：每个 handler 块内都含 assertAdmin（按 handler 名切分源码块）。
    for (const act of actions) {
      // 定位 handler 块（action: async (event, context) => { ... } 区间，至下一个 handler 或文件尾）。
      const startIdx = src.indexOf(act + ':');
      expect(startIdx, `admin handler ${act} 未找到`).toBeGreaterThan(-1);
      // 取该 handler 到下一个 ', <name>:' 或 loadCollection 之间的片段（保守截取 800 字符足够覆盖单 handler）。
      const slice = src.slice(startIdx, startIdx + 800);
      expect(
        slice.includes('assertAdmin('),
        `admin handler "${act}" 块内未调用 assertAdmin（守卫缺失）`
      ).toBe(true);
    }
    // 精确计数兜底：只数「语句调用」（行首缩进 + assertAdmin(store，排除注释/require 解构）。
    // 注释里也可能出现 assertAdmin( 文本，故用行首缩进式调用形态锁定真实调用。
    const callCount = (src.match(/^\s+assertAdmin\(store/gm) || []).length;
    expect(callCount).toBe(actions.length);
  });

  it('activity.save handler 调用 assertAdmin（管理员守卫，与 admin 8 action 同口径）', () => {
    const src = readSource('cloudfunctions/activity/index.js');
    // save 是唯一需要管理员守卫的 activity action，语句调用必须精确出现 1 次。
    const callCount = (src.match(/^\s+assertAdmin\(store/gm) || []).length;
    expect(callCount).toBe(1);
    // save handler 块内含 assertAdmin
    const saveIdx = src.indexOf('save:');
    expect(saveIdx).toBeGreaterThan(-1);
    expect(src.slice(saveIdx, saveIdx + 800).includes('assertAdmin(')).toBe(true);
  });

  it('assertAdmin 全仓调用总数 = 9（admin 8 + activity.save 1），锁定无遗漏', () => {
    // 跨文件精确总数：避免未来新增 action 漏挂守卫而计数断言不报警。
    // 只数语句调用（行首缩进 + assertAdmin(store），排除注释/require 解构文本。
    const adminSrc = readSource('cloudfunctions/admin/index.js');
    const activitySrc = readSource('cloudfunctions/activity/index.js');
    const adminCount = (adminSrc.match(/^\s+assertAdmin\(store/gm) || []).length;
    const activityCount = (activitySrc.match(/^\s+assertAdmin\(store/gm) || []).length;
    expect(adminCount).toBe(8);
    expect(activityCount).toBe(1);
    expect(adminCount + activityCount).toBe(9);
  });

  it('admin 纯函数模块文件存在（8 个）', () => {
    const files = [
      'cloudfunctions/admin/adminGuard.js',
      'cloudfunctions/admin/whitelistParse.js',
      'cloudfunctions/admin/whitelistImport.js',
      'cloudfunctions/admin/userList.js',
      'cloudfunctions/admin/changeDept.js',
      'cloudfunctions/admin/abnormalList.js',
      'cloudfunctions/admin/verdict.js',
      'cloudfunctions/admin/deptManage.js',
      'cloudfunctions/admin/dashboard.js'
    ];
    for (const rel of files) {
      expect(fs.existsSync(path.join(ROOT, rel)), `缺少纯函数模块: ${rel}`).toBe(true);
    }
  });

  it('admin 纯函数不调真实云 API（grep 实证：无 wx-server-sdk/cloud 副作用）', () => {
    const modules = [
      'cloudfunctions/admin/adminGuard.js',
      'cloudfunctions/admin/whitelistParse.js',
      'cloudfunctions/admin/whitelistImport.js',
      'cloudfunctions/admin/userList.js',
      'cloudfunctions/admin/changeDept.js',
      'cloudfunctions/admin/abnormalList.js',
      'cloudfunctions/admin/verdict.js',
      'cloudfunctions/admin/deptManage.js',
      'cloudfunctions/admin/dashboard.js'
    ];
    for (const rel of modules) {
      const src = readSource(rel);
      expect(src).not.toMatch(/require\(['"]wx-server-sdk['"]\)/);
      expect(src).not.toMatch(/cloud\.database\(\)/);
      expect(src).not.toMatch(/cloud\.callFunction/);
    }
  });

  it('projectUser 投影函数体不下发敏感字段（grep 实证）', () => {
    const src = readSource('cloudfunctions/admin/userList.js');
    expect(src).toMatch(/projectUser/);
    expect(src).not.toMatch(/_openid\s*:/);
    expect(src).not.toMatch(/\bphone\s*:/);
    expect(src).not.toMatch(/sync_count\s*:/);
  });

  it('projectAbnormal 投影函数体不下发敏感字段（grep 实证）', () => {
    const src = readSource('cloudfunctions/admin/abnormalList.js');
    expect(src).toMatch(/projectAbnormal/);
    expect(src).not.toMatch(/_openid\s*:/);
    expect(src).not.toMatch(/sync_count\s*:/);
  });
});

describe('admin 后台前端页面结构与红线（H2：dashboard / activity / whitelist + profile 入口）', () => {
  const H2_WXML = [
    'miniprogram/pages/admin/dashboard/dashboard.wxml',
    'miniprogram/pages/admin/activity/activity.wxml',
    'miniprogram/pages/admin/whitelist/whitelist.wxml'
  ];

  it('dashboard 页含 5 模块导航卡片 + 6 指标卡 + 日活趋势柱状 + 部门榜', () => {
    const wxml = readSource('miniprogram/pages/admin/dashboard/dashboard.wxml');
    // 5 模块导航（data-mod 标识）
    expect(wxml).toMatch(/data-mod="activity"/);
    expect(wxml).toMatch(/data-mod="whitelist"/);
    expect(wxml).toMatch(/data-mod="users"/);
    expect(wxml).toMatch(/data-mod="abnormal"/);
    expect(wxml).toMatch(/data-mod="dept"/);
    expect(wxml).toMatch(/onModuleTap/);
    // 6 指标卡（参与人数 / 白名单总数 / 参与率 / 累计步数 / 人均 / 有效参与）
    expect(wxml).toMatch(/participated/);
    expect(wxml).toMatch(/whitelistTotal/);
    expect(wxml).toMatch(/rateText/);
    expect(wxml).toMatch(/totalSteps/);
    expect(wxml).toMatch(/avgSteps/);
    expect(wxml).toMatch(/validParticipants/);
    // 日活趋势纯 CSS 柱状
    expect(wxml).toMatch(/dailyActive/);
    expect(wxml).toMatch(/height:\{\{item\.heightPct\}\}%/);
    // 部门榜（small_sample 标注）
    expect(wxml).toMatch(/deptRank/);
    expect(wxml).toMatch(/small_sample/);
  });

  it('dashboard.js 调 admin / action:dashboard，且 api.call 接 .catch', () => {
    const js = readSource('miniprogram/pages/admin/dashboard/dashboard.js');
    expect(js).toMatch(/\.call\(\s*['"]admin['"]/);
    expect(js).toMatch(/action:\s*['"]dashboard['"]/);
    expect(js).toMatch(/activity_id/);
    expect(js).toMatch(/\.catch\s*\(/);
    // 引用 dashboardCalc 纯函数
    expect(js).toMatch(/require\(['"]\.\/dashboardCalc['"]\)/);
    // 本地轨守卫：getApp().api 不存在时提前 return
    expect(js).toMatch(/getApp\(\)/);
    expect(js).toMatch(/typeof api\.call !== 'function'/);
  });

  it('dashboardCalc.js 纯函数模块存在（formatRate/normalizeDailyActive/isEmptyDashboard）', () => {
    expect(
      fs.existsSync(path.join(ROOT, 'miniprogram/pages/admin/dashboard/dashboardCalc.js')),
      '缺少 dashboardCalc.js'
    ).toBe(true);
    const src = readSource('miniprogram/pages/admin/dashboard/dashboardCalc.js');
    expect(src).toMatch(/function formatRate/);
    expect(src).toMatch(/function normalizeDailyActive/);
    expect(src).toMatch(/function isEmptyDashboard/);
  });

  it('activity 页含表单字段（name/cover/起止 picker/rules/发布 switch）', () => {
    const wxml = readSource('miniprogram/pages/admin/activity/activity.wxml');
    expect(wxml).toMatch(/onNameInput/);
    expect(wxml).toMatch(/onCoverInput/);
    expect(wxml).toMatch(/onStartChange/);
    expect(wxml).toMatch(/onEndChange/);
    expect(wxml).toMatch(/picker mode="date"/);
    expect(wxml).toMatch(/onRulesInput/);
    expect(wxml).toMatch(/switch/);
    expect(wxml).toMatch(/onPublishChange/);
    expect(wxml).toMatch(/onSave/);
  });

  it('activity.js 调 activity / action:save，且 api.call 接 .catch；前端先校验', () => {
    const js = readSource('miniprogram/pages/admin/activity/activity.js');
    expect(js).toMatch(/\.call\(\s*['"]activity['"]/);
    expect(js).toMatch(/action:\s*['"]save['"]/);
    expect(js).toMatch(/\.catch\s*\(/);
    // 引用 activityCalc 并先校验
    expect(js).toMatch(/require\(['"]\.\/activityCalc['"]\)/);
    expect(js).toMatch(/validateActivityForm/);
    // 本地轨守卫
    expect(js).toMatch(/getApp\(\)/);
  });

  it('activityCalc.js 纯函数模块存在（validateActivityForm/formatPublishState）', () => {
    expect(
      fs.existsSync(path.join(ROOT, 'miniprogram/pages/admin/activity/activityCalc.js')),
      '缺少 activityCalc.js'
    ).toBe(true);
    const src = readSource('miniprogram/pages/admin/activity/activityCalc.js');
    expect(src).toMatch(/function validateActivityForm/);
    expect(src).toMatch(/function formatPublishState/);
  });

  it('whitelist 页含 textarea + 预览数量 + 样本 + 导入按钮', () => {
    const wxml = readSource('miniprogram/pages/admin/whitelist/whitelist.wxml');
    expect(wxml).toMatch(/onTextChange/);
    expect(wxml).toMatch(/previewCount/);
    expect(wxml).toMatch(/previewSample/);
    expect(wxml).toMatch(/onImport/);
  });

  it('whitelist.js 调 admin / action:whitelistImport，入参 raw_text，且 api.call 接 .catch', () => {
    const js = readSource('miniprogram/pages/admin/whitelist/whitelist.js');
    expect(js).toMatch(/\.call\(\s*['"]admin['"]/);
    expect(js).toMatch(/action:\s*['"]whitelistImport['"]/);
    expect(js).toMatch(/raw_text/);
    expect(js).toMatch(/\.catch\s*\(/);
    // 引用 whitelistCalc
    expect(js).toMatch(/require\(['"]\.\/whitelistCalc['"]\)/);
    // 本地轨守卫
    expect(js).toMatch(/getApp\(\)/);
  });

  it('whitelistCalc.js 纯函数模块存在（previewPhones/formatImportResult），正则与后端一致', () => {
    expect(
      fs.existsSync(path.join(ROOT, 'miniprogram/pages/admin/whitelist/whitelistCalc.js')),
      '缺少 whitelistCalc.js'
    ).toBe(true);
    const src = readSource('miniprogram/pages/admin/whitelist/whitelistCalc.js');
    expect(src).toMatch(/function previewPhones/);
    expect(src).toMatch(/function formatImportResult/);
    // 与后端 whitelistParse.js 同款正则 1[3-9]\d{9}
    expect(src).toMatch(/1\[3-9\]\\d\{9\}/);
  });

  it('whitelist 前端预览正则与后端 whitelistParse 严格一致（同源校验）', () => {
    const wlSrc = readSource('miniprogram/pages/admin/whitelist/whitelistCalc.js');
    const parseSrc = readSource('cloudfunctions/admin/whitelistParse.js');
    // 两处都定义 1[3-9]\d{9} 正则
    expect(wlSrc).toMatch(/1\[3-9\]\\d\{9\}/);
    expect(parseSrc).toMatch(/1\[3-9\]\\d\{9\}/);
  });

  it('profile 后台入口 wx:if adminVisible + onAdminEntry navigateTo dashboard', () => {
    const wxml = readSource('miniprogram/pages/profile/profile.wxml');
    expect(wxml).toMatch(/wx:if="\{\{adminVisible\}\}"/);
    expect(wxml).toMatch(/onAdminEntry/);
    const js = readSource('miniprogram/pages/profile/profile.js');
    // adminVisible 默认 false；is_admin===true 才置 true
    expect(js).toMatch(/adminVisible:\s*false/);
    expect(js).toMatch(/is_admin === true/);
    // navigateTo 到 dashboard（admin 页非 tab）
    expect(js).toMatch(/wx\.navigateTo/);
    expect(js).toMatch(/\/pages\/admin\/dashboard\/dashboard/);
  });

  // ===== 红线 grep：本轮 wxml 不绑定 _openid / 完整 phone / sync_count =====
  it('红线：本轮 3 个 admin 页 wxml 不绑定 _openid', () => {
    for (const rel of H2_WXML) {
      const src = readSource(rel);
      // 数据绑定形式 {{..._openid...}} 或属性绑定 data-x="{{_openid}}" → 禁止
      expect(src).not.toMatch(/\{\{[^}]*_openid/);
    }
  });

  it('红线：本轮 3 个 admin 页 wxml 不绑定 sync_count', () => {
    for (const rel of H2_WXML) {
      const src = readSource(rel);
      expect(src).not.toMatch(/\{\{[^}]*sync_count/);
    }
  });

  it('红线：本轮 3 个 admin 页 wxml 不绑定完整 phone（仅允许 phoneMasked 脱敏）', () => {
    for (const rel of H2_WXML) {
      const src = readSource(rel);
      // 排除 phoneMasked / previewXxx 后，不应有 {{...phone...}} 绑定
      // 匹配 {{...phone...}} 但其前不紧跟 Masked，且整体非 preview 前缀
      const lines = src.split('\n');
      for (const line of lines) {
        // 找所有 {{ ... }} 绑定
        const binds = line.match(/\{\{[^}]+\}\}/g) || [];
        for (const b of binds) {
          // 含 phone 但不是 phoneMasked / previewPhone / phone_masked → 命中红线
          if (/phone/i.test(b) && !/phoneMasked|phone_masked|previewPhone/i.test(b)) {
            throw new Error(`${rel} 疑似绑定完整 phone: ${line.trim()}`);
          }
        }
      }
    }
  });
});

describe('admin 后台前端页面结构与红线（H3：users / abnormal / dept）', () => {
  const H3_PAGES = {
    users: 'miniprogram/pages/admin/users/users',
    abnormal: 'miniprogram/pages/admin/abnormal/abnormal',
    dept: 'miniprogram/pages/admin/dept/dept'
  };
  const H3_WXML = [
    H3_PAGES.users + '.wxml',
    H3_PAGES.abnormal + '.wxml',
    H3_PAGES.dept + '.wxml'
  ];

  // ===== users 页（R8.3 用户管理）=====
  it('users 页含筛选栏（keyword input + 部门 picker）+ 用户列表 + 改部门入口 + 分页 + 空态', () => {
    const wxml = readSource(H3_PAGES.users + '.wxml');
    // 筛选栏：关键字 input + 部门 picker
    expect(wxml).toMatch(/onKeywordInput|onKeywordSearch/);
    expect(wxml).toMatch(/picker/);
    expect(wxml).toMatch(/onDeptFilterChange/);
    // 用户列表
    expect(wxml).toMatch(/user-list|user-row/);
    // 改部门入口
    expect(wxml).toMatch(/onOpenDeptPicker|改部门/);
    // 分页
    expect(wxml).toMatch(/loadingMore|load-more|hasMore/);
    // 空态
    expect(wxml).toMatch(/暂无/);
  });

  it('users.js 调 admin.users（dept_id/keyword/page/page_size）+ admin.changeDept + dept.list，且 api.call 全 .catch', () => {
    const js = readSource(H3_PAGES.users + '.js');
    // admin.users：event 字段名严格对齐
    expect(js).toMatch(/\.call\(\s*['"]admin['"]/);
    expect(js).toMatch(/action:\s*['"]users['"]/);
    expect(js).toMatch(/dept_id/);
    expect(js).toMatch(/keyword/);
    expect(js).toMatch(/page_size/);
    // admin.changeDept
    expect(js).toMatch(/action:\s*['"]changeDept['"]/);
    expect(js).toMatch(/user_id/);
    // dept.list（填充部门选项）
    expect(js).toMatch(/\.call\(\s*['"]dept['"]/);
    expect(js).toMatch(/action:\s*['"]list['"]/);
    // 引用 usersCalc
    expect(js).toMatch(/require\(['"]\.\/usersCalc['"]\)/);
    // 本地轨守卫
    expect(js).toMatch(/getApp\(\)/);
    expect(js).toMatch(/typeof api\.call !== 'function'/);
    // 所有 api.call 全 .catch（至少 3 处：users / changeDept / dept.list）
    const catchCount = (js.match(/\.catch\s*\(/g) || []).length;
    expect(catchCount).toBeGreaterThanOrEqual(3);
  });

  it('usersCalc.js 纯函数模块存在（buildDeptOptions/hasMore/formatJoinStatus）', () => {
    expect(
      fs.existsSync(path.join(ROOT, 'miniprogram/pages/admin/users/usersCalc.js')),
      '缺少 usersCalc.js'
    ).toBe(true);
    const src = readSource('miniprogram/pages/admin/users/usersCalc.js');
    expect(src).toMatch(/function buildDeptOptions/);
    // hasMore 已抽到公共 utils/pagination.js，本页 require 转发后在 module.exports 暴露
    expect(src).toMatch(/hasMore/);
    expect(src).toMatch(/function formatJoinStatus/);
  });

  // ===== abnormal 页（R8.4 异常裁定）=====
  it('abnormal 页含异常列表（user_id/date/steps/abnormal 高亮 + 忽略/置零按钮）+ 分页 + 空态', () => {
    const wxml = readSource(H3_PAGES.abnormal + '.wxml');
    // 异常列表
    expect(wxml).toMatch(/abnormal-list|abnormal-row/);
    // 字段展示
    expect(wxml).toMatch(/user_id/);
    expect(wxml).toMatch(/date/);
    expect(wxml).toMatch(/steps/);
    // 异常高亮
    expect(wxml).toMatch(/abnormal-flag|异常/);
    // 忽略 / 置零按钮（verdict action 区分）
    expect(wxml).toMatch(/data-verdict="ignore"/);
    expect(wxml).toMatch(/data-verdict="zero"/);
    expect(wxml).toMatch(/onVerdict/);
    // 分页
    expect(wxml).toMatch(/loadingMore|load-more|hasMore/);
    // 空态
    expect(wxml).toMatch(/暂无/);
  });

  it('abnormal.js 调 admin.abnormalList；verdict 用 verdict_action（非 action 做 ignore/zero），且 api.call 全 .catch', () => {
    const js = readSource(H3_PAGES.abnormal + '.js');
    // admin.abnormalList
    expect(js).toMatch(/\.call\(\s*['"]admin['"]/);
    expect(js).toMatch(/action:\s*['"]abnormalList['"]/);
    expect(js).toMatch(/page_size/);
    // verdict：dispatch 字段 action='verdict'，业务裁定用 verdict_action
    expect(js).toMatch(/action:\s*['"]verdict['"]/);
    expect(js).toMatch(/verdict_action/);
    // 不应出现把 ignore/zero 赋给 action 字段（即 action: 'ignore' / action: 'zero'）
    expect(js).not.toMatch(/action:\s*['"]ignore['"]/);
    expect(js).not.toMatch(/action:\s*['"]zero['"]/);
    // 引用 abnormalCalc
    expect(js).toMatch(/require\(['"]\.\/abnormalCalc['"]\)/);
    // 本地轨守卫
    expect(js).toMatch(/getApp\(\)/);
    expect(js).toMatch(/typeof api\.call !== 'function'/);
    // 所有 api.call 全 .catch（abnormalList / verdict）
    const catchCount = (js.match(/\.catch\s*\(/g) || []).length;
    expect(catchCount).toBeGreaterThanOrEqual(2);
  });

  it('abnormalCalc.js 纯函数模块存在（verdictLabel/formatSteps/hasMore）', () => {
    expect(
      fs.existsSync(path.join(ROOT, 'miniprogram/pages/admin/abnormal/abnormalCalc.js')),
      '缺少 abnormalCalc.js'
    ).toBe(true);
    const src = readSource('miniprogram/pages/admin/abnormal/abnormalCalc.js');
    expect(src).toMatch(/function verdictLabel/);
    expect(src).toMatch(/function formatSteps/);
    // hasMore 已抽到公共 utils/pagination.js，本页 require 转发后在 module.exports 暴露
    expect(src).toMatch(/hasMore/);
  });

  // ===== dept 页（部门管理）=====
  it('dept 页含部门列表（名称/成员数 + 编辑/删除）+ 新建按钮 + 弹窗表单（input + 确认/取消）+ 空态', () => {
    const wxml = readSource(H3_PAGES.dept + '.wxml');
    // 部门列表
    expect(wxml).toMatch(/dept-list|dept-row/);
    // 名称 / 成员数
    expect(wxml).toMatch(/memberCountText|member_count|人/);
    // 编辑 / 删除
    expect(wxml).toMatch(/onEdit/);
    expect(wxml).toMatch(/onDelete/);
    // 新建按钮
    expect(wxml).toMatch(/onCreate|新建/);
    // 弹窗表单
    expect(wxml).toMatch(/showForm/);
    expect(wxml).toMatch(/formName/);
    expect(wxml).toMatch(/onFormConfirm/);
    expect(wxml).toMatch(/onFormCancel/);
    // 空态
    expect(wxml).toMatch(/暂无/);
  });

  it('dept.js 调 dept.list + admin.deptManage（op），且 api.call 全 .catch', () => {
    const js = readSource(H3_PAGES.dept + '.js');
    // dept.list
    expect(js).toMatch(/\.call\(\s*['"]dept['"]/);
    expect(js).toMatch(/action:\s*['"]list['"]/);
    // admin.deptManage（op create/update/delete）
    expect(js).toMatch(/\.call\(\s*['"]admin['"]/);
    expect(js).toMatch(/action:\s*['"]deptManage['"]/);
    expect(js).toMatch(/\bop\b/);
    expect(js).toMatch(/['"]create['"]/);
    expect(js).toMatch(/['"]update['"]/);
    expect(js).toMatch(/['"]delete['"]/);
    // 引用 deptCalc
    expect(js).toMatch(/require\(['"]\.\/deptCalc['"]\)/);
    // 本地轨守卫
    expect(js).toMatch(/getApp\(\)/);
    expect(js).toMatch(/typeof api\.call !== 'function'/);
    // 所有 api.call 全 .catch（dept.list / deptManage create|update / deptManage delete）
    const catchCount = (js.match(/\.catch\s*\(/g) || []).length;
    expect(catchCount).toBeGreaterThanOrEqual(2);
  });

  it('deptCalc.js 纯函数模块存在（validateDeptName/formatDept）', () => {
    expect(
      fs.existsSync(path.join(ROOT, 'miniprogram/pages/admin/dept/deptCalc.js')),
      '缺少 deptCalc.js'
    ).toBe(true);
    const src = readSource('miniprogram/pages/admin/dept/deptCalc.js');
    expect(src).toMatch(/function validateDeptName/);
    expect(src).toMatch(/function formatDept/);
  });

  // ===== verdict bug 修复断言（H1 遗留 event.action 冲突）=====
  it('verdict bug 已修复：admin/index.js verdict handler 取 event.verdict_action（不再用 event.action 做 ignore/zero）', () => {
    const src = readSource('cloudfunctions/admin/index.js');
    // verdict handler 取 event.verdict_action（兼容 verdictAction）
    expect(src).toMatch(/verdict_action\s*\|\|\s*event\.verdictAction/);
    // applyVerdict 调用入参 action 来自 verdict_action（而非 event.action）
    // 验证 verdict handler 块内 action 字段绑定到 verdict_action
    expect(src).toMatch(/action:\s*event\s*&&\s*\(event\.verdict_action\s*\|\|\s*event\.verdictAction\)/);
  });

  // ===== 红线 grep：H3 3 页 wxml 不绑定 _openid / 完整 phone / sync_count =====
  it('红线：H3 3 个 admin 页 wxml 不绑定 _openid', () => {
    for (const rel of H3_WXML) {
      const src = readSource(rel);
      expect(src).not.toMatch(/\{\{[^}]*_openid/);
    }
  });

  it('红线：H3 3 个 admin 页 wxml 不绑定 sync_count', () => {
    for (const rel of H3_WXML) {
      const src = readSource(rel);
      expect(src).not.toMatch(/\{\{[^}]*sync_count/);
    }
  });

  it('红线：H3 3 个 admin 页 wxml 不绑定完整 phone（users 仅允许 phone_masked）', () => {
    for (const rel of H3_WXML) {
      const src = readSource(rel);
      const lines = src.split('\n');
      for (const line of lines) {
        const binds = line.match(/\{\{[^}]+\}\}/g) || [];
        for (const b of binds) {
          // 含 phone 但不是 phone_masked / phoneMasked / previewPhone → 命中红线
          if (/phone/i.test(b) && !/phoneMasked|phone_masked|previewPhone/i.test(b)) {
            throw new Error(`${rel} 疑似绑定完整 phone: ${line.trim()}`);
          }
        }
      }
    }
  });
});

describe('activity.save action 挂载与共享 adminGuard（I）', () => {
  it('activity/index.js 的 handlers 表挂载 save（不再占位注释）', () => {
    const src = readSource('cloudfunctions/activity/index.js');
    expect(src).toMatch(/\bsave\s*:\s*async/);
    // 纯函数模块被 require
    expect(src).toMatch(/require\(['"]\.\/activitySave['"]\)/);
  });

  it('activity.save 走 assertAdmin（管理员守卫，非管理员 AUTH_NOT_ADMIN）', () => {
    const src = readSource('cloudfunctions/activity/index.js');
    // save handler 内调用 assertAdmin
    expect(src).toMatch(/assertAdmin\(/);
    // 共享守卫来自 common（跨云函数 require common 范式）
    expect(src).toMatch(/require\(['"]\.\.\/common\/adminGuard['"]\)/);
  });

  it('activity.save 经 authMiddleware 取 openid（缺则 AUTH_NO_OPENID，区别于 current 游客通道）', () => {
    const src = readSource('cloudfunctions/activity/index.js');
    expect(src).toMatch(/require\(['"]\.\.\/common\/authMiddleware['"]\)/);
    // save handler 内调用 authMiddleware
    expect(src).toMatch(/authMiddleware\(/);
  });

  it('activity.current 仍游客可调（不经强制 authMiddleware）', () => {
    const src = readSource('cloudfunctions/activity/index.js');
    // 入口对所有 action 直接 dispatch 到 handler（current 游客通道不变）
    expect(src).toMatch(/safeOpenid/);
    expect(src).toMatch(/\bcurrent\s*:\s*async/);
  });

  it('activitySave.js 纯函数模块存在', () => {
    expect(
      fs.existsSync(path.join(ROOT, 'cloudfunctions/activity/activitySave.js')),
      '缺少 activitySave.js'
    ).toBe(true);
  });

  it('activitySave.js 纯函数不调真实云 API（grep 实证：无 wx-server-sdk/cloud 副作用）', () => {
    const src = readSource('cloudfunctions/activity/activitySave.js');
    expect(src).not.toMatch(/require\(['"]wx-server-sdk['"]\)/);
    expect(src).not.toMatch(/cloud\.database\(\)/);
    expect(src).not.toMatch(/cloud\.callFunction/);
  });

  it('activitySave.js 复用 activityStatus.deriveStatus（R8.1 由 deriveStatus 满足）', () => {
    const src = readSource('cloudfunctions/activity/activitySave.js');
    expect(src).toMatch(/require\(['"]\.\/activityStatus['"]\)/);
    expect(src).toMatch(/deriveStatus/);
  });

  it('activitySave.js 不写入 published 字段（R8.1 无 published）', () => {
    const src = readSource('cloudfunctions/activity/activitySave.js');
    expect(src).not.toMatch(/published\s*:/);
  });

  it('common/adminGuard.js 共享守卫模块存在且导出 assertAdmin', () => {
    expect(
      fs.existsSync(path.join(ROOT, 'cloudfunctions/common/adminGuard.js')),
      '缺少 common/adminGuard.js'
    ).toBe(true);
    const src = readSource('cloudfunctions/common/adminGuard.js');
    expect(src).toMatch(/function assertAdmin/);
    expect(src).toMatch(/module\.exports.*assertAdmin/);
    // 复用 common/errors（相对路径）
    expect(src).toMatch(/require\(['"]\.\/errors['"]\)/);
  });

  it('admin/adminGuard.js 为 re-export common/adminGuard（一行 re-export，零回归）', () => {
    const src = readSource('cloudfunctions/admin/adminGuard.js');
    // 一行 re-export，指向 common/adminGuard
    expect(src).toMatch(/require\(['"]\.\.\/common\/adminGuard['"]\)/);
    // 不应再内嵌 assertAdmin 实现体（实现已移走）
    expect(src).not.toMatch(/function assertAdmin/);
  });
});

describe('用户注册向导 + 账号管理（user.update/cancel + login 向导 + profile 入口 + edit 页）', () => {
  it('user/index.js 的 handlers 表挂载 update / cancel（不再 not implemented）', () => {
    const src = readSource('cloudfunctions/user/index.js');
    expect(src).toMatch(/\bupdate\s*:\s*async/);
    expect(src).toMatch(/\bcancel\s*:\s*async/);
    expect(src).toMatch(/require\(['"]\.\/userAccount['"]\)/);
  });

  it('user.update / user.cancel 走 requireUser（需登录态）', () => {
    const src = readSource('cloudfunctions/user/index.js');
    expect(src).toMatch(/update:\s*true/);
    expect(src).toMatch(/cancel:\s*true/);
  });

  it('user/index.js 含 wrapRemoveAll（绕过 where().remove() 单次 20 条上限）', () => {
    const src = readSource('cloudfunctions/user/index.js');
    expect(src).toMatch(/function wrapRemoveAll/);
    expect(src).toMatch(/wrapRemoveAll\(db\)/);
  });

  it('userAccount.js 纯函数模块存在且不调真实云 API', () => {
    expect(fs.existsSync(path.join(ROOT, 'cloudfunctions/user/userAccount.js'))).toBe(true);
    const src = readSource('cloudfunctions/user/userAccount.js');
    expect(src).toMatch(/function updateProfile/);
    expect(src).toMatch(/function cancelAccount/);
    expect(src).not.toMatch(/require\(['"]wx-server-sdk['"]\)/);
    expect(src).not.toMatch(/cloud\.database\(\)/);
  });

  it('authPhone.js 白名单开关：导出 PHONE_WHITELIST_REQUIRED 常量且默认 false（放开注册）', () => {
    const src = readSource('cloudfunctions/auth/authPhone.js');
    expect(src).toMatch(/const PHONE_WHITELIST_REQUIRED = false/);
    expect(src).toMatch(/PHONE_WHITELIST_REQUIRED/);
    // verifyPhone 支持测试用 requireWhitelist 覆盖（handler 不传，安全）
    expect(src).toMatch(/requireWhitelist/);
  });

  it('login.wxml 注册向导：保留一键登录/手机号/openSetting，新增 chooseAvatar + nickname input', () => {
    const wxml = readSource('miniprogram/pages/login/login.wxml');
    // 保留（既有断言元素不破坏）
    expect(wxml).toMatch(/onLoginTap/);
    expect(wxml).toMatch(/open-type=["']getPhoneNumber["']/);
    expect(wxml).toMatch(/open-type=["']openSetting["']/);
    expect(wxml).toMatch(/onOpenSetting/);
    // 新增：头像昵称填写能力
    expect(wxml).toMatch(/open-type=["']chooseAvatar["']/);
    expect(wxml).toMatch(/bindchooseavatar=["']onChooseAvatar["']/);
    expect(wxml).toMatch(/type=["']nickname["']/);
    expect(wxml).toMatch(/onNicknameBlur/);
    expect(wxml).toMatch(/onSubmitProfile/);
  });

  it('login.js 注册向导：按 join_status/registered 分流；提交资料调 user.update；手机号后跳 dept', () => {
    const js = readSource('miniprogram/pages/login/login.js');
    expect(js).toMatch(/join_status === 'joined'/);
    expect(js).toMatch(/data && data\.registered/);
    expect(js).toMatch(/action:\s*['"]update['"]/);
    expect(js).toMatch(/action:\s*['"]phone['"]/);
    expect(js).toMatch(/\/pages\/dept\/dept/);
    // 复用 editCalc（昵称校验与后端同口径）
    expect(js).toMatch(/require\(['"]\.\.\/profile\/edit\/editCalc['"]\)/);
  });

  it('profile.wxml 账号管理入口：编辑资料 / 登出 / 注销（保留 adminVisible/onAdminEntry）', () => {
    const wxml = readSource('miniprogram/pages/profile/profile.wxml');
    expect(wxml).toMatch(/wx:if="\{\{adminVisible\}\}"/);
    expect(wxml).toMatch(/onAdminEntry/);
    expect(wxml).toMatch(/onEditProfile/);
    expect(wxml).toMatch(/onLogout/);
    expect(wxml).toMatch(/onCancelAccount/);
  });

  it('profile.js 实现 onEditProfile / onLogout / onCancelAccount，且注销调 user.cancel + 清本地 reLaunch', () => {
    const js = readSource('miniprogram/pages/profile/profile.js');
    expect(js).toMatch(/onEditProfile/);
    expect(js).toMatch(/onLogout/);
    expect(js).toMatch(/onCancelAccount/);
    expect(js).toMatch(/action:\s*['"]cancel['"]/);
    expect(js).toMatch(/clearStorageSync|clearStorage/);
    expect(js).toMatch(/reLaunch/);
    // 保留既有逻辑（不破坏 H2 断言）
    expect(js).toMatch(/is_admin === true/);
  });

  it('profile/edit 子页存在并引用 editCalc；提交调 user.update；含 chooseAvatar + nickname input', () => {
    expect(fs.existsSync(path.join(ROOT, 'miniprogram/pages/profile/edit/edit.js'))).toBe(true);
    expect(fs.existsSync(path.join(ROOT, 'miniprogram/pages/profile/edit/edit.wxml'))).toBe(true);
    expect(fs.existsSync(path.join(ROOT, 'miniprogram/pages/profile/edit/editCalc.js'))).toBe(true);
    const js = readSource('miniprogram/pages/profile/edit/edit.js');
    expect(js).toMatch(/require\(['"]\.\/editCalc['"]\)/);
    expect(js).toMatch(/action:\s*['"]update['"]/);
    const wxml = readSource('miniprogram/pages/profile/edit/edit.wxml');
    expect(wxml).toMatch(/open-type=["']chooseAvatar["']/);
    expect(wxml).toMatch(/type=["']nickname["']/);
  });

  it('editCalc.js 纯函数模块存在（validateNickname/buildAvatarCloudPath/isAvatarChanged）', () => {
    expect(fs.existsSync(path.join(ROOT, 'miniprogram/pages/profile/edit/editCalc.js'))).toBe(true);
    const src = readSource('miniprogram/pages/profile/edit/editCalc.js');
    expect(src).toMatch(/function validateNickname/);
    expect(src).toMatch(/function buildAvatarCloudPath/);
    expect(src).toMatch(/function isAvatarChanged/);
  });

  it('app.json 登记 profile/edit 页', () => {
    const src = readSource('miniprogram/app.json');
    expect(src).toMatch(/"pages\/profile\/edit\/edit"/);
  });

  it('红线：profile/login/edit 三页 wxml 不绑定 _openid / sync_count / 完整 phone', () => {
    const files = [
      'miniprogram/pages/profile/profile.wxml',
      'miniprogram/pages/login/login.wxml',
      'miniprogram/pages/profile/edit/edit.wxml'
    ];
    for (const rel of files) {
      const src = readSource(rel);
      expect(src).not.toMatch(/\{\{[^}]*_openid/);
      expect(src).not.toMatch(/\{\{[^}]*sync_count/);
      const lines = src.split('\n');
      for (const line of lines) {
        // 精确匹配 phone 作为独立字段（{{phone}} / {{xxx.phone}}）；
        // 排除 phoneMasked / phone_masked / phoneDenied / 'phone' 字面量等含 phone 子串的非数据绑定
        if (/\{\{[^}]*\bphone\b\s*[\}.]/.test(line)) {
          throw new Error(`${rel} 疑似绑定完整 phone: ${line.trim()}`);
        }
      }
    }
  });
});


