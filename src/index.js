'use strict';

const { config, validateEnv } = require('./utils/config');
validateEnv();

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const logger = require('./utils/logger');
const { initDb } = require('./models');

const paymentRoutes = require('./routes/payments');
const webhookRoutes = require('./routes/webhooks');
const serviceRoutes = require('./routes/services');

const app = express();

// ─── Security ───────────────────────────────────────────────────────────────
app.use(helmet());
app.use(cors({
  origin: [
    'https://api.thronoschain.org',
    'https://commerce.thronoschain.org',
    'https://builder.thronoschain.org',
    'https://verifyid.thronoschain.org',
    'https://sentinel.thronoschain.org',
    /\.thronoschain\.org$/,
  ],
  credentials: true,
}));

// Global rate limit
app.use(rateLimit({
  windowMs: 60000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests' },
}));

// ─── Stripe webhook needs raw body ──────────────────────────────────────────
app.use('/webhooks/stripe', express.raw({ type: 'application/json' }));

// ─── JSON parsing for all other routes ──────────────────────────────────────
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// ─── Request logging ────────────────────────────────────────────────────────
app.use((req, _res, next) => {
  logger.debug(`${req.method} ${req.path}`, { ip: req.ip });
  next();
});

// ─── HSTS ───────────────────────────────────────────────────────────────────
app.use((_req, res, next) => {
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});

// ─── Health ─────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'healthy', service: 'thronos-gateway', timestamp: new Date().toISOString() });
});

// ─── Routes ─────────────────────────────────────────────────────────────────
app.use('/api/payments', paymentRoutes);
app.use('/webhooks', webhookRoutes);
app.use('/api/services', serviceRoutes);

// ─── Error handler ──────────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  logger.error('Unhandled error', { error: err.message, stack: err.stack });
  res.status(500).json({ error: 'Internal server error' });
});

// ─── Start ──────────────────────────────────────────────────────────────────
async function start() {
  await initDb();
  app.listen(config.port, () => {
    logger.info(`Thronos Gateway running on port ${config.port}`, {
      env: config.env,
      stripeEnabled: config.stripe.enabled,
      chains: Object.keys(config.rpc),
    });
  });
}

start().catch(err => {
  logger.error('Failed to start gateway', { error: err.message });
  process.exit(1);
});

module.exports = app;
