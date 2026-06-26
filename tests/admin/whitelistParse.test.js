/**
 * admin.parseWhitelist 单测（H1 R8.2）：
 *   - 合法行 / 重复行 / 非法格式 / 混合分隔符 / 空输入 / 多手机号同 token。
 */
const { parseWhitelist } = require('../../cloudfunctions/admin/whitelistParse');

describe('parseWhitelist（白名单文本解析）', () => {
  it('合法换行文本：提取所有手机号，保留首次出现顺序', () => {
    const text = '13800001111\n13900002222\n13700003333';
    const r = parseWhitelist(text);
    expect(r.phones).toEqual(['13800001111', '13900002222', '13700003333']);
    expect(r.duplicate).toBe(0);
  });

  it('重复手机号：去重，duplicate 计数', () => {
    const text = '13800001111\n13900002222\n13800001111\n13800001111';
    const r = parseWhitelist(text);
    expect(r.phones).toEqual(['13800001111', '13900002222']);
    expect(r.duplicate).toBe(2);
  });

  it('非法格式行：计 invalid，不影响合法提取', () => {
    const text = '手机号\nabc\n13800001111\nnot-a-phone';
    const r = parseWhitelist(text);
    expect(r.phones).toEqual(['13800001111']);
    expect(r.invalid).toBe(3); // 手机号 / abc / not-a-phone
  });

  it('CSV 逗号分隔：自动切分', () => {
    const text = '13800001111,13900002222,13700003333';
    const r = parseWhitelist(text);
    expect(r.phones).toEqual(['13800001111', '13900002222', '13700003333']);
  });

  it('TSV 制表符分隔：自动切分', () => {
    const text = '13800001111\t13900002222\t13700003333';
    const r = parseWhitelist(text);
    expect(r.phones).toEqual(['13800001111', '13900002222', '13700003333']);
  });

  it('混合分隔符（换行+逗号+制表+分号+空白）', () => {
    const text = '13800001111, 13900002222\n13700003333;\t13700004444';
    const r = parseWhitelist(text);
    expect(r.phones).toEqual(['13800001111', '13900002222', '13700003333', '13700004444']);
  });

  it('显式 delimiter（CSV）：仅按逗号切', () => {
    const text = '13800001111,13900002222\n13700003333';
    const r = parseWhitelist(text, { delimiter: ',' });
    // 按 ',' 切后，第二块含换行+号码，仍能正则提取
    expect(r.phones).toEqual(['13800001111', '13900002222', '13700003333']);
  });

  it('空输入：返回空结果', () => {
    expect(parseWhitelist('')).toEqual({ phones: [], duplicate: 0, invalid: 0 });
    expect(parseWhitelist(null)).toEqual({ phones: [], duplicate: 0, invalid: 0 });
    expect(parseWhitelist('   \n\t  ')).toEqual({ phones: [], duplicate: 0, invalid: 0 });
  });

  it('带噪声的 token（一个 token 含多个手机号）', () => {
    const text = 'tel:13800001111;13900002222';
    const r = parseWhitelist(text);
    expect(r.phones).toEqual(['13800001111', '13900002222']);
  });

  it('只提取 11 位合法手机号（1[3-9]\\d{9}），不提取 10 位 / 12 位', () => {
    const text = '1380000111\n138000011111\n13800001111';
    const r = parseWhitelist(text);
    // 10 位 / 12 位均非法
    expect(r.phones).toEqual(['13800001111']);
  });

  it('首位非 1[3-9] 的 11 位号码不计入', () => {
    const text = '10800001111\n12800001111\n15800001111';
    const r = parseWhitelist(text);
    // 10xx 开头非法、12xx（1[3-9]要求第二位 3-9，2 不在）非法、158 合法
    expect(r.phones).toEqual(['15800001111']);
  });
});
