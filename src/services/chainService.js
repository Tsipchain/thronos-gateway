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
  if (!receipt) return { verified: false, reason: 'Transaction not found' };
  if (receipt.status !== 1) return { verified: false, reason: 'Transaction reverted' };

  const confirmations = await provider.getBlockNumber() - receipt.blockNumber;
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
 * Verify a BTC payment via the BTC adapter service or public API.
 */
async function verifyBtcPayment({ txHash, expectedTo, expectedAmount }) {
  try {
    const url = config.services.btcAdapter
      ? `${config.services.btcAdapter}/tx/${txHash}`
      : `https://blockstream.info/api/tx/${txHash}`;
    const { data: tx } = await axios.get(url, { timeout: 15000 });

    if (!tx.status || !tx.status.confirmed) {
      return { verified: false, reason: 'Transaction not confirmed' };
    }

    const satoshis = Math.round(expectedAmount * 1e8);
    const matchingOutput = (tx.vout || []).find(
      out => out.scriptpubkey_address === expectedTo && out.value >= satoshis
    );

    return {
      verified: !!matchingOutput,
      confirmations: tx.status.block_height ? 'confirmed' : 0,
      reason: matchingOutput ? null : 'No matching output found',
    };
  } catch (err) {
    logger.error('BTC verification failed', { txHash, error: err.message });
    return { verified: false, reason: err.message };
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
 * Verify a Solana USDC payment via RPC.
 */
async function verifySolanaPayment({ txSignature, expectedTo, expectedAmountUsdc }) {
  try {
    const rpcUrl = config.rpc.solana;
    const { data } = await axios.post(rpcUrl, {
      jsonrpc: '2.0',
      id: 1,
      method: 'getTransaction',
      params: [txSignature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }],
    }, { timeout: 15000 });

    const tx = data.result;
    if (!tx) return { verified: false, reason: 'Transaction not found' };
    if (tx.meta?.err) return { verified: false, reason: 'Transaction failed' };

    // Check for USDC SPL token transfer in inner instructions
    const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const expectedLamports = Math.round(expectedAmountUsdc * 1e6); // USDC 6 decimals

    const allInstructions = [
      ...(tx.transaction?.message?.instructions || []),
      ...(tx.meta?.innerInstructions?.flatMap(i => i.instructions) || []),
    ];

    for (const ix of allInstructions) {
      const parsed = ix.parsed;
      if (!parsed) continue;

      if (parsed.type === 'transferChecked' || parsed.type === 'transfer') {
        const info = parsed.info;
        const mint = info.mint || null;
        const amount = parseInt(info.amount || info.tokenAmount?.amount || '0');

        if (mint === USDC_MINT || !mint) {
          if (amount >= expectedLamports) {
            return {
              verified: true,
              confirmations: 'finalized',
              from: info.source || info.authority,
              to: info.destination,
              value: (amount / 1e6).toFixed(2),
              token: 'USDC',
            };
          }
        }
      }
    }

    return { verified: false, reason: 'No matching USDC transfer found' };
  } catch (err) {
    logger.error('Solana verification failed', { txSignature, error: err.message });
    return { verified: false, reason: err.message };
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
