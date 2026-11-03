const express         = require("express");
const mongoose        = require("mongoose");
const ProductMetric   = require("../models/ProductMetric.js");
const Product         = require("../models/productModel");
const adminMiddleware = require("../middleware/adminMiddleware.js");
const { getClientIp } = adminMiddleware;

const metricRouter = express.Router();

/* ════════════════════════════════════════════════════════════════════════════
   metricRouter — clics en productos

   POST /api/click                        público (lo llama la tienda)
   GET  /api/top-clicked?limit=5&page=1   admin
   GET  /api/product-detail/:productId    admin

   Seguridad
   · El cliente solo manda el productId. Nombre e imagen salen de la BD:
     antes cualquiera podía renombrar un producto en el panel o poner una
     imagen ajena mandando productName / productImage en el body.
   · Solo cuentan productos que existen y están activos: antes un bot podía
     crear millones de documentos con productIds inventados (upsert).
   · Límite por IP y un clic contado por IP + producto cada 30 min, para que
     las métricas no se puedan inflar con un script.
   · Hora y día en la zona del negocio (Europe/Madrid, con horario de verano).
════════════════════════════════════════════════════════════════════════════ */

const BUSINESS_TZ = process.env.BUSINESS_TZ || "Europe/Madrid";
const DAY_NAMES   = ["Domingo","Lunes","Martes","Miércoles","Jueves","Viernes","Sábado"];
const DAY_LABELS  = ["Dom","Lun","Mar","Mié","Jue","Vie","Sáb"];
const WEEKDAY_IDX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

const HISTORY_MAX     = 500;
const DEDUPE_MS       = 30 * 60 * 1000;   // un clic contado por IP + producto cada 30 min
const IP_MAX_CLICKS   = 120;              // clics aceptados por IP…
const IP_WINDOW_MS    = 10 * 60 * 1000;   // …cada 10 minutos
const MAX_PAGE        = 500;

const isId = (v) => typeof v === "string" && /^[a-f\d]{24}$/i.test(v) && mongoose.Types.ObjectId.isValid(v);

// hora (0-23) y día (0 = domingo) en la zona del negocio
const tzFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: BUSINESS_TZ, hour: "2-digit", hourCycle: "h23", weekday: "short",
});
function localParts(date) {
  const o = {};
  for (const p of tzFormat.formatToParts(date)) o[p.type] = p.value;
  return { hour: Number(o.hour) % 24, dayOfWeek: WEEKDAY_IDX[o.weekday] ?? date.getUTCDay() };
}

// ── límites en memoria (mismo patrón que el resto de routers) ──
function crearLimite(max, ventanaMs) {
  const mapa = new Map();
  return {
    bloqueado(k) {
      const r = mapa.get(k);
      if (!r) return false;
      if (Date.now() - r.first > ventanaMs) { mapa.delete(k); return false; }
      return r.count >= max;
    },
    sumar(k) {
      const now = Date.now();
      const r = mapa.get(k);
      if (!r || now - r.first > ventanaMs) mapa.set(k, { count: 1, first: now });
      else r.count += 1;
      if (mapa.size > 20000) for (const [kk, v] of mapa) if (now - v.first > ventanaMs) mapa.delete(kk);
    },
  };
}
const limiteIp    = crearLimite(IP_MAX_CLICKS, IP_WINDOW_MS);
const yaContado   = crearLimite(1, DEDUPE_MS);   // clave ip:productId

// POST /api/click — Body: { productId }
metricRouter.post("/api/click", async (req, res) => {
  const productId = req.body?.productId;
  if (!isId(productId)) return res.status(400).json({ error: "Producto inválido" });

  const ip = getClientIp(req);
  if (limiteIp.bloqueado(ip)) return res.status(429).json({ error: "Demasiadas solicitudes" });
  limiteIp.sumar(ip);

  // mismo visitante y mismo producto dentro de la ventana: se responde igual, pero no suma
  const clave = `${ip}:${productId}`;
  if (yaContado.bloqueado(clave)) return res.json({ ok: true });

  try {
    const product = await Product.findOne({ _id: productId, estado: "activo" })
      .select("nombre imagenes_generales")
      .lean();
    if (!product) return res.status(404).json({ error: "Producto no encontrado" });

    yaContado.sumar(clave);

    const now = new Date();
    const { hour, dayOfWeek } = localParts(now);

    await ProductMetric.updateOne(
      { productId: String(product._id) },
      {
        $inc:  { clicks: 1 },
        $set:  {
          productName:   String(product.nombre || "").slice(0, 150),
          productImage:  String(product.imagenes_generales?.[0] || "").slice(0, 500),
          lastClickedAt: now,
        },
        $push: {
          clickHistory: {
            $each:  [{ timestamp: now, hour, dayOfWeek, dayName: DAY_NAMES[dayOfWeek] }],
            $slice: -HISTORY_MAX,
          },
        },
      },
      { upsert: true, setDefaultsOnInsert: true }
    );

    // no se devuelve el contador: es un dato interno del negocio
    res.json({ ok: true });
  } catch (err) {
    console.error("metrics/click error:", err);
    res.status(500).json({ error: "Error al registrar métrica" });
  }
});

// GET /api/top-clicked?limit=5&page=1
metricRouter.get("/api/top-clicked", adminMiddleware, async (req, res) => {
  res.set("Cache-Control", "no-store");
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 5, 1), 20);
    const page  = Math.min(Math.max(parseInt(req.query.page, 10)  || 1, 1), MAX_PAGE);
    const skip  = (page - 1) * limit;

    const [products, total] = await Promise.all([
      ProductMetric.find()
        .sort({ clicks: -1, _id: 1 })
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

// GET /api/product-detail/:productId
metricRouter.get("/api/product-detail/:productId", adminMiddleware, async (req, res) => {
  res.set("Cache-Control", "no-store");
  const { productId } = req.params;
  if (!isId(productId)) return res.status(400).json({ error: "Producto inválido" });

  try {
    const metric = await ProductMetric.findOne({ productId }).lean();
    if (!metric) return res.status(404).json({ error: "Producto no encontrado" });

    const history = Array.isArray(metric.clickHistory) ? metric.clickHistory : [];

    // un solo recorrido en vez de 24 + 7 + 168 filtros
    const grid = Array.from({ length: 7 }, () => new Array(24).fill(0));
    for (const e of history) {
      const d = Number(e?.dayOfWeek), h = Number(e?.hour);
      if (Number.isInteger(d) && d >= 0 && d < 7 && Number.isInteger(h) && h >= 0 && h < 24) grid[d][h] += 1;
    }

    const byHour = Array.from({ length: 24 }, (_, h) => ({
      hour:   `${String(h).padStart(2, "0")}hs`,
      clicks: grid.reduce((a, row) => a + row[h], 0),
    }));

    const byDay = DAY_LABELS.map((name, d) => ({
      day:    name,
      clicks: grid[d].reduce((a, n) => a + n, 0),
    }));

    const heatmap = grid.flatMap((row, d) =>
      row.map((clicks, h) => ({ day: DAY_LABELS[d], hour: h, clicks }))
    );

    res.json({
      productId:   metric.productId,
      productName: metric.productName,
      totalClicks: metric.clicks,
      timezone:    BUSINESS_TZ,
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