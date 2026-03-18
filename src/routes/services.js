'use strict';

const express = require('express');
const { requireAuthOrInternal, requireInternalKey } = require('../middleware/auth');
const { healthCheckAll, proxyToService } = require('../services/orchestrator');
const { getThrPrice, getWalletBalance } = require('../services/chainService');
const { Service } = require('../models');
const { config } = require('../utils/config');
const logger = require('../utils/logger');

const router = express.Router();

// ─── Health Check All Services ──────────────────────────────────────────────
router.get('/health', async (_req, res) => {
  try {
    const results = await healthCheckAll();
    const allHealthy = Object.values(results).every(r => r.status === 'healthy');
    res.status(allHealthy ? 200 : 207).json({
      gateway: 'healthy',
      services: results,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Service Registry ───────────────────────────────────────────────────────
router.get('/registry', requireAuthOrInternal, async (_req, res) => {
  try {
    const services = await Service.findAll({ order: [['name', 'ASC']] });
    res.json({ services });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Proxy to Service ───────────────────────────────────────────────────────
router.all('/proxy/:service/*', requireInternalKey, async (req, res) => {
  const serviceName = req.params.service;
  const path = '/' + req.params[0];
  try {
    const result = await proxyToService(serviceName, req.method.toLowerCase(), path, req.body, {});
    res.status(result.status).json(result.data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ─── THR Price ──────────────────────────────────────────────────────────────
router.get('/price/thr', async (_req, res) => {
  try {
    const price = await getThrPrice();
    res.json({ symbol: 'THR', priceUsd: price, timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Wallet Balance ─────────────────────────────────────────────────────────
router.get('/wallet/:address/balance', requireAuthOrInternal, async (req, res) => {
  try {
    const balance = await getWalletBalance(req.params.address);
    if (!balance) return res.status(404).json({ error: 'Wallet not found' });
    res.json(balance);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Ecosystem Status ───────────────────────────────────────────────────────
router.get('/status', async (_req, res) => {
  try {
    const services = await Service.findAll();
    const healthy = services.filter(s => s.status === 'healthy').length;
    const total = services.length;
    const price = await getThrPrice();

    res.json({
      ecosystem: 'Thronos',
      version: 'v3.6',
      gateway: 'operational',
      services: { healthy, total, percentage: total > 0 ? Math.round((healthy / total) * 100) : 0 },
      thrPrice: price,
      stripeEnabled: config.stripe.enabled,
      chains: Object.keys(config.rpc),
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
