const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function readJson(rel) {
  const abs = path.join(ROOT, rel);
  const text = fs.readFileSync(abs, 'utf-8');
  return JSON.parse(text);
}

describe('结构校验', () => {
  it('app.json 是合法 JSON 对象', () => {
    const app = readJson('miniprogram/app.json');
    expect(app).toEqual(expect.any(Object));
    expect(Array.isArray(app.pages)).toBe(true);
  });

  it('pages 注册全部占位页', () => {
    const expected = [
      'pages/activity/activity',
      'pages/login/login',
      'pages/dept/dept',
      'pages/home/home',
      'pages/rank/rank',
      'pages/profile/profile',
      'pages/admin/dashboard/dashboard',
      'pages/admin/activity/activity',
      'pages/admin/whitelist/whitelist',
      'pages/admin/users/users',
      'pages/admin/abnormal/abnormal',
      'pages/admin/dept/dept'
    ];
    const app = readJson('miniprogram/app.json');
    for (const p of expected) {
      expect(app.pages, `缺少页面注册: ${p}`).toContain(p);
    }
  });

  it('tabBar 存在且 list 有 4 项', () => {
    const app = readJson('miniprogram/app.json');
    expect(app.tabBar).toBeDefined();
    expect(Array.isArray(app.tabBar.list)).toBe(true);
    expect(app.tabBar.list.length).toBe(4);
  });

  it('每个 tabBar 项含 pagePath/text（图标可选；活动 tab 暂为纯文字）', () => {
    const app = readJson('miniprogram/app.json');
    const required = ['pagePath', 'text'];
    app.tabBar.list.forEach((item, i) => {
      required.forEach((k) => {
        expect(item[k], `tabBar[${i}] 缺少 ${k}`).toEqual(expect.any(String));
        expect(item[k].length, `tabBar[${i}].${k} 不能为空`).toBeGreaterThan(0);
      });
      // iconPath / selectedIconPath 可选：活动 tab 无图标；其余 tab 提供则必须非空。
      ['iconPath', 'selectedIconPath'].forEach((k) => {
        if (k in item) {
          expect(item[k], `tabBar[${i}].${k} 若提供不能为空`).toEqual(expect.any(String));
          expect(item[k].length, `tabBar[${i}].${k} 若提供不能为空`).toBeGreaterThan(0);
        }
      });
    });
  });

  it('tabBar 含 home / activity / rank / profile 四个 tab', () => {
    const app = readJson('miniprogram/app.json');
    const paths = app.tabBar.list.map((t) => t.pagePath);
    expect(paths).toContain('pages/home/home');
    expect(paths).toContain('pages/activity/activity');
    expect(paths).toContain('pages/rank/rank');
    expect(paths).toContain('pages/profile/profile');
  });

  it('project.config.json 含 cloudfunctionRoot 配置', () => {
    const cfg = readJson('miniprogram/project.config.json');
    expect(cfg.cloudfunctionRoot).toBeDefined();
    expect(typeof cfg.cloudfunctionRoot).toBe('string');
    expect(cfg.cloudfunctionRoot.length).toBeGreaterThan(0);
  });

  it('project.config.json 含 appid 占位', () => {
    const cfg = readJson('miniprogram/project.config.json');
    expect(cfg.appid).toBeDefined();
    expect(typeof cfg.appid).toBe('string');
  });

  it('8 个云函数入口 index.js 存在', () => {
    const fns = ['auth', 'user', 'dept', 'activity', 'steps', 'rank', 'admin', 'tasks'];
    for (const fn of fns) {
      const p = path.join(ROOT, 'cloudfunctions', fn, 'index.js');
      expect(fs.existsSync(p), `缺少云函数入口: ${fn}/index.js`).toBe(true);
    }
  });

  it('common 共享模块文件齐全', () => {
    const files = [
      'cloudfunctions/common/errors.js',
      'cloudfunctions/common/response.js',
      'cloudfunctions/common/db.js',
      'cloudfunctions/common/authMiddleware.js'
    ];
    for (const rel of files) {
      expect(fs.existsSync(path.join(ROOT, rel)), `缺少共享模块: ${rel}`).toBe(true);
    }
  });

  it('前端 utils 文件齐全', () => {
    const files = [
      'miniprogram/utils/request.js',
      'miniprogram/utils/auth-guard.js',
      'miniprogram/utils/format.js'
    ];
    for (const rel of files) {
      expect(fs.existsSync(path.join(ROOT, rel)), `缺少工具: ${rel}`).toBe(true);
    }
  });

  it('每个注册页面四件套（.js/.json/.wxml/.wxss）齐全', () => {
    const app = readJson('miniprogram/app.json');
    const exts = ['.js', '.json', '.wxml', '.wxss'];
    for (const pagePath of app.pages) {
      for (const ext of exts) {
        const abs = path.join(ROOT, 'miniprogram', pagePath + ext);
        expect(fs.existsSync(abs), `缺少页面文件: ${pagePath}${ext}`).toBe(true);
      }
    }
  });

  it('auth-guard 路由判定（顺带验证 utils 可被 require）', () => {
    const { nextRoute, canEnterAdmin, PAGES } = require('../miniprogram/utils/auth-guard');
    expect(nextRoute({})).toBe(PAGES.LOGIN);
    expect(nextRoute({ loggedIn: true, phoneVerified: true })).toBe(PAGES.DEPT);
    expect(nextRoute({ loggedIn: true, phoneVerified: true, joined: true })).toBe(PAGES.HOME);
    expect(canEnterAdmin('/pages/admin/users/users', { loggedIn: true, isAdmin: true })).toBe(true);
    expect(canEnterAdmin('/pages/admin/users/users', { loggedIn: true, isAdmin: false })).toBe(false);
  });
});
