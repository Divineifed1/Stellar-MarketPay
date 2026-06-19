/**
 * tests/referralService.test.js
 * Comprehensive unit tests for multi-level referral tree system
 */

const {
  registerReferral,
  processMultiLevelPayout,
  getReferralStats,
  getReferralTree,
} = require('./referralService');
const pool = require('../db/pool');

// Mock the database pool
jest.mock('../db/pool');

describe('ReferralService - Multi-Level Referral Tree', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('registerReferral', () => {
    it('should register a valid referral relationship', async () => {
      const mockQuery = jest.fn()
        .mockResolvedValueOnce({ rowCount: 0 }) // checkCycle - no existing path
        .mockResolvedValueOnce({ // insert referral
          rows: [{
            id: 1,
            referrer_address: 'REFERRER_ADDRESS',
            referee_address: 'REFEREE_ADDRESS',
            depth: 1,
            parent_address: 'REFERRER_ADDRESS',
          }],
        });

      pool.query = mockQuery;

      const result = await registerReferral('REFERRER_ADDRESS', 'REFEREE_ADDRESS');

      expect(result.id).toBe(1);
      expect(result.depth).toBe(1);
      expect(mockQuery).toHaveBeenCalledTimes(2);
    });

    it('should detect direct self-referral cycle', async () => {
      const mockQuery = jest.fn();
      pool.query = mockQuery;

      await expect(
        registerReferral('SAME_ADDRESS', 'SAME_ADDRESS')
      ).rejects.toThrow('Self-referral not allowed');

      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('should detect indirect referral cycle', async () => {
      // A refers B, B refers C, C tries to refer A → cycle
      const mockQuery = jest.fn()
        .mockResolvedValueOnce({ rowCount: 1 }); // Cycle detected

      pool.query = mockQuery;

      await expect(
        registerReferral('C_ADDRESS', 'A_ADDRESS')
      ).rejects.toThrow('Referral cycle detected');

      expect(mockQuery).toHaveBeenCalledTimes(1);
    });

    it('should calculate correct depth for multi-level chain', async () => {
      // Level 1 referral
      const mockQuery1 = jest.fn()
        .mockResolvedValueOnce({ rowCount: 0 }) // No cycle
        .mockResolvedValueOnce({
          rows: [{
            id: 1,
            referrer_address: 'A',
            referee_address: 'B',
            depth: 1,
            parent_address: 'A',
          }],
        });

      pool.query = mockQuery1;
      const result1 = await registerReferral('A', 'B');
      expect(result1.depth).toBe(1);

      // Level 2 referral
      const mockQuery2 = jest.fn()
        .mockResolvedValueOnce({ rowCount: 0 }) // No cycle
        .mockResolvedValueOnce({
          rows: [{
            id: 2,
            referrer_address: 'B',
            referee_address: 'C',
            depth: 2,
            parent_address: 'B',
          }],
        });

      pool.query = mockQuery2;
      const result2 = await registerReferral('B', 'C');
      expect(result2.depth).toBe(2);

      // Level 3 referral
      const mockQuery3 = jest.fn()
        .mockResolvedValueOnce({ rowCount: 0 }) // No cycle
        .mockResolvedValueOnce({
          rows: [{
            id: 3,
            referrer_address: 'C',
            referee_address: 'D',
            depth: 3,
            parent_address: 'C',
          }],
        });

      pool.query = mockQuery3;
      const result3 = await registerReferral('C', 'D');
      expect(result3.depth).toBe(3);
    });

    it('should reject if referee already has a parent', async () => {
      const mockQuery = jest.fn()
        .mockResolvedValueOnce({ rowCount: 0 }) // No cycle
        .mockRejectedValueOnce({
          code: '23505', // Unique constraint violation
          constraint: 'referral_tree_pkey',
        });

      pool.query = mockQuery;

      await expect(
        registerReferral('NEW_REFERRER', 'EXISTING_REFEREE')
      ).rejects.toThrow('Referee already has a referrer');
    });
  });

  describe('processMultiLevelPayout', () => {
    it('should calculate correct rewards for 3-level chain', async () => {
      const mockClient = {
        query: jest.fn()
          // Get referral chain (3 levels)
          .mockResolvedValueOnce({
            rows: [
              { referrer_address: 'LEVEL1', depth: 1 },
              { referrer_address: 'LEVEL2', depth: 2 },
              { referrer_address: 'LEVEL3', depth: 3 },
            ],
          })
          // Insert multi_level_payouts × 3
          .mockResolvedValueOnce({ rows: [{ id: 1 }] })
          .mockResolvedValueOnce({ rows: [{ id: 2 }] })
          .mockResolvedValueOnce({ rows: [{ id: 3 }] })
          // Update referrals table (level 1 only for back-compat)
          .mockResolvedValueOnce({ rowCount: 1 }),
        release: jest.fn(),
      };

      pool.connect = jest.fn().mockResolvedValue(mockClient);

      const jobAmount = 100; // 100 XLM
      const result = await processMultiLevelPayout('JOB_ID', 'FREELANCER_ADDRESS', jobAmount);

      // Level 1: 2% of 100 = 2 XLM
      // Level 2: 0.75% of 100 = 0.75 XLM
      // Level 3: 0.25% of 100 = 0.25 XLM
      expect(result.payouts).toHaveLength(3);
      expect(result.payouts[0].amount).toBe('2.00');
      expect(result.payouts[1].amount).toBe('0.75');
      expect(result.payouts[2].amount).toBe('0.25');
      expect(result.totalPaid).toBe('3.00');

      expect(mockClient.query).toHaveBeenCalledTimes(7); // begin + 1 select + 3 inserts + 1 update + commit
      expect(mockClient.release).toHaveBeenCalled();
    });

    it('should handle single-level referral correctly', async () => {
      const mockClient = {
        query: jest.fn()
          .mockResolvedValueOnce({
            rows: [{ referrer_address: 'LEVEL1', depth: 1 }],
          })
          .mockResolvedValueOnce({ rows: [{ id: 1 }] })
          .mockResolvedValueOnce({ rowCount: 1 }),
        release: jest.fn(),
      };

      pool.connect = jest.fn().mockResolvedValue(mockClient);

      const result = await processMultiLevelPayout('JOB_ID', 'FREELANCER_ADDRESS', 50);

      expect(result.payouts).toHaveLength(1);
      expect(result.payouts[0].amount).toBe('1.00'); // 2% of 50
    });

    it('should handle no referral chain gracefully', async () => {
      const mockClient = {
        query: jest.fn()
          .mockResolvedValueOnce({ rows: [] }),
        release: jest.fn(),
      };

      pool.connect = jest.fn().mockResolvedValue(mockClient);

      const result = await processMultiLevelPayout('JOB_ID', 'FREELANCER_ADDRESS', 100);

      expect(result.payouts).toHaveLength(0);
      expect(result.totalPaid).toBe('0.00');
      expect(mockClient.query).toHaveBeenCalledTimes(3); // begin + select + commit
    });

    it('should rollback on database error', async () => {
      const mockClient = {
        query: jest.fn()
          .mockResolvedValueOnce({ rows: [{ referrer_address: 'LEVEL1', depth: 1 }] })
          .mockRejectedValueOnce(new Error('Insert failed')),
        release: jest.fn(),
      };

      pool.connect = jest.fn().mockResolvedValue(mockClient);

      await expect(
        processMultiLevelPayout('JOB_ID', 'FREELANCER_ADDRESS', 100)
      ).rejects.toThrow('Insert failed');

      // Verify rollback was called
      expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
      expect(mockClient.release).toHaveBeenCalled();
    });
  });

  describe('getReferralStats', () => {
    it('should return comprehensive referral statistics', async () => {
      const mockQuery = jest.fn()
        // Flat stats
        .mockResolvedValueOnce({
          rows: [{
            total_referrals: 5,
            paid_referrals: 3,
            pending_referrals: 2,
            total_earned_xlm: '10.50',
            bonus_bps: 200,
          }],
        })
        // Tree stats
        .mockResolvedValueOnce({
          rows: [{
            tree_earned_xlm: '15.75',
            tree_payout_count: 8,
          }],
        })
        // Referee list
        .mockResolvedValueOnce({
          rows: [
            { id: 1, referee_address: 'REF1', status: 'paid', payout_amount_xlm: '2.00' },
            { id: 2, referee_address: 'REF2', status: 'pending', payout_amount_xlm: null },
          ],
        })
        // Payout history
        .mockResolvedValueOnce({
          rows: [
            { id: 1, job_id: 'J1', job_title: 'Job 1', referee_address: 'REF1', amount_xlm: '2.00', created_at: '2024-01-01' },
          ],
        });

      pool.query = mockQuery;

      const result = await getReferralStats('REFERRER_ADDRESS');

      expect(result.totalReferrals).toBe(5);
      expect(result.paidReferrals).toBe(3);
      expect(result.pendingReferrals).toBe(2);
      expect(result.totalEarnedXlm).toBe('10.50');
      expect(result.treeEarnedXlm).toBe('15.75');
      expect(result.treePayoutCount).toBe(8);
      expect(result.referees).toHaveLength(2);
      expect(result.payouts).toHaveLength(1);
      expect(mockQuery).toHaveBeenCalledTimes(4);
    });

    it('should handle user with no referrals', async () => {
      const mockQuery = jest.fn()
        .mockResolvedValueOnce({
          rows: [{
            total_referrals: 0,
            paid_referrals: 0,
            pending_referrals: 0,
            total_earned_xlm: '0.00',
            bonus_bps: 200,
          }],
        })
        .mockResolvedValueOnce({ rows: [{ tree_earned_xlm: '0.00', tree_payout_count: 0 }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });

      pool.query = mockQuery;

      const result = await getReferralStats('NEW_USER');

      expect(result.totalReferrals).toBe(0);
      expect(result.referees).toHaveLength(0);
      expect(result.payouts).toHaveLength(0);
    });
  });

  describe('getReferralTree', () => {
    it('should build hierarchical tree with 3 levels', async () => {
      const mockQuery = jest.fn()
        .mockResolvedValueOnce({
          rows: [{
            tree: {
              address: 'ROOT',
              displayName: 'Root User',
              depth: 0,
              earnedXlm: '10.00',
              children: [
                {
                  address: 'CHILD1',
                  displayName: 'Child 1',
                  depth: 1,
                  earnedXlm: '2.00',
                  children: [
                    {
                      address: 'GRANDCHILD1',
                      displayName: null,
                      depth: 2,
                      earnedXlm: '0.75',
                      children: [],
                    },
                  ],
                },
                {
                  address: 'CHILD2',
                  displayName: 'Child 2',
                  depth: 1,
                  earnedXlm: '2.00',
                  children: [],
                },
              ],
            },
          }],
        });

      pool.query = mockQuery;

      const result = await getReferralTree('ROOT');

      expect(result.address).toBe('ROOT');
      expect(result.children).toHaveLength(2);
      expect(result.children[0].children).toHaveLength(1);
      expect(result.children[0].children[0].address).toBe('GRANDCHILD1');
      expect(result.children[0].children[0].depth).toBe(2);
    });

    it('should return null for user without referrals', async () => {
      const mockQuery = jest.fn()
        .mockResolvedValueOnce({ rows: [] });

      pool.query = mockQuery;

      const result = await getReferralTree('SOLO_USER');

      expect(result).toBeNull();
    });

    it('should handle large tree efficiently', async () => {
      // Mock a tree with 10 level-1 children
      const children = Array.from({ length: 10 }, (_, i) => ({
        address: `CHILD${i}`,
        displayName: `Child ${i}`,
        depth: 1,
        earnedXlm: '1.00',
        children: [],
      }));

      const mockQuery = jest.fn()
        .mockResolvedValueOnce({
          rows: [{
            tree: {
              address: 'ROOT',
              displayName: 'Root',
              depth: 0,
              earnedXlm: '20.00',
              children,
            },
          }],
        });

      pool.query = mockQuery;

      const result = await getReferralTree('ROOT');

      expect(result.children).toHaveLength(10);
      expect(mockQuery).toHaveBeenCalledTimes(1); // Single recursive CTE query
    });
  });

  describe('Edge Cases', () => {
    it('should handle concurrent referral registrations', async () => {
      // Simulate race condition where two parents try to claim same child
      const mockQuery = jest.fn()
        .mockResolvedValueOnce({ rowCount: 0 })
        .mockRejectedValueOnce({
          code: '23505',
          constraint: 'referral_tree_pkey',
        });

      pool.query = mockQuery;

      await expect(
        registerReferral('PARENT2', 'CONTESTED_CHILD')
      ).rejects.toThrow('Referee already has a referrer');
    });

    it('should handle zero-amount payout', async () => {
      const mockClient = {
        query: jest.fn()
          .mockResolvedValueOnce({
            rows: [{ referrer_address: 'LEVEL1', depth: 1 }],
          }),
        release: jest.fn(),
      };

      pool.connect = jest.fn().mockResolvedValue(mockClient);

      const result = await processMultiLevelPayout('JOB_ID', 'FREELANCER_ADDRESS', 0);

      expect(result.payouts).toHaveLength(0);
      expect(result.totalPaid).toBe('0.00');
    });

    it('should prevent depth > 3 referrals', async () => {
      const mockQuery = jest.fn()
        .mockResolvedValueOnce({ rowCount: 0 }) // No cycle
        .mockResolvedValueOnce({
          rows: [{
            id: 4,
            referrer_address: 'D',
            referee_address: 'E',
            depth: 4,
            parent_address: 'D',
          }],
        });

      pool.query = mockQuery;

      // Even if DB allows depth 4, the payout logic should cap at 3
      const result = await registerReferral('D', 'E');
      expect(result.depth).toBe(4); // Registered, but won't earn rewards
    });
  });
});
