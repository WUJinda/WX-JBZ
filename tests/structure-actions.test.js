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
