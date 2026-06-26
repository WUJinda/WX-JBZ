/**
 * 集合 schema 定义（对齐技术架构 §5 数据模型）。
 *
 * 文档型存储（微信云开发数据库），字段以 JSON 表示。
 * 此文件是「结构真相源」，用于：
 *   1) 索引初始化脚本（initIndexes.js）按此声明建唯一/普通索引；
 *   2) 单测做结构合法性校验（字段名、类型、索引唯一性声明齐全）；
 *   3) 后续轮次写其它集合时在此补充。
 *
 * 约定：
 *   - unique: true 的索引在初始化时按云数据库要求建为唯一索引。
 *   - 🔒 字段标记 onlyServer: true，表示仅后端存用、不下发前端（脱敏见各 action）。
 */

const COLLECTIONS = {
  User: {
    description: '用户（对齐技术架构 §5.1）',
    indexes: [
      { name: 'idx_user_openid', fields: { _openid: 1 }, unique: true },
      { name: 'idx_user_phone', fields: { phone: 1 }, unique: true },
      { name: 'idx_user_dept', fields: { dept_id: 1 }, unique: false },
      { name: 'idx_user_admin', fields: { is_admin: 1 }, unique: false }
    ],
    fields: {
      _id: { type: 'string', desc: '主键（云数据库自动生成）' },
      _openid: { type: 'string', onlyServer: true, desc: '微信 openid（唯一），鉴权身份键' },
      unionid: { type: 'string', optional: true, onlyServer: true, desc: '微信 unionid（可选，预留）' },
      nickname: { type: 'string', desc: '昵称（取微信昵称或自填）' },
      avatar: { type: 'string', desc: '头像 URL（取微信头像或自传）' },
      phone: { type: 'string', onlyServer: true, desc: '🔒 完整手机号，仅后端做白名单匹配' },
      phone_masked: { type: 'string', desc: '脱敏手机号（138****1234），前端展示' },
      dept_id: { type: 'string', optional: true, desc: '部门 id（报名后写入）' },
      join_status: {
        type: 'string',
        enum: ['pending', 'joined'],
        default: 'pending',
        desc: '报名状态：pending 未报名 / joined 已报名'
      },
      joined_at: { type: 'date', optional: true, desc: '报名时间' },
      is_admin: { type: 'boolean', default: false, desc: '是否管理员' },
      created_at: { type: 'date', desc: '创建时间' },
      updated_at: { type: 'date', desc: '更新时间' }
    }
  },

  Whitelist: {
    description: '员工白名单（对齐技术架构 §5.3）',
    indexes: [
      { name: 'idx_whitelist_phone', fields: { phone: 1 }, unique: true }
    ],
    fields: {
      _id: { type: 'string', desc: '主键' },
      phone: { type: 'string', onlyServer: true, desc: '🔒 完整手机号，仅后端匹配' },
      imported_at: { type: 'date', desc: '导入时间' }
    }
  }
};

module.exports = { COLLECTIONS };
