'use strict';

const express = require('express');
const { body, param, query } = require('express-validator');
const crypto = require('crypto');
const { Payment, WebhookLog } = require('../models');
const { requireAuthOrInternal } = require('../middleware/auth');
const { handleValidation } = require('../middleware/validate');
const stripeService = require('../services/stripeService');
const chainService = require('../services/chainService');
const { paymentQueue } = require('../services/queueService');
const { config } = require('../utils/config');
const logger = require('../utils/logger');

const router = express.Router();

// ─── Create Fiat (Stripe) Payment ───────────────────────────────────────────
router.post('/fiat/checkout',
  requireAuthOrInternal,
  [
    body('serviceType').isIn([
      'commerce_order', 'builder_build', 'sentinel_subscription',
      'verifyid_kyc', 'driver_ride', 'career_credits', 'thr_purchase', 'custom',
    ]),
    body('serviceRef').optional().isString().trim(),
    body('plan').optional().isString().trim(),
    body('amountCents').optional().isInt({ min: 100, max: 5000000 }),
    body('walletAddress').optional().isString().trim(),
    body('successUrl').optional().isURL(),
    body('cancelUrl').optional().isURL(),
  ],
  handleValidation,
  async (req, res) => {
    try {
      const { serviceType, serviceRef, plan, amountCents, walletAddress, successUrl, cancelUrl } = req.body;
      const userId = req.user?.sub || req.body.userId || null;

      const payment = await Payment.create({
        userId,
        walletAddress,
        serviceType,
        serviceRef,
        method: 'stripe',
        amountFiat: amountCents ? (amountCents / 100) : null,
        currency: 'USD',
        status: 'pending',
        metadata: { plan },
      });

      const session = await stripeService.createCheckoutSession({
        serviceType,
        serviceRef,
        plan,
        amountCents,
        userId,
        walletAddress,
        successUrl,
        cancelUrl,
        metadata: { paymentId: payment.id },
      });

      await payment.update({ externalId: session.sessionId });

      res.json({
        paymentId: payment.id,
        checkoutUrl: session.url,
        sessionId: session.sessionId,
      });
    } catch (err) {
      logger.error('Fiat checkout failed', { error: err.message });
      res.status(500).json({ error: err.message });
    }
  }
);

// ─── Create Fiat Subscription ───────────────────────────────────────────────
router.post('/fiat/subscribe',
  requireAuthOrInternal,
  [
    body('serviceType').isIn(['sentinel_subscription']),
    body('plan').isString().trim().notEmpty(),
    body('walletAddress').optional().isString().trim(),
    body('successUrl').optional().isURL(),
    body('cancelUrl').optional().isURL(),
  ],
  handleValidation,
  async (req, res) => {
    try {
      const { serviceType, plan, walletAddress, successUrl, cancelUrl } = req.body;
      const userId = req.user?.sub || req.body.userId || null;

      const payment = await Payment.create({
        userId,
        walletAddress,
        serviceType,
        method: 'stripe',
        currency: 'USD',
        status: 'pending',
        metadata: { plan, recurring: true },
      });

      const session = await stripeService.createSubscription({
        serviceType,
        plan,
        userId,
        walletAddress,
        successUrl,
        cancelUrl,
        metadata: { paymentId: payment.id },
      });

      await payment.update({ externalId: session.sessionId });

      res.json({
        paymentId: payment.id,
        checkoutUrl: session.url,
        sessionId: session.sessionId,
      });
    } catch (err) {
      logger.error('Subscription creation failed', { error: err.message });
      res.status(500).json({ error: err.message });
    }
  }
);

// ─── Submit Crypto Payment for Verification ─────────────────────────────────
router.post('/crypto/submit',
  requireAuthOrInternal,
  [
    body('serviceType').isIn([
      'commerce_order', 'builder_build', 'sentinel_subscription',
      'verifyid_kyc', 'driver_ride', 'career_credits', 'thr_purchase', 'custom',
    ]),
    body('serviceRef').optional().isString().trim(),
    body('chain').isIn(['eth', 'bsc', 'polygon', 'arbitrum', 'base', 'btc', 'thr', 'solana']),
    body('txHash').isString().trim().notEmpty(),
    body('fromAddress').isString().trim().notEmpty(),
    body('amountCrypto').isNumeric(),
    body('cryptoSymbol').isString().trim().notEmpty(),
    body('plan').optional().isString().trim(),
  ],
  handleValidation,
  async (req, res) => {
    try {
      const {
        serviceType, serviceRef, chain, txHash,
        fromAddress, amountCrypto, cryptoSymbol, plan,
      } = req.body;
      const userId = req.user?.sub || req.body.userId || null;

      // Check for duplicate txHash
      const existing = await Payment.findOne({ where: { txHash } });
      if (existing) {
        return res.status(409).json({ error: 'Transaction already submitted', paymentId: existing.id });
      }

      const payment = await Payment.create({
        userId,
        walletAddress: fromAddress,
        serviceType,
        serviceRef,
        method: chain === 'btc' ? 'crypto_btc' : chain === 'thr' ? 'crypto_thr' : chain === 'solana' ? 'crypto_solana' : 'crypto_evm',
        chain,
        amountCrypto,
        cryptoSymbol,
        txHash,
        status: 'confirming',
        metadata: { plan },
      });

      // Queue for async verification
      await paymentQueue.add('verify-crypto', {
        paymentId: payment.id,
        chain,
        txHash,
        expectedTo: config.treasury[chain] || config.treasury.eth,
        expectedAmount: amountCrypto,
        tokenSymbol: cryptoSymbol,
      });

      res.json({
        paymentId: payment.id,
        status: 'confirming',
        message: 'Payment submitted for verification',
      });
    } catch (err) {
      logger.error('Crypto payment submission failed', { error: err.message });
      res.status(500).json({ error: err.message });
    }
  }
);

// ─── Get Payment Status ─────────────────────────────────────────────────────
router.get('/:paymentId',
  requireAuthOrInternal,
  [param('paymentId').isUUID()],
  handleValidation,
  async (req, res) => {
    try {
      const payment = await Payment.findByPk(req.params.paymentId);
      if (!payment) return res.status(404).json({ error: 'Payment not found' });

      // Verify ownership (unless internal service)
      if (!req.isInternalService && req.user?.sub !== payment.userId) {
        return res.status(403).json({ error: 'Forbidden' });
      }

      res.json(payment);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// ─── List Payments ──────────────────────────────────────────────────────────
router.get('/',
  requireAuthOrInternal,
  [
    query('serviceType').optional().isString(),
    query('status').optional().isString(),
    query('limit').optional().isInt({ min: 1, max: 100 }),
    query('offset').optional().isInt({ min: 0 }),
  ],
  handleValidation,
  async (req, res) => {
    try {
      const where = {};
      if (!req.isInternalService && req.user?.sub) {
        where.userId = req.user.sub;
      }
      if (req.query.serviceType) where.serviceType = req.query.serviceType;
      if (req.query.status) where.status = req.query.status;

      const payments = await Payment.findAndCountAll({
        where,
        limit: parseInt(req.query.limit, 10) || 20,
        offset: parseInt(req.query.offset, 10) || 0,
        order: [['createdAt', 'DESC']],
      });

      res.json({ total: payments.count, payments: payments.rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// ─── Refund ─────────────────────────────────────────────────────────────────
router.post('/:paymentId/refund',
  requireAuthOrInternal,
  [param('paymentId').isUUID()],
  handleValidation,
  async (req, res) => {
    try {
      const payment = await Payment.findByPk(req.params.paymentId);
      if (!payment) return res.status(404).json({ error: 'Payment not found' });
      if (payment.status !== 'completed') {
        return res.status(400).json({ error: 'Can only refund completed payments' });
      }
      if (payment.method !== 'stripe') {
        return res.status(400).json({ error: 'Only Stripe payments can be refunded via gateway' });
      }

      const refund = await stripeService.issueRefund(payment.externalId);
      await payment.update({ status: 'refunded', metadata: { ...payment.metadata, refundId: refund.id } });

      logger.info('Payment refunded', { paymentId: payment.id, refundId: refund.id });
      res.json({ status: 'refunded', refundId: refund.id });
    } catch (err) {
      logger.error('Refund failed', { error: err.message });
      res.status(500).json({ error: err.message });
    }
  }
);

// ─── Cross-Chain Payment Registration (from Builder/Services) ─────────────
// This endpoint receives cross-chain payment proofs and triggers fee processing
const { processCrossChainFee } = require('../services/crossChainFeeHandler');

// SECURITY: Auth added — Phase 0 hardening
router.post('/crosschain/register',
  requireAuthOrInternal,
  [
    body('tx_hash').isString().trim().notEmpty(),
    body('chain').isIn(['ethereum', 'arbitrum', 'bsc', 'base', 'solana']),
    body('payer').isString().trim().notEmpty(),
    body('amount_thr_equivalent').isNumeric(),
    body('service_type').isIn([
      'builder_build', 'sentinel_subscription', 'commerce_order',
      'verifyid_kyc', 'custom',
    ]),
    body('fee_action').optional().isIn(['standard', 'stake_and_mint']),
    body('token_symbol').optional().isIn(['ETH', 'BNB', 'USDT', 'USDC', 'MATIC']),
  ],
  handleValidation,
  async (req, res) => {
    try {
      const {
        tx_hash, chain, payer, amount_thr_equivalent,
        service_type, fee_action, token_symbol,
      } = req.body;

      // Check duplicate
      const existing = await Payment.findOne({ where: { txHash: tx_hash } });
      if (existing) {
        return res.status(409).json({ error: 'Transaction already registered', paymentId: existing.id });
      }

      // Normalize chain name for gateway
      const chainMap = {
        ethereum: 'eth', arbitrum: 'arbitrum', bsc: 'bsc',
        base: 'base', solana: 'solana',
      };

      // Determine crypto symbol — use token_symbol if provided, otherwise infer
      let cryptoSymbol;
      if (token_symbol) {
        cryptoSymbol = token_symbol;
      } else if (chain === 'solana') {
        cryptoSymbol = 'USDC';
      } else if (chain === 'bsc') {
        cryptoSymbol = 'BNB';
      } else {
        cryptoSymbol = 'ETH';
      }

      const payment = await Payment.create({
        walletAddress: payer,
        serviceType: service_type,
        method: chain === 'solana' ? 'crypto_solana' : 'crypto_evm',
        chain: chainMap[chain] || chain,
        amountCrypto: amount_thr_equivalent,
        cryptoSymbol,
        txHash: tx_hash,
        status: 'confirming',
        metadata: { fee_action, original_chain: chain, token_symbol: cryptoSymbol },
      });

      // Queue for async verification
      // For USDT/USDC payments, pass the token symbol so verifyEvmPayment
      // checks ERC-20 Transfer events instead of native value
      await paymentQueue.add('verify-crypto', {
        paymentId: payment.id,
        chain: chainMap[chain] || chain,
        txHash: tx_hash,
        expectedTo: config.treasury[chain] || config.treasury.eth,
        expectedAmount: amount_thr_equivalent,
        tokenSymbol: (cryptoSymbol === 'USDT' || cryptoSymbol === 'USDC' || chain === 'solana')
          ? cryptoSymbol : null,
      });

      // If fee_action is stake_and_mint, process cross-chain fee
      if (fee_action === 'stake_and_mint') {
        // Process asynchronously (don't block response)
        processCrossChainFee({
          sourceChain: chain,
          amountThrEquivalent: parseFloat(amount_thr_equivalent),
          payerAddress: payer,
          txHash: tx_hash,
          serviceType: service_type,
        }).catch(err => {
          logger.error('Async cross-chain fee processing failed', { error: err.message });
        });
      }

      res.json({
        paymentId: payment.id,
        status: 'confirming',
        message: 'Cross-chain payment registered',
        fee_processing: fee_action === 'stake_and_mint' ? 'initiated' : 'standard',
      });
    } catch (err) {
      logger.error('Cross-chain registration failed', { error: err.message });
      res.status(500).json({ error: err.message });
    }
  }
);

// ─── Solana Payment Preparation ──────────────────────────────────────────────
// Returns payment details for Phantom to sign
router.post('/solana/prepare',
  [
    body('payer').isString().trim().notEmpty(),
    body('amount_usdc').isNumeric(),
    body('service_type').isString().trim().notEmpty(),
  ],
  handleValidation,
  async (req, res) => {
    try {
      const { payer, amount_usdc, service_type } = req.body;
      const treasury = config.treasury.solana;

      if (!treasury) {
        return res.status(503).json({ error: 'Solana treasury not configured' });
      }

      const paymentId = crypto.randomUUID();

      res.json({
        payment_id: paymentId,
        treasury_address: treasury,
        usdc_mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        amount_usdc: parseFloat(amount_usdc) / 1e6, // convert to USDC (6 decimals)
        amount_lamports: parseInt(amount_usdc),
        service_type,
        message: 'Sign and submit the USDC transfer, then register via /crosschain/register',
      });
    } catch (err) {
      logger.error('Solana prepare failed', { error: err.message });
      res.status(500).json({ error: err.message });
    }
  }
);

module.exports = router;
