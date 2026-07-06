/**
 * home 活动状态感知纯函数单测。
 * 覆盖 deriveStatusFromTime / deriveHomeStatus（时间推算 + 无时间退化）/ needsFetchStatus / shouldLoadData。
 *
 * 核心回归：时间窗口优先于 status 字符串快照——活动跨 end_time 后 status 仍='pending' 时，
 * 用时间实时推算应得 ended（修复登录后「活动未开始」一闪而过 →「活动已结束」的竞态）。
 */
const {
  STATUS,
  deriveHomeStatus,
  deriveStatusFromTime,
  needsFetchStatus,
  shouldLoadData
} = require('../../miniprogram/pages/home/homeStatus');

// 固定时间窗口 + 三个探测时间点（与后端 deriveStatus 同口径：Date.parse 字符串）。
const START = '2026-07-01T00:00:00+08:00';
const END = '2026-07-21T23:59:59+08:00';
const PAST = '2026-06-20T00:00:00+08:00'; // now<start → pending
const NOW = '2026-07-10T12:00:00+08:00'; // start<now<end → active
const FUTURE = '2026-08-01T00:00:00+08:00'; // now>end → ended

describe('homeStatus 活动状态感知', () => {
  describe('deriveStatusFromTime（与后端 deriveStatus 同口径）', () => {
    it('now<start → pending', () => {
      expect(deriveStatusFromTime(START, END, PAST)).toBe('pending');
    });

    it('start<now<end → active', () => {
      expect(deriveStatusFromTime(START, END, NOW)).toBe('active');
    });

    it('now>end → ended', () => {
      expect(deriveStatusFromTime(START, END, FUTURE)).toBe('ended');
    });

    it('start/end 都缺 → pending（保守，与后端一致）', () => {
      expect(deriveStatusFromTime(null, null, NOW)).toBe('pending');
    });

    it('end 缺 → pending（缺时间信息保守）', () => {
      expect(deriveStatusFromTime(START, null, NOW)).toBe('pending');
    });

    it('now 接受 number 时间戳', () => {
      expect(deriveStatusFromTime(START, END, Date.parse(NOW))).toBe('active');
    });
  });

  describe('deriveHomeStatus', () => {
    describe('时间窗口优先（实时推算——核心修复）', () => {
      it('时间在窗口内 → active', () => {
        expect(deriveHomeStatus({ activity_id: 'a1', start_time: START, end_time: END }, NOW)).toBe(STATUS.ACTIVE);
      });

      it('now<start + 有 id → pending（未开始）', () => {
        expect(deriveHomeStatus({ activity_id: 'a1', start_time: START, end_time: END }, PAST)).toBe(STATUS.PENDING);
      });

      it('now>end → ended', () => {
        expect(deriveHomeStatus({ activity_id: 'a1', start_time: START, end_time: END }, FUTURE)).toBe(STATUS.ENDED);
      });

      it('now<start + 无 id → none（边界：有时间窗口但无 id 视为无活动）', () => {
        expect(deriveHomeStatus({ activity_id: '', start_time: START, end_time: END }, PAST)).toBe(STATUS.NONE);
      });

      // ★ 核心回归：status 字符串快照过时，时间推算纠正之
      it('时间=active 但 status 快照=pending → 仍 active（忽略过时快照）', () => {
        expect(deriveHomeStatus({ activity_id: 'a1', start_time: START, end_time: END, status: 'pending' }, NOW)).toBe(
          STATUS.ACTIVE
        );
      });

      it('时间=ended 但 status 快照=pending → ended（修复「未开始一闪 → 已结束」）', () => {
        expect(deriveHomeStatus({ activity_id: 'a1', start_time: START, end_time: END, status: 'pending' }, FUTURE)).toBe(
          STATUS.ENDED
        );
      });

      it('时间=ended 但 status 快照=active → ended', () => {
        expect(deriveHomeStatus({ activity_id: 'a1', start_time: START, end_time: END, status: 'active' }, FUTURE)).toBe(
          STATUS.ENDED
        );
      });

      it('纯函数：不修改入参对象', () => {
        const input = { activity_id: 'a1', start_time: START, end_time: END, status: 'pending' };
        deriveHomeStatus(input, NOW);
        expect(input).toEqual({ activity_id: 'a1', start_time: START, end_time: END, status: 'pending' });
      });
    });

    describe('无时间窗口 → 退化 status 字符串（兼容冷启动 / 旧 mock）', () => {
      it('status=active → active', () => {
        expect(deriveHomeStatus({ activity_id: 'a1', status: 'active' })).toBe(STATUS.ACTIVE);
      });

      it('status=ended → ended（有历史战绩可归档展示）', () => {
        expect(deriveHomeStatus({ activity_id: 'a1', status: 'ended' })).toBe(STATUS.ENDED);
      });

      it('status=pending + 有 activity_id → pending（活动已发布但未到开始时间）', () => {
        expect(deriveHomeStatus({ activity_id: 'a1', status: 'pending' })).toBe(STATUS.PENDING);
      });

      it('status=pending + activity_id 空 → none（库无活动：current 返回 pending 但 id 空）', () => {
        expect(deriveHomeStatus({ activity_id: '', status: 'pending' })).toBe(STATUS.NONE);
      });

      it('status=pending + 无 activity_id 字段 → none', () => {
        expect(deriveHomeStatus({ status: 'pending' })).toBe(STATUS.NONE);
      });

      it('status 空 → unknown（globalData 尚未写入）', () => {
        expect(deriveHomeStatus({ activity_id: '', status: '' })).toBe(STATUS.UNKNOWN);
      });

      it('status 字段缺失 → unknown', () => {
        expect(deriveHomeStatus({})).toBe(STATUS.UNKNOWN);
      });

      it('入参 null / undefined → unknown', () => {
        expect(deriveHomeStatus(null)).toBe(STATUS.UNKNOWN);
        expect(deriveHomeStatus(undefined)).toBe(STATUS.UNKNOWN);
      });

      it('未知 status 值 → unknown（保守降级）', () => {
        expect(deriveHomeStatus({ activity_id: 'a1', status: 'foobar' })).toBe(STATUS.UNKNOWN);
      });
    });
  });

  describe('needsFetchStatus（新判据：无时间且无 status 才 fetch）', () => {
    it('有时间窗口 → false（用时间实时推算）', () => {
      expect(needsFetchStatus({ activity_id: 'a1', start_time: START, end_time: END, status: 'active' })).toBe(false);
    });

    it('仅有 start_time → false（已可推算）', () => {
      expect(needsFetchStatus({ activity_id: 'a1', start_time: START })).toBe(false);
    });

    it('无时间但有 status → false（退化路径可算）', () => {
      expect(needsFetchStatus({ activity_id: 'a1', status: 'active' })).toBe(false);
    });

    it('无活动但 status 明确(pending) → false', () => {
      expect(needsFetchStatus({ activity_id: '', status: 'pending' })).toBe(false);
    });

    it('初始 globalData（id/name 空 + 无时间无 status）→ true', () => {
      expect(needsFetchStatus({ activity_id: '', name: '', status: '' })).toBe(true);
    });

    it('空对象 → true（冷启动）', () => {
      expect(needsFetchStatus({})).toBe(true);
    });

    it('入参 null → true', () => {
      expect(needsFetchStatus(null)).toBe(true);
    });
  });

  describe('shouldLoadData', () => {
    it('active → true', () => {
      expect(shouldLoadData(STATUS.ACTIVE)).toBe(true);
    });

    it('ended → true（战绩归档：历史数据可展示）', () => {
      expect(shouldLoadData(STATUS.ENDED)).toBe(true);
    });

    it('pending → false（空态不发起请求）', () => {
      expect(shouldLoadData(STATUS.PENDING)).toBe(false);
    });

    it('none → false', () => {
      expect(shouldLoadData(STATUS.NONE)).toBe(false);
    });

    it('unknown → false（等补调结果再决定是否加载）', () => {
      expect(shouldLoadData(STATUS.UNKNOWN)).toBe(false);
    });
  });
});
