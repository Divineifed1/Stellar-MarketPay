-- Database migration: Create insurance and SLA monitoring tables
-- Decentralized Storage Insurance (SLA Verification)

-- Table: insured_files
-- Stores information about files covered by insurance
CREATE TABLE IF NOT EXISTS insured_files (
    id SERIAL PRIMARY KEY,
    cid VARCHAR(255) NOT NULL UNIQUE,  -- Content Identifier (IPFS/Arweave)
    owner_address VARCHAR(56) NOT NULL,  -- Stellar address
    file_size INTEGER NOT NULL,  -- File size in MB
    file_value DECIMAL(20, 7) NOT NULL,  -- File value in XLM
    premium DECIMAL(20, 7) NOT NULL,  -- Insurance premium in XLM
    storage_type VARCHAR(20) NOT NULL DEFAULT 'ipfs',  -- 'ipfs' or 'arweave'
    status VARCHAR(50) NOT NULL DEFAULT 'active',  -- active, expired, claimed
    availability_score DECIMAL(5, 4) DEFAULT 1.0,  -- 0-1 availability percentage
    checks_total INTEGER DEFAULT 0,  -- Total availability checks performed
    checks_passed INTEGER DEFAULT 0,  -- Number of passed checks
    last_checked TIMESTAMP,  -- Last availability check timestamp
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT valid_file_size CHECK (file_size > 0),
    CONSTRAINT valid_file_value CHECK (file_value > 0),
    CONSTRAINT valid_premium CHECK (premium > 0),
    CONSTRAINT valid_availability CHECK (availability_score >= 0 AND availability_score <= 1),
    CONSTRAINT valid_storage_type CHECK (storage_type IN ('ipfs', 'arweave'))
);

CREATE INDEX idx_insured_files_owner ON insured_files(owner_address);
CREATE INDEX idx_insured_files_status ON insured_files(status);
CREATE INDEX idx_insured_files_created_at ON insured_files(created_at DESC);

-- Table: insurance_claims
-- Stores insurance claims from users when SLA is violated
CREATE TABLE IF NOT EXISTS insurance_claims (
    id SERIAL PRIMARY KEY,
    file_id INTEGER NOT NULL REFERENCES insured_files(id) ON DELETE CASCADE,
    owner_address VARCHAR(56) NOT NULL,  -- Claimant's Stellar address
    claim_amount DECIMAL(20, 7) NOT NULL,  -- Claim payout amount in XLM
    status VARCHAR(50) NOT NULL DEFAULT 'pending',  -- pending, proof_submitted, approved, rejected

    -- Evidence and proof
    evidence JSONB,  -- Availability metrics at time of claim
    oracle_proof JSONB,  -- Oracle verification proof
    oracle_address VARCHAR(56),  -- Oracle address that submitted proof

    -- Payout tracking
    payout_tx_hash VARCHAR(255),  -- Blockchain transaction hash
    rejection_reason VARCHAR(500),  -- Reason for rejection if rejected

    -- Timestamps
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    proof_submitted_at TIMESTAMP,  -- When oracle proof was submitted
    paid_at TIMESTAMP,  -- When claim was paid out
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT valid_claim_amount CHECK (claim_amount > 0),
    CONSTRAINT valid_status CHECK (
        status IN ('pending', 'proof_submitted', 'approved', 'rejected')
    ),
    CONSTRAINT unique_active_claim_per_file UNIQUE (file_id) WHERE status != 'rejected'
);

CREATE INDEX idx_insurance_claims_file_id ON insurance_claims(file_id);
CREATE INDEX idx_insurance_claims_owner ON insurance_claims(owner_address);
CREATE INDEX idx_insurance_claims_status ON insurance_claims(status);
CREATE INDEX idx_insurance_claims_created_at ON insurance_claims(created_at DESC);
CREATE INDEX idx_insurance_claims_proof_submitted ON insurance_claims(proof_submitted_at);

-- Table: availability_check_history
-- Maintains history of availability checks for audit and analytics
CREATE TABLE IF NOT EXISTS availability_check_history (
    id SERIAL PRIMARY KEY,
    file_id INTEGER NOT NULL REFERENCES insured_files(id) ON DELETE CASCADE,
    cid VARCHAR(255) NOT NULL,
    is_available BOOLEAN NOT NULL,
    check_duration_ms INTEGER,  -- How long the check took
    error_message VARCHAR(500),  -- Error message if check failed
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_availability_check_file ON availability_check_history(file_id);
CREATE INDEX idx_availability_check_created ON availability_check_history(created_at DESC);

-- Table: oracle_proofs
-- Maintains detailed oracle proof records
CREATE TABLE IF NOT EXISTS oracle_proofs (
    id SERIAL PRIMARY KEY,
    claim_id INTEGER NOT NULL REFERENCES insurance_claims(id) ON DELETE CASCADE,
    oracle_address VARCHAR(56) NOT NULL,
    proof_data JSONB NOT NULL,  -- Detailed proof data
    proof_type VARCHAR(50),  -- Type of proof (signature, hash, etc)
    verified BOOLEAN DEFAULT FALSE,
    verification_error VARCHAR(500),
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    verified_at TIMESTAMP
);

CREATE INDEX idx_oracle_proofs_claim ON oracle_proofs(claim_id);
CREATE INDEX idx_oracle_proofs_oracle ON oracle_proofs(oracle_address);
CREATE INDEX idx_oracle_proofs_verified ON oracle_proofs(verified);

-- Table: insurance_premiums_paid
-- Tracks premium payments received from users
CREATE TABLE IF NOT EXISTS insurance_premiums_paid (
    id SERIAL PRIMARY KEY,
    file_id INTEGER NOT NULL REFERENCES insured_files(id) ON DELETE CASCADE,
    owner_address VARCHAR(56) NOT NULL,
    premium_amount DECIMAL(20, 7) NOT NULL,
    payment_tx_hash VARCHAR(255),
    payment_status VARCHAR(50) DEFAULT 'pending',  -- pending, confirmed, failed
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    confirmed_at TIMESTAMP
);

CREATE INDEX idx_premiums_file ON insurance_premiums_paid(file_id);
CREATE INDEX idx_premiums_owner ON insurance_premiums_paid(owner_address);
CREATE INDEX idx_premiums_status ON insurance_premiums_paid(payment_status);

-- Table: sla_violations
-- Tracks all SLA violations for monitoring and analytics
CREATE TABLE IF NOT EXISTS sla_violations (
    id SERIAL PRIMARY KEY,
    file_id INTEGER NOT NULL REFERENCES insured_files(id) ON DELETE CASCADE,
    owner_address VARCHAR(56) NOT NULL,
    violation_type VARCHAR(50),  -- unavailable, degraded, timeout
    availability_score DECIMAL(5, 4),
    reported_by VARCHAR(56),  -- Reporter's address
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_violations_file ON sla_violations(file_id);
CREATE INDEX idx_violations_owner ON sla_violations(owner_address);
CREATE INDEX idx_violations_created ON sla_violations(created_at DESC);

-- View: insurance_summary
-- Provides summary statistics for insurance program
CREATE OR REPLACE VIEW insurance_summary AS
SELECT
    (SELECT COUNT(*) FROM insured_files WHERE status = 'active') as active_policies,
    (SELECT COUNT(*) FROM insurance_claims WHERE status = 'pending') as pending_claims,
    (SELECT COUNT(*) FROM insurance_claims WHERE status = 'proof_submitted') as submitted_proofs,
    (SELECT COUNT(*) FROM insurance_claims WHERE status = 'approved') as approved_claims,
    (SELECT COUNT(*) FROM insurance_claims WHERE status = 'rejected') as rejected_claims,
    (SELECT COALESCE(SUM(premium), 0) FROM insured_files WHERE status = 'active') as total_premiums_active,
    (SELECT COALESCE(SUM(claim_amount), 0) FROM insurance_claims WHERE status = 'approved') as total_payouts,
    (SELECT AVG(availability_score) FROM insured_files WHERE status = 'active') as avg_system_availability,
    (SELECT COUNT(*) FROM sla_violations) as total_violations;
