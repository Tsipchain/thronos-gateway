'use strict';

const crypto = require('crypto');
const { Op } = require('sequelize');
const logger = require('../utils/logger');

let Merchant, Checkout, Voucher;

function init(models) {
  Merchant = models.Merchant;
  Checkout = models.Checkout;
  Voucher = models.Voucher;
}

function hashApiKey(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

async function registerMerchant({ name, email, callbackUrl }) {
  const rawKey = `mk_${crypto.randomBytes(32).toString('hex')}`;
  const merchant = await Merchant.create({
    name,
    email,
    apiKeyHash: hashApiKey(rawKey),
    callbackUrl: callbackUrl || null,
    status: 'pending_review',
  });
  return { merchant, apiKey: rawKey };
}

async function authenticateMerchant(apiKey) {
  if (!apiKey) return null;
  const hash = hashApiKey(apiKey);
  const merchant = await Merchant.findOne({ where: { apiKeyHash: hash, status: 'active' } });
  return merchant;
}

async function createCheckout(merchant, { amountEur, description, customerRef, metadata }) {
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000);

  const checkout = await Checkout.create({
    merchantId: merchant.id,
    amountEur,
    description: description || null,
    customerRef: customerRef || null,
    status: 'created',
    expiresAt,
    metadata: metadata || {},
  });

  return checkout;
}

async function confirmCheckout(checkoutId, { txHash, selectedCrypto, cryptoAmount, confirmations }) {
  const checkout = await Checkout.findByPk(checkoutId);
  if (!checkout) throw new Error('Checkout not found');
  if (checkout.status !== 'created' && checkout.status !== 'pending') {
    throw new Error(`Cannot confirm checkout in status ${checkout.status}`);
  }

  await checkout.update({
    txHash,
    selectedCrypto: selectedCrypto || null,
    expectedCryptoAmount: cryptoAmount || null,
    confirmations: confirmations || 1,
    confirmedAt: new Date(),
    status: 'confirmed',
  });

  return checkout;
}

async function issueVoucher(checkoutId) {
  const checkout = await Checkout.findByPk(checkoutId);
  if (!checkout) throw new Error('Checkout not found');
  if (checkout.status !== 'confirmed') throw new Error('Checkout not confirmed');

  const merchant = await Merchant.findByPk(checkout.merchantId);
  if (!merchant) throw new Error('Merchant not found');

  const feeRate = parseFloat(merchant.feePercent) / 100;
  const gross = parseFloat(checkout.amountEur);
  const fee = Math.round(gross * feeRate * 100) / 100;
  const net = Math.round((gross - fee) * 100) / 100;

  const voucher = await Voucher.create({
    checkoutId: checkout.id,
    merchantId: merchant.id,
    amountEur: gross,
    feeEur: fee,
    netEur: net,
    cryptoSymbol: checkout.selectedCrypto,
    cryptoAmount: checkout.expectedCryptoAmount,
    vaultTxHash: checkout.txHash,
    status: 'pending_review',
  });

  await checkout.update({ voucherId: voucher.id, status: 'voucher_issued' });

  logger.info('Voucher issued', {
    voucherId: voucher.id,
    checkoutId: checkout.id,
    merchantId: merchant.id,
    netEur: net,
  });

  return voucher;
}

async function getCheckoutStatus(checkoutId, merchantId) {
  const where = { id: checkoutId };
  if (merchantId) where.merchantId = merchantId;
  const checkout = await Checkout.findOne({ where });
  return checkout;
}

async function listCheckouts(merchantId, { status, limit, offset }) {
  const where = { merchantId };
  if (status) where.status = status;
  return Checkout.findAndCountAll({
    where,
    limit: limit || 20,
    offset: offset || 0,
    order: [['createdAt', 'DESC']],
  });
}

async function listVouchers(merchantId, { status, limit, offset }) {
  const where = { merchantId };
  if (status) where.status = status;
  return Voucher.findAndCountAll({
    where,
    limit: limit || 20,
    offset: offset || 0,
    order: [['issuedAt', 'DESC']],
  });
}

module.exports = {
  init,
  hashApiKey,
  registerMerchant,
  authenticateMerchant,
  createCheckout,
  confirmCheckout,
  issueVoucher,
  getCheckoutStatus,
  listCheckouts,
  listVouchers,
};
