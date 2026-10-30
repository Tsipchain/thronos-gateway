'use strict';

const { DataTypes } = require('sequelize');

/**
 * A Checkout represents a single crypto-payment session created by a
 * merchant.  The customer pays to the vault address shown; once confirmed
 * on-chain the gateway issues a settlement voucher.
 */
function defineCheckout(sequelize) {
  return sequelize.define('Checkout', {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },

    merchantId: { type: DataTypes.UUID, allowNull: false },

    amountEur: { type: DataTypes.DECIMAL(18, 2), allowNull: false },
    description: { type: DataTypes.STRING, allowNull: true },

    cryptoOptions: {
      type: DataTypes.JSONB,
      defaultValue: {},
      comment: 'Map of accepted crypto → vault address, e.g. {"THR":"0x…","BTC":"1Q…"}',
    },

    selectedCrypto: { type: DataTypes.STRING, allowNull: true, comment: 'Crypto the customer chose' },
    expectedCryptoAmount: { type: DataTypes.DECIMAL(36, 18), allowNull: true },
    vaultAddress: { type: DataTypes.STRING, allowNull: true, comment: 'Vault address for the selected crypto' },

    txHash: { type: DataTypes.STRING, allowNull: true, comment: 'On-chain transaction hash (set on confirmation)' },
    confirmations: { type: DataTypes.INTEGER, defaultValue: 0 },
    confirmedAt: { type: DataTypes.DATE, allowNull: true },

    voucherId: { type: DataTypes.UUID, allowNull: true, comment: 'FK to the settlement voucher once issued' },

    status: {
      type: DataTypes.ENUM('created', 'pending', 'confirmed', 'voucher_issued', 'settled', 'expired', 'cancelled'),
      defaultValue: 'created',
    },

    expiresAt: { type: DataTypes.DATE, allowNull: true, comment: 'Checkout link expiry (e.g. 30 min)' },
    customerRef: { type: DataTypes.STRING, allowNull: true, comment: 'Merchant-supplied order/invoice reference' },
    metadata: { type: DataTypes.JSONB, defaultValue: {} },
  }, {
    tableName: 'merchant_checkouts',
    indexes: [
      { fields: ['merchantId'] },
      { fields: ['status'] },
      { fields: ['txHash'] },
      { fields: ['voucherId'] },
      { fields: ['createdAt'] },
    ],
  });
}

module.exports = { defineCheckout };
