const mongoose = require('mongoose');

const CartSchema = new mongoose.Schema({
    userEmail: {
        type:     String,
        required: true,
        unique:   true,
        lowercase:true
    },
    items: [
        {
            id:                 { type: String, required: true },   // id de variante, o el del producto si es único
            productId:          { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
            varianteId:         { type: String, default: null },
            nombre:             String,
            precio:             Number,    // solo visual: el cobro se recalcula siempre en el backend
            imagen:             String,
            cantidad:           { type: Number, min: 1 },
            stockMax:           Number,
            categorias:         [String],
            skuPadre:           { type: String, default: "" },
            varianteLabel:      { type: String, default: "" },
            talle:              { type: String, default: "" },  // legado
            color:              { type: String, default: "" },  // legado
        }
    ],

    appliedCoupon: {
        code:        { type: String,  default: null },
        discount:    { type: Number,  default: null },
        type:        { type: String,  default: null },
        appliedAt:   { type: Date,    default: null },
        scope:             { type: String,  default: "all" },
        allowedProducts:   { type: [String], default: [] },
        allowedCategories: { type: [String], default: [] },
    },
    checked: { type: Boolean, default: false },

}, { timestamps: true });

CartSchema.post('init', function(doc) {
    if (doc.appliedCoupon && doc.appliedCoupon.appliedAt) {
        const limitTime    = 72 * 60 * 60 * 1000;
        const transcurrido = Date.now() - new Date(doc.appliedCoupon.appliedAt).getTime();

        if (transcurrido > limitTime) {
            doc.appliedCoupon = undefined;
            mongoose.model("Cart")
                .updateOne({ _id: doc._id }, { $unset: { appliedCoupon: "" } })
                .catch(err => console.error("Error removiendo cupón expirado del carrito:", err));
        }
    }
});

const Cart = mongoose.model("Cart", CartSchema);
module.exports = Cart;