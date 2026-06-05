const mongoose = require('mongoose');

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
    required: true, 
    min: 0 
  },
  sku_padre: { 
    type: String, 
    required: [true, 'El SKU principal es necesario'], 
    unique: true, 
    index: true 
  },
  descripcion: { type: String },
  precio_base: { 
    type: Number, 
    required: true, 
    min: 0 
  },
  imagenes_generales: [{ type: String }], 
  
  categorias: [{ type: String, toLowerCase: true }],

  variantes: [{
    sku_variante: { type: String, required: true, sparse: true, unique: true },
    talle:        { type: String, default: null },
    color:        { type: String, default: null },
    medida:       { type: String, default: null },
    gb:           { type: String, default: null },  
    largo_cable:  { type: String, default: null },
    stock:        { type: Number, default: 0 },
    precio_adicional: { type: Number, default: 0 },
    foto_variante: { type: String, default: null }
  }],

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

  en_promocion: {
    type: Boolean,
    default: false
  },
  
  porcentaje_promo: {
    type: Number,
    default: 0,
    min: 0,
    max: 100
  },

}, { timestamps: true });

productSchema.index({ nombre: 'text', sku_padre: 'text' });

module.exports = mongoose.model('Product', productSchema);