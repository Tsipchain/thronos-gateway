'use strict';

const axios = require('axios');
const logger = require('../utils/logger');

function isBasketballSubscriptionPayment(payment) {
  return payment?.serviceType === 'custom'
    && payment?.metadata?.kind === 'basketball_subscription';
}

async function notifyBasketballPaymentComplete(payment) {
  if (!isBasketballSubscriptionPayment(payment)) return null;

  const baseUrl = process.env.BASKETBALL_MARKET_URL;
  const internalKey = process.env.BASKETBALL_MARKET_INTERNAL_KEY;
  if (!baseUrl || !internalKey) {
    logger.error('Basketball payment callback is not configured', { paymentId: payment.id });
    return null;
  }

  try {
    const response = await axios.post(
      `${baseUrl.replace(/\/$/, '')}/api/v1/monetization/gateway/payment-complete`,
      {
        subscriptionId: payment.serviceRef,
        userId: payment.userId,
        plan: payment.metadata?.plan,
        billingPeriod: payment.metadata?.billingPeriod,
        paymentId: payment.id,
        amount: Number(payment.amountFiat || 0),
        currency: payment.currency,
        status: payment.status,
      },
      {
        headers: {
          'X-Internal-Key': internalKey,
          'Content-Type': 'application/json',
        },
        timeout: 30000,
      }
    );
    logger.info('Basketball subscription payment callback delivered', {
      paymentId: payment.id,
      subscriptionId: payment.serviceRef,
      status: response.status,
    });
    return response.data;
  } catch (err) {
    logger.error('Basketball subscription payment callback failed', {
      paymentId: payment.id,
      subscriptionId: payment.serviceRef,
      error: err.message,
    });
    return null;
  }
}

module.exports = { isBasketballSubscriptionPayment, notifyBasketballPaymentComplete };
