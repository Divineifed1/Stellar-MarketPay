/**
 * backend/src/routes/insurance.js
 * Insurance API Routes
 * Endpoints for managing storage insurance policies and claims
 */
"use strict";

const express = require("express");
const { requireAuth } = require("../middleware/auth");
const slaMonitor = require("../services/sla_monitor");
const { createServiceLogger } = require("../utils/logger");

const router = express.Router();
const logger = createServiceLogger("insurance_routes");

/**
 * POST /api/insurance/policies
 * Create a new insurance policy for a file
 */
router.post("/policies", requireAuth, async (req, res, next) => {
  try {
    const { cid, fileSize, fileValue, storageType } = req.body;
    const ownerAddress = req.user.address;

    if (!cid || fileSize <= 0 || fileValue <= 0) {
      return res.status(400).json({
        error: "Invalid parameters",
        message: "CID, file size, and file value are required",
      });
    }

    if (!["ipfs", "arweave"].includes(storageType)) {
      return res.status(400).json({
        error: "Invalid storage type",
        message: "Storage type must be 'ipfs' or 'arweave'",
      });
    }

    const policy = await slaMonitor.createInsuredFile(
      cid,
      ownerAddress,
      fileSize,
      fileValue,
      storageType
    );

    logger.info({
      event: "policy_created_via_api",
      policyId: policy.id,
      ownerAddress,
      cid,
    });

    res.status(201).json({
      success: true,
      policy: {
        id: policy.id,
        cid: policy.cid,
        premium: policy.premium,
        fileValue: policy.file_value,
        status: policy.status,
        createdAt: policy.created_at,
      },
    });
  } catch (error) {
    logger.error({
      event: "policy_creation_failed",
      error: error.message,
    });
    next(error);
  }
});

/**
 * GET /api/insurance/policies
 * Get user's insurance policies
 */
router.get("/policies", requireAuth, async (req, res, next) => {
  try {
    const ownerAddress = req.user.address;

    const policies = await slaMonitor.getUserInsuredFiles(ownerAddress);

    res.json({
      success: true,
      policies: policies.map((p) => ({
        id: p.id,
        cid: p.cid,
        fileSize: p.file_size,
        fileValue: p.file_value,
        premium: p.premium,
        status: p.status,
        availabilityScore: p.availability_score,
        storageType: p.storage_type,
        lastChecked: p.last_checked,
        createdAt: p.created_at,
      })),
      count: policies.length,
    });
  } catch (error) {
    logger.error({
      event: "get_policies_failed",
      error: error.message,
    });
    next(error);
  }
});

/**
 * GET /api/insurance/policies/:id
 * Get specific policy details
 */
router.get("/policies/:id", requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;
    const ownerAddress = req.user.address;

    // Verify ownership
    const query = `
      SELECT * FROM insured_files
      WHERE id = $1 AND owner_address = $2
    `;

    const pool = require("../db/pool");
    const result = await pool.query(query, [id, ownerAddress]);

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: "Not found",
        message: "Policy not found or you don't have permission to view it",
      });
    }

    const policy = result.rows[0];

    res.json({
      success: true,
      policy: {
        id: policy.id,
        cid: policy.cid,
        fileSize: policy.file_size,
        fileValue: policy.file_value,
        premium: policy.premium,
        status: policy.status,
        availabilityScore: policy.availability_score,
        storageType: policy.storage_type,
        checksTotal: policy.checks_total,
        checksPassed: policy.checks_passed,
        lastChecked: policy.last_checked,
        createdAt: policy.created_at,
      },
    });
  } catch (error) {
    logger.error({
      event: "get_policy_failed",
      error: error.message,
    });
    next(error);
  }
});

/**
 * POST /api/insurance/claims
 * Submit an insurance claim for a policy
 */
router.post("/claims", requireAuth, async (req, res, next) => {
  try {
    const { fileId } = req.body;
    const ownerAddress = req.user.address;

    if (!fileId) {
      return res.status(400).json({
        error: "Missing parameter",
        message: "fileId is required",
      });
    }

    // Verify ownership
    const pool = require("../db/pool");
    const fileQuery = `
      SELECT * FROM insured_files
      WHERE id = $1 AND owner_address = $2
    `;

    const fileResult = await pool.query(fileQuery, [fileId, ownerAddress]);

    if (fileResult.rows.length === 0) {
      return res.status(404).json({
        error: "Not found",
        message: "File not found or you don't have permission",
      });
    }

    const file = fileResult.rows[0];

    // Check if eligible for claim (availability < 99%)
    if (file.availability_score >= 0.99) {
      return res.status(400).json({
        error: "Not eligible",
        message: "File availability is above threshold. No claim can be made.",
        availabilityScore: file.availability_score,
      });
    }

    // Evaluate and create claim
    const claim = await slaMonitor.evaluateInsuranceClaim(fileId);

    if (!claim) {
      return res.status(400).json({
        error: "Not eligible",
        message: "Claim evaluation determined this file is not eligible",
      });
    }

    logger.info({
      event: "claim_submitted_via_api",
      claimId: claim.id,
      fileId,
      ownerAddress,
    });

    res.status(201).json({
      success: true,
      claim: {
        id: claim.id,
        fileId: claim.file_id,
        claimAmount: claim.claim_amount,
        status: claim.status,
        createdAt: claim.created_at,
      },
    });
  } catch (error) {
    logger.error({
      event: "claim_submission_failed",
      error: error.message,
    });
    next(error);
  }
});

/**
 * GET /api/insurance/claims
 * Get user's insurance claims
 */
router.get("/claims", requireAuth, async (req, res, next) => {
  try {
    const ownerAddress = req.user.address;

    const pool = require("../db/pool");
    const query = `
      SELECT
        ic.id, ic.file_id, ic.owner_address, ic.claim_amount,
        ic.status, ic.created_at, ic.paid_at,
        IF.cid, IF.file_size, IF.availability_score
      FROM insurance_claims ic
      JOIN insured_files IF ON ic.file_id = IF.id
      WHERE ic.owner_address = $1
      ORDER BY ic.created_at DESC
    `;

    const result = await pool.query(query, [ownerAddress]);

    res.json({
      success: true,
      claims: result.rows.map((c) => ({
        id: c.id,
        fileId: c.file_id,
        cid: c.cid,
        claimAmount: c.claim_amount,
        status: c.status,
        availabilityScore: c.availability_score,
        createdAt: c.created_at,
        paidAt: c.paid_at,
      })),
      count: result.rows.length,
    });
  } catch (error) {
    logger.error({
      event: "get_claims_failed",
      error: error.message,
    });
    next(error);
  }
});

/**
 * GET /api/insurance/claims/:id
 * Get specific claim details
 */
router.get("/claims/:id", requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;
    const ownerAddress = req.user.address;

    const claim = await slaMonitor.getInsuranceClaim(id);

    if (claim.owner_address !== ownerAddress) {
      return res.status(403).json({
        error: "Forbidden",
        message: "You don't have permission to view this claim",
      });
    }

    res.json({
      success: true,
      claim: {
        id: claim.id,
        fileId: claim.file_id,
        cid: claim.cid,
        claimAmount: claim.claim_amount,
        status: claim.status,
        evidence: claim.evidence,
        oracleProof: claim.oracle_proof,
        oracleAddress: claim.oracle_address,
        payoutTxHash: claim.payout_tx_hash,
        createdAt: claim.created_at,
        proofSubmittedAt: claim.proof_submitted_at,
        paidAt: claim.paid_at,
      },
    });
  } catch (error) {
    logger.error({
      event: "get_claim_failed",
      error: error.message,
    });
    next(error);
  }
});

/**
 * POST /api/insurance/claims/:id/submit-proof
 * Submit oracle proof for a claim (oracle only)
 */
router.post("/claims/:id/submit-proof", requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { oracleProof } = req.body;
    const oracleAddress = req.user.address;

    if (!oracleProof) {
      return res.status(400).json({
        error: "Missing parameter",
        message: "oracleProof is required",
      });
    }

    const claim = await slaMonitor.submitOracleProof(id, oracleProof, oracleAddress);

    logger.info({
      event: "oracle_proof_submitted_via_api",
      claimId: id,
      oracleAddress,
    });

    res.json({
      success: true,
      claim: {
        id: claim.id,
        status: claim.status,
        oracleAddress: claim.oracle_address,
        proofSubmittedAt: new Date().toISOString(),
      },
    });
  } catch (error) {
    logger.error({
      event: "proof_submission_failed",
      error: error.message,
    });
    next(error);
  }
});

/**
 * GET /api/insurance/stats
 * Get insurance program statistics
 */
router.get("/stats", async (req, res, next) => {
  try {
    const stats = await slaMonitor.getInsuranceStats();

    res.json({
      success: true,
      stats: {
        activeInsuredFiles: stats.activeFiles,
        pendingClaims: stats.pendingClaims,
        approvedClaims: stats.approvedClaims,
        totalPremiumsActive: stats.totalPremiums,
        totalPayoutsIssued: stats.totalPayouts,
        systemAverageAvailability: stats.avgAvailability,
      },
    });
  } catch (error) {
    logger.error({
      event: "stats_retrieval_failed",
      error: error.message,
    });
    next(error);
  }
});

module.exports = router;
