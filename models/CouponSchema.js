const mongoose = require('mongoose');

const CouponSchema = new mongoose.Schema({
    code:       { type: String, required: true, unique: true, uppercase: true, trim: true },
    discount:   { type: Number, required: true },
    type: {
        type:   String,
        enum:   ['single_use', 'date_limited', 'limited_uses'], 
        required: true
    },
    expiryDate: { type: Date },

    maxUses:    { type: Number, default: null },   
    usesCount:  { type: Number, default: 0 },      

    scope: {
        type:    String,
        enum:    ['all', 'products', 'categories'],
        default: 'all'
    },
    /* allowedProducts:   [{ type: mongoose.Schema.Types.ObjectId, ref: 'Product' }], */
    allowedProducts: [{ type: String }],
    allowedCategories: [{ type: String }],  

    isActive: { type: Boolean, default: true },
    usedBy:   [{ type: String }]
}, { timestamps: true });

module.exports = mongoose.model('Coupon', CouponSchema);