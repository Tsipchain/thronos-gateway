'use strict';

const { ethers } = require('ethers');
const axios = require('axios');
const { config } = require('../utils/config');
const logger = require('../utils/logger');

// ERC-20 ABI subset for token transfers
const ERC20_ABI = [
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function balanceOf(address) view returns (uint256)',
];

// Well-known stablecoin addresses per chain
const STABLECOINS = {
  eth: {
    USDT: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    USDC: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  },
  bsc: {
    USDT: '0x55d398326f99059fF775485246999027B3197955',
    USDC: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
  },
  polygon: {
    USDT: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F',
    USDC: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
  },
  arbitrum: {
    USDT: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
    USDC: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  },
  base: {
    USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  },
};

const providers = {};

function getProvider(chain) {
  if (!providers[chain]) {
    const url = config.rpc[chain];
    if (!url) throw new Error(`No RPC configured for chain: ${chain}`);
    providers[chain] = new ethers.JsonRpcProvider(url);
  }
  return providers[chain];
}

/**
 * Verify an EVM transaction payment (native coin or ERC-20).
 */
async function verifyEvmPayment({ chain, txHash, expectedTo, expectedAmount, tokenSymbol }) {
  const provider = getProvider(chain);
  const receipt = await provider.getTransactionReceipt(txHash);
  if (!receipt) return { verified: false, reason: 'Transaction not found', retryable: true, confirmations: 0 };
  if (receipt.status !== 1) return { verified: false, reason: 'Transaction reverted' };

  const confirmations = Math.max(0, (await provider.getBlockNumber()) - receipt.blockNumber + 1);
  if (confirmations < config.payment.confirmationBlocks) {
    return { verified: false, reason: 'Insufficient confirmations', confirmations };
  }

  // Native coin transfer
  if (!tokenSymbol || tokenSymbol === 'ETH' || tokenSymbol === 'BNB' || tokenSymbol === 'MATIC') {
    const tx = await provider.getTransaction(txHash);
    const toMatch = tx.to && tx.to.toLowerCase() === expectedTo.toLowerCase();
    const amountWei = ethers.parseEther(expectedAmount.toString());
    const amountMatch = tx.value >= amountWei;
    return {
      verified: toMatch && amountMatch,
      confirmations,
      from: tx.from,
      to: tx.to,
      value: ethers.formatEther(tx.value),
      reason: !toMatch ? 'Wrong recipient' : !amountMatch ? 'Insufficient amount' : null,
    };
  }

  // ERC-20 transfer
  const stablecoins = STABLECOINS[chain] || {};
  const tokenAddress = stablecoins[tokenSymbol];
  if (!tokenAddress) return { verified: false, reason: `Unknown token ${tokenSymbol} on ${chain}` };

  const contract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
  const decimals = await contract.decimals();
  const expectedUnits = ethers.parseUnits(expectedAmount.toString(), decimals);

  // Parse Transfer events from receipt
  const iface = new ethers.Interface(ERC20_ABI);
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== tokenAddress.toLowerCase()) continue;
    try {
      const parsed = iface.parseLog(log);
      if (parsed.name === 'Transfer' &&
          parsed.args.to.toLowerCase() === expectedTo.toLowerCase() &&
          parsed.args.value >= expectedUnits) {
        return {
          verified: true,
          confirmations,
          from: parsed.args.from,
          to: parsed.args.to,
          value: ethers.formatUnits(parsed.args.value, decimals),
          token: tokenSymbol,
        };
      }
    } catch (_) { /* not a matching log */ }
  }

  return { verified: false, reason: 'No matching transfer event found', confirmations };
}

/**
 * Verify a BTC payment and return the actual Bitcoin confirmation count.
 * Blockstream-compatible adapter endpoints are rooted at /api.
 */
async function verifyBtcPayment({ txHash, expectedTo, expectedAmount }) {
  const baseUrl = config.services.btcAdapter
    ? config.services.btcAdapter.replace(/\/+$/, '')
    : 'https://blockstream.info/api';

  try {
    const { data: tx } = await axios.get(`${baseUrl}/tx/${txHash}`, { timeout: 15000 });

    if (!tx.status || !tx.status.confirmed) {
      return { verified: false, reason: 'Transaction not confirmed', retryable: true, confirmations: 0 };
    }

    const blockHeight = Number(tx.status.block_height);
    if (!Number.isSafeInteger(blockHeight) || blockHeight <= 0) {
      return {
        verified: false,
        reason: 'Unable to determine Bitcoin confirmation count',
        retryable: true,
        confirmations: 0,
      };
    }

    const { data: tipResponse } = await axios.get(`${baseUrl}/blocks/tip/height`, { timeout: 10000 });
    const tipHeight = Number(String(tipResponse).trim());
    if (!Number.isSafeInteger(tipHeight) || tipHeight < blockHeight) {
      return {
        verified: false,
        reason: 'Unable to determine current Bitcoin block height',
        retryable: true,
        confirmations: 0,
      };
    }

    const confirmations = Math.max(0, tipHeight - blockHeight + 1);
    const expectedSatoshis = Math.round(Number(expectedAmount) * 1e8);
    if (!Number.isFinite(expectedSatoshis) || expectedSatoshis <= 0 || !expectedTo) {
      return { verified: false, reason: 'Invalid expected Bitcoin recipient or amount', confirmations };
    }

    const matchingOutput = (tx.vout || []).find(
      out => out.scriptpubkey_address === expectedTo && Number(out.value) >= expectedSatoshis
    );

    return {
      verified: Boolean(matchingOutput),
      confirmations,
      from: undefined,
      to: expectedTo,
      value: matchingOutput ? Number(matchingOutput.value) / 1e8 : null,
      reason: matchingOutput ? null : 'No matching output found',
    };
  } catch (err) {
    logger.error('BTC verification failed', { txHash, error: err.message });
    return { verified: false, reason: err.message || 'Bitcoin provider request failed', retryable: true, confirmations: 0 };
  }
}

/**
 * Record a payment on the Thronos chain for attestation.
 */
async function attestPaymentOnChain(payment) {
  try {
    const { data } = await axios.post(
      `${config.thronos.coreUrl}/api/tx/submit`,
      {
        type: 'payment_attestation',
        data: {
          paymentId: payment.id,
          method: payment.method,
          amount: payment.amountFiat || payment.amountCrypto,
          serviceType: payment.serviceType,
          serviceRef: payment.serviceRef,
          txHash: payment.txHash,
          timestamp: new Date().toISOString(),
        },
      },
      {
        headers: { 'X-Internal-Key': config.thronos.internalKey },
        timeout: 10000,
      }
    );
    logger.info('Payment attested on-chain', { paymentId: payment.id, proofHash: data.hash });
    return data.hash;
  } catch (err) {
    logger.error('On-chain attestation failed', { paymentId: payment.id, error: err.message });
    return null;
  }
}

/**
 * Fetch current THR price from the core node.
 */
async function getThrPrice() {
  try {
    const { data } = await axios.get(`${config.thronos.coreUrl}/api/price/thr`, { timeout: 5000 });
    return data.priceUsd || 0.03;
  } catch (_) {
    return 0.03; // fallback
  }
}

/**
 * Get wallet balance from Thronos core.
 */
async function getWalletBalance(address) {
  try {
    const { data } = await axios.get(
      `${config.thronos.coreUrl}/api/wallet/${address}/balance`,
      {
        headers: { 'X-Internal-Key': config.thronos.internalKey },
        timeout: 5000,
      }
    );
    return data;
  } catch (err) {
    logger.warn('Failed to get wallet balance', { address, error: err.message });
    return null;
  }
}

/**
 * Verify a Solana USDC payment from a finalized transaction.
 * The destination must be a USDC token account owned by the configured treasury.
 */
async function verifySolanaPayment({ txSignature, expectedTo, expectedAmountUsdc }) {
  try {
    const rpcUrl = config.rpc.solana;
    const { data } = await axios.post(rpcUrl, {
      jsonrpc: '2.0',
      id: 1,
      method: 'getTransaction',
      params: [txSignature, {
        encoding: 'jsonParsed',
        commitment: 'finalized',
        maxSupportedTransactionVersion: 0,
      }],
    }, { timeout: 15000 });

    const tx = data.result;
    if (!tx) {
      return { verified: false, reason: 'Transaction not found', retryable: true, confirmations: 0 };
    }
    if (tx.meta?.err) return { verified: false, reason: 'Transaction failed', confirmations: 1 };

    const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const expectedUnits = BigInt(Math.round(Number(expectedAmountUsdc) * 1e6));
    if (expectedUnits <= 0n || !expectedTo) {
      return { verified: false, reason: 'Invalid expected Solana recipient or amount', confirmations: 1, finalized: true };
    }

    const accountKeys = tx.transaction?.message?.accountKeys || [];
    const publicKeyOf = key => typeof key === 'string' ? key : key?.pubkey;
    const preBalances = tx.meta?.preTokenBalances || [];
    const postBalances = tx.meta?.postTokenBalances || [];
    const tokenBalances = [...preBalances, ...postBalances];

    const destinationIsTreasuryUsdc = destination => {
      const destinationIndex = accountKeys.findIndex(key => publicKeyOf(key) === destination);
      if (destinationIndex < 0) return false;
      return tokenBalances.some(balance =>
        balance.accountIndex === destinationIndex &&
        balance.mint === USDC_MINT &&
        balance.owner === expectedTo
      );
    };

    const instructions = [
      ...(tx.transaction?.message?.instructions || []),
      ...(tx.meta?.innerInstructions?.flatMap(group => group.instructions || []) || []),
    ];

    for (const instruction of instructions) {
      const parsed = instruction.parsed;
      if (!parsed || !['transfer', 'transferChecked'].includes(parsed.type)) continue;

      const info = parsed.info || {};
      const destination = info.destination;
      if (!destination || !destinationIsTreasuryUsdc(destination)) continue;

      const destinationBalance = tokenBalances.find(balance =>
        accountKeys.findIndex(key => publicKeyOf(key) === destination) === balance.accountIndex &&
        balance.mint === USDC_MINT &&
        balance.owner === expectedTo
      );
      const mint = info.mint || destinationBalance?.mint;
      if (mint !== USDC_MINT) continue;

      const rawAmount = info.tokenAmount?.amount ?? info.amount;
      if (!/^\d+$/.test(String(rawAmount ?? ''))) continue;
      if (BigInt(String(rawAmount)) < expectedUnits) continue;

      return {
        verified: true,
        finalized: true,
        confirmations: 1,
        from: info.source || info.authority || null,
        to: expectedTo,
        value: (Number(BigInt(String(rawAmount))) / 1e6).toFixed(6),
        token: 'USDC',
      };
    }

    return {
      verified: false,
      reason: 'No matching finalized USDC transfer to treasury found',
      confirmations: 1,
      finalized: true,
    };
  } catch (err) {
    logger.error('Solana verification failed', { txSignature, error: err.message });
    return { verified: false, reason: err.message || 'Solana RPC request failed', retryable: true, confirmations: 0 };
  }
}

module.exports = {
  verifyEvmPayment,
  verifyBtcPayment,
  verifySolanaPayment,
  attestPaymentOnChain,
  getThrPrice,
  getWalletBalance,
  getProvider,
  STABLECOINS,
};
