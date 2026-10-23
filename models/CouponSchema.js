const mongoose = require('mongoose');

/* ════════════════════════════════════════════════════════════════════════════
   CouponSchema.js
   Reglas combinables (todas se validan al cotizar y otra vez al cobrar):
   ─ type single_use   → 1 uso en total (se desactiva al usarse)
   ─ type limited_uses → maxUses usos en total
   ─ type date_limited → vence en expiryDate (puede llevar maxUses también)
   ─ startDate         → no vale antes de esa fecha (cualquier tipo)
   ─ expiryDate        → vence (cualquier tipo)
   ─ onePerUser        → cada email lo puede usar una sola vez
   ─ minPurchase       → compra mínima (€) en productos alcanzados
   ─ scope             → all | products (SKU padre o SKU variante) | categories
════════════════════════════════════════════════════════════════════════════ */

const CouponSchema = new mongoose.Schema({
    code:        { type: String, required: true, unique: true, uppercase: true, trim: true },
    description: { type: String, default: "" },
    discount:    { type: Number, required: true, min: 1, max: 100 },   // porcentaje
    type: {
        type:     String,
        enum:     ['single_use', 'date_limited', 'limited_uses'],
        required: true
    },

    startDate:  { type: Date, default: null },
    expiryDate: { type: Date, default: null },

    maxUses:    { type: Number, default: null },
    usesCount:  { type: Number, default: 0, min: 0 },
    onePerUser: { type: Boolean, default: false },
    minPurchase:{ type: Number, default: 0, min: 0 },

    scope: {
        type:    String,
        enum:    ['all', 'products', 'categories'],
        default: 'all'
    },
    allowedProducts:   [{ type: String }],   // SKUs en mayúscula
    allowedCategories: [{ type: String }],   // categorías en minúscula

    isActive:        { type: Boolean, default: true },
    autoDeactivated: { type: Boolean, default: false },   // true = se apagó solo por llegar al límite
    usedBy:          [{ type: String }]
}, { timestamps: true });

module.exports = mongoose.model('Coupon', CouponSchema);