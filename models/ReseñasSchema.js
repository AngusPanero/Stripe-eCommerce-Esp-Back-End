const mongoose = require('mongoose');

const ReseñasSchema = new mongoose.Schema({
    reseña: {
        type: String,
        required: [true, "La reseña es obligatoria"],
        trim: true,
        minlength: [3, "La reseña debe tener al menos 3 caracteres"],
        maxlength: [500, "La reseña no debe superar los 500 caracteres"]
        // sin lowercase: antes pasaba todo el texto a minúsculas y se perdía el formato del cliente
    },
    rating: {
        type: Number,
        required: true,
        min: [1, "El puntaje mínimo es 1"],
        max: [5, "El puntaje máximo es 5"],
        validate: { validator: Number.isInteger, message: "El puntaje debe ser un número entero" }
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
        required: true,
        index: true
    }
    }, { timestamps: true }
);

// Una sola reseña por usuario y producto (también frena el spam con un mismo usuario)
ReseñasSchema.index({ userEmail: 1, productId: 1 }, { unique: true });

const Reseñas = mongoose.model("reseñas", ReseñasSchema)

module.exports = Reseñas