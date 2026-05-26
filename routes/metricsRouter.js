const express         = require("express");
const ProductMetric   = require("../models/ProductMetric.js");
const adminMiddleware = require("../middleware/adminMiddleware.js");

const metricRouter = express.Router();

const toArgentina = (date = new Date()) => {
  const AR_OFFSET_MS = -3 * 60 * 60 * 1000;
  return new Date(date.getTime() + AR_OFFSET_MS);
};

const DAY_NAMES = ["Domingo","Lunes","Martes","Miércoles","Jueves","Viernes","Sábado"];

// POST /api/metrics/click
metricRouter.post("/api/click", async (req, res) => {
  try {
    const { productId, productName, productImage } = req.body;

    if (!productId || !productName)
      return res.status(400).json({ error: "productId y productName son requeridos" });

    const now   = new Date();
    const arNow = toArgentina(now);

    const clickEvent = {
      timestamp: now,
      hour:      arNow.getUTCHours(),
      dayOfWeek: arNow.getUTCDay(),
      dayName:   DAY_NAMES[arNow.getUTCDay()],
    };

    const metric = await ProductMetric.findOneAndUpdate(
      { productId: String(productId) },
      {
        $inc:  { clicks: 1 },
        $set:  { productName, productImage: productImage || "", lastClickedAt: now },
        $push: {
          clickHistory: {
            $each:  [clickEvent],
            $slice: -500,
          },
        },
      },
      { upsert: true, returnDocument: "after", setDefaultsOnInsert: true }
    );

    res.json({ ok: true, clicks: metric.clicks });
  } catch (err) {
    console.error("metrics/click error:", err);
    res.status(500).json({ error: "Error al registrar métrica", detail: err.message });
  }
});

// GET /api/metrics/top-clicked?limit=5&page=1
metricRouter.get("/api/top-clicked", adminMiddleware, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 5, 20);
    const page  = Math.max(parseInt(req.query.page)  || 1, 1);
    const skip  = (page - 1) * limit;

    const [products, total] = await Promise.all([
      ProductMetric.find()
        .sort({ clicks: -1 })
        .skip(skip)
        .limit(limit)
        .select("-clickHistory")
        .lean(),
      ProductMetric.countDocuments(),
    ]);

    res.json({ products, total, page, totalPages: Math.ceil(total / limit) });
  } catch (err) {
    console.error("metrics/top-clicked error:", err);
    res.status(500).json({ error: "Error al obtener métricas" });
  }
});

// GET /api/metrics/product-detail/:productId
metricRouter.get("/api/product-detail/:productId", adminMiddleware, async (req, res) => {
  try {
    const metric = await ProductMetric.findOne({
      productId: req.params.productId,
    }).lean();

    if (!metric) return res.status(404).json({ error: "Producto no encontrado" });

    const history = metric.clickHistory || [];

    const DAY_LABELS = ["Dom","Lun","Mar","Mié","Jue","Vie","Sáb"];

    const byHour = Array.from({ length: 24 }, (_, h) => ({
      hour:   `${String(h).padStart(2, "0")}hs`,
      clicks: history.filter(e => e.hour === h).length,
    }));

    const byDay = DAY_LABELS.map((name, d) => ({
      day:    name,
      clicks: history.filter(e => e.dayOfWeek === d).length,
    }));

    const heatmap = Array.from({ length: 7 }, (_, d) =>
      Array.from({ length: 24 }, (_, h) => ({
        day:    DAY_LABELS[d],
        hour:   h,
        clicks: history.filter(e => e.dayOfWeek === d && e.hour === h).length,
      }))
    ).flat();

    res.json({
      productId:   metric.productId,
      productName: metric.productName,
      totalClicks: metric.clicks,
      byHour,
      byDay,
      heatmap,
    });
  } catch (err) {
    console.error("metrics/product-detail error:", err);
    res.status(500).json({ error: "Error al obtener detalle" });
  }
});

module.exports = metricRouter;