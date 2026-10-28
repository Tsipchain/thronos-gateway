'use strict';

jest.mock('axios', () => ({
  get: jest.fn(),
  post: jest.fn(),
}));

jest.mock('../src/utils/config', () => ({
  config: {
    services: { btcAdapter: 'https://btc-adapter.example/api' },
    rpc: { solana: 'https://solana-rpc.example' },
    thronos: { coreUrl: 'https://core.example', internalKey: 'test-key' },
    payment: { confirmationBlocks: 12 },
  },
}));

jest.mock('../src/utils/logger', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

const axios = require('axios');
const chainService = require('../src/services/chainService');

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const txHash = 'a'.repeat(64);

describe('Bitcoin payment verification', () => {
  beforeEach(() => jest.clearAllMocks());

  test('returns a numeric confirmation count from the tx block and current tip', async () => {
    axios.get
      .mockResolvedValueOnce({
        data: {
          status: { confirmed: true, block_height: 100 },
          vout: [{ scriptpubkey_address: 'bc1qtreasury', value: 150000 }],
        },
      })
      .mockResolvedValueOnce({ data: '111' });

    const result = await chainService.verifyBtcPayment({
      txHash,
      expectedTo: 'bc1qtreasury',
      expectedAmount: 0.001,
    });

    expect(result).toMatchObject({ verified: true, confirmations: 12 });
    expect(axios.get).toHaveBeenNthCalledWith(
      1,
      `https://btc-adapter.example/api/tx/${txHash}`,
      { timeout: 15000 }
    );
    expect(axios.get).toHaveBeenNthCalledWith(
      2,
      'https://btc-adapter.example/api/blocks/tip/height',
      { timeout: 10000 }
    );
  });

  test('does not claim a confirmed payment until the worker applies the threshold', async () => {
    axios.get
      .mockResolvedValueOnce({
        data: {
          status: { confirmed: true, block_height: 100 },
          vout: [{ scriptpubkey_address: 'bc1qtreasury', value: 150000 }],
        },
      })
      .mockResolvedValueOnce({ data: '100' });

    const result = await chainService.verifyBtcPayment({
      txHash,
      expectedTo: 'bc1qtreasury',
      expectedAmount: 0.001,
    });

    expect(result).toMatchObject({ verified: true, confirmations: 1 });
  });

  test('treats unconfirmed Bitcoin transactions as retryable with zero confirmations', async () => {
    axios.get.mockResolvedValueOnce({
      data: { status: { confirmed: false }, vout: [] },
    });

    const result = await chainService.verifyBtcPayment({
      txHash,
      expectedTo: 'bc1qtreasury',
      expectedAmount: 0.001,
    });

    expect(result).toMatchObject({
      verified: false,
      retryable: true,
      confirmations: 0,
      reason: 'Transaction not confirmed',
    });
    expect(axios.get).toHaveBeenCalledTimes(1);
  });

  test('does not accept an output that pays a different address', async () => {
    axios.get
      .mockResolvedValueOnce({
        data: {
          status: { confirmed: true, block_height: 100 },
          vout: [{ scriptpubkey_address: 'bc1qattacker', value: 150000 }],
        },
      })
      .mockResolvedValueOnce({ data: '111' });

    const result = await chainService.verifyBtcPayment({
      txHash,
      expectedTo: 'bc1qtreasury',
      expectedAmount: 0.001,
    });

    expect(result).toMatchObject({
      verified: false,
      confirmations: 12,
      reason: 'No matching output found',
    });
  });
});

describe('Solana USDC payment verification', () => {
  beforeEach(() => jest.clearAllMocks());

  function transaction({ owner = 'treasuryWallet', mint = USDC_MINT, amount = '1250000' } = {}) {
    return {
      transaction: {
        message: {
          accountKeys: [
            { pubkey: 'senderWallet' },
            { pubkey: 'treasuryAta' },
          ],
          instructions: [{
            program: 'spl-token',
            parsed: {
              type: 'transferChecked',
              info: {
                mint,
                source: 'senderAta',
                destination: 'treasuryAta',
                tokenAmount: { amount },
              },
            },
          }],
        },
      },
      meta: {
        err: null,
        preTokenBalances: [],
        postTokenBalances: [{
          accountIndex: 1,
          mint,
          owner,
          uiTokenAmount: { amount, decimals: 6 },
        }],
        innerInstructions: [],
      },
    };
  }

  test('accepts only finalized USDC transferred to a token account owned by the treasury', async () => {
    axios.post.mockResolvedValueOnce({ data: { result: transaction() } });

    const result = await chainService.verifySolanaPayment({
      txSignature: 'solana-test-signature',
      expectedTo: 'treasuryWallet',
      expectedAmountUsdc: 1.25,
    });

    expect(result).toMatchObject({
      verified: true,
      finalized: true,
      confirmations: 1,
      to: 'treasuryWallet',
      token: 'USDC',
    });
    expect(axios.post.mock.calls[0][1].params[1].commitment).toBe('finalized');
  });

  test('rejects USDC transferred to a token account not owned by the treasury', async () => {
    axios.post.mockResolvedValueOnce({ data: { result: transaction({ owner: 'someoneElse' }) } });

    const result = await chainService.verifySolanaPayment({
      txSignature: 'solana-test-signature',
      expectedTo: 'treasuryWallet',
      expectedAmountUsdc: 1.25,
    });

    expect(result).toMatchObject({
      verified: false,
      finalized: true,
      reason: 'No matching finalized USDC transfer to treasury found',
    });
  });

  test('rejects a non-USDC token even when the transfer amount matches', async () => {
    axios.post.mockResolvedValueOnce({
      data: { result: transaction({ mint: 'NOT_USDC' }) },
    });

    const result = await chainService.verifySolanaPayment({
      txSignature: 'solana-test-signature',
      expectedTo: 'treasuryWallet',
      expectedAmountUsdc: 1.25,
    });

    expect(result.verified).toBe(false);
  });
});
