'use strict';

const express = require('express');
const { Payment, WebhookLog } = require('../models');
const stripeService = require('../services/stripeService');
const { notifyServicePaymentComplete } = require('../services/orchestrator');
const { attestPaymentOnChain } = require('../services/chainService');
const { config } = require('../utils/config');
const logger = require('../utils/logger');

const router = express.Router();

// ─── Stripe Webhook ─────────────────────────────────────────────────────────
// NOTE: This route must receive raw body (configured in index.js)
router.post('/stripe', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  if (!sig) return res.status(400).json({ error: 'Missing stripe-signature header' });

  let event;
  try {
    event = stripeService.constructWebhookEvent(req.body, sig);
  } catch (err) {
    logger.error('Stripe webhook signature verification failed', { error: err.message });
    return res.status(400).json({ error: `Webhook Error: ${err.message}` });
  }

  // Log the webhook
  const webhookLog = await WebhookLog.create({
    source: 'stripe',
    eventType: event.type,
    payload: event.data,
    processed: false,
  });

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const paymentId = session.metadata?.gatewayPaymentId;
        if (!paymentId) {
          logger.warn('Stripe session without gatewayPaymentId', { sessionId: session.id });
          break;
        }

        const payment = await Payment.findByPk(paymentId);
        if (!payment) {
          logger.error('Payment not found for Stripe session', { paymentId });
          break;
        }

        const amountCents = session.amount_total;
        await payment.update({
          status: 'completed',
          amountFiat: amountCents / 100,
          externalId: session.payment_intent || session.id,
          completedAt: new Date(),
        });

        // Apply fee split on gross amount (consistent with crossChainFeeHandler)
        const amountUsd = amountCents / 100;
        const feeTreasury = amountUsd * (config.feeSplit.treasury / 100);
        const feeBurn = amountUsd * (config.feeSplit.burn / 100);
        const feeLp = amountUsd * (config.feeSplit.lp / 100);

        await payment.update({ feeTreasury, feeBurn, feeLp });

        // Notify downstream service
        await notifyServicePaymentComplete(payment);

        // Attest on-chain
        await attestPaymentOnChain(payment);

        logger.info('Stripe payment completed', {
          paymentId,
          amount: amountCents / 100,
          serviceType: payment.serviceType,
        });
        break;
      }

      case 'invoice.payment_succeeded': {
        // Handle subscription renewals
        const invoice = event.data.object;
        const subMeta = invoice.subscription_details?.metadata || {};
        const paymentId = subMeta.gatewayPaymentId;
        if (paymentId) {
          const payment = await Payment.findByPk(paymentId);
          if (payment) {
            await payment.update({
              status: 'completed',
              amountFiat: invoice.amount_paid / 100,
              completedAt: new Date(),
            });
            await notifyServicePaymentComplete(payment);
          }
        }
        break;
      }

      case 'charge.refunded': {
        const charge = event.data.object;
        const pi = charge.payment_intent;
        if (pi) {
          const payment = await Payment.findOne({ where: { externalId: pi } });
          if (payment) {
            await payment.update({ status: 'refunded' });
            logger.info('Payment refunded via webhook', { paymentId: payment.id });
          }
        }
        break;
      }

      default:
        logger.debug('Unhandled Stripe event', { type: event.type });
    }

    await webhookLog.update({ processed: true, paymentId: webhookLog.paymentId });
    res.json({ received: true });
  } catch (err) {
    logger.error('Stripe webhook processing error', { error: err.message, eventType: event.type });
    await webhookLog.update({ error: err.message });
    res.status(500).json({ error: 'Processing failed' });
  }
});

module.exports = router;
