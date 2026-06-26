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
