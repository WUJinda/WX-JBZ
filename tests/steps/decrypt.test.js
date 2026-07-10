/**
 * 解密纯函数单测（E2）：自造加密样本 round-trip 验证 AES-128-CBC 解密逻辑正确。
 *
 * 自造方式：用 Node crypto 以「微信相同算法」加密一段 stepInfoList，
 * 得到 encryptedData/iv/sessionKey（均 base64），再交给 decryptSteps 解密，
 * 断言还原的 stepInfoList 与原始一致。这样无需真实微信样本即可验证解密链路。
 */
const crypto = require('crypto');
const { decryptSteps, aesDecryptedBuffer } = require('../../cloudfunctions/steps/decrypt');
const { CODE } = require('../../cloudfunctions/common/errors');

/**
 * 自造微信运动加密样本（与微信 AES-128-CBC 同算法）。
 * @param {object} plain JS 对象（含 stepInfoList）
 * @returns {{sessionKey:string, iv:string, encryptedData:string}}
 */
function makeEncryptedSample(plain) {
  // session_key：微信为 16 字节随机串的 base64
  const sessionKey = crypto.randomBytes(16);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-128-cbc', sessionKey, iv);
  const buf = Buffer.from(JSON.stringify(plain), 'utf8');
  const enc = Buffer.concat([cipher.update(buf), cipher.final()]);
  return {
    sessionKey: sessionKey.toString('base64'),
    iv: iv.toString('base64'),
    encryptedData: enc.toString('base64')
  };
}

describe('steps.decrypt 解密纯函数（E2，自造样本 round-trip）', () => {
  it('自造样本 round-trip：加密 stepInfoList 再解密，还原一致', () => {
    const plain = {
      stepInfoList: [
        { timestamp: 1751328000, step: 8521 },
        { timestamp: 1751414400, step: 12345 },
        { timestamp: 1751500800, step: 60000 }
      ],
      watermark: { appid: 'wxDEMO', timestamp: 1751500900 }
    };
    const sample = makeEncryptedSample(plain);
    const { stepInfoList, raw } = decryptSteps(sample);
    expect(stepInfoList).toHaveLength(3);
    expect(stepInfoList[0]).toEqual({ timestamp: 1751328000, step: 8521 });
    expect(stepInfoList[1]).toEqual({ timestamp: 1751414400, step: 12345 });
    expect(stepInfoList[2]).toEqual({ timestamp: 1751500800, step: 60000 });
    expect(raw.watermark.appid).toBe('wxDEMO');
  });

  it('空 stepInfoList → 返回空数组（不抛）', () => {
    const sample = makeEncryptedSample({ stepInfoList: [] });
    const { stepInfoList } = decryptSteps(sample);
    expect(stepInfoList).toEqual([]);
  });

  it('缺少 stepInfoList 字段 → 返回空数组', () => {
    const sample = makeEncryptedSample({ watermark: { appid: 'x' } });
    const { stepInfoList } = decryptSteps(sample);
    expect(stepInfoList).toEqual([]);
  });

  it('session_key 长度非 16 字节 → 抛 STEP_DECRYPT_FAILED', () => {
    const badKey = crypto.randomBytes(15).toString('base64'); // 15 字节
    expect(() =>
      decryptSteps({ sessionKey: badKey, iv: crypto.randomBytes(16).toString('base64'), encryptedData: 'AAAAAAAAAAAAAAAAAAAAAA==' })
    ).toThrow(/session_key must be 16 bytes/);
  });

  it('错误的 session_key/iv 解密失败 → 抛 STEP_DECRYPT_FAILED（带 code）', () => {
    const plain = { stepInfoList: [{ timestamp: 1, step: 1 }] };
    const sample = makeEncryptedSample(plain);
    // 用错误的 session_key 解密
    const wrongKey = crypto.randomBytes(16).toString('base64');
    let thrown = null;
    try {
      decryptSteps({ sessionKey: wrongKey, iv: sample.iv, encryptedData: sample.encryptedData });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).not.toBeNull();
    expect(thrown.code).toBe(CODE.STEP_DECRYPT_FAILED);
  });

  it('缺参 → 抛 STEP_DECRYPT_FAILED', () => {
    expect(() => decryptSteps({})).toThrow(/required/);
  });

  it('aesDecryptedBuffer 输出明文 JSON 可解析', () => {
    const plain = { stepInfoList: [{ timestamp: 100, step: 200 }] };
    const sample = makeEncryptedSample(plain);
    const buf = aesDecryptedBuffer(sample.sessionKey, sample.iv, sample.encryptedData);
    expect(JSON.parse(buf.toString('utf8')).stepInfoList[0]).toEqual({ timestamp: 100, step: 200 });
  });

  it('解密返回结果不含 sessionKey 字段（不下发 session_key）', () => {
    const sample = makeEncryptedSample({ stepInfoList: [] });
    const out = decryptSteps(sample);
    expect(JSON.stringify(out)).not.toContain('sessionKey');
    expect(JSON.stringify(out)).not.toContain(sample.sessionKey);
  });

  // watermark.appid 校验（安全加固：微信官方 encryptedData 防篡改标准检查）
  it('expectedAppid 与 watermark.appid 一致 → 通过校验', () => {
    const plain = {
      stepInfoList: [{ timestamp: 100, step: 200 }],
      watermark: { appid: 'wxABC', timestamp: 999 }
    };
    const sample = makeEncryptedSample(plain);
    const { stepInfoList } = decryptSteps(Object.assign({}, sample, { expectedAppid: 'wxABC' }));
    expect(stepInfoList).toEqual([{ timestamp: 100, step: 200 }]);
  });

  it('expectedAppid 与 watermark.appid 不一致 → 抛 STEP_DECRYPT_FAILED（防伪造）', () => {
    const plain = {
      stepInfoList: [{ timestamp: 100, step: 200 }],
      watermark: { appid: 'wxFORGERY', timestamp: 999 } // 伪造数据
    };
    const sample = makeEncryptedSample(plain);
    let thrown = null;
    try {
      decryptSteps(Object.assign({}, sample, { expectedAppid: 'wxREAL' }));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).not.toBeNull();
    expect(thrown.code).toBe(CODE.STEP_DECRYPT_FAILED);
    expect(String(thrown.message)).toMatch(/watermark appid mismatch/);
  });

  it('expectedAppid 传入但解密 JSON 缺 watermark → 抛 STEP_DECRYPT_FAILED', () => {
    const plain = { stepInfoList: [{ timestamp: 1, step: 1 }] }; // 无 watermark 字段
    const sample = makeEncryptedSample(plain);
    expect(() => decryptSteps(Object.assign({}, sample, { expectedAppid: 'wxX' }))).toThrow(/watermark appid mismatch/);
  });

  it('expectedAppid 缺省 → 跳过 watermark 校验（向后兼容，不破坏现有调用/单测）', () => {
    const plain = { stepInfoList: [], watermark: { appid: 'any' } };
    const sample = makeEncryptedSample(plain);
    // 不传 expectedAppid，即使 watermark.appid 随意也不报错。
    expect(() => decryptSteps(sample)).not.toThrow();
  });
});
