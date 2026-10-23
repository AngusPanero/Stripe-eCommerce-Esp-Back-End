const mongoose = require('mongoose');

/* ════════════════════════════════════════════════════════════════════════════
   AttributeSchema.js
   Diccionario de características usadas en las variantes (color, talle,
   capacidad, largo de cable...). Se alimenta solo cada vez que se crea o
   edita un producto, y el admin lo usa para autocompletar.
════════════════════════════════════════════════════════════════════════════ */

const AttributeSchema = new mongoose.Schema({
    nombre:  { type: String, required: true, unique: true, trim: true, lowercase: true, maxlength: 40 },
    valores: [{ type: String, trim: true, maxlength: 60 }],
    usos:    { type: Number, default: 0 },
}, { timestamps: true });

// Registra (o amplía) las opciones de un producto: [{ nombre, valores: [] }]
AttributeSchema.statics.registrar = async function (opciones = []) {
    for (const op of opciones) {
        const nombre = String(op?.nombre || "").trim().toLowerCase();
        if (!nombre) continue;

        try {
            const doc = (await this.findOne({ nombre })) || new this({ nombre, valores: [] });

            for (const raw of op.valores || []) {
                const valor = String(raw || "").replace(/\s+/g, " ").trim();
                if (valor && !doc.valores.some(x => x.toLowerCase() === valor.toLowerCase())) {
                    doc.valores.push(valor);
                }
            }
            doc.usos = (doc.usos || 0) + 1;
            await doc.save();
        } catch (error) {
            // dos productos guardados a la vez con un atributo nuevo → ignorar el duplicado
            if (error.code !== 11000) throw error;
        }
    }
};

module.exports = mongoose.model('Attribute', AttributeSchema);