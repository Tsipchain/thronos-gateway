'use strict';

const express = require('express');
const { body, param, query } = require('express-validator');
const { handleValidation } = require('../middleware/validate');
const { requireAuthOrInternal } = require('../middleware/auth');
const merchantService = require('../services/merchantService');
const logger = require('../utils/logger');

const router = express.Router();

function requireMerchantApiKey(req, res, next) {
  const key = req.headers['x-merchant-key'];
  if (!key) return res.status(401).json({ error: 'Missing X-Merchant-Key header' });

  merchantService.authenticateMerchant(key)
    .then(merchant => {
      if (!merchant) return res.status(401).json({ error: 'Invalid or inactive merchant key' });
      req.merchant = merchant;
      next();
    })
    .catch(err => {
      logger.error('Merchant auth failed', { error: err.message });
      res.status(500).json({ error: 'Authentication error' });
    });
}

// ─── Register Merchant (admin / internal only) ─────────────────────────────
router.post('/register',
  requireAuthOrInternal,
  [
    body('name').isString().trim().notEmpty().isLength({ max: 200 }),
    body('email').isEmail().normalizeEmail(),
    body('callbackUrl').optional().isURL({ protocols: ['https'] }),
  ],
  handleValidation,
  async (req, res) => {
    try {
      const { name, email, callbackUrl } = req.body;
      const { merchant, apiKey } = await merchantService.registerMerchant({ name, email, callbackUrl });

      logger.info('Merchant registered', { merchantId: merchant.id, email });
      res.status(201).json({
        merchantId: merchant.id,
        status: merchant.status,
        apiKey,
        warning: 'Store this API key securely — it will not be shown again.',
      });
    } catch (err) {
      if (err.name === 'SequelizeUniqueConstraintError') {
        return res.status(409).json({ error: 'Email already registered' });
      }
      logger.error('Merchant registration failed', { error: err.message });
      res.status(500).json({ error: err.message });
    }
  }
);

// ─── Get Merchant Profile ──────────────────────────────────────────────────
router.get('/profile',
  requireMerchantApiKey,
  async (req, res) => {
    const m = req.merchant;
    res.json({
      id: m.id,
      name: m.name,
      email: m.email,
      status: m.status,
      feePercent: m.feePercent,
      callbackUrl: m.callbackUrl,
      bankIbanMasked: m.bankIbanMasked,
      createdAt: m.createdAt,
    });
  }
);

// ─── Create Checkout Session ───────────────────────────────────────────────
router.post('/checkout',
  requireMerchantApiKey,
  [
    body('amountEur').isFloat({ min: 0.50, max: 1000000 }),
    body('description').optional().isString().trim().isLength({ max: 500 }),
    body('customerRef').optional().isString().trim().isLength({ max: 100 }),
  ],
  handleValidation,
  async (req, res) => {
    try {
      const { amountEur, description, customerRef } = req.body;
      const checkout = await merchantService.createCheckout(req.merchant, {
        amountEur,
        description,
        customerRef,
      });

      res.status(201).json({
        checkoutId: checkout.id,
        amountEur: checkout.amountEur,
        status: checkout.status,
        expiresAt: checkout.expiresAt,
      });
    } catch (err) {
      logger.error('Checkout creation failed', { error: err.message, merchantId: req.merchant.id });
      res.status(500).json({ error: err.message });
    }
  }
);

// ─── Checkout Status ───────────────────────────────────────────────────────
router.get('/checkout/:checkoutId',
  requireMerchantApiKey,
  [param('checkoutId').isUUID()],
  handleValidation,
  async (req, res) => {
    try {
      const checkout = await merchantService.getCheckoutStatus(req.params.checkoutId, req.merchant.id);
      if (!checkout) return res.status(404).json({ error: 'Checkout not found' });
      res.json(checkout);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// ─── List Checkouts ────────────────────────────────────────────────────────
router.get('/checkouts',
  requireMerchantApiKey,
  [
    query('status').optional().isString(),
    query('limit').optional().isInt({ min: 1, max: 100 }),
    query('offset').optional().isInt({ min: 0 }),
  ],
  handleValidation,
  async (req, res) => {
    try {
      const result = await merchantService.listCheckouts(req.merchant.id, {
        status: req.query.status,
        limit: parseInt(req.query.limit, 10) || 20,
        offset: parseInt(req.query.offset, 10) || 0,
      });
      res.json({ total: result.count, checkouts: result.rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// ─── List Vouchers ─────────────────────────────────────────────────────────
router.get('/vouchers',
  requireMerchantApiKey,
  [
    query('status').optional().isString(),
    query('limit').optional().isInt({ min: 1, max: 100 }),
    query('offset').optional().isInt({ min: 0 }),
  ],
  handleValidation,
  async (req, res) => {
    try {
      const result = await merchantService.listVouchers(req.merchant.id, {
        status: req.query.status,
        limit: parseInt(req.query.limit, 10) || 20,
        offset: parseInt(req.query.offset, 10) || 0,
      });
      res.json({ total: result.count, vouchers: result.rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// ─── Confirm Checkout (internal — called by chain watchers) ────────────────
router.post('/checkout/:checkoutId/confirm',
  requireAuthOrInternal,
  [
    param('checkoutId').isUUID(),
    body('txHash').isString().trim().notEmpty(),
    body('selectedCrypto').optional().isString().trim(),
    body('cryptoAmount').optional().isNumeric(),
    body('confirmations').optional().isInt({ min: 1 }),
  ],
  handleValidation,
  async (req, res) => {
    try {
      const { txHash, selectedCrypto, cryptoAmount, confirmations } = req.body;
      const checkout = await merchantService.confirmCheckout(req.params.checkoutId, {
        txHash,
        selectedCrypto,
        cryptoAmount,
        confirmations,
      });

      const voucher = await merchantService.issueVoucher(checkout.id);

      res.json({
        checkoutId: checkout.id,
        status: checkout.status,
        voucherId: voucher.id,
        netEur: voucher.netEur,
      });
    } catch (err) {
      logger.error('Checkout confirmation failed', { error: err.message });
      res.status(500).json({ error: err.message });
    }
  }
);

module.exports = router;
