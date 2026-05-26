const mongoose = require('mongoose');

const ReseñasSchema = new mongoose.Schema({
    reseña: {
        type: String,
        required: [true, "La reseña es obligatorio"],
        trim: true,  
        lowercase: true, 
        maxlength: [500, "La reseña no debe superar los 50 caracteres"]
    },
    rating: {
        type: Number,
        required: true
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
    }, { timestamps: true }
);

const Reseñas = mongoose.model("reseñas", ReseñasSchema)

module.exports = Reseñas