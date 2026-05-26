const mongoose = require("mongoose");

const clickEventSchema = new mongoose.Schema(
  {
    timestamp: { type: Date, default: Date.now },
    hour:      { type: Number }, // 0-23 hora Argentina
    dayOfWeek: { type: Number }, // 0=Dom ... 6=Sab
    dayName:   { type: String }, // "Lunes", "Martes"...
  },
  { _id: false }
);

const productMetricSchema = new mongoose.Schema(
  {
    productId:    { type: String, required: true, index: true, unique: true },
    productName:  { type: String, default: "" },
    productImage: { type: String, default: "" },
    clicks:       { type: Number, default: 0   },
    lastClickedAt:{ type: Date,   default: Date.now },

    // historial — últimos 500 eventos por producto
    clickHistory: {
      type:    [clickEventSchema],
      default: [],
    },
  },
  { timestamps: true }
);

productMetricSchema.index({ clicks: -1 });

module.exports = mongoose.model("ProductMetric", productMetricSchema);