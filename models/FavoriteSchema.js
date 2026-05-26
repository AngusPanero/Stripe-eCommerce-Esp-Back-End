const mongoose = require('mongoose');

const FavoriteSchema = new mongoose.Schema({
    nombre: {
        type: String,
        required: true,
        lowercase: true,
        trim: true
    },
    userEmail: {
        type: String,
        required: true,
        lowercase: true,
        trim: true
    },
    productId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Product',
        required: true
    }
}, { timestamps: true });

// Índice único: Un usuario + Un producto = Solo una entrada en la DB
FavoriteSchema.index({ userEmail: 1, productId: 1 }, { unique: true });

module.exports = mongoose.model('Favorite', FavoriteSchema);