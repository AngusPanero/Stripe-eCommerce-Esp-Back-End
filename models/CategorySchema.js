const mongoose = require('mongoose');

const CategorySchema = new mongoose.Schema({
    nombre: {
        type: String,
        required: [true, "El nombre de la categoría es obligatorio"],
        trim: true,
        lowercase: true,
        maxlength: [50, "El nombre no puede exceder los 50 caracteres"],
        // "aire    libre" → "aire libre"
        set: v => typeof v === "string" ? v.replace(/\s+/g, " ") : v,
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
}, { timestamps: true });

// Único sin distinguir mayúsculas ni tildes: "Café" = "cafe" = "CAFÉ"
// (la ñ sigue siendo distinta de la n: "año" ≠ "ano")
const COLLATION_ES = { locale: "es", strength: 1 };
CategorySchema.index(
    { nombre: 1 },
    { unique: true, collation: COLLATION_ES, name: "nombre_unico_sin_tildes" }
);

const Category = mongoose.model("category", CategorySchema);

module.exports = Category;
module.exports.COLLATION_ES = COLLATION_ES;