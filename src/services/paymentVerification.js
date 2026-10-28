'use strict';

const DEFAULT_MAX_VERIFICATION_AGE_MS = 3 * 60 * 60 * 1000;
const RETRYABLE_REASONS = new Set([
  'Transaction not found',
  'Transaction not confirmed',
  'Insufficient confirmations',
  'Unable to determine Bitcoin confirmation count',
  'Unable to determine current Bitcoin block height',
]);

function normalizeConfirmations(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return 0;
  return Math.floor(numeric);
}

function decideVerification({
  chain,
  result,
  requiredConfirmations = 12,
  elapsedMs = 0,
  maxVerificationAgeMs = DEFAULT_MAX_VERIFICATION_AGE_MS,
}) {
  const confirmations = normalizeConfirmations(result?.confirmations);
  const reason = result?.reason || 'Payment verification failed';

  if (result?.verified) {
    const finalityReached = chain === 'solana'
      ? result.finalized === true
      : confirmations >= requiredConfirmations;

    if (finalityReached) {
      return { action: 'complete', confirmations, reason: null };
    }

    const pendingReason = chain === 'solana'
      ? 'Waiting for Solana finalized commitment'
      : `Only ${confirmations} confirmations, need ${requiredConfirmations}`;

    if (elapsedMs >= maxVerificationAgeMs) {
      return {
        action: 'fail',
        confirmations,
        reason: `Verification timed out: ${pendingReason}`,
      };
    }

    return { action: 'retry', confirmations, reason: pendingReason };
  }

  const retryable = result?.retryable === true || RETRYABLE_REASONS.has(reason);
  if (!retryable) {
    return { action: 'fail', confirmations, reason };
  }

  if (elapsedMs >= maxVerificationAgeMs) {
    return {
      action: 'fail',
      confirmations,
      reason: `Verification timed out: ${reason}`,
    };
  }

  return { action: 'retry', confirmations, reason };
}

module.exports = {
  DEFAULT_MAX_VERIFICATION_AGE_MS,
  decideVerification,
  normalizeConfirmations,
};
