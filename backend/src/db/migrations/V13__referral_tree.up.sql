-- V13: Referral Tree with Multi-Level Rewards
--
-- Adds parent_address to the referrals table to model the tree relationship.
-- Adds a multi_level_payouts table to audit every ancestor reward emitted
-- during escrow release.
--
-- The referrals table already has (referrer_address, referee_address) for the
-- direct pair.  parent_address is synonymous with referrer_address for level-1
-- entries; for higher-level ancestors the backend records separate rows in
-- multi_level_payouts rather than in the referrals table itself.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Add depth + parent columns to existing referrals table
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE referrals
  ADD COLUMN IF NOT EXISTS depth          INTEGER NOT NULL DEFAULT 1
    CHECK (depth >= 1 AND depth <= 3),
  ADD COLUMN IF NOT EXISTS parent_address TEXT REFERENCES profiles(public_key);

-- Back-fill parent_address from referrer_address for existing rows
UPDATE referrals
  SET parent_address = referrer_address
  WHERE parent_address IS NULL;

CREATE INDEX IF NOT EXISTS referrals_parent_address_idx
  ON referrals(parent_address);

CREATE INDEX IF NOT EXISTS referrals_referee_depth_idx
  ON referrals(referee_address, depth);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. referral_tree — stores the full parent/child relationships
--    (mirrors the on-chain ReferralParent/ReferralChildren storage)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS referral_tree (
  child_address   TEXT  NOT NULL REFERENCES profiles(public_key),
  parent_address  TEXT  NOT NULL REFERENCES profiles(public_key),
  depth           INTEGER NOT NULL DEFAULT 1,   -- depth of child in the tree
  registered_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- On-chain tx hash of the register_referral_tree() call (optional)
  on_chain_tx     TEXT,
  PRIMARY KEY (child_address),                  -- each child has exactly one parent
  CHECK (child_address <> parent_address)       -- self-referral forbidden
);

CREATE INDEX IF NOT EXISTS referral_tree_parent_idx
  ON referral_tree(parent_address);

CREATE INDEX IF NOT EXISTS referral_tree_depth_idx
  ON referral_tree(depth);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. multi_level_payouts — audit log for every ancestor reward
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS multi_level_payouts (
  id                UUID  PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id            UUID  NOT NULL REFERENCES jobs(id),
  freelancer_address TEXT NOT NULL REFERENCES profiles(public_key),
  recipient_address  TEXT NOT NULL REFERENCES profiles(public_key),
  level             INTEGER NOT NULL CHECK (level >= 1 AND level <= 3),
  amount_xlm        NUMERIC(20,7) NOT NULL,
  contract_tx_hash  TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS multi_level_payouts_job_idx
  ON multi_level_payouts(job_id);

CREATE INDEX IF NOT EXISTS multi_level_payouts_recipient_idx
  ON multi_level_payouts(recipient_address);

CREATE INDEX IF NOT EXISTS multi_level_payouts_freelancer_idx
  ON multi_level_payouts(freelancer_address);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. View: referral_tree_stats — convenience view for the dashboard API
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW referral_tree_stats AS
SELECT
  rt.parent_address                                                AS referrer_address,
  COUNT(DISTINCT rt.child_address)                                AS direct_referrals,
  COUNT(DISTINCT rt2.child_address)                               AS level2_referrals,
  COUNT(DISTINCT rt3.child_address)                               AS level3_referrals,
  COALESCE(SUM(mlp.amount_xlm), 0)                                AS total_tree_earned_xlm
FROM referral_tree rt
LEFT JOIN referral_tree rt2 ON rt2.parent_address = rt.child_address
LEFT JOIN referral_tree rt3 ON rt3.parent_address = rt2.child_address
LEFT JOIN multi_level_payouts mlp ON mlp.recipient_address = rt.parent_address
GROUP BY rt.parent_address;
