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
    body('chain').isIn(['eth', 'bsc', 'polygon', 'arbitrum', 'btc', 'thr']),
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
        method: chain === 'btc' ? 'crypto_btc' : chain === 'thr' ? 'crypto_thr' : 'crypto_evm',
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

module.exports = router;
