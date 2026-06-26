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
