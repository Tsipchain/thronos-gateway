'use strict';

const Queue = require('bull');
const { config } = require('../utils/config');
const logger = require('../utils/logger');

const paymentQueue = new Queue('payment-processing', config.redis.url, {
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: 100,
    removeOnFail: 50,
  },
});

const healthCheckQueue = new Queue('health-checks', config.redis.url, {
  defaultJobOptions: {
    attempts: 1,
    removeOnComplete: 10,
  },
});

const webhookQueue = new Queue('webhook-delivery', config.redis.url, {
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: 'exponential', delay: 3000 },
    removeOnComplete: 50,
    removeOnFail: 100,
  },
});

// Logging for all queues
[paymentQueue, healthCheckQueue, webhookQueue].forEach(q => {
  q.on('error', err => logger.error(`Queue ${q.name} error`, { error: err.message }));
  q.on('failed', (job, err) => logger.error(`Job ${job.id} in ${q.name} failed`, { error: err.message }));
});

module.exports = { paymentQueue, healthCheckQueue, webhookQueue };
