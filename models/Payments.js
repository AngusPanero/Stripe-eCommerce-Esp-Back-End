const mongoose = require("mongoose");

/* ════════════════════════════════════════════════════════════════════════════
   Payments.js — Pedido + estado del cobro en Stripe
   El pedido se crea ANTES de cobrar (status "pending") con el cálculo
   hecho 100% en el backend. El webhook lo pasa a approved / in_process /
   rejected / refunded... nunca queda un cobro sin rastro.
   Todos los importes *_Cents son enteros en céntimos de euro.
════════════════════════════════════════════════════════════════════════════ */

const itemSchema = new mongoose.Schema({
    productId:      { type: String, required: true },
    varianteId:     { type: String, default: null },
    nombre:         { type: String },
    skuPadre:       { type: String },
    skuVariante:    { type: String, default: null },
    varianteLabel:  { type: String, default: null },
    imagen:         { type: String, default: null },
    categorias:     [{ type: String }],
    cantidad:       { type: Number, required: true },

    listUnitCents:  { type: Number, required: true },   // precio sin promo
    unitCents:      { type: Number, required: true },   // precio con promo
    lineCents:      { type: Number, required: true },   // unitCents × cantidad
    discountCents:  { type: Number, default: 0 },       // descuento de cupón en la línea
    couponApplies:  { type: Boolean, default: false },

    // compatibilidad con el panel actual (euros)
    precioUnitario: { type: Number },
    totalItem:      { type: Number },
    descuentoCupon: { type: Number, default: 0 },

    stockDiscounted: { type: Boolean, default: false },
    restockedQty:    { type: Number, default: 0 },
}, { _id: false });

const refundSchema = new mongoose.Schema({
    refundId:      { type: String, required: true },
    amountCents:   { type: Number, required: true },
    status:        { type: String },             // pending | succeeded | failed | canceled | requires_action
    reason:        { type: String, default: null },
    note:          { type: String, default: null },
    failureReason: { type: String, default: null },
    restocked:     { type: Boolean, default: false },
    couponReleased:{ type: Boolean, default: false },
    createdBy:     { type: String, default: "admin" },
    createdAt:     { type: Date, default: Date.now },
}, { _id: false });

const historySchema = new mongoose.Schema({
    at:     { type: Date, default: Date.now },
    status: { type: String },
    note:   { type: String },
}, { _id: false });

const PaymentsSchema = new mongoose.Schema({
    orderId:   { type: String, required: true, unique: true },
    client_id: { type: String, required: true },
    email:     { type: String, required: true, lowercase: true, index: true },
    nombre:    { type: String, default: "" },
    telefono:  { type: String, default: "N/A" },
    plan:      { type: String, enum: ["Compra General", "Productos Varios"], default: "Compra General" },

    status: {
        type: String,
        enum: [
            'pending',             // pedido creado, esperando pago
            'in_process',          // Stripe procesando (SEPA, Klarna, revisión)
            'approved',            // cobrado y descontado stock
            'rejected',            // intento fallido (puede reintentar con otra tarjeta)
            'canceled',            // PaymentIntent cancelado
            'refunded',            // reembolso total
            'partially_refunded',  // reembolso parcial
            'disputed',            // contracargo abierto
            'review',              // importe cobrado distinto al pedido → revisar a mano
        ],
        default: 'pending',
        index: true
    },

    // ── Stripe ──
    stripePaymentIntentId: { type: String, index: { unique: true, sparse: true } },
    stripeChargeId:        { type: String, default: null },
    mp_payment_id:         { type: String },          // legado (pedidos viejos)
    currency:              { type: String, default: "eur" },
    failureMessage:        { type: String, default: null },
    paidAt:                { type: Date, default: null },

    // ── Importes (céntimos) ──
    subtotalCents:       { type: Number, required: true },
    discountCents:       { type: Number, default: 0 },
    shippingCents:       { type: Number, default: 0 },
    totalCents:          { type: Number, required: true },
    amountReceivedCents: { type: Number, default: 0 },
    refundedCents:       { type: Number, default: 0 },
    amount:              { type: Number, required: true },   // total en euros (compatibilidad panel)

    // ── Cupón (snapshot al crear el pedido; se quema SOLO tras el cobro) ──
    coupon: {
        couponId: { type: mongoose.Schema.Types.ObjectId, ref: "Coupon", default: null },
        code:     { type: String, default: null },
        discount: { type: Number, default: null },
        type:     { type: String, default: null },
        scope:    { type: String, default: null },
    },
    couponBurned:   { type: Boolean, default: false },
    couponConflict: { type: String, default: null },   // motivo si al cobrar el cupón ya no era válido
    couponReleased: { type: Boolean, default: false },

    // ── Stock ──
    stockApplied:   { type: Boolean, default: false },
    stockConflicts: [{
        productId: String, varianteId: String, nombre: String, solicitado: Number, _id: false
    }],

    // ── Revisión manual ──
    needsReview: { type: Boolean, default: false, index: true },
    reviewNotes: [{ type: String }],

    refunds: { type: [refundSchema], default: [] },
    dispute: {
        disputeId:   { type: String, default: null },
        status:      { type: String, default: null },
        reason:      { type: String, default: null },
        amountCents: { type: Number, default: null },
        prevStatus:  { type: String, default: null },
    },
    history: { type: [historySchema], default: [] },

    date:    { type: Date, default: Date.now },
    checked: { type: Boolean, default: false },

    items: { type: [itemSchema], default: [] },

    invoiceSent:     { type: Boolean, default: false },
    invoiceSentAt:   { type: Date },
    invoiceFilename: { type: String },

    shipping: {
        mode:        { type: String, enum: ["delivery", "pickup"], default: "delivery" },
        cost:        { type: Number, default: 0 },    // euros (compatibilidad)
        ownerCovers: { type: Boolean, default: false },
        address: {
            calle:        String,
            numero:       String,
            piso:         String,
            ciudad:       String,
            provincia:    String,
            codigoPostal: String,
            pais:         String,
            paisCodigo:   String,   // ISO 3166-1 alpha-2 (ES, PT, FR...)
        }
    },

    // ── Datos de la factura que recibe el cliente ──
    billing: {
        type:          { type: String, enum: ["fisica", "empresa"], default: "fisica" },
        nombre:        String,      // particular, o persona de contacto en empresa
        apellidos:     String,
        razonSocial:   String,
        tipoDocumento: { type: String, enum: ["nif", "nie", "cif", "vat_ue", "pasaporte", null], default: null },
        documento:     String,      // normalizado: mayúsculas, sin espacios ni guiones
        direccion: {
            calle:        String,
            numero:       String,
            piso:         String,
            ciudad:       String,
            provincia:    String,
            codigoPostal: String,
            pais:         String,
            paisCodigo:   String,
        },
        // compatibilidad con el panel / pedidos anteriores
        cif:             String,
        direccionFiscal: String,
        ciudadFiscal:    String,
        cpFiscal:        String,
    },

}, { timestamps: true });

PaymentsSchema.index({ email: 1, createdAt: -1 });

const PaymentsMongo = mongoose.model("payments", PaymentsSchema);
module.exports = PaymentsMongo;