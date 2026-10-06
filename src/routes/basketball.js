'use strict';

const crypto = require('crypto');
const express = require('express');
const { body, param } = require('express-validator');
const { Payment } = require('../models');
const { handleValidation } = require('../middleware/validate');
const logger = require('../utils/logger');

const router = express.Router();

const PLANS = {
  pro_monthly: { amountCents: 1490, interval: 'month' },
  pro_yearly: { amountCents: 14900, interval: 'year' },
  scout_monthly: { amountCents: 3990, interval: 'month' },
  scout_yearly: { amountCents: 39900, interval: 'year' },
  agent_monthly: { amountCents: 5990, interval: 'month' },
  agent_yearly: { amountCents: 59900, interval: 'year' },
  club_monthly: { amountCents: 14900, interval: 'month' },
  club_yearly: { amountCents: 149000, interval: 'year' },
};

function requireBasketballKey(req, res, next) {
  const expectedValue = process.env.BASKETBALL_MARKET_INTERNAL_KEY;
  const receivedValue = req.headers['x-internal-key'] || req.headers['x-api-key'];
  if (!expectedValue || !receivedValue) {
    return res.status(403).json({ error: 'Basketball service key is not configured' });
  }
  const expected = Buffer.from(expectedValue);
  const received = Buffer.from(receivedValue);
  if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) {
    return res.status(403).json({ error: 'Invalid basketball service key' });
  }
  return next();
}

function stripeClient() {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) throw new Error('Stripe is not configured');
  return require('stripe')(secretKey);
}

router.post(
  '/subscriptions/checkout',
  requireBasketballKey,
  [
    body('subscriptionId').isString().trim().notEmpty(),
    body('userId').isString().trim().notEmpty(),
    body('plan').isIn(['pro', 'scout', 'agent', 'club']),
    body('billingPeriod').isIn(['monthly', 'yearly']),
    body('successUrl').isURL(),
    body('cancelUrl').isURL(),
  ],
  handleValidation,
  async (req, res) => {
    try {
      const {
        subscriptionId,
        userId,
        plan,
        billingPeriod,
        successUrl,
        cancelUrl,
      } = req.body;
      const planKey = `${plan}_${billingPeriod}`;
      const pricing = PLANS[planKey];
      if (!pricing) return res.status(400).json({ error: 'Unsupported basketball plan' });

      const existing = await Payment.findOne({
        where: {
          serviceType: 'custom',
          serviceRef: subscriptionId,
        },
      });
      if (existing && ['pending', 'confirming', 'completed'].includes(existing.status)) {
        return res.status(409).json({
          error: 'Subscription payment already exists',
          paymentId: existing.id,
          status: existing.status,
        });
      }

      const payment = await Payment.create({
        userId,
        serviceType: 'custom',
        serviceRef: subscriptionId,
        method: 'stripe',
        amountFiat: pricing.amountCents / 100,
        currency: 'EUR',
        status: 'pending',
        metadata: {
          kind: 'basketball_subscription',
          plan,
          billingPeriod,
          recurring: true,
        },
      });

      const metadata = {
        gatewayPaymentId: payment.id,
        serviceType: 'custom',
        serviceRef: subscriptionId,
        kind: 'basketball_subscription',
        plan,
        billingPeriod,
        userId,
      };
      const stripe = stripeClient();
      const session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        payment_method_types: ['card'],
        line_items: [{
          price_data: {
            currency: 'eur',
            product_data: {
              name: `Thronos Basketball Market — ${plan}`,
              description: `${billingPeriod} Basketball Market subscription`,
            },
            unit_amount: pricing.amountCents,
            recurring: { interval: pricing.interval },
          },
          quantity: 1,
        }],
        metadata,
        subscription_data: { metadata },
        success_url: successUrl,
        cancel_url: cancelUrl,
      }, {
        idempotencyKey: payment.id,
      });

      await payment.update({ externalId: session.id });
      return res.json({
        paymentId: payment.id,
        checkoutUrl: session.url,
        sessionId: session.id,
      });
    } catch (err) {
      logger.error('Basketball subscription checkout failed', { error: err.message });
      return res.status(500).json({ error: 'Basketball subscription checkout failed' });
    }
  }
);

router.get(
  '/payments/:paymentId',
  requireBasketballKey,
  [param('paymentId').isUUID()],
  handleValidation,
  async (req, res) => {
    const payment = await Payment.findByPk(req.params.paymentId);
    if (!payment || payment.metadata?.kind !== 'basketball_subscription') {
      return res.status(404).json({ error: 'Basketball payment not found' });
    }
    return res.json({
      paymentId: payment.id,
      subscriptionId: payment.serviceRef,
      status: payment.status,
      amount: Number(payment.amountFiat || 0),
      currency: payment.currency,
      plan: payment.metadata?.plan,
      billingPeriod: payment.metadata?.billingPeriod,
      completedAt: payment.completedAt,
    });
  }
);

module.exports = router;
