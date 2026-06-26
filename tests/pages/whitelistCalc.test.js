/**
 * 后台白名单导入前端纯函数单测（F8 R8.2，H2）。
 * previewPhones / formatImportResult，纯函数不耦合 wx 运行时。
 *
 * 红线验证：previewPhones 正则与后端 whitelistParse 严格一致（1[3-9]\d{9}），
 * 保证预览数 = 实际导入数。对照数据来自后端口径。
 */
const { previewPhones, formatImportResult, PHONE_RE } = require('../../miniprogram/pages/admin/whitelist/whitelistCalc');

describe('previewPhones 预览解析（与后端 whitelistParse 同口径）', () => {
  it('正则与后端一致：1[3-9]\\d{9}', () => {
    expect(PHONE_RE.source).toBe('1[3-9]\\d{9}');
  });

  it('换行分隔 → 去重保序', () => {
    const out = previewPhones('13800001111\n13900002222\n13800001111');
    expect(out.phones).toEqual(['13800001111', '13900002222']);
    expect(out.count).toBe(2);
  });

  it('逗号分隔', () => {
    const out = previewPhones('13800001111,13900002222,13700003333');
    expect(out.phones).toEqual(['13800001111', '13900002222', '13700003333']);
    expect(out.count).toBe(3);
  });

  it('混合分隔符（换行/逗号/分号/制表/空白）', () => {
    const out = previewPhones('13800001111, 13900002222;\n13700003333\t13600004444');
    expect(out.count).toBe(4);
    expect(out.phones[0]).toBe('13800001111');
    expect(out.phones[3]).toBe('13600004444');
  });

  it('重复手机号 → 去重（保留首次出现顺序）', () => {
    const out = previewPhones('13800001111\n13800001111\n13800001111');
    expect(out.count).toBe(1);
    expect(out.phones).toEqual(['13800001111']);
  });

  it('无效行（表头/非手机号文本）→ 计入 invalid', () => {
    const out = previewPhones('手机号\n13800001111\n姓名');
    expect(out.count).toBe(1);
    expect(out.invalid).toBe(2); // "手机号" + "姓名"
  });

  it('非法号段（12x / 10x 开头）不识别', () => {
    // 1[3-9]\d{9}：第二位必须是 3-9
    const out = previewPhones('12000001111\n10000022222\n13800003333');
    // 12000001111 / 10000022222 不是手机号，但其中包含的 "200001111" / "00002222" 也不匹配
    // 实际：12000001111 整体不匹配 1[3-9]\d{9}（第二位 2），但内部无手机号
    expect(out.count).toBe(1);
    expect(out.phones).toEqual(['13800003333']);
  });

  it('一个 token 内含多个手机号 → 全部提取（与后端 token.match 一致）', () => {
    const out = previewPhones('tel:13800001111;13900002222');
    expect(out.count).toBe(2);
  });

  it('空字符串 / null / undefined → count=0', () => {
    expect(previewPhones('').count).toBe(0);
    expect(previewPhones('   ').count).toBe(0);
    expect(previewPhones(null).count).toBe(0);
    expect(previewPhones(undefined).count).toBe(0);
  });

  it('纯空白 / 仅分隔符 → count=0, invalid=0', () => {
    const out = previewPhones('\n\n,;\t  ');
    expect(out.count).toBe(0);
    expect(out.invalid).toBe(0);
  });

  it('纯有效行无 invalid', () => {
    const out = previewPhones('13800001111\n13900002222');
    expect(out.invalid).toBe(0);
  });

  it('不修改入参（纯函数，非字符串也不抛）', () => {
    expect(() => previewPhones(12345)).not.toThrow();
    expect(() => previewPhones({})).not.toThrow();
  });
});

describe('formatImportResult 导入结果格式化', () => {
  it('有新增 + 更新 → 两者都展示', () => {
    expect(formatImportResult({ imported: 5, updated: 3 })).toBe('新增 5 条，更新 3 条');
  });

  it('仅新增 → 省略更新', () => {
    expect(formatImportResult({ imported: 5, updated: 0 })).toBe('新增 5 条');
  });

  it('仅更新 → 省略新增', () => {
    expect(formatImportResult({ imported: 0, updated: 2 })).toBe('更新 2 条');
  });

  it('全 0 → 未导入提示', () => {
    expect(formatImportResult({ imported: 0, updated: 0 })).toBe('未导入任何手机号');
  });

  it('null / undefined → 未导入提示', () => {
    expect(formatImportResult(null)).toBe('未导入任何手机号');
    expect(formatImportResult(undefined)).toBe('未导入任何手机号');
  });

  it('字符串数字也能识别', () => {
    expect(formatImportResult({ imported: '5', updated: '3' })).toBe('新增 5 条，更新 3 条');
  });
});
