'use strict';

const { ThrPayWallet, PayCard, Payment } = require('../models');
const { config } = require('../utils/config');
const logger = require('../utils/logger');
const axios = require('axios');

/**
 * Thronos Pay Service
 * Virtual wallet management for the Thronos Pay system
 */

/**
 * Get or create a ThrPay wallet for a user
 */
async function getOrCreateWallet(userId, walletAddress) {
  let wallet = await ThrPayWallet.findOne({
    where: walletAddress ? { walletAddress } : { userId },
  });

  if (!wallet) {
    wallet = await ThrPayWallet.create({
      userId,
      walletAddress: walletAddress || null,
      balanceThr: 0,
      balanceEth: 0,
      balanceUsdc: 0,
      status: 'active',
    });
    logger.info('ThrPay wallet created', { userId, walletAddress });
  }

  return wallet;
}

/**
 * Credit a wallet balance after verified on-chain deposit
 */
async function creditWallet({ walletId, asset, amount, paymentId }) {
  const wallet = await ThrPayWallet.findByPk(walletId);
  if (!wallet) throw new Error('Wallet not found');

  const field = assetToField(asset);
  const prev = parseFloat(wallet[field]) || 0;
  await wallet.update({ [field]: prev + parseFloat(amount) });

  logger.info('ThrPay wallet credited', { walletId, asset, amount });
  return wallet;
}

/**
 * Debit wallet balance (for card spend or withdrawal)
 */
async function debitWallet({ walletId, asset, amount, reason }) {
  const wallet = await ThrPayWallet.findByPk(walletId);
  if (!wallet) throw new Error('Wallet not found');

  const field = assetToField(asset);
  const current = parseFloat(wallet[field]) || 0;
  if (current < parseFloat(amount)) throw new Error('Insufficient balance');

  await wallet.update({ [field]: current - parseFloat(amount) });
  logger.info('ThrPay wallet debited', { walletId, asset, amount, reason });
  return wallet;
}

/**
 * Get wallet balances enriched with USD equivalents
 */
async function getWalletBalances(walletId) {
  const wallet = await ThrPayWallet.findByPk(walletId);
  if (!wallet) return null;

  // Fetch prices from core node price feed
  let prices = { THR: 0.03, ETH: 3000, USDC: 1 };
  try {
    const res = await axios.get(`${config.thronos.coreUrl}/api/v1/prices`, {
      headers: { 'X-Internal-Key': config.thronos.internalKey },
      timeout: 3000,
    });
    if (res.data?.THR) prices.THR = parseFloat(res.data.THR);
    if (res.data?.ETH) prices.ETH = parseFloat(res.data.ETH);
  } catch (err) { logger.warn('Price feed unavailable, using defaults', { error: err.message }); }

  const thr = parseFloat(wallet.balanceThr) || 0;
  const eth = parseFloat(wallet.balanceEth) || 0;
  const usdc = parseFloat(wallet.balanceUsdc) || 0;

  return {
    walletId: wallet.id,
    userId: wallet.userId,
    walletAddress: wallet.walletAddress,
    status: wallet.status,
    balances: {
      THR: { amount: thr, usdValue: (thr * prices.THR).toFixed(2) },
      ETH: { amount: eth, usdValue: (eth * prices.ETH).toFixed(2) },
      USDC: { amount: usdc, usdValue: usdc.toFixed(2) },
    },
    totalUsd: (thr * prices.THR + eth * prices.ETH + usdc).toFixed(2),
  };
}

/**
 * Get card application status for a user
 */
async function getCardStatus(userId, walletAddress) {
  const card = await PayCard.findOne({
    where: walletAddress ? { walletAddress } : { userId },
    order: [['createdAt', 'DESC']],
  });
  return card || null;
}

/**
 * Record a card application (user clicked apply via ether.fi referral)
 */
async function recordCardApplication({ userId, walletAddress, trackingId, source }) {
  const existing = await PayCard.findOne({
    where: walletAddress ? { walletAddress } : { userId },
  });
  if (existing) return existing; // already applied

  return PayCard.create({
    userId,
    walletAddress,
    provider: 'etherfi',
    status: 'applied',
    trackingId,
    source,
    metadata: { appliedAt: new Date().toISOString() },
  });
}

/**
 * Update card status from ether.fi webhook
 */
async function updateCardFromWebhook({ trackingId, status, cardLast4, network }) {
  const card = await PayCard.findOne({ where: { trackingId } });
  if (!card) {
    logger.warn('PayCard not found for webhook', { trackingId });
    return null;
  }

  const updates = { status };
  if (cardLast4) updates.cardLast4 = cardLast4;
  if (network) updates.metadata = { ...card.metadata, network };

  await card.update(updates);
  logger.info('PayCard updated from webhook', { trackingId, status });
  return card;
}

function assetToField(asset) {
  const map = { THR: 'balanceThr', ETH: 'balanceEth', USDC: 'balanceUsdc' };
  const field = map[asset?.toUpperCase()];
  if (!field) throw new Error(`Unsupported asset: ${asset}`);
  return field;
}

module.exports = {
  getOrCreateWallet,
  creditWallet,
  debitWallet,
  getWalletBalances,
  getCardStatus,
  recordCardApplication,
  updateCardFromWebhook,
};
