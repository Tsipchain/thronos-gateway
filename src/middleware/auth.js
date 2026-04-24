'use strict';

const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { config } = require('../utils/config');
const logger = require('../utils/logger');

/**
 * Verify JWT token from Authorization header.
 */
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }
  const token = authHeader.slice(7);
  try {
    req.user = jwt.verify(token, config.jwt.secret);
    next();
  } catch (err) {
    logger.warn('JWT verification failed', { error: err.message });
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

/**
 * Verify internal service-to-service key (X-Internal-Key header).
 */
function requireInternalKey(req, res, next) {
  const key = req.headers['x-internal-key'] || req.headers['x-api-key'];
  if (!key || !config.thronos.internalKey) {
    return res.status(403).json({ error: 'Missing internal key' });
  }
  // Timing-safe comparison
  const expected = Buffer.from(config.thronos.internalKey);
  const received = Buffer.from(key);
  if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) {
    return res.status(403).json({ error: 'Invalid internal key' });
  }
  req.isInternalService = true;
  next();
}

/**
 * Allow either JWT or internal key.
 */
function requireAuthOrInternal(req, res, next) {
  const authHeader = req.headers.authorization;
  const internalKey = req.headers['x-internal-key'] || req.headers['x-api-key'];

  if (internalKey && config.thronos.internalKey) {
    const expected = Buffer.from(config.thronos.internalKey);
    const received = Buffer.from(internalKey);
    if (expected.length === received.length && crypto.timingSafeEqual(expected, received)) {
      req.isInternalService = true;
      return next();
    }
  }

  if (authHeader && authHeader.startsWith('Bearer ')) {
    try {
      req.user = jwt.verify(authHeader.slice(7), config.jwt.secret);
      return next();
    } catch (_) { /* JWT invalid — fall through to 401 */ }
  }

  return res.status(401).json({ error: 'Authentication required' });
}

module.exports = { requireAuth, requireInternalKey, requireAuthOrInternal };
