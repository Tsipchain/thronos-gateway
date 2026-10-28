'use strict';

const { config, validateEnv } = require('../utils/config');
validateEnv();

const logger = require('../utils/logger');
const { Payment, WebhookLog, initDb } = require('../models');
const { paymentQueue, healthCheckQueue } = require('../services/queueService');
const chainService = require('../services/chainService');
const { notifyServicePaymentComplete } = require('../services/orchestrator');
const { decideVerification, DEFAULT_MAX_VERIFICATION_AGE_MS } = require('../services/paymentVerification');

const VERIFICATION_RETRY_DELAY_MS = 60 * 1000;

async function start() {
  await initDb();
  logger.info('Payment worker started');

  // ─── Process Crypto Payment Verification ────────────────────────────────
  paymentQueue.process('verify-crypto', 3, async (job) => {
    const { paymentId, chain, txHash, expectedTo, expectedAmount, tokenSymbol } = job.data;
    logger.info('Verifying crypto payment', { paymentId, chain, txHash });

    const payment = await Payment.findByPk(paymentId);
    if (!payment) throw new Error(`Payment ${paymentId} not found`);
    if (['completed', 'failed', 'expired', 'refunded'].includes(payment.status)) {
      logger.info('Skipping verification for terminal payment', { paymentId, status: payment.status });
      return;
    }

    let result;
    try {
      if (chain === 'btc') {
        result = await chainService.verifyBtcPayment({ txHash, expectedTo, expectedAmount });
      } else if (chain === 'solana') {
        result = await chainService.verifySolanaPayment({
          txSignature: txHash,
          expectedTo,
          expectedAmountUsdc: expectedAmount,
        });
      } else if (chain === 'thr') {
        result = {
          verified: false,
          reason: 'Native THR transactions must be verified by Thronos Core, not the EVM payment verifier',
        };
      } else {
        result = await chainService.verifyEvmPayment({ chain, txHash, expectedTo, expectedAmount, tokenSymbol });
      }
    } catch (err) {
      const permanentConfigurationError = /No RPC configured|Unknown token|unsupported chain/i.test(err.message || '');
      result = {
        verified: false,
        reason: err.message || 'Payment verification request failed',
        retryable: !permanentConfigurationError,
        confirmations: 0,
      };
    }

    const createdAtMs = new Date(payment.createdAt || Date.now()).getTime();
    const elapsedMs = Number.isFinite(createdAtMs) ? Math.max(0, Date.now() - createdAtMs) : 0;
    const decision = decideVerification({
      chain,
      result,
      requiredConfirmations: config.payment.confirmationBlocks,
      elapsedMs,
      maxVerificationAgeMs: DEFAULT_MAX_VERIFICATION_AGE_MS,
    });

    if (decision.action === 'retry') {
      await payment.update({
        status: 'confirming',
        confirmations: decision.confirmations,
        metadata: {
          ...(payment.metadata || {}),
          lastVerificationReason: decision.reason,
          lastVerificationAt: new Date().toISOString(),
        },
      });

      // Schedule one delayed follow-up instead of exhausting Bull's three fast retries.
      const minuteSlot = Math.floor(Date.now() / VERIFICATION_RETRY_DELAY_MS);
      await paymentQueue.add('verify-crypto', job.data, {
        delay: VERIFICATION_RETRY_DELAY_MS,
        jobId: `verify-${payment.id}-${minuteSlot}`,
        attempts: 1,
        removeOnComplete: true,
        removeOnFail: 50,
      });

      logger.info('Payment remains confirming; delayed verification scheduled', {
        paymentId,
        chain,
        confirmations: decision.confirmations,
        retryDelayMs: VERIFICATION_RETRY_DELAY_MS,
        reason: decision.reason,
      });
      return;
    }

    if (decision.action === 'fail') {
      await payment.update({
        status: 'failed',
        confirmations: decision.confirmations,
        metadata: { ...(payment.metadata || {}), failReason: decision.reason },
      });
      logger.warn('Crypto payment verification failed', {
        paymentId,
        chain,
        reason: decision.reason,
      });
      return;
    }

    // Calculate fee split only after the chain-specific finality rule is met.
    const thrPrice = await chainService.getThrPrice();
    const amountUsd = parseFloat(payment.amountCrypto) * thrPrice;

    await payment.update({
      status: 'completed',
      confirmations: decision.confirmations,
      amountFiat: amountUsd,
      feeTreasury: (parseFloat(payment.amountCrypto) * config.feeSplit.treasury) / 100,
      feeBurn: (parseFloat(payment.amountCrypto) * config.feeSplit.burn) / 100,
      feeLp: (parseFloat(payment.amountCrypto) * config.feeSplit.lp) / 100,
      completedAt: new Date(),
      metadata: { ...(payment.metadata || {}), finalityVerifiedAt: new Date().toISOString() },
    });

    await notifyServicePaymentComplete(payment);
    await chainService.attestPaymentOnChain(payment);

    logger.info('Crypto payment verified and completed', {
      paymentId,
      chain,
      confirmations: decision.confirmations,
    });
  });

  // ─── Health Check Worker ────────────────────────────────────────────────
  healthCheckQueue.process('check-all', async () => {
    const { healthCheckAll } = require('../services/orchestrator');
    const results = await healthCheckAll();
    logger.info('Health check completed', { results });
    return results;
  });

  // ─── Schedule periodic health checks ────────────────────────────────────
  setInterval(async () => {
    await healthCheckQueue.add('check-all', {}, { removeOnComplete: true });
  }, 60000); // Every 60 seconds

  // ─── Expired payment cleanup ────────────────────────────────────────────
  setInterval(async () => {
    try {
      const oneHourAgo = new Date(Date.now() - 3600000);
      const [count] = await Payment.update(
        { status: 'expired' },
        { where: { status: 'pending', createdAt: { [require('sequelize').Op.lt]: oneHourAgo } } }
      );
      if (count > 0) {
        logger.info(`Expired ${count} stale pending payments`);
      }
    } catch (err) {
      logger.error('Expired payment cleanup failed', { error: err.message });
    }
  }, 300000); // Every 5 minutes
}

start().catch(err => {
  logger.error('Payment worker failed to start', { error: err.message });
  process.exit(1);
});
