'use strict';

const { DataTypes } = require('sequelize');

/**
 * Define the Merchant model on the shared Sequelize instance.
 *
 * A Merchant is a business that accepts crypto payments through Thronos
 * Gateway without operating its own wallet.  ThronosChain holds incoming
 * crypto in its vault, issues a settlement voucher, and Thronos Labs IKE
 * pays the merchant in fiat (EUR) minus the service fee.
 */
function defineMerchant(sequelize) {
  return sequelize.define('Merchant', {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },

    name: { type: DataTypes.STRING, allowNull: false },
    email: { type: DataTypes.STRING, allowNull: false, unique: true },
    apiKeyHash: {
      type: DataTypes.STRING,
      allowNull: false,
      comment: 'SHA-256 hash of the merchant API key — the plaintext is shown once at registration',
    },

    bankIbanMasked: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'Masked IBAN (e.g. GR16 **** **** 1234) for display; full IBAN never stored in gateway DB',
    },
    bankReference: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'Opaque reference for the settlement partner to look up the real IBAN',
    },

    callbackUrl: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'HTTPS URL the gateway POSTs to when a checkout is confirmed',
    },

    feePercent: {
      type: DataTypes.DECIMAL(5, 2),
      defaultValue: 2.50,
      comment: 'Settlement fee charged by Thronos Labs IKE (%)',
    },

    status: {
      type: DataTypes.ENUM('pending_review', 'active', 'suspended', 'closed'),
      defaultValue: 'pending_review',
    },
  }, {
    tableName: 'merchants',
    indexes: [
      { fields: ['email'], unique: true },
      { fields: ['status'] },
    ],
  });
}

module.exports = { defineMerchant };
