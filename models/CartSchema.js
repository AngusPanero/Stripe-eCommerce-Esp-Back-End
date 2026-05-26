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
            id:                 { type: String, required: true },
            productId:          { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
            nombre:             String,
            precio:             Number,
            imagen:             String,
            cantidad:           { type: Number, min: 1 },
            stockMax:           Number,
            cuotas_sin_interes: { type: Number, default: 0 },
            categorias:         [String],
            skuPadre:           { type: String, default: "" },
            talle:              { type: String, default: "" },  // ← agregado
            color:              { type: String, default: "" },  // ← agregado
        }
    ],

    // ← definido explícitamente para que no se pierda en .lean() ni populate
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
        const limitTime   = 72 * 60 * 60 * 1000;
        const transcurrido = Date.now() - new Date(doc.appliedCoupon.appliedAt).getTime();

        if (transcurrido > limitTime) {
            console.log(">>> ¡EXPIRADO! Borrando cupón de la DB...");
            doc.appliedCoupon = undefined;
            mongoose.model("Cart")
                .updateOne({ _id: doc._id }, { $unset: { appliedCoupon: "" } })
                .then(()  => console.log(">>> Cupón expirado removido"))
                .catch(err => console.error("Error removiendo cupón:", err));
        }
    }
});

const Cart = mongoose.model("Cart", CartSchema);
module.exports = Cart;