/**
 * utils/pagination.hasMore 纯函数单测（对齐 PRD F5/F6/F8 分页口径）。
 *
 * 语义：本次返回条数 count 与每页条数 pageSize 比较，满页 → 可能还有更多。
 *   - count >= pageSize → true（可能还有下一页）
 *   - count <  pageSize → false（已是末页）
 *   - count = 0         → false（无数据）
 *   - pageSize 缺省/非法（<1 或非数字）→ 兜底 50
 */
const { hasMore } = require('../../miniprogram/utils/pagination');

describe('pagination.hasMore（满页判定）', () => {
  describe('常规满页', () => {
    it('count === pageSize → true（恰好满页，可能还有下一页）', () => {
      expect(hasMore(20, 20)).toBe(true);
    });
    it('count > pageSize → true', () => {
      expect(hasMore(21, 20)).toBe(true);
    });
    it('count < pageSize → false（末页）', () => {
      expect(hasMore(19, 20)).toBe(false);
    });
    it('count = pageSize-1（典型末页）→ false', () => {
      expect(hasMore(7, 8)).toBe(false);
    });
  });

  describe('count = 0 边界', () => {
    it('count = 0, pageSize 任意 → false（无数据不可能有更多）', () => {
      expect(hasMore(0, 20)).toBe(false);
      expect(hasMore(0, 50)).toBe(false);
      expect(hasMore(0, 1)).toBe(false);
    });
  });

  describe('pageSize 缺省 / 非法兜底（默认 50）', () => {
    it('pageSize = 50 缺省口径：count=50 → true', () => {
      expect(hasMore(50, 50)).toBe(true);
    });
    it('pageSize = 50 缺省口径：count=49 → false', () => {
      expect(hasMore(49, 50)).toBe(false);
    });
    it('pageSize 缺省（undefined）→ 兜底 50：count=50 true / count=49 false', () => {
      // hasMore 仅声明 (count, pageSize) 两参；测试其缺省行为兜底为 50。
      expect(hasMore(50)).toBe(true);
      expect(hasMore(49)).toBe(false);
    });
    it('pageSize = 0 → 兜底 50（避免除零/恒真）', () => {
      expect(hasMore(50, 0)).toBe(true);
      expect(hasMore(49, 0)).toBe(false);
    });
    it('pageSize 为负数 → 兜底 50', () => {
      expect(hasMore(50, -5)).toBe(true);
      expect(hasMore(49, -5)).toBe(false);
    });
    it('pageSize 非数字（NaN）→ 兜底 50', () => {
      expect(hasMore(50, NaN)).toBe(true);
      expect(hasMore(49, NaN)).toBe(false);
    });
    it('pageSize 为字符串数字 → 当作数字解析（Number("20")=20）', () => {
      // 实现用 Number(pageSize)，字符串数字可解析为有限数。
      expect(hasMore(20, '20')).toBe(true);
      expect(hasMore(19, '20')).toBe(false);
    });
  });

  describe('count 非数字 / NaN 兜底', () => {
    it('count 非数字 → 兜底 0 → false', () => {
      expect(hasMore('abc', 20)).toBe(false);
      expect(hasMore(NaN, 20)).toBe(false);
      expect(hasMore(undefined, 20)).toBe(false);
      expect(hasMore(null, 20)).toBe(false);
    });
    it('count 为字符串数字 → 解析为数字参与比较', () => {
      expect(hasMore('20', 20)).toBe(true);
      expect(hasMore('19', 20)).toBe(false);
    });
  });

  describe('典型分页场景', () => {
    it('首页满页（page_size=10, 返回 10）→ true', () => {
      expect(hasMore(10, 10)).toBe(true);
    });
    it('末页只剩 3 条（page_size=10）→ false', () => {
      expect(hasMore(3, 10)).toBe(false);
    });
    it('默认 pageSize=50 场景：返回正好 50 → true（可能还有）', () => {
      expect(hasMore(50, 50)).toBe(true);
    });
  });
});
