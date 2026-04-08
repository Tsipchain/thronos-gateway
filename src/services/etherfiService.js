'use strict';

const crypto = require('crypto');
const axios = require('axios');
const logger = require('../utils/logger');
const { config } = require('../utils/config');

/**
 * ether.fi Integration Service
 * Handles referral card onboarding + webhook verification
 * 
 * Phase 1: Referral redirect (user applies via ether.fi with our referral)
 * Phase 2: Co-branded card (when volume qualifies for ether.fi partnership)
 * Phase 3: Own card infrastructure (long-term)
 */

/**
 * Build the ether.fi referral URL with tracking params
 * @param {object} opts
 * @param {string} opts.userId
 * @param {string} opts.walletAddress
 * @param {string} [opts.source]  - where the user came from (app, dashboard, sentinel)
 * @returns {{ url: string, trackingId: string }}
 */
function buildReferralUrl({ userId, walletAddress, source = 'gateway' }) {
  const trackingId = crypto.randomUUID();
  const baseUrl = config.etherfi.referralUrl; // e.g. https://app.ether.fi/referral/XXXXX

  const params = new URLSearchParams({
    ref: config.etherfi.referralCode,
    utm_source: 'thronoschain',
    utm_medium: source,
    utm_campaign: 'thronos_card',
    tid: trackingId,
  });

  // Encode wallet for tracking (no PII in URL)
  if (walletAddress) {
    params.set('wa', Buffer.from(walletAddress.toLowerCase()).toString('base64url').slice(0, 16));
  }

  return {
    url: `${baseUrl}?${params.toString()}`,
    trackingId,
  };
}

/**
 * Verify ether.fi webhook signature
 */
function verifyWebhookSignature(rawBody, signatureHeader) {
  const secret = config.etherfi.webhookSecret;
  if (!secret) return true; // skip in dev

  const expected = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');

  const received = signatureHeader?.replace('sha256=', '') || '';
  return crypto.timingSafeEqual(
    Buffer.from(expected, 'hex'),
    Buffer.from(received.padEnd(expected.length, '0').slice(0, expected.length), 'hex')
  );
}

/**
 * Notify ether.fi of a Thronos user (for partnership tracking)
 * Only called if ETHERFI_PARTNER_API_KEY is set (Phase 2+)
 */
async function notifyEtherfiUserRegistration({ userId, walletAddress, email }) {
  if (!config.etherfi.partnerApiKey) return null;

  try {
    const res = await axios.post(
      `${config.etherfi.partnerApiUrl}/v1/referrals/register`,
      { referralCode: config.etherfi.referralCode, walletAddress, email },
      {
        headers: {
          'X-Api-Key': config.etherfi.partnerApiKey,
          'Content-Type': 'application/json',
        },
        timeout: 5000,
      }
    );
    return res.data;
  } catch (err) {
    logger.warn('ether.fi partner notify failed (non-critical)', { error: err.message });
    return null;
  }
}

module.exports = {
  buildReferralUrl,
  verifyWebhookSignature,
  notifyEtherfiUserRegistration,
};
