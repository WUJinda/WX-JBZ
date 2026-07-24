const {
  generateCodes,
  listCodes,
  disableCode,
  projectInviteCode,
  generateOneCode,
  MAX_BATCH
} = require('../../cloudfunctions/admin/inviteCode');

function code(c, status, extra) {
  return Object.assign(
    { code: c, status, batch_id: 'b1', created_by: 'admin', created_at: new Date('2026-07-01'), note: '' },
    extra || {}
  );
}

// 可预测伪随机：返回 [0,1)，序列覆盖字母表不同位置，避免单测不确定。
function makeSequentialRand() {
  let i = 0;
  return () => {
    i += 1;
    return (i * 0.137) % 1;
  };
}

describe('admin/inviteCode 管理纯函数', () => {
  describe('generateCodes', () => {
    it('生成 N 个唯一码（与已有去重，docs 结构正确）', () => {
      const existing = [code('AAAAAA', 'unused')];
      const out = generateCodes({
        store: { InviteCode: existing },
        count: 3,
        createdBy: 'admin',
        now: new Date('2026-07-08'),
        rand: makeSequentialRand()
      });
      expect(out.generated).toBe(3);
      expect(out.codes).toHaveLength(3);
      expect(out.docs).toHaveLength(3);
      expect(out.codes).not.toContain('AAAAAA'); // 不与已有重复
      expect(out.docs[0].status).toBe('unused');
      expect(out.docs[0].created_by).toBe('admin');
      expect(out.docs[0].batch_id).toBe(out.batchId);
    });

    it('批次号缺省自动生成 b_<timestamp>', () => {
      const out = generateCodes({
        store: { InviteCode: [] },
        count: 1,
        now: new Date('2026-07-08T00:00:00Z')
      });
      expect(out.batchId).toMatch(/^b_\d+$/);
    });

    it('count 非正整数 → 抛 BIZ_PARAM_MISSING', () => {
      expect(() => generateCodes({ store: { InviteCode: [] }, count: 0 })).toThrow();
      expect(() => generateCodes({ store: { InviteCode: [] }, count: -1 })).toThrow();
      expect(() => generateCodes({ store: { InviteCode: [] }, count: 'x' })).toThrow();
    });

    it('count 超 MAX_BATCH → 抛错', () => {
      expect(() => generateCodes({ store: { InviteCode: [] }, count: MAX_BATCH + 1 })).toThrow();
    });

    it('store 缺失/非数组 → 抛 SYS_DB_ERROR', () => {
      expect(() => generateCodes({ count: 1 })).toThrow();
      expect(() => generateCodes({ store: {}, count: 1 })).toThrow();
    });
  });

  describe('generateOneCode', () => {
    it('长度 = 6；rand=0 → 全字母表首位', () => {
      expect(generateOneCode(() => 0)).toBe('000000');
    });

    it('默认用 Math.random（不传 rand）也能产出 6 位', () => {
      const c = generateOneCode();
      expect(c.length).toBe(6);
    });
  });

  describe('listCodes', () => {
    it('默认全部，按 created_at 降序 + 投影（不下发 used_by）', () => {
      const store = {
        InviteCode: [
          code('AAA111', 'unused', { created_at: new Date('2026-07-01'), used_by: 'oSECRET' }),
          code('BBB222', 'used', { created_at: new Date('2026-07-02') })
        ]
      };
      const out = listCodes(store, { page: 1, pageSize: 10 });
      expect(out.totalCount).toBe(2);
      expect(out.list[0].code).toBe('BBB222'); // 07-02 在前（降序）
      expect(out.list[0].used_by).toBeUndefined(); // 不下发原始 openid
    });

    it('status 过滤', () => {
      const store = {
        InviteCode: [code('A', 'unused'), code('B', 'used'), code('C', 'disabled')]
      };
      expect(listCodes(store, { status: 'used' }).totalCount).toBe(1);
      expect(listCodes(store, { status: 'disabled' }).totalCount).toBe(1);
      expect(listCodes(store, { status: 'unused' }).totalCount).toBe(1);
    });

    it('分页', () => {
      const arr = [];
      for (let i = 0; i < 5; i++) arr.push(code('C' + i, 'unused', { created_at: new Date(2026, 6, i + 1) }));
      const store = { InviteCode: arr };
      const p1 = listCodes(store, { page: 1, pageSize: 2 });
      expect(p1.list).toHaveLength(2);
      expect(p1.totalCount).toBe(5);
      const p3 = listCodes(store, { page: 3, pageSize: 2 });
      expect(p3.list).toHaveLength(1); // 5 - 4 = 1
    });

    it('store 缺失/非数组 → 抛 SYS_DB_ERROR', () => {
      expect(() => listCodes({}, {})).toThrow();
      expect(() => listCodes(null, {})).toThrow();
    });
  });

  describe('disableCode', () => {
    it('unused 码 → 返回 {code, status:disabled}', () => {
      const store = { InviteCode: [code('ABC123', 'unused')] };
      const out = disableCode({ store, code: 'ABC123' });
      expect(out).toEqual({ code: 'ABC123', status: 'disabled' });
    });

    it('used 码 → 抛 BIZ_INVITE_CODE_USED（已用码不可禁用）', () => {
      const store = { InviteCode: [code('ABC123', 'used')] };
      expect(() => disableCode({ store, code: 'ABC123' })).toThrow();
    });

    it('已禁用码 → 抛 BIZ_INVITE_CODE_DISABLED', () => {
      const store = { InviteCode: [code('ABC123', 'disabled')] };
      expect(() => disableCode({ store, code: 'ABC123' })).toThrow();
    });

    it('码不存在 → 抛 BIZ_INVITE_CODE_INVALID', () => {
      const store = { InviteCode: [] };
      expect(() => disableCode({ store, code: 'ABC123' })).toThrow();
    });

    it('code 缺失 → 抛 BIZ_PARAM_MISSING', () => {
      const store = { InviteCode: [] };
      expect(() => disableCode({ store })).toThrow();
    });
  });

  describe('projectInviteCode', () => {
    it('下发白名单字段，不下发 used_by / created_by', () => {
      const out = projectInviteCode(code('ABC123', 'used', { used_by: 'oSECRET', used_at: new Date('2026-07-08') }));
      expect(out.code).toBe('ABC123');
      expect(out.status).toBe('used');
      expect(out.used_by).toBeUndefined();
      expect(out.created_by).toBeUndefined();
    });

    it('空输入兜底 null', () => {
      expect(projectInviteCode(null)).toBeNull();
    });
  });
});
