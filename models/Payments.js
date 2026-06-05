const mongoose = require("mongoose");

const PaymentsSchema = new mongoose.Schema({
    orderId:       { type: String, required: true },
    client_id:     { type: String, required: true },
    email:         { type: String, required: true },
    plan:          { type: String, enum: ["Compra General", "Productos Varios"] },
    amount:        { type: Number, required: true },
    mp_payment_id: { type: String },
    telefono:      { type: String, default: "N/A" },
    status: {
        type:    String,
        enum:    ['pending', 'approved', 'rejected', 'in_process'],
        default: 'pending'
    },
    date:    { type: Date, default: Date.now },
    checked: { type: Boolean, default: false },

    items: [{
        nombre:         { type: String },
        cantidad:       { type: Number },
        precioUnitario: { type: Number },
        totalItem:      { type: Number },
        descuentoCupon: { type: Number, default: 0 },
        aplicaInteres:  { type: Boolean, default: false },
        tasa:           { type: String },
        skuPadre:       { type: String },
        productId:      { type: String },
        varianteId:     { type: String },   
        varianteLabel:  { type: String },   
    }],
    invoiceSent:     { type: Boolean, default: false },
    invoiceSentAt:   { type: Date },
    invoiceFilename: { type: String },   
    shipping: {
    mode:        { type: String, enum: ["delivery", "pickup"], default: "delivery" },
    cost:        { type: Number, default: 0 },
    ownerCovers: { type: Boolean, default: false },
    address: {
            calle:        String,
            numero:       String,
            piso:         String,
            ciudad:       String,
            provincia:    String,
            codigoPostal: String,
            pais:         String,
        }
    },
    billing: {
        type:            { type: String, enum: ["fisica", "empresa"], default: "fisica" },
        razonSocial:     String,
        cif:             String,
        direccionFiscal: String,
        ciudadFiscal:    String,
        cpFiscal:        String,
    },

}, { timestamps: true });

const PaymentsMongo = mongoose.model("payments", PaymentsSchema);
module.exports = PaymentsMongo;