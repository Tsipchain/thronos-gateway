'use strict';

const { Sequelize, DataTypes } = require('sequelize');
const { config } = require('../utils/config');
const logger = require('../utils/logger');

const sequelize = new Sequelize(config.db.url, {
  dialect: 'postgres',
  logging: msg => logger.debug(msg),
  pool: { max: 10, min: 2, acquire: 30000, idle: 10000 },
});

// ─── Payment ────────────────────────────────────────────────────────────────
const Payment = sequelize.define('Payment', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  externalId: { type: DataTypes.STRING, unique: true, comment: 'Stripe session/PI id or on-chain txHash' },
  userId: { type: DataTypes.STRING, allowNull: true },
  walletAddress: { type: DataTypes.STRING, allowNull: true },

  // What service is being paid for
  serviceType: {
    type: DataTypes.ENUM(
      'commerce_order',
      'builder_build',
      'sentinel_subscription',
      'verifyid_kyc',
      'driver_ride',
      'career_credits',
      'thr_purchase',
      'custom'
    ),
    allowNull: false,
  },
  serviceRef: { type: DataTypes.STRING, allowNull: true, comment: 'Reference ID in the target service' },

  // Payment method
  method: {
    type: DataTypes.ENUM('stripe', 'crypto_evm', 'crypto_btc', 'crypto_thr', 'bank_transfer'),
    allowNull: false,
  },
  chain: { type: DataTypes.STRING, allowNull: true, comment: 'eth, bsc, polygon, arbitrum, btc, thr' },

  // Amounts
  amountFiat: { type: DataTypes.DECIMAL(18, 2), allowNull: true },
  currency: { type: DataTypes.STRING(3), defaultValue: 'USD' },
  amountCrypto: { type: DataTypes.DECIMAL(36, 18), allowNull: true },
  cryptoSymbol: { type: DataTypes.STRING(10), allowNull: true },
  txHash: { type: DataTypes.STRING, allowNull: true },

  // Fee split
  feeTreasury: { type: DataTypes.DECIMAL(36, 18), defaultValue: 0 },
  feeBurn: { type: DataTypes.DECIMAL(36, 18), defaultValue: 0 },
  feeLp: { type: DataTypes.DECIMAL(36, 18), defaultValue: 0 },

  // Status
  status: {
    type: DataTypes.ENUM('pending', 'confirming', 'completed', 'failed', 'refunded', 'expired'),
    defaultValue: 'pending',
  },
  confirmations: { type: DataTypes.INTEGER, defaultValue: 0 },

  metadata: { type: DataTypes.JSONB, defaultValue: {} },
  completedAt: { type: DataTypes.DATE, allowNull: true },
}, {
  tableName: 'payments',
  indexes: [
    { fields: ['status'] },
    { fields: ['userId'] },
    { fields: ['walletAddress'] },
    { fields: ['serviceType', 'serviceRef'] },
    { fields: ['txHash'] },
    { fields: ['createdAt'] },
  ],
});

// ─── Service Registry ───────────────────────────────────────────────────────
const Service = sequelize.define('Service', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  name: { type: DataTypes.STRING, unique: true, allowNull: false },
  url: { type: DataTypes.STRING, allowNull: false },
  healthEndpoint: { type: DataTypes.STRING, defaultValue: '/health' },
  status: { type: DataTypes.ENUM('healthy', 'degraded', 'down', 'unknown'), defaultValue: 'unknown' },
  lastCheck: { type: DataTypes.DATE, allowNull: true },
  lastLatencyMs: { type: DataTypes.INTEGER, allowNull: true },
  metadata: { type: DataTypes.JSONB, defaultValue: {} },
}, {
  tableName: 'services',
});

// ─── Webhook Log ────────────────────────────────────────────────────────────
const WebhookLog = sequelize.define('WebhookLog', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  source: { type: DataTypes.STRING, allowNull: false, comment: 'stripe, evm_watcher, btc_watcher' },
  eventType: { type: DataTypes.STRING, allowNull: false },
  paymentId: { type: DataTypes.UUID, allowNull: true },
  payload: { type: DataTypes.JSONB, defaultValue: {} },
  processed: { type: DataTypes.BOOLEAN, defaultValue: false },
  error: { type: DataTypes.TEXT, allowNull: true },
}, {
  tableName: 'webhook_logs',
  indexes: [
    { fields: ['source', 'eventType'] },
    { fields: ['paymentId'] },
    { fields: ['processed'] },
  ],
});

// ─── Price Feed ─────────────────────────────────────────────────────────────
const PriceFeed = sequelize.define('PriceFeed', {
  symbol: { type: DataTypes.STRING(20), primaryKey: true },
  priceUsd: { type: DataTypes.DECIMAL(24, 8), allowNull: false },
  source: { type: DataTypes.STRING, allowNull: false },
  updatedAt: { type: DataTypes.DATE, allowNull: false },
}, {
  tableName: 'price_feeds',
  timestamps: false,
});

// Relations
Payment.hasMany(WebhookLog, { foreignKey: 'paymentId' });
WebhookLog.belongsTo(Payment, { foreignKey: 'paymentId' });

async function initDb() {
  await sequelize.authenticate();
  logger.info('Database connected');
  await sequelize.sync({ alter: config.env !== 'production' });
  logger.info('Database synced');
}

module.exports = { sequelize, Payment, Service, WebhookLog, PriceFeed, initDb };
