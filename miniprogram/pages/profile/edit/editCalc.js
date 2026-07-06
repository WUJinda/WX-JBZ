/**
 * 编辑资料 / 注册向导 昵称头像表单纯函数（前端可单测）。
 *
 * 与后端 userAccount.validateNickname 同源（昵称长度口径一致），保证前端先校验与后端最终校验
 * 不产生口径漂移（对齐 whitelist 前后端正则同源的项目惯例）。
 *
 * 纯函数：不依赖 wx 运行时，可在 Node 下单测。
 */

/** 昵称长度上限（按 Unicode 码点计，与后端 userAccount.NICKNAME_MAX_LEN 一致）。 */
const NICKNAME_MAX_LEN = 20;

/**
 * 校验昵称：trim 后 1..NICKNAME_MAX_LEN 个码点（与后端同口径）。
 * @param {*} nickname
 * @returns {boolean}
 */
function validateNickname(nickname) {
  if (typeof nickname !== 'string') return false;
  const s = nickname.trim();
  const len = Array.from(s).length;
  return len >= 1 && len <= NICKNAME_MAX_LEN;
}

/**
 * 生成头像云存储路径：avatars/<base>.jpg。
 * 前端拿不到 openid（红线不下发），故用时间戳+随机串命名，避免并发撞名。
 * @param {string} [filename] 可选文件名（不含路径/后缀），用于单测注入；缺省内部生成。
 * @returns {string} cloudPath（相对云存储根）
 */
function buildAvatarCloudPath(filename) {
  const base =
    filename ||
    Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  return 'avatars/' + base + '.jpg';
}

/**
 * 判断头像是否变化（需重新上传）。
 * chooseAvatar 回调返回的是 wxfile:// 临时路径，与已存的 cloud:// fileID 不同 → 视为变化。
 * @param {string} oldUrl 已存头像（fileID 或 URL）
 * @param {string} newUrl 新选头像（临时路径或 fileID）
 * @returns {boolean}
 */
function isAvatarChanged(oldUrl, newUrl) {
  return typeof oldUrl === 'string' && typeof newUrl === 'string' && oldUrl !== newUrl;
}

module.exports = { validateNickname, buildAvatarCloudPath, isAvatarChanged, NICKNAME_MAX_LEN };
