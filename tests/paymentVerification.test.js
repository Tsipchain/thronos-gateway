'use strict';

const { decideVerification, normalizeConfirmations, DEFAULT_MAX_VERIFICATION_AGE_MS } =
  require('../src/services/paymentVerification');

describe('payment confirmation decisions', () => {
  test('verified BTC transfer remains pending below the confirmation threshold', () => {
    expect(decideVerification({
      chain: 'btc',
      result: { verified: true, confirmations: 1 },
      requiredConfirmations: 12,
      elapsedMs: 60_000,
    })).toMatchObject({ action: 'retry', confirmations: 1 });
  });

  test('verified EVM transfer completes only at the configured confirmation count', () => {
    expect(decideVerification({
      chain: 'bsc',
      result: { verified: true, confirmations: 12 },
      requiredConfirmations: 12,
    })).toMatchObject({ action: 'complete', confirmations: 12 });
  });

  test('Solana completion uses finalized commitment rather than the EVM block threshold', () => {
    expect(decideVerification({
      chain: 'solana',
      result: { verified: true, finalized: true, confirmations: 1 },
      requiredConfirmations: 12,
    })).toMatchObject({ action: 'complete', confirmations: 1 });
  });

  test('Solana transfer without finalized commitment remains pending', () => {
    expect(decideVerification({
      chain: 'solana',
      result: { verified: true, finalized: false, confirmations: 0 },
      elapsedMs: 1_000,
    })).toMatchObject({ action: 'retry' });
  });

  test('not-yet-indexed transactions are retried rather than immediately failed', () => {
    expect(decideVerification({
      chain: 'btc',
      result: { verified: false, reason: 'Transaction not found', retryable: true },
      elapsedMs: 1_000,
    })).toMatchObject({ action: 'retry', confirmations: 0 });
  });

  test('a confirmed transaction sent to the wrong recipient fails closed', () => {
    expect(decideVerification({
      chain: 'btc',
      result: { verified: false, reason: 'No matching output found', confirmations: 12 },
      elapsedMs: 1_000,
    })).toMatchObject({ action: 'fail', reason: 'No matching output found' });
  });

  test('verification does not retry forever beyond the maximum pending age', () => {
    expect(decideVerification({
      chain: 'btc',
      result: { verified: true, confirmations: 3 },
      requiredConfirmations: 12,
      elapsedMs: DEFAULT_MAX_VERIFICATION_AGE_MS,
    })).toMatchObject({ action: 'fail', confirmations: 3 });
  });

  test('non-numeric confirmation strings are normalized to zero', () => {
    expect(normalizeConfirmations('confirmed')).toBe(0);
    expect(normalizeConfirmations('finalized')).toBe(0);
    expect(normalizeConfirmations(4)).toBe(4);
  });
});
