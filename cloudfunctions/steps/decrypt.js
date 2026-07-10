/**
 * 微信运动步数解密纯函数（对齐技术架构 §6.2，PRD F3 R3.1）。
 *
 * 链路：
 *   wx.getWeRunData → encryptedData(base64) + iv(base64)
 *   + 当次 code2Session 取到的 session_key(base64)
 *   → AES-128-CBC 解密 → 去除 PKCS#7 padding → JSON
 *   → stepInfoList（近 30 天每日步数：[{timestamp, step}]）
 *
 * 红线（架构 §6.2）：
 *   - session_key 由 handler 当次 code2Session 取得，传入本函数**立即解密后即丢弃**；
 *     本函数不存储、不返回 session_key。
 *   - 解密纯函数与 wx-server-sdk 完全解耦（只用 Node 内置 crypto），
 *     便于在 Node 下单测（自造加密样本 round-trip 验证）。
 *
 * 算法：微信官方 AES-128-CBC，PKCS#7 填充。
 *   - key   = Buffer.from(session_key, 'base64')   （16 字节）
 *   - iv    = Buffer.from(iv, 'base64')            （16 字节）
 *   - plain = AES-128-CBC 解密 Buffer.from(encryptedData, 'base64')，去 padding
 *   - JSON.parse(plain) → { stepInfoList: [{ timestamp, step }, ...], watermark, ... }
 */

const crypto = require('crypto');

const STEP_DECRYPT_FAILED = require('../common/errors').CODE.STEP_DECRYPT_FAILED;
const BizError = require('../common/errors').BizError;

/**
 * AES-128-CBC 解密（去 PKCS#7 padding）。
 * @param {string} sessionKeyB64 session_key（base64）
 * @param {string} ivB64         iv（base64）
 * @param {string} encryptedB64  encryptedData（base64）
 * @returns {Buffer} 明文 Buffer（已去 padding）
 * @throws {Error} 解密失败（参数非法 / padding 错 / 解密异常）
 */
function aesDecryptedBuffer(sessionKeyB64, ivB64, encryptedB64) {
  let key, iv, data;
  try {
    key = Buffer.from(sessionKeyB64, 'base64');
    iv = Buffer.from(ivB64, 'base64');
    data = Buffer.from(encryptedB64, 'base64');
  } catch (e) {
    throw BizError(STEP_DECRYPT_FAILED, 'decrypt: invalid base64 input');
  }
  if (key.length !== 16) {
    throw BizError(STEP_DECRYPT_FAILED, 'decrypt: session_key must be 16 bytes (AES-128)');
  }
  if (iv.length !== 16) {
    throw BizError(STEP_DECRYPT_FAILED, 'decrypt: iv must be 16 bytes');
  }
  if (data.length === 0 || data.length % 16 !== 0) {
    throw BizError(STEP_DECRYPT_FAILED, 'decrypt: encryptedData length invalid');
  }
  let decipher;
  try {
    decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
    decipher.setAutoPadding(true); // PKCS#7
    const head = decipher.update(data);
    const tail = decipher.final();
    return Buffer.concat([head, tail]);
  } catch (e) {
    throw BizError(STEP_DECRYPT_FAILED, 'decrypt: aes-128-cbc failed (' + ((e && e.message) || 'error') + ')');
  }
}

/**
 * 解密微信运动 encryptedData，取出 stepInfoList。
 *
 * @param {object} params
 * @param {string} params.sessionKey 当次 code2Session 取得的 session_key（base64）
 * @param {string} params.iv         wx.getWeRunData 返回的 iv（base64）
 * @param {string} params.encryptedData wx.getWeRunData 返回的 encryptedData（base64）
 * @param {string} [params.expectedAppid] 可选：本小程序 appid（云函数环境变量 WX_APPID）。
 *   传入则校验解密 JSON 的 watermark.appid 与之一致（微信官方 encryptedData 防篡改标准检查），
 *   不一致抛 STEP_DECRYPT_FAILED。纵深防御：session_key 密码学绑定 appid 且用后即弃、不下发，
 *   正常可达路径 watermark.appid 必然等于本 appid；本校验兜底防「未来 session_key 泄露 / 实现回归」。
 * @returns {{stepInfoList: Array<{timestamp:number, step:number}>, raw: object}}
 *   stepInfoList 近 30 天每日步数；raw 为完整解密 JSON（含 watermark，调试用，不下发前端敏感字段）。
 * @throws {BizError} STEP_DECRYPT_FAILED
 */
function decryptSteps(params) {
  const p = params || {};
  if (!p.sessionKey || !p.iv || !p.encryptedData) {
    throw BizError(STEP_DECRYPT_FAILED, 'decrypt: sessionKey/iv/encryptedData required');
  }
  const buf = aesDecryptedBuffer(p.sessionKey, p.iv, p.encryptedData);
  let json;
  try {
    json = JSON.parse(buf.toString('utf8'));
  } catch (e) {
    throw BizError(STEP_DECRYPT_FAILED, 'decrypt: plaintext is not valid JSON');
  }
  // 纵深防御：watermark.appid 校验（微信官方 encryptedData 防篡改标准检查）。
  // expectedAppid 缺省（本地轨/单测）则跳过；传入则 watermark.appid 必须与之一致，否则视为伪造数据。
  if (p.expectedAppid) {
    const wm = json && json.watermark;
    if (!wm || wm.appid !== p.expectedAppid) {
      throw BizError(STEP_DECRYPT_FAILED, 'decrypt: watermark appid mismatch（encryptedData 非本小程序产出）');
    }
  }
  const list = Array.isArray(json && json.stepInfoList) ? json.stepInfoList : [];
  // 归一化：只保留 timestamp / step 数值字段
  const stepInfoList = list
    .map((it) => ({
      timestamp: Number(it && it.timestamp),
      step: Number(it && it.step)
    }))
    .filter((it) => Number.isInteger(it.timestamp) && Number.isInteger(it.step));
  return { stepInfoList, raw: json };
}

module.exports = { decryptSteps, aesDecryptedBuffer };
