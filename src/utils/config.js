'use strict';

require('dotenv').config();

const REQUIRED_ENV = [
  'DATABASE_URL',
  'REDIS_URL',
  'GATEWAY_SECRET',
  'JWT_SECRET',
];

const REQUIRED_PAYMENT_ENV = [
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
];

function validateEnv() {
  const missing = REQUIRED_ENV.filter(k => !process.env[k]);
  if (missing.length > 0) {
    console.error(`[FATAL] Missing required env vars: ${missing.join(', ')}`);
    console.error('[FATAL] Set these in Railway Variables tab before deploying.');
    process.exit(1);
  }
  const missingPayment = REQUIRED_PAYMENT_ENV.filter(k => !process.env[k]);
  if (missingPayment.length > 0) {
    console.warn(`[WARN] Missing payment env vars (Stripe disabled): ${missingPayment.join(', ')}`);
  }
}

const config = {
  env: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT, 10) || 3000,
  gatewaySecret: process.env.GATEWAY_SECRET,

  db: {
    url: process.env.DATABASE_URL,
  },

  redis: {
    url: process.env.REDIS_URL,
  },

  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY,
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
    enabled: !!(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_WEBHOOK_SECRET),
  },

  thronos: {
    coreUrl: process.env.THRONOS_CORE_URL || 'https://api.thronoschain.org',
    internalKey: process.env.THRONOS_INTERNAL_KEY,
  },

  treasury: {
    thr: process.env.THR_TREASURY_ADDRESS,
    eth: process.env.ETH_TREASURY_ADDRESS,
    bsc: process.env.BSC_TREASURY_ADDRESS,
    arbitrum: process.env.ARB_TREASURY_ADDRESS || process.env.ETH_TREASURY_ADDRESS,
    base: process.env.BASE_TREASURY_ADDRESS || process.env.ETH_TREASURY_ADDRESS,
    solana: process.env.SOL_TREASURY_ADDRESS,
  },

  rpc: {
    eth: process.env.ETH_RPC_URL || 'https://eth.llamarpc.com',
    bsc: process.env.BSC_RPC_URL || 'https://bsc-dataseed.binance.org',
    polygon: process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com',
    arbitrum: process.env.ARBITRUM_RPC_URL || 'https://arb1.arbitrum.io/rpc',
    base: process.env.BASE_RPC_URL || 'https://mainnet.base.org',
    solana: process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
  },

  // AI wallet that holds THR to stake when cross-chain fees arrive
  aiWallet: {
    thrAddress: process.env.AI_WALLET_THR_ADDRESS,
    thrAuthSecret: process.env.AI_WALLET_AUTH_SECRET,
  },

  // Wrapped THR token contracts on external chains
  wrappedThr: {
    eth: process.env.WTHR_ETH_CONTRACT,
    bsc: process.env.WTHR_BSC_CONTRACT,
    arbitrum: process.env.WTHR_ARB_CONTRACT,
    base: process.env.WTHR_BASE_CONTRACT,
    solana: process.env.WTHR_SOL_MINT,
  },

  payment: {
    confirmationBlocks: parseInt(process.env.PAYMENT_CONFIRMATION_BLOCKS, 10) || 12,
    minUsd: parseFloat(process.env.MIN_PAYMENT_USD) || 1.0,
    maxUsd: parseFloat(process.env.MAX_PAYMENT_USD) || 50000.0,
  },

  feeSplit: {
    treasury: parseInt(process.env.FEE_TREASURY_PCT, 10) || 50,
    burn: parseInt(process.env.FEE_BURN_PCT, 10) || 25,
    lp: parseInt(process.env.FEE_LP_PCT, 10) || 25,
  },

  jwt: {
    secret: process.env.JWT_SECRET,
    expiry: process.env.JWT_EXPIRY || '24h',
  },

  services: {
    commerce: process.env.COMMERCE_URL,
    builder: process.env.BUILDER_URL,
    verifyid: process.env.VERIFYID_URL,
    sentinel: process.env.SENTINEL_URL,
    btcAdapter: process.env.BTC_ADAPTER_URL,
  },
};

module.exports = { config, validateEnv };
