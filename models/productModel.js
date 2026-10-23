const mongoose = require('mongoose');

/* ════════════════════════════════════════════════════════════════════════════
   productModel.js
   ─ Producto ÚNICO  → variantes: []  · usa stock_base
   ─ Con VARIANTES   → mínimo 2 variantes · cada una con sus atributos libres
                       (color, talle, capacidad... lo que el vendedor quiera)
                       stock_base queda en 0 y el stock vive en cada variante
════════════════════════════════════════════════════════════════════════════ */

// Característica de una variante: { nombre: "color", valor: "Azul" }
const atributoSchema = new mongoose.Schema({
    nombre: { type: String, required: true, trim: true, lowercase: true, maxlength: 40 },
    valor:  { type: String, required: true, trim: true, maxlength: 60 },
}, { _id: false });

// Opciones del producto (orden de los selectores en la tienda)
// Ej: [{ nombre: "color", valores: ["Azul","Negro"] }, { nombre: "capacidad", valores: ["128GB","256GB"] }]
const opcionSchema = new mongoose.Schema({
    nombre:  { type: String, required: true, trim: true, lowercase: true, maxlength: 40 },
    valores: [{ type: String, trim: true, maxlength: 60 }],
}, { _id: false });

const varianteSchema = new mongoose.Schema({
    sku_variante:     { type: String, required: true, trim: true },
    atributos:        { type: [atributoSchema], default: [] },
    stock:            { type: Number, default: 0, min: 0 },
    precio_adicional: { type: Number, default: 0, min: 0 },   // € por encima del precio base
    foto_variante:    { type: String, default: null },
    activo:           { type: Boolean, default: true },
});

const faqSchema = new mongoose.Schema({
    pregunta:  { type: String, required: true, trim: true, maxlength: 200 },
    respuesta: { type: String, required: true, trim: true, maxlength: 1500 },
});

const productSchema = new mongoose.Schema({
    nombre: {
        type: String,
        required: [true, 'El nombre es obligatorio'],
        trim: true,
        set: (v) => v?.toLowerCase()
    },
    marca: {
        type: String,
        required: [true, 'La marca es obligatoria'],
        trim: true,
        set: (v) => v?.toLowerCase()
    },
    stock_base: {
        type: Number,
        default: 0,
        min: 0
    },
    sku_padre: {
        type: String,
        required: [true, 'El SKU principal es necesario'],
        unique: true,
        index: true,
        trim: true
    },
    descripcion: { type: String, default: "" },
    precio_base: {
        type: Number,
        required: true,
        min: 0
    },
    imagenes_generales: [{ type: String }],

    categorias: [{ type: String, lowercase: true, trim: true }],

    opciones:  { type: [opcionSchema], default: [] },
    variantes: { type: [varianteSchema], default: [] },

    faqs: {
        type: [faqSchema],
        default: [],
        validate: [(v) => v.length <= 20, 'Máximo 20 preguntas frecuentes por producto']
    },

    medidas_empaque: {
        peso:  { type: Number, default: 0 },
        ancho: { type: Number, default: 0 },
        alto:  { type: Number, default: 0 },
        largo: { type: Number, default: 0 }
    },

    estado: {
        type: String,
        enum: ['activo', 'pausado', 'borrado'],
        default: 'activo'
    },

    en_promocion:     { type: Boolean, default: false },
    porcentaje_promo: { type: Number, default: 0, min: 0, max: 100 },

}, {
    timestamps: true,
    toJSON:   { virtuals: true },
    toObject: { virtuals: true },
});

// SKU de variante único en toda la colección (los productos sin variantes no cuentan)
productSchema.index({ "variantes.sku_variante": 1 }, { unique: true, sparse: true });
productSchema.index({ nombre: 'text', sku_padre: 'text' });
productSchema.index({ "variantes.atributos.nombre": 1, "variantes.atributos.valor": 1 });

// Stock total para mostrar en el admin / tienda
productSchema.virtual("stock_total").get(function () {
    if (this.variantes?.length) {
        return this.variantes.filter(v => v.activo !== false).reduce((acc, v) => acc + (v.stock || 0), 0);
    }
    return this.stock_base || 0;
});

productSchema.virtual("tipo").get(function () {
    return this.variantes?.length ? "variantes" : "simple";
});

// ── Reglas de integridad (se ejecutan en create() y save()) ─────────────────
productSchema.pre("validate", function () {
    const vars = this.variantes || [];

    if (vars.length === 1) {
        this.invalidate("variantes", "Un producto con variantes necesita al menos 2. Si es único, no cargues variantes.");
    }

    if (vars.length === 0) {
        this.opciones = [];
        return;
    }

    // con variantes el stock vive en cada variante
    this.stock_base = 0;

    const skus   = new Set();
    const combos = new Set();
    let firmaRef = null;

    vars.forEach((v, i) => {
        const sku = (v.sku_variante || "").toUpperCase();
        if (skus.has(sku)) this.invalidate(`variantes.${i}.sku_variante`, `SKU de variante repetido: ${v.sku_variante}`);
        skus.add(sku);

        if (!v.atributos?.length) {
            this.invalidate(`variantes.${i}.atributos`, `La variante ${i + 1} necesita al menos una característica`);
            return;
        }

        const firma = v.atributos.map(a => a.nombre).sort().join("|");
        if (firmaRef === null) firmaRef = firma;
        else if (firma !== firmaRef) {
            this.invalidate(`variantes.${i}.atributos`, "Todas las variantes deben tener las mismas características");
        }

        const combo = [...v.atributos]
            .sort((a, b) => a.nombre.localeCompare(b.nombre))
            .map(a => `${a.nombre}=${String(a.valor).toLowerCase()}`)
            .join("|");
        if (combos.has(combo)) this.invalidate(`variantes.${i}.atributos`, "Hay dos variantes con la misma combinación");
        combos.add(combo);
    });
});

module.exports = mongoose.model('Product', productSchema);