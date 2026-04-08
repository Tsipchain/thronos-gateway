'use strict';

require('dotenv').config();
const axios = require('axios');

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

  node2: {
    url: process.env.NODE2_URL || process.env.REPLICA_EXTERNAL_URL,
    internalKey: process.env.NODE2_INTERNAL_KEY,
  },

  thronos: {
    coreUrl: process.env.THRONOS_CORE_URL || process.env.NODE2_URL || process.env.REPLICA_EXTERNAL_URL || 'https://api.thronoschain.org',
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
    thrAddress: process.env.AI_WALLET_THR_ADDRESS || process.env.THR_AI_AGENT_WALLET,
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

  etherfi: {
    referralUrl: process.env.ETHERFI_REFERRAL_URL || 'https://app.ether.fi/referral',
    referralCode: process.env.ETHERFI_REFERRAL_CODE || '',
    webhookSecret: process.env.ETHERFI_WEBHOOK_SECRET || '',
    partnerApiKey: process.env.ETHERFI_PARTNER_API_KEY || '',
    partnerApiUrl: process.env.ETHERFI_PARTNER_API_URL || 'https://api.ether.fi',
  },
};

/**
 * Sync config from Node 2 replica (source of truth for RPCs, treasury, keys).
 * Called once at startup if NODE2_URL is set.
 */
async function syncConfigFromNode2() {
  const node2Url = config.node2.url;
  if (!node2Url) {
    console.warn('[config] NODE2_URL not set — skipping Node 2 sync');
    return;
  }

  try {
    const { data } = await axios.get(`${node2Url}/api/config/gateway`, {
      headers: config.node2.internalKey
        ? { 'X-Internal-Key': config.node2.internalKey }
        : {},
      timeout: 10000,
    });

    // Merge RPC URLs (Node 2 overrides local)
    if (data.rpc) {
      Object.entries(data.rpc).forEach(([chain, url]) => {
        if (url) config.rpc[chain] = url;
      });
    }

    // Merge treasury addresses
    if (data.treasury) {
      Object.entries(data.treasury).forEach(([chain, addr]) => {
        if (addr) config.treasury[chain] = addr;
      });
    }

    // AI wallet address
    if (data.aiWallet) {
      config.aiWallet.thrAddress = data.aiWallet || config.aiWallet.thrAddress;
    }

    // Stripe keys (if provided by Node 2)
    if (data.stripe) {
      if (data.stripe.secretKey) config.stripe.secretKey = data.stripe.secretKey;
      if (data.stripe.publishableKey) config.stripe.publishableKey = data.stripe.publishableKey;
      if (data.stripe.webhookSecret) config.stripe.webhookSecret = data.stripe.webhookSecret;
      config.stripe.enabled = !!(config.stripe.secretKey && config.stripe.webhookSecret);
    }

    console.log('[config] Synced config from Node 2 successfully');
  } catch (err) {
    console.warn(`[config] Failed to sync from Node 2: ${err.message} — using local env`);
  }
}

module.exports = { config, validateEnv, syncConfigFromNode2 };
