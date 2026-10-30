'use strict';

const { DataTypes } = require('sequelize');

function defineVoucher(sequelize) {
  return sequelize.define('Voucher', {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },

    checkoutId: { type: DataTypes.UUID, allowNull: false },
    merchantId: { type: DataTypes.UUID, allowNull: false },

    amountEur: { type: DataTypes.DECIMAL(18, 2), allowNull: false, comment: 'Gross checkout value in EUR' },
    feeEur: { type: DataTypes.DECIMAL(18, 2), allowNull: false, comment: 'Service fee retained by Thronos Labs IKE' },
    netEur: { type: DataTypes.DECIMAL(18, 2), allowNull: false, comment: 'Amount payable to merchant (amountEur − feeEur)' },

    cryptoSymbol: { type: DataTypes.STRING, allowNull: true, comment: 'Crypto received (THR, BTC, ETH …)' },
    cryptoAmount: { type: DataTypes.DECIMAL(36, 18), allowNull: true },
    vaultTxHash: { type: DataTypes.STRING, allowNull: true, comment: 'Tx that moved crypto into the vault' },

    status: {
      type: DataTypes.ENUM('pending_review', 'approved', 'settled', 'rejected'),
      defaultValue: 'pending_review',
    },

    issuedAt: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
    settledAt: { type: DataTypes.DATE, allowNull: true },
    reviewedBy: { type: DataTypes.STRING, allowNull: true, comment: 'Admin who approved/rejected' },
    notes: { type: DataTypes.TEXT, allowNull: true },
  }, {
    tableName: 'merchant_vouchers',
    indexes: [
      { fields: ['checkoutId'] },
      { fields: ['merchantId'] },
      { fields: ['status'] },
      { fields: ['issuedAt'] },
    ],
  });
}

module.exports = { defineVoucher };
