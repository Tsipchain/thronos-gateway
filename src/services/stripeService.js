'use strict';

const { config } = require('../utils/config');
const logger = require('../utils/logger');

let stripe = null;
if (config.stripe.enabled) {
  stripe = require('stripe')(config.stripe.secretKey);
}

const SERVICE_PRICES = {
  commerce_order: null,  // dynamic, set by caller
  builder_build: { apk: 1000, aab: 1000, ipa: 5000 },  // cents
  sentinel_subscription: { free: 0, hunter: 999, predator: 2999, whale: 9999 },
  verifyid_kyc: { basic: 499, full: 1499 },
  driver_ride: null,
  career_credits: { pack_10: 999, pack_50: 3999, pack_200: 12999 },
  thr_purchase: null,
};

/**
 * Create a Stripe checkout session for a service payment.
 */
async function createCheckoutSession({ serviceType, serviceRef, plan, amountCents, userId, walletAddress, successUrl, cancelUrl, metadata = {} }) {
  if (!stripe) throw new Error('Stripe is not configured');

  let unitAmount = amountCents;
  if (!unitAmount && SERVICE_PRICES[serviceType]) {
    const prices = SERVICE_PRICES[serviceType];
    unitAmount = prices[plan];
    if (unitAmount === undefined) {
      throw new Error(`Unknown plan "${plan}" for service "${serviceType}"`);
    }
  }
  if (!unitAmount || unitAmount <= 0) {
    throw new Error('Amount is required');
  }

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    payment_method_types: ['card'],
    line_items: [{
      price_data: {
        currency: 'usd',
        product_data: {
          name: `Thronos ${serviceType.replace(/_/g, ' ')}${plan ? ` — ${plan}` : ''}`,
          description: `Service: ${serviceType}, Ref: ${serviceRef || 'N/A'}`,
        },
        unit_amount: unitAmount,
      },
      quantity: 1,
    }],
    metadata: {
      gatewayPaymentId: metadata.paymentId || '',
      serviceType,
      serviceRef: serviceRef || '',
      userId: userId || '',
      walletAddress: walletAddress || '',
      ...metadata,
    },
    success_url: successUrl || `${config.thronos.coreUrl}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: cancelUrl || `${config.thronos.coreUrl}/payment/cancel`,
  }, {
    idempotencyKey: metadata.paymentId || undefined,
  });

  logger.info('Stripe checkout session created', {
    sessionId: session.id,
    serviceType,
    amount: unitAmount,
  });

  return { sessionId: session.id, url: session.url };
}

/**
 * Create a Stripe subscription for recurring service payments.
 */
async function createSubscription({ serviceType, plan, userId, walletAddress, successUrl, cancelUrl, metadata = {} }) {
  if (!stripe) throw new Error('Stripe is not configured');

  const prices = SERVICE_PRICES[serviceType];
  if (!prices || !prices[plan]) {
    throw new Error(`Unknown subscription plan "${plan}" for "${serviceType}"`);
  }

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    payment_method_types: ['card'],
    line_items: [{
      price_data: {
        currency: 'usd',
        product_data: {
          name: `Thronos ${serviceType.replace(/_/g, ' ')} — ${plan}`,
        },
        unit_amount: prices[plan],
        recurring: { interval: 'month' },
      },
      quantity: 1,
    }],
    metadata: {
      gatewayPaymentId: metadata.paymentId || '',
      serviceType,
      plan,
      userId: userId || '',
      walletAddress: walletAddress || '',
    },
    success_url: successUrl || `${config.thronos.coreUrl}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: cancelUrl || `${config.thronos.coreUrl}/payment/cancel`,
  });

  return { sessionId: session.id, url: session.url };
}

/**
 * Verify and construct a Stripe webhook event.
 */
function constructWebhookEvent(rawBody, signature) {
  if (!stripe) throw new Error('Stripe is not configured');
  if (!config.stripe.webhookSecret) {
    throw new Error('Stripe webhook secret not configured — refusing to process');
  }
  return stripe.webhooks.constructEvent(rawBody, signature, config.stripe.webhookSecret);
}

/**
 * Issue a refund via Stripe.
 */
async function issueRefund(paymentIntentId, amountCents) {
  if (!stripe) throw new Error('Stripe is not configured');
  const params = { payment_intent: paymentIntentId };
  if (amountCents) params.amount = amountCents;
  return stripe.refunds.create(params);
}

module.exports = {
  createCheckoutSession,
  createSubscription,
  constructWebhookEvent,
  issueRefund,
  SERVICE_PRICES,
};
