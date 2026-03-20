'use strict';

const axios = require('axios');
const { config } = require('../utils/config');
const logger = require('../utils/logger');
const { getThrPrice } = require('./chainService');

/**
 * Cross-Chain Fee Handler
 *
 * When a payment arrives from an external chain (ETH, BSC, Solana, etc.):
 * 1. Convert fee to THR equivalent
 * 2. Split: 50% treasury, 25% burn, 25% LP
 * 3. Stake THR from AI wallet into LP pool (locks native THR)
 * 4. Mint wrapped THR (wTHR) on the source chain
 * 5. Notify Sentinel of the new LP deposit
 *
 * This creates REAL liquidity in Sentinel pools backed by locked THR.
 */

const FEE_SPLIT = {
  treasury: (config.feeSplit?.treasury || 50) / 100,
  burn: (config.feeSplit?.burn || 25) / 100,
  lp: (config.feeSplit?.lp || 25) / 100,
};

/**
 * Process cross-chain fee from a builder/service payment.
 *
 * @param {Object} params
 * @param {string} params.sourceChain - Origin chain (ethereum, bsc, arbitrum, base, solana)
 * @param {number} params.amountThrEquivalent - Amount in THR equivalent
 * @param {string} params.payerAddress - Who paid
 * @param {string} params.txHash - Tx hash on source chain
 * @param {string} params.serviceType - Service that generated the fee
 * @returns {Object} Fee processing result
 */
async function processCrossChainFee({
  sourceChain,
  amountThrEquivalent,
  payerAddress,
  txHash,
  serviceType,
}) {
  logger.info('Processing cross-chain fee', {
    sourceChain, amountThrEquivalent, payerAddress, txHash, serviceType,
  });

  const thrPrice = await getThrPrice();
  const amountUsd = amountThrEquivalent * thrPrice;

  // Calculate fee splits
  const treasuryAmount = amountThrEquivalent * FEE_SPLIT.treasury;
  const burnAmount = amountThrEquivalent * FEE_SPLIT.burn;
  const lpAmount = amountThrEquivalent * FEE_SPLIT.lp;

  const result = {
    source_chain: sourceChain,
    amount_thr: amountThrEquivalent,
    amount_usd: amountUsd,
    fee_split: {
      treasury: { thr: treasuryAmount, usd: treasuryAmount * thrPrice },
      burn: { thr: burnAmount, usd: burnAmount * thrPrice },
      lp: { thr: lpAmount, usd: lpAmount * thrPrice },
    },
    actions: [],
  };

  // 1. Treasury deposit (50%) — record on Thronos chain
  try {
    await recordTreasuryDeposit(treasuryAmount, sourceChain, txHash);
    result.actions.push({ action: 'treasury_deposit', status: 'success', amount: treasuryAmount });
  } catch (err) {
    logger.error('Treasury deposit failed', { error: err.message });
    result.actions.push({ action: 'treasury_deposit', status: 'failed', error: err.message });
  }

  // 2. Burn (25%) — send to burn address on Thronos chain
  try {
    await burnThr(burnAmount, txHash);
    result.actions.push({ action: 'burn', status: 'success', amount: burnAmount });
  } catch (err) {
    logger.error('Burn failed', { error: err.message });
    result.actions.push({ action: 'burn', status: 'failed', error: err.message });
  }

  // 3. LP Pool stake (25%) — lock THR from AI wallet, mint wTHR on source chain
  try {
    const stakeResult = await stakeThrAndMintWrapped(lpAmount, sourceChain, txHash);
    result.actions.push({
      action: 'lp_stake_and_mint',
      status: 'success',
      amount: lpAmount,
      pool_id: stakeResult.pool_id,
      wrapped_mint_tx: stakeResult.mint_tx,
    });
  } catch (err) {
    logger.error('LP stake+mint failed', { error: err.message });
    result.actions.push({ action: 'lp_stake_and_mint', status: 'failed', error: err.message });
  }

  // 4. Notify Sentinel of pool update
  try {
    await notifySentinelPoolUpdate(sourceChain, lpAmount, txHash);
    result.actions.push({ action: 'sentinel_notify', status: 'success' });
  } catch (err) {
    logger.warn('Sentinel notification failed', { error: err.message });
    result.actions.push({ action: 'sentinel_notify', status: 'failed' });
  }

  logger.info('Cross-chain fee processed', { result });
  return result;
}

/**
 * Record treasury deposit on Thronos chain.
 */
async function recordTreasuryDeposit(amount, sourceChain, refTxHash) {
  const { data } = await axios.post(
    `${config.thronos.coreUrl}/api/tx/submit`,
    {
      type: 'crosschain_treasury_deposit',
      data: {
        from_chain: sourceChain,
        amount_thr: amount,
        to: config.treasury.thr,
        ref_tx: refTxHash,
        timestamp: new Date().toISOString(),
      },
    },
    {
      headers: { 'X-Internal-Key': config.thronos.internalKey },
      timeout: 10000,
    }
  );
  return data;
}

/**
 * Burn THR by sending to the burn address.
 */
async function burnThr(amount, refTxHash) {
  const { data } = await axios.post(
    `${config.thronos.coreUrl}/api/tx/submit`,
    {
      type: 'crosschain_fee_burn',
      data: {
        amount_thr: amount,
        from: config.treasury.thr,
        to: 'THR0000000000000000000000000000000000000000', // burn address
        ref_tx: refTxHash,
        timestamp: new Date().toISOString(),
      },
    },
    {
      headers: { 'X-Internal-Key': config.thronos.internalKey },
      timeout: 10000,
    }
  );
  return data;
}

/**
 * Stake THR from AI wallet into LP pool AND mint wrapped THR on the source chain.
 *
 * This is the key mechanism:
 * - AI wallet locks native THR in the LP pool (backing)
 * - Gateway mints equivalent wTHR on the source chain (representation)
 * - The locked THR backs the circulating wTHR 1:1
 * - Sentinel pools reflect real locked liquidity
 */
async function stakeThrAndMintWrapped(amount, sourceChain, refTxHash) {
  // Step A: Lock THR from AI wallet into the pool
  const poolMap = {
    ethereum: 'THR/ETH',
    arbitrum: 'THR/ETH',
    bsc: 'THR/BNB',
    base: 'THR/ETH',
    solana: 'THR/USDC',
  };
  const poolPair = poolMap[sourceChain] || 'THR/USDC';

  const stakeRes = await axios.post(
    `${config.thronos.coreUrl}/api/v1/pools/add_liquidity`,
    {
      pool_pair: poolPair,
      token_a: 'THR',
      amount_a: amount,
      user_address: config.aiWallet.thrAddress,
      auth_secret: config.aiWallet.thrAuthSecret,
      source: 'crosschain_fee',
      ref_tx: refTxHash,
    },
    {
      headers: { 'X-Internal-Key': config.thronos.internalKey },
      timeout: 15000,
    }
  );

  // Step B: Mint wrapped THR on the target chain
  const mintRes = await axios.post(
    `${config.thronos.coreUrl}/api/bridge/mint_wrapped`,
    {
      target_chain: sourceChain,
      amount_thr: amount,
      wrapped_contract: config.wrappedThr[sourceChain],
      backing_tx: stakeRes.data?.tx_id,
      ref_tx: refTxHash,
      timestamp: new Date().toISOString(),
    },
    {
      headers: { 'X-Internal-Key': config.thronos.internalKey },
      timeout: 15000,
    }
  );

  return {
    pool_id: stakeRes.data?.pool_id,
    stake_tx: stakeRes.data?.tx_id,
    mint_tx: mintRes.data?.mint_tx,
    amount_locked: amount,
    target_chain: sourceChain,
    wrapped_amount: amount,
  };
}

/**
 * Notify Sentinel that a pool has been updated with new liquidity from fees.
 */
async function notifySentinelPoolUpdate(sourceChain, amount, refTxHash) {
  const sentinelUrl = config.services.sentinel;
  if (!sentinelUrl) return;

  await axios.post(
    `${sentinelUrl}/api/pools/fee-deposit`,
    {
      source_chain: sourceChain,
      amount_thr: amount,
      type: 'crosschain_fee_lp',
      ref_tx: refTxHash,
      timestamp: new Date().toISOString(),
    },
    {
      headers: { 'X-Internal-Key': config.thronos.internalKey },
      timeout: 10000,
    }
  );
}

module.exports = {
  processCrossChainFee,
  FEE_SPLIT,
};
