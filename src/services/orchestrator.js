'use strict';

const axios = require('axios');
const { config } = require('../utils/config');
const logger = require('../utils/logger');
const { Service } = require('../models');

const SERVICE_MAP = {
  commerce: { name: 'thronos-commerce', urlKey: 'commerce' },
  builder: { name: 'thronosbuilder', urlKey: 'builder' },
  verifyid: { name: 'thronos-verifyid', urlKey: 'verifyid' },
  sentinel: { name: 'trader-sentinel', urlKey: 'sentinel' },
  btcAdapter: { name: 'thronos-btc-api-adapter', urlKey: 'btcAdapter' },
  core: { name: 'thronos-core', urlKey: null },
};

/**
 * Forward a request to a downstream service (proxy pattern).
 */
async function proxyToService(serviceName, method, path, data, headers = {}) {
  const svc = SERVICE_MAP[serviceName];
  if (!svc) throw new Error(`Unknown service: ${serviceName}`);

  let url;
  if (svc.urlKey) {
    url = config.services[svc.urlKey];
  } else {
    url = config.thronos.coreUrl;
  }
  if (!url) throw new Error(`Service ${serviceName} URL not configured`);

  const reqConfig = {
    method,
    url: `${url}${path}`,
    timeout: 30000,
    headers: {
      'X-Internal-Key': config.thronos.internalKey,
      'Content-Type': 'application/json',
      ...headers,
    },
  };
  if (data && (method === 'post' || method === 'put' || method === 'patch')) {
    reqConfig.data = data;
  }

  try {
    const response = await axios(reqConfig);
    return { status: response.status, data: response.data };
  } catch (err) {
    const status = err.response?.status || 502;
    const errorData = err.response?.data || { error: err.message };
    logger.error('Service proxy failed', { serviceName, path, status, error: err.message });
    return { status, data: errorData };
  }
}

/**
 * Check health of all registered services.
 */
async function healthCheckAll() {
  const results = {};

  // Check configured services
  const checks = [
    { name: 'core', url: config.thronos.coreUrl, health: '/health' },
    { name: 'commerce', url: config.services.commerce, health: '/health' },
    { name: 'builder', url: config.services.builder, health: '/health' },
    { name: 'verifyid', url: config.services.verifyid, health: '/health' },
    { name: 'sentinel', url: config.services.sentinel, health: '/health' },
    { name: 'btcAdapter', url: config.services.btcAdapter, health: '/health' },
  ];

  await Promise.all(checks.map(async (svc) => {
    if (!svc.url) {
      results[svc.name] = { status: 'not_configured', latencyMs: null };
      return;
    }
    const start = Date.now();
    try {
      const resp = await axios.get(`${svc.url}${svc.health}`, { timeout: 5000 });
      const latencyMs = Date.now() - start;
      results[svc.name] = {
        status: resp.status === 200 ? 'healthy' : 'degraded',
        latencyMs,
        statusCode: resp.status,
      };

      // Update DB record
      await Service.upsert({
        name: svc.name,
        url: svc.url,
        healthEndpoint: svc.health,
        status: resp.status === 200 ? 'healthy' : 'degraded',
        lastCheck: new Date(),
        lastLatencyMs: latencyMs,
      });
    } catch (err) {
      const latencyMs = Date.now() - start;
      results[svc.name] = {
        status: 'down',
        latencyMs,
        error: err.message,
      };

      await Service.upsert({
        name: svc.name,
        url: svc.url,
        healthEndpoint: svc.health,
        status: 'down',
        lastCheck: new Date(),
        lastLatencyMs: latencyMs,
      }).catch((dbErr) => { logger.warn('Service upsert failed', { name: svc.name, error: dbErr.message }); });
    }
  }));

  return results;
}

/**
 * Notify a service that a payment was completed.
 * Each service type has its own callback pattern.
 */
async function notifyServicePaymentComplete(payment) {
  const callbacks = {
    commerce_order: () => proxyToService('commerce', 'post', '/api/gateway/payment-complete', {
      orderId: payment.serviceRef,
      paymentId: payment.id,
      method: payment.method,
      amount: payment.amountFiat,
    }),
    builder_build: () => proxyToService('builder', 'post', '/api/builds/payment-confirmed', {
      jobId: payment.serviceRef,
      paymentId: payment.id,
    }),
    sentinel_subscription: () => proxyToService('sentinel', 'post', '/api/subscription/activate', {
      userId: payment.userId,
      plan: payment.metadata?.plan,
      paymentId: payment.id,
    }),
    verifyid_kyc: () => proxyToService('verifyid', 'post', '/api/kyc/payment-confirmed', {
      sessionId: payment.serviceRef,
      paymentId: payment.id,
    }),
    driver_ride: () => proxyToService('core', 'post', '/api/driver/ride-paid', {
      rideId: payment.serviceRef,
      paymentId: payment.id,
    }),
    career_credits: () => proxyToService('core', 'post', '/api/career/credits-purchased', {
      userId: payment.userId,
      pack: payment.metadata?.plan,
      paymentId: payment.id,
    }),
  };

  const callback = callbacks[payment.serviceType];
  if (!callback) {
    logger.warn('No callback registered for service type', { serviceType: payment.serviceType });
    return null;
  }

  try {
    const result = await callback();
    logger.info('Service notified of payment', {
      serviceType: payment.serviceType,
      paymentId: payment.id,
      status: result.status,
    });
    return result;
  } catch (err) {
    logger.error('Failed to notify service', {
      serviceType: payment.serviceType,
      paymentId: payment.id,
      error: err.message,
    });
    return null;
  }
}

module.exports = { proxyToService, healthCheckAll, notifyServicePaymentComplete };
