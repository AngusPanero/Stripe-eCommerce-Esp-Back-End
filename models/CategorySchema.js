const mongoose = require('mongoose');

const CategorySchema = new mongoose.Schema({
    nombre: {
        type: String,
        required: [true, "El nombre de la categoría es obligatorio"],
        unique: true,
        trim: true,  
        lowercase: true, 
        maxlength: [50, "El nombre no puede exceder los 50 caracteres"]
    },
    descripcion: {
        type: String,
        trim: true,
        default: ""
    },
    
    active: {
        type: Boolean,
        default: true
    }
    }, { timestamps: true }
);

const Category = mongoose.model("category", CategorySchema)

module.exports = Category