'use strict';

const express = require('express');
const { body, query } = require('express-validator');
const { requireAuthOrInternal } = require('../middleware/auth');
const { handleValidation } = require('../middleware/validate');
const payService = require('../services/payService');
const etherfiService = require('../services/etherfiService');
const { ThrPayWallet, WebhookLog } = require('../models');
const logger = require('../utils/logger');

const router = express.Router();

// ─── GET /api/pay/wallet ─────────────────────────────────────────────────────
// Get or create virtual wallet + balances
router.get('/wallet',
  requireAuthOrInternal,
  async (req, res) => {
    try {
      const userId = req.user?.sub || (req.isInternalService ? req.query.userId : null);
      const walletAddress = req.query.walletAddress || null;

      if (!userId && !walletAddress) {
        return res.status(400).json({ error: 'userId or walletAddress required' });
      }

      const wallet = await payService.getOrCreateWallet(userId, walletAddress);
      const balances = await payService.getWalletBalances(wallet.id);

      res.json({ wallet: balances });
    } catch (err) {
      logger.error('GET /pay/wallet failed', { error: err.message });
      res.status(500).json({ error: err.message });
    }
  }
);

// ─── GET /api/pay/history ────────────────────────────────────────────────────
// Transaction history for a wallet
router.get('/history',
  requireAuthOrInternal,
  [
    query('walletAddress').optional().isString(),
    query('limit').optional().isInt({ min: 1, max: 100 }),
    query('offset').optional().isInt({ min: 0 }),
  ],
  handleValidation,
  async (req, res) => {
    try {
      const userId = req.user?.sub || (req.isInternalService ? req.query.userId : null);
      const { walletAddress, limit = 20, offset = 0 } = req.query;
      const { Payment } = require('../models');

      const where = {};
      if (walletAddress) where.walletAddress = walletAddress;
      else if (userId) where.userId = userId;
      else return res.status(400).json({ error: 'userId or walletAddress required' });

      const { rows, count } = await Payment.findAndCountAll({
        where,
        order: [['createdAt', 'DESC']],
        limit: parseInt(limit),
        offset: parseInt(offset),
        attributes: [
          'id', 'serviceType', 'method', 'chain',
          'amountFiat', 'amountCrypto', 'cryptoSymbol',
          'status', 'txHash', 'createdAt', 'completedAt',
        ],
      });

      res.json({ transactions: rows, total: count, limit: parseInt(limit), offset: parseInt(offset) });
    } catch (err) {
      logger.error('GET /pay/history failed', { error: err.message });
      res.status(500).json({ error: err.message });
    }
  }
);

// ─── GET /api/pay/card/status ────────────────────────────────────────────────
// Get card application status
router.get('/card/status',
  requireAuthOrInternal,
  async (req, res) => {
    try {
      const userId = req.user?.sub || (req.isInternalService ? req.query.userId : null);
      const walletAddress = req.query.walletAddress || null;

      const card = await payService.getCardStatus(userId, walletAddress);

      if (!card) {
        return res.json({
          hasCard: false,
          status: null,
          provider: null,
          applyUrl: null,
        });
      }

      res.json({
        hasCard: true,
        status: card.status,
        provider: card.provider,
        cardLast4: card.cardLast4 || null,
        appliedAt: card.createdAt,
      });
    } catch (err) {
      logger.error('GET /pay/card/status failed', { error: err.message });
      res.status(500).json({ error: err.message });
    }
  }
);

// ─── POST /api/pay/card/apply ────────────────────────────────────────────────
// Initiate card application via ether.fi referral
router.post('/card/apply',
  requireAuthOrInternal,
  [
    body('walletAddress').optional().isString().trim(),
    body('source').optional().isIn(['app', 'dashboard', 'sentinel', 'builder', 'commerce']),
  ],
  handleValidation,
  async (req, res) => {
    try {
      const userId = req.user?.sub || (req.isInternalService ? req.body.userId : null);
      const { walletAddress, source = 'app' } = req.body;

      if (!userId && !walletAddress) {
        return res.status(400).json({ error: 'userId or walletAddress required' });
      }

      // Build tracked referral URL
      const { url, trackingId } = etherfiService.buildReferralUrl({
        userId,
        walletAddress,
        source,
      });

      // Record the application attempt
      const card = await payService.recordCardApplication({
        userId,
        walletAddress,
        trackingId,
        source,
      });

      logger.info('Card apply initiated', { userId, walletAddress, trackingId, source });

      res.json({
        success: true,
        applyUrl: url,
        trackingId,
        cardStatus: card.status,
        message: 'Redirect user to applyUrl to complete ether.fi card application',
      });
    } catch (err) {
      logger.error('POST /pay/card/apply failed', { error: err.message });
      res.status(500).json({ error: err.message });
    }
  }
);

// ─── POST /api/pay/card/etherfi-webhook ─────────────────────────────────────
// Receive card status updates from ether.fi
router.post('/card/etherfi-webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    let rawBody;
    try {
      rawBody = req.body;
      const sig = req.headers['x-etherfi-signature'];

      if (!etherfiService.verifyWebhookSignature(rawBody, sig)) {
        logger.warn('ether.fi webhook signature invalid');
        return res.status(401).json({ error: 'Invalid signature' });
      }

      const payload = JSON.parse(rawBody.toString());
      const { event, trackingId, status, cardLast4, network } = payload;

      await WebhookLog.create({
        source: 'etherfi',
        eventType: event || 'card_status_update',
        payload,
      });

      if (trackingId) {
        await payService.updateCardFromWebhook({ trackingId, status, cardLast4, network });
      }

      res.json({ received: true });
    } catch (err) {
      logger.error('ether.fi webhook error', { error: err.message });
      res.status(500).json({ error: err.message });
    }
  }
);

// ─── POST /api/pay/wallet/credit (internal only) ─────────────────────────────
// Credit wallet after verified on-chain deposit (called by paymentWorker)
router.post('/wallet/credit',
  requireAuthOrInternal,
  [
    body('walletId').isUUID(),
    body('asset').isIn(['THR', 'ETH', 'USDC']),
    body('amount').isFloat({ min: 0.000001 }),
    body('paymentId').optional().isUUID(),
  ],
  handleValidation,
  async (req, res) => {
    try {
      if (!req.isInternal) {
        return res.status(403).json({ error: 'Internal endpoint' });
      }

      const { walletId, asset, amount, paymentId } = req.body;
      const wallet = await payService.creditWallet({ walletId, asset, amount, paymentId });
      const balances = await payService.getWalletBalances(wallet.id);

      res.json({ success: true, wallet: balances });
    } catch (err) {
      logger.error('POST /pay/wallet/credit failed', { error: err.message });
      res.status(400).json({ error: err.message });
    }
  }
);

module.exports = router;
