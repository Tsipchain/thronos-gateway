'use strict';

const { config, validateEnv } = require('../utils/config');
validateEnv();

const logger = require('../utils/logger');
const { Payment, WebhookLog, initDb } = require('../models');
const { paymentQueue, healthCheckQueue } = require('../services/queueService');
const chainService = require('../services/chainService');
const { notifyServicePaymentComplete } = require('../services/orchestrator');

async function start() {
  await initDb();
  logger.info('Payment worker started');

  // ─── Process Crypto Payment Verification ────────────────────────────────
  paymentQueue.process('verify-crypto', 3, async (job) => {
    const { paymentId, chain, txHash, expectedTo, expectedAmount, tokenSymbol } = job.data;
    logger.info('Verifying crypto payment', { paymentId, chain, txHash });

    const payment = await Payment.findByPk(paymentId);
    if (!payment) throw new Error(`Payment ${paymentId} not found`);

    let result;
    if (chain === 'btc') {
      result = await chainService.verifyBtcPayment({ txHash, expectedTo, expectedAmount });
    } else {
      result = await chainService.verifyEvmPayment({ chain, txHash, expectedTo, expectedAmount, tokenSymbol });
    }

    if (result.verified) {
      // Calculate fee split
      const thrPrice = await chainService.getThrPrice();
      const amountUsd = parseFloat(payment.amountCrypto) * thrPrice;

      await payment.update({
        status: 'completed',
        confirmations: result.confirmations,
        amountFiat: amountUsd,
        feeTreasury: (parseFloat(payment.amountCrypto) * config.feeSplit.treasury) / 100,
        feeBurn: (parseFloat(payment.amountCrypto) * config.feeSplit.burn) / 100,
        feeLp: (parseFloat(payment.amountCrypto) * config.feeSplit.lp) / 100,
        completedAt: new Date(),
      });

      // Notify downstream service
      await notifyServicePaymentComplete(payment);

      // Attest on-chain
      await chainService.attestPaymentOnChain(payment);

      logger.info('Crypto payment verified and completed', { paymentId, chain });
    } else if (result.confirmations !== undefined && result.confirmations < config.payment.confirmationBlocks) {
      // Not enough confirmations yet — re-queue with delay
      await payment.update({ confirmations: result.confirmations });
      throw new Error(`Only ${result.confirmations} confirmations, need ${config.payment.confirmationBlocks}`);
    } else {
      await payment.update({ status: 'failed', metadata: { ...payment.metadata, failReason: result.reason } });
      logger.warn('Crypto payment verification failed', { paymentId, reason: result.reason });
    }
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
