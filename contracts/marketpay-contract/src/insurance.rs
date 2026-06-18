/*
 * contracts/marketpay-contract/src/insurance.rs
 *
 * Soroban Smart Contract for Decentralized Storage Insurance
 *
 * Manages insurance premiums, claims, and payouts for file storage on IPFS/Arweave.
 * Uses oracle proofs to verify file availability and automatically trigger payouts
 * when SLA violations occur.
 */

use soroban_sdk::{
    contract, contractimpl, contracttype, token, Address, Bytes, Env, String, Symbol,
    symbol_short, Vec, Map,
};

// ─── Insurance Data Structures ─────────────────────────────────────────────────

/// Insurance policy status
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum InsuranceStatus {
    Active,
    Suspended,
    Claimed,
    Expired,
}

/// Insurance claim status
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum ClaimStatus {
    Pending,
    ProofSubmitted,
    Approved,
    Rejected,
    Paid,
}

/// Insurance policy record
#[contracttype]
#[derive(Clone, Debug)]
pub struct InsurancePolicy {
    /// Unique policy ID
    pub policy_id: String,
    /// File content identifier (CID)
    pub cid: String,
    /// Policy owner address
    pub owner: Address,
    /// Insurance premium amount (stroops)
    pub premium: i128,
    /// File declared value (stroops)
    pub file_value: i128,
    /// Maximum payout (stroops)
    pub max_payout: i128,
    /// Current policy status
    pub status: InsuranceStatus,
    /// Storage type: "ipfs" or "arweave"
    pub storage_type: String,
    /// Ledger when policy was created
    pub created_ledger: u32,
    /// Policy expiration ledger (0 = no expiration)
    pub expiration_ledger: u32,
    /// Token address (XLM native or USDC)
    pub token: Address,
    /// Last SLA check timestamp
    pub last_check_timestamp: u64,
    /// Current availability score (0-1, scaled to 0-1000000)
    pub availability_score: u32,
}

/// Insurance claim record
#[contracttype]
#[derive(Clone, Debug)]
pub struct InsuranceClaim {
    /// Unique claim ID
    pub claim_id: String,
    /// Associated policy ID
    pub policy_id: String,
    /// Claimant address
    pub claimant: Address,
    /// Claim amount (stroops)
    pub claim_amount: i128,
    /// Claim status
    pub status: ClaimStatus,
    /// Oracle that verified the claim
    pub oracle: Option<Address>,
    /// Oracle proof data
    pub oracle_proof: Option<Bytes>,
    /// Payout transaction ledger
    pub payout_ledger: Option<u32>,
    /// Creation ledger
    pub created_ledger: u32,
    /// Last update ledger
    pub updated_ledger: u32,
}

/// Oracle proof of file unavailability
#[contracttype]
#[derive(Clone, Debug)]
pub struct OracleProof {
    /// File CID being checked
    pub cid: String,
    /// Proof of unavailability
    pub proof_data: Bytes,
    /// Oracle signature
    pub signature: Bytes,
    /// Timestamp of check
    pub check_timestamp: u64,
    /// Number of unavailability checks
    pub failed_checks: u32,
    /// Total checks performed
    pub total_checks: u32,
}

// ─── Insurance Contract ────────────────────────────────────────────────────────

#[contract]
pub struct InsuranceContract;

#[contractimpl]
impl InsuranceContract {
    /// Initialize insurance contract with admin
    /// Called once during contract deployment
    pub fn initialize(env: Env, admin: Address, token: Address) {
        admin.require_auth();

        let key = Symbol::new(&env, "admin");
        env.storage().instance().set(&key, &admin);

        let token_key = Symbol::new(&env, "token");
        env.storage().instance().set(&token_key, &token);

        // Initialize counters
        let policy_counter = Symbol::new(&env, "policy_counter");
        env.storage().instance().set(&policy_counter, &0u32);

        let claim_counter = Symbol::new(&env, "claim_counter");
        env.storage().instance().set(&claim_counter, &0u32);

        env.events().publish(
            (Symbol::new(&env, "initialized"),),
            (admin, token),
        );
    }

    /// Create an insurance policy for a file
    ///
    /// # Arguments
    /// * `owner` - File owner's address
    /// * `cid` - Content identifier
    /// * `file_value` - Declared value of the file (stroops)
    /// * `storage_type` - "ipfs" or "arweave"
    /// * `duration_ledgers` - Policy duration in ledgers (0 = no expiration)
    pub fn create_policy(
        env: Env,
        owner: Address,
        cid: String,
        file_value: i128,
        storage_type: String,
        duration_ledgers: u32,
    ) -> InsurancePolicy {
        owner.require_auth();

        // Validate inputs
        if file_value <= 0 {
            panic!("File value must be positive");
        }

        if cid.len() == 0 || cid.len() > 255 {
            panic!("Invalid CID");
        }

        let valid_storage = storage_type.to_utf8().unwrap_or_default();
        if valid_storage != "ipfs" && valid_storage != "arweave" {
            panic!("Invalid storage type");
        }

        // Calculate premium (2% base premium)
        let premium = (file_value * 2) / 100;

        // Get current ledger
        let current_ledger = env.ledger().sequence();
        let expiration_ledger = if duration_ledgers > 0 {
            current_ledger + duration_ledgers
        } else {
            0
        };

        // Generate policy ID
        let policy_counter_key = Symbol::new(&env, "policy_counter");
        let counter: u32 = env.storage()
            .instance()
            .get(&policy_counter_key)
            .unwrap_or(0u32);
        let new_counter = counter + 1;
        env.storage().instance().set(&policy_counter_key, &new_counter);

        let policy_id = String::from_slice(
            &env,
            format!("POL-{}", new_counter).as_bytes(),
        );

        // Get token address
        let token_key = Symbol::new(&env, "token");
        let token: Address = env.storage()
            .instance()
            .get(&token_key)
            .expect("Token not initialized");

        let policy = InsurancePolicy {
            policy_id: policy_id.clone(),
            cid: cid.clone(),
            owner: owner.clone(),
            premium,
            file_value,
            max_payout: file_value, // Max payout is 100% of file value
            status: InsuranceStatus::Active,
            storage_type,
            created_ledger: current_ledger,
            expiration_ledger,
            token,
            last_check_timestamp: 0,
            availability_score: 1_000_000, // Full availability initially (1.0 scaled)
        };

        // Store policy
        let key = Symbol::new(&env, &format!("policy_{}", policy_id.to_utf8().unwrap_or_default()));
        env.storage().instance().set(&key, &policy);

        // Store owner mapping
        let owner_key = Symbol::new(&env, &format!("owner_policies_{}", owner.to_string()));
        let mut policies: Vec<String> = env.storage()
            .instance()
            .get(&owner_key)
            .unwrap_or(Vec::new(&env));
        policies.push_back(policy_id.clone());
        env.storage().instance().set(&owner_key, &policies);

        env.events().publish(
            (Symbol::new(&env, "policy_created"),),
            (&policy_id, &owner, file_value, premium),
        );

        policy
    }

    /// Submit oracle proof of file unavailability
    ///
    /// # Arguments
    /// * `policy_id` - Policy ID
    /// * `proof` - Oracle proof of unavailability
    /// * `oracle` - Oracle's address
    pub fn submit_availability_proof(
        env: Env,
        policy_id: String,
        proof: OracleProof,
        oracle: Address,
    ) -> InsuranceClaim {
        oracle.require_auth();

        // Retrieve policy
        let policy_key = Symbol::new(&env, &format!("policy_{}", policy_id.to_utf8().unwrap_or_default()));
        let mut policy: InsurancePolicy = env.storage()
            .instance()
            .get(&policy_key)
            .expect("Policy not found");

        // Verify proof CID matches policy
        if proof.cid != policy.cid {
            panic!("CID mismatch");
        }

        // Calculate availability score
        let availability_score = if proof.total_checks > 0 {
            ((proof.total_checks - proof.failed_checks) as i128 * 1_000_000 / proof.total_checks as i128) as u32
        } else {
            1_000_000
        };

        // Update policy availability score
        policy.availability_score = availability_score;
        policy.last_check_timestamp = proof.check_timestamp;
        env.storage().instance().set(&policy_key, &policy);

        // Check if availability is below threshold (99% = 990_000)
        if availability_score >= 990_000 {
            panic!("Availability above threshold; no claim justified");
        }

        // Create insurance claim
        let claim_counter_key = Symbol::new(&env, "claim_counter");
        let counter: u32 = env.storage()
            .instance()
            .get(&claim_counter_key)
            .unwrap_or(0u32);
        let new_counter = counter + 1;
        env.storage().instance().set(&claim_counter_key, &new_counter);

        let claim_id = String::from_slice(
            &env,
            format!("CLM-{}", new_counter).as_bytes(),
        );

        // Calculate claim amount based on availability score
        // Full payout if 0% available, scaled down as availability increases
        let claim_amount = (policy.max_payout * (1_000_000 - availability_score) as i128) / 1_000_000;

        let current_ledger = env.ledger().sequence();
        let claim = InsuranceClaim {
            claim_id: claim_id.clone(),
            policy_id: policy_id.clone(),
            claimant: policy.owner.clone(),
            claim_amount,
            status: ClaimStatus::ProofSubmitted,
            oracle: Some(oracle.clone()),
            oracle_proof: Some(proof.proof_data),
            payout_ledger: None,
            created_ledger: current_ledger,
            updated_ledger: current_ledger,
        };

        // Store claim
        let claim_key = Symbol::new(&env, &format!("claim_{}", claim_id.to_utf8().unwrap_or_default()));
        env.storage().instance().set(&claim_key, &claim);

        env.events().publish(
            (Symbol::new(&env, "claim_submitted"),),
            (&claim_id, &policy_id, claim_amount),
        );

        claim
    }

    /// Approve and pay out an insurance claim
    ///
    /// # Arguments
    /// * `claim_id` - Claim ID
    pub fn approve_and_payout(
        env: Env,
        claim_id: String,
    ) {
        let admin_key = Symbol::new(&env, "admin");
        let admin: Address = env.storage()
            .instance()
            .get(&admin_key)
            .expect("Admin not set");
        admin.require_auth();

        // Retrieve claim
        let claim_key = Symbol::new(&env, &format!("claim_{}", claim_id.to_utf8().unwrap_or_default()));
        let mut claim: InsuranceClaim = env.storage()
            .instance()
            .get(&claim_key)
            .expect("Claim not found");

        if claim.status != ClaimStatus::ProofSubmitted {
            panic!("Claim must be in ProofSubmitted status");
        }

        // Transfer payout to claimant
        let token_key = Symbol::new(&env, "token");
        let token: Address = env.storage()
            .instance()
            .get(&token_key)
            .expect("Token not set");

        let token_contract = token::Client::new(&env, &token);

        // Get contract's balance
        let contract_id = env.current_contract_address();
        let balance = token_contract.balance(&contract_id);

        if balance < claim.claim_amount {
            panic!("Insufficient funds for payout");
        }

        token_contract.transfer(
            &contract_id,
            &claim.claimant,
            &claim.claim_amount,
        );

        // Update claim status
        claim.status = ClaimStatus::Paid;
        claim.payout_ledger = Some(env.ledger().sequence());
        claim.updated_ledger = env.ledger().sequence();
        env.storage().instance().set(&claim_key, &claim);

        // Mark policy as claimed
        let policy_key = Symbol::new(&env, &format!("policy_{}", claim.policy_id.to_utf8().unwrap_or_default()));
        let mut policy: InsurancePolicy = env.storage()
            .instance()
            .get(&policy_key)
            .expect("Policy not found");
        policy.status = InsuranceStatus::Claimed;
        env.storage().instance().set(&policy_key, &policy);

        env.events().publish(
            (Symbol::new(&env, "claim_paid"),),
            (&claim_id, &claim.claimant, claim.claim_amount),
        );
    }

    /// Reject an insurance claim
    ///
    /// # Arguments
    /// * `claim_id` - Claim ID
    /// * `reason` - Rejection reason
    pub fn reject_claim(
        env: Env,
        claim_id: String,
        reason: String,
    ) {
        let admin_key = Symbol::new(&env, "admin");
        let admin: Address = env.storage()
            .instance()
            .get(&admin_key)
            .expect("Admin not set");
        admin.require_auth();

        // Retrieve and update claim
        let claim_key = Symbol::new(&env, &format!("claim_{}", claim_id.to_utf8().unwrap_or_default()));
        let mut claim: InsuranceClaim = env.storage()
            .instance()
            .get(&claim_key)
            .expect("Claim not found");

        claim.status = ClaimStatus::Rejected;
        claim.updated_ledger = env.ledger().sequence();
        env.storage().instance().set(&claim_key, &claim);

        env.events().publish(
            (Symbol::new(&env, "claim_rejected"),),
            (&claim_id, reason),
        );
    }

    /// Get policy details
    pub fn get_policy(env: Env, policy_id: String) -> InsurancePolicy {
        let key = Symbol::new(&env, &format!("policy_{}", policy_id.to_utf8().unwrap_or_default()));
        env.storage()
            .instance()
            .get(&key)
            .expect("Policy not found")
    }

    /// Get claim details
    pub fn get_claim(env: Env, claim_id: String) -> InsuranceClaim {
        let key = Symbol::new(&env, &format!("claim_{}", claim_id.to_utf8().unwrap_or_default()));
        env.storage()
            .instance()
            .get(&key)
            .expect("Claim not found")
    }
}
