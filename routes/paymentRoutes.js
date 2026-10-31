// Express y Router
const express = require("express")
const mongoose = require("mongoose")
const paymentsRouter = express.Router()
// Mongo
const PaymentsMongo = require("../models/Payments")

const adminMiddleware = require("../middleware/adminMiddleware")
const verifyToken = require("../middleware/authMiddleware")

const esProduccion = (process.env.NODE_ENV === 'production');

const isId = (v) => typeof v === "string" && mongoose.Types.ObjectId.isValid(v) && /^[a-f\d]{24}$/i.test(v)

// Estados de un pedido cobrado (los mismos que PAID_STATUSES de stripeRouter)
const PAID_STATUSES = ["approved", "partially_refunded", "refunded", "disputed"]

// Lo que ve el cliente de SUS pedidos: sin notas internas, historial, hashes ni ids de Stripe
const CLIENT_FIELDS = [
    "orderId", "status", "amount", "createdAt", "paidAt", "invoiceSent",
    "items.nombre", "items.varianteLabel", "items.cantidad", "items.imagen",
    "items.precioUnitario", "items.totalItem", "items.descuentoCupon",
    "subtotalCents", "discountCents", "shippingCents", "totalCents", "refundedCents",
    "coupon.code", "shipping", "billing",
].join(" ")

// Lo que nunca sale ni en el panel admin
const ADMIN_HIDDEN = "-statusTokenHash"

const MAX_ADMIN_TICKETS = 2000

// ═══════════════════════════════════════════════════════════════
//  POST /tickets — pedidos del usuario logueado
//  El email sale del token, NUNCA del body: antes cualquiera con sesión podía leer
//  los pedidos de otro (o de todos, mandando {"email":{"$ne":null}}).
//  El body se ignora; se mantiene POST para no romper el front.
//  Los pedidos hechos como invitado no aparecen: cualquiera puede escribir
//  un email ajeno al comprar sin cuenta.
// ═══════════════════════════════════════════════════════════════
paymentsRouter.post("/tickets", verifyToken, async (req, res) => {
    const email = typeof req.user?.email === "string" ? req.user.email.toLowerCase() : null
    if (!email) {
        return res.status(401).json({ message: "No autenticado 🔴" })
    }

    res.set("Cache-Control", "no-store")

    try {
        const payments = await PaymentsMongo.find({ email, guest: { $ne: true }, status: { $in: PAID_STATUSES } })
            .sort({ createdAt: -1 })
            .limit(100)
            .select(CLIENT_FIELDS)
            .lean()

        return res.status(200).json(payments)
    } catch (error) {
        console.error("Error getting tickets 🔴", esProduccion ? error.message : error)
        res.status(500).json({ message: "Error gettings tickets! 🔴" })
    }
})

// ═══════════════════════════════════════════════════════════════
//  GET /all-tickets — todas las ventas (solo admin)
//  Con tope de registros y sin campos internos sensibles.
// ═══════════════════════════════════════════════════════════════
paymentsRouter.get("/all-tickets", adminMiddleware, async (req, res) => {
    res.set("Cache-Control", "no-store")

    try {
        const allPayments = await PaymentsMongo.find()
            .sort({ createdAt: -1 })
            .limit(MAX_ADMIN_TICKETS)
            .select(ADMIN_HIDDEN)
            .lean();

        // Sin ventas no es un error: lista vacía
        return res.status(200).json(allPayments);
    } catch (error) {
        console.error("Error fetching all tickets 🔴", esProduccion ? error.message : error);
        res.status(500).json({ message: "Internal Server Error 🔴" });
    }
});

// ═══════════════════════════════════════════════════════════════
//  PATCH /api/payments/:id/checked — marcar venta como revisada (solo admin)
//  Antes: sin validar el id ni el valor y sin try/catch. Un id inválido tiraba
//  un error no capturado que podía voltear el proceso de Node.
// ═══════════════════════════════════════════════════════════════
paymentsRouter.patch("/api/payments/:id/checked", adminMiddleware, async (req, res) => {
    const { id } = req.params
    const checked = req.body?.checked

    if (!isId(id)) {
        return res.status(400).json({ message: "Venta inválida 🔴" })
    }
    // Estricto: solo true o false (nada de "true", 1 ni objetos)
    if (typeof checked !== "boolean") {
        return res.status(400).json({ message: "checked debe ser true o false 🔴" })
    }

    try {
        const r = await PaymentsMongo.updateOne({ _id: id }, { $set: { checked } })
        if (r.matchedCount === 0) {
            return res.status(404).json({ message: "Venta no encontrada 🔴" })
        }
        return res.json({ ok: true, checked })
    } catch (error) {
        console.error("Error marking sale as checked 🔴", esProduccion ? error.message : error)
        return res.status(500).json({ message: "Error al actualizar la venta 🔴" })
    }
});

/* ═══════════════════════════════════════════════════════════════════════════
   MÉTRICAS (solo admin) — GET /api/admin/metrics
   Todo el dinero se calcula AQUÍ, en céntimos. El front solo dibuja.

   Query:
     range = day | week | month | year | all | custom   (por defecto month)
     from, to = YYYY-MM-DD  (solo con range=custom, ambos incluidos)

   Configuración en el .env (se lee al arrancar el servidor):
     STRIPE_FEE_PERCENT   = 2      % de comisión por cobro (por defecto 2)
     STRIPE_FEE_FIXED_EUR = 0      fijo por cobro en € (Stripe EEE: 0.25)
     IVA_RATE             = 21     IVA incluido en el precio (Suiza: 8.1)
     BUSINESS_TZ          = Europe/Madrid   zona para días / meses

   Reglas de cálculo
   · Cuenta como venta todo pedido cobrado: approved, partially_refunded,
     refunded, disputed y review (cobrado pero con importe a revisar).
   · Bruto     = lo que Stripe cobró (amountReceivedCents; si no, totalCents).
   · Comisión  = bruto × % + fijo, por cobro. Stripe NO la devuelve al
     reembolsar, así que se descuenta aunque el pedido se reembolse.
   · Reembolsos y disputas perdidas restan del neto. Se imputan a la fecha
     de la venta (no a la del reembolso).
   · IVA       = parte incluida en lo cobrado y no reembolsado:
                 neto_ventas − neto_ventas / (1 + IVA%)
   · La fecha de una venta es paidAt; si no existe, createdAt.
═══════════════════════════════════════════════════════════════════════════ */
const numEnv = (v, def, min, max) => {
    const n = Number(v)
    return v !== undefined && v !== "" && Number.isFinite(n) && n >= min && n <= max ? n : def
}

const FEE_PERCENT     = numEnv(process.env.STRIPE_FEE_PERCENT, 2, 0, 20)
const FEE_FIXED_CENTS = Math.round(numEnv(process.env.STRIPE_FEE_FIXED_EUR, 0, 0, 5) * 100)
const IVA_RATE        = numEnv(process.env.IVA_RATE, 21, 0, 30)
const BUSINESS_TZ     = process.env.BUSINESS_TZ || "Europe/Madrid"

console.log(`[METRICS] Comisión Stripe: ${FEE_PERCENT}% + ${(FEE_FIXED_CENTS / 100).toFixed(2)} € · IVA ${IVA_RATE}% · ${BUSINESS_TZ}`)

const CHARGED_STATUSES = [...PAID_STATUSES, "review"]
const ALL_STATUSES     = [...CHARGED_STATUSES, "pending", "in_process", "rejected", "canceled"]
const METRIC_RANGES    = ["day", "week", "month", "year", "all", "custom"]
const MAX_CUSTOM_DAYS  = 731          // 2 años
const MAX_METRIC_DOCS  = 50000
const TOP_N            = 8

const METRIC_FIELDS = [
    "orderId", "email", "guest", "status", "createdAt", "paidAt", "needsReview",
    "amount", "totalCents", "amountReceivedCents", "refundedCents", "discountCents", "shippingCents",
    "items.productId", "items.nombre", "items.varianteLabel", "items.cantidad", "items.lineCents",
    "items.discountCents", "items.totalItem", "items.categorias",
    "coupon.code", "shipping.mode", "shipping.address.pais", "billing.direccion.pais",
    "dispute.status", "dispute.amountCents",
].join(" ")

const feeFor = (grossCents) => grossCents > 0 ? Math.round(grossCents * FEE_PERCENT / 100) + FEE_FIXED_CENTS : 0
const ivaFor = (netSalesCents) => netSalesCents > 0 ? Math.round(netSalesCents - netSalesCents / (1 + IVA_RATE / 100)) : 0
const centsOf = (cents, eur) => (Number.isFinite(cents) ? cents : Math.round(Number(eur || 0) * 100))

// ── fechas en la zona del negocio ──
const tzFormat = new Intl.DateTimeFormat("en-CA", {
    timeZone: BUSINESS_TZ, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
})
function tzParts(date) {
    const o = {}
    for (const p of tzFormat.formatToParts(date)) o[p.type] = p.value
    return { y: +o.year, m: +o.month, d: +o.day, h: +o.hour, mi: +o.minute, s: +o.second }
}
const tzOffsetMs = (date) => {
    const p = tzParts(date)
    return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(date.getTime() / 1000) * 1000
}
// medianoche (u hora h) de un día del calendario local → instante UTC
function zonedToUtc(y, m, d, h = 0) {
    const guess = Date.UTC(y, m - 1, d, h)
    const off1  = tzOffsetMs(new Date(guess))
    let t = guess - off1
    const off2 = tzOffsetMs(new Date(t))
    if (off2 !== off1) t = guess - off2
    return new Date(t)
}
// aritmética de calendario (sin horas): normaliza día / mes desbordados
const cal = (y, m, d) => {
    const x = new Date(Date.UTC(y, m - 1, d))
    return { y: x.getUTCFullYear(), m: x.getUTCMonth() + 1, d: x.getUTCDate() }
}
const pad = (n) => String(n).padStart(2, "0")
const dayKey   = (c) => `${c.y}-${pad(c.m)}-${pad(c.d)}`
const monthKey = (c) => `${c.y}-${pad(c.m)}`
const MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"]

function parseDay(s) {
    if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null
    const [y, m, d] = s.split("-").map(Number)
    const c = cal(y, m, d)
    return c.y === y && c.m === m && c.d === d && y >= 2000 && y <= 2100 ? c : null
}
const daysBetween = (a, b) => Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / 86400000)

// Devuelve { start, end, prevStart, prevEnd, bucket, startCal, endCal } o { error }
function resolveRange(range, from, to, firstSaleDate) {
    const now = tzParts(new Date())
    const today = { y: now.y, m: now.m, d: now.d }
    let startCal, endCal, prevStartCal, prevEndCal, bucket

    switch (range) {
        case "day":
            startCal = today; endCal = cal(today.y, today.m, today.d + 1)
            prevStartCal = cal(today.y, today.m, today.d - 1); prevEndCal = today
            bucket = "hour"
            break
        case "week":
            startCal = cal(today.y, today.m, today.d - 6); endCal = cal(today.y, today.m, today.d + 1)
            prevStartCal = cal(today.y, today.m, today.d - 13); prevEndCal = startCal
            bucket = "day"
            break
        case "month":
            startCal = { y: today.y, m: today.m, d: 1 }; endCal = cal(today.y, today.m + 1, 1)
            prevStartCal = cal(today.y, today.m - 1, 1); prevEndCal = startCal
            bucket = "day"
            break
        case "year":
            startCal = { y: today.y, m: 1, d: 1 }; endCal = { y: today.y + 1, m: 1, d: 1 }
            prevStartCal = { y: today.y - 1, m: 1, d: 1 }; prevEndCal = startCal
            bucket = "month"
            break
        case "custom": {
            const f = parseDay(from), t = parseDay(to)
            if (!f || !t) return { error: "Fechas inválidas: usa el formato AAAA-MM-DD" }
            const days = daysBetween(f, t) + 1
            if (days < 1) return { error: "La fecha inicial no puede ser posterior a la final" }
            if (days > MAX_CUSTOM_DAYS) return { error: `El rango máximo es de ${MAX_CUSTOM_DAYS} días` }
            startCal = f; endCal = cal(t.y, t.m, t.d + 1)
            prevStartCal = cal(f.y, f.m, f.d - days); prevEndCal = f
            bucket = days <= 62 ? "day" : "month"
            break
        }
        case "all": {
            const first = firstSaleDate ? tzParts(firstSaleDate) : now
            startCal = { y: first.y, m: first.m, d: 1 }; endCal = cal(today.y, today.m, today.d + 1)
            prevStartCal = null; prevEndCal = null
            bucket = "month"
            break
        }
        default:
            return { error: "Rango inválido" }
    }

    return {
        bucket, startCal, endCal,
        start: zonedToUtc(startCal.y, startCal.m, startCal.d),
        end:   zonedToUtc(endCal.y, endCal.m, endCal.d),
        prevStart: prevStartCal ? zonedToUtc(prevStartCal.y, prevStartCal.m, prevStartCal.d) : null,
        prevEnd:   prevEndCal   ? zonedToUtc(prevEndCal.y, prevEndCal.m, prevEndCal.d) : null,
    }
}

// Lista de cubetas del gráfico (todas, aunque no haya ventas)
function buildBuckets(r) {
    const out = []
    if (r.bucket === "hour") {
        for (let h = 0; h < 24; h++) out.push({ key: String(h), label: `${pad(h)}:00` })
    } else if (r.bucket === "day") {
        for (let c = r.startCal; dayKey(c) !== dayKey(r.endCal); c = cal(c.y, c.m, c.d + 1)) {
            out.push({ key: dayKey(c), label: `${pad(c.d)} ${MESES[c.m - 1]}` })
        }
    } else {
        const last = cal(r.endCal.y, r.endCal.m, r.endCal.d - 1)
        for (let c = { y: r.startCal.y, m: r.startCal.m, d: 1 };
             c.y < last.y || (c.y === last.y && c.m <= last.m);
             c = cal(c.y, c.m + 1, 1)) {
            out.push({ key: monthKey(c), label: `${MESES[c.m - 1]} ${String(c.y).slice(2)}` })
            if (out.length > 240) break
        }
    }
    return out
}
function bucketKeyOf(date, bucket) {
    const p = tzParts(date)
    if (bucket === "hour") return String(p.h)
    if (bucket === "day")  return dayKey(p)
    return monthKey(p)
}

// Números de un pedido cobrado (en céntimos)
function orderMoney(o) {
    const gross    = centsOf(o.amountReceivedCents ?? o.totalCents, o.amount)
    const refunded = Math.min(Math.max(o.refundedCents || 0, 0), gross)
    const lost     = o.status === "disputed" && o.dispute?.status === "lost" ? Math.min(o.dispute.amountCents || 0, gross - refunded) : 0
    const fee      = feeFor(gross)
    const netSales = gross - refunded - lost
    return { gross, refunded, lost, fee, netSales, iva: ivaFor(netSales), net: netSales - fee }
}

const emptyTotals = () => ({
    grossCents: 0, refundedCents: 0, disputeLostCents: 0, feeCents: 0, ivaCents: 0,
    netSalesCents: 0, netCents: 0, netAfterIvaCents: 0,
    paidOrders: 0, refundedOrders: 0, units: 0, discountCents: 0, shippingCents: 0,
})
function addTo(t, o, m) {
    t.grossCents       += m.gross
    t.refundedCents    += m.refunded
    t.disputeLostCents += m.lost
    t.feeCents         += m.fee
    t.ivaCents         += m.iva
    t.netSalesCents    += m.netSales
    t.netCents         += m.net
    t.netAfterIvaCents += m.net - m.iva
    t.paidOrders       += 1
    if (m.refunded > 0) t.refundedOrders += 1
    t.discountCents    += Math.max(o.discountCents || 0, 0)
    t.shippingCents    += Math.max(o.shippingCents || 0, 0)
    for (const it of o.items || []) t.units += Math.max(Number(it.cantidad) || 0, 0)
}
const topList = (map, sortKey = "grossCents") =>
    [...map.values()].sort((a, b) => b[sortKey] - a[sortKey]).slice(0, TOP_N)

paymentsRouter.get("/api/admin/metrics", adminMiddleware, async (req, res) => {
    res.set("Cache-Control", "no-store")

    // tipos estrictos: nada de objetos ni arrays en la query
    const range = typeof req.query.range === "string" && METRIC_RANGES.includes(req.query.range) ? req.query.range : "month"
    const from  = typeof req.query.from === "string" ? req.query.from : null
    const to    = typeof req.query.to === "string" ? req.query.to : null

    try {
        let firstSaleDate = null
        if (range === "all") {
            const first = await PaymentsMongo.findOne({ status: { $in: CHARGED_STATUSES } })
                .sort({ createdAt: 1 }).select("createdAt paidAt").lean()
            firstSaleDate = first ? (first.paidAt || first.createdAt) : null
        }

        const r = resolveRange(range, from, to, firstSaleDate)
        if (r.error) return res.status(400).json({ message: `${r.error} 🔴` })

        const windowStart = r.prevStart || r.start
        const dateFilter  = { $gte: windowStart, $lt: r.end }
        const query = {
            status: { $in: ALL_STATUSES },
            $or: [
                { paidAt: dateFilter },
                { paidAt: null, createdAt: dateFilter },
            ],
        }

        const [docs, historicAgg] = await Promise.all([
            PaymentsMongo.find(query).select(METRIC_FIELDS).limit(MAX_METRIC_DOCS).lean(),
            PaymentsMongo.aggregate([
                { $match: { status: { $in: CHARGED_STATUSES } } },
                { $project: {
                    gross: { $ifNull: ["$amountReceivedCents", { $ifNull: ["$totalCents",
                        { $round: [{ $multiply: [{ $ifNull: ["$amount", 0] }, 100] }, 0] }] }] },
                    refunded: { $ifNull: ["$refundedCents", 0] },
                    lost: { $cond: [{ $and: [{ $eq: ["$status", "disputed"] }, { $eq: ["$dispute.status", "lost"] }] },
                        { $ifNull: ["$dispute.amountCents", 0] }, 0] },
                } },
                { $group: { _id: null, gross: { $sum: "$gross" }, refunded: { $sum: "$refunded" }, lost: { $sum: "$lost" }, count: { $sum: 1 } } },
            ]),
        ])

        // ── recorrido único ──
        const buckets   = buildBuckets(r)
        const seriesMap = new Map(buckets.map(b => [b.key, {
            key: b.key, label: b.label, grossCents: 0, refundedCents: 0, feeCents: 0, ivaCents: 0, netCents: 0, orders: 0,
        }]))

        const totals   = emptyTotals()
        const previous = emptyTotals()
        const status   = Object.fromEntries(ALL_STATUSES.map(s => [s, 0]))
        const products = new Map(), categories = new Map(), coupons = new Map(), countries = new Map()
        const shipping = { delivery: 0, pickup: 0 }
        const emails   = new Map()
        let guests = 0, accounts = 0, needsReview = 0, openDisputes = 0, openDisputeCents = 0
        const recent = []

        for (const o of docs) {
            const date = new Date(o.paidAt || o.createdAt)
            const inCurrent = date >= r.start && date < r.end
            const charged   = CHARGED_STATUSES.includes(o.status)

            if (!inCurrent) {
                if (charged && r.prevStart && date >= r.prevStart && date < r.prevEnd) addTo(previous, o, orderMoney(o))
                continue
            }

            status[o.status] = (status[o.status] || 0) + 1
            if (o.needsReview) needsReview += 1
            if (!charged) continue

            const m = orderMoney(o)
            addTo(totals, o, m)

            const s = seriesMap.get(bucketKeyOf(date, r.bucket))
            if (s) {
                s.grossCents += m.gross; s.refundedCents += m.refunded + m.lost
                s.feeCents += m.fee; s.ivaCents += m.iva; s.netCents += m.net; s.orders += 1
            }

            if (o.status === "disputed" && !["won", "lost"].includes(o.dispute?.status)) {
                openDisputes += 1
                openDisputeCents += o.dispute?.amountCents || 0
            }

            // clientes
            if (o.guest) guests += 1; else accounts += 1
            const em = String(o.email || "").toLowerCase()
            if (em) emails.set(em, (emails.get(em) || 0) + 1)

            // productos y categorías (importe de la línea con el cupón ya restado)
            for (const it of o.items || []) {
                const qty  = Math.max(Number(it.cantidad) || 0, 0)
                const line = Number.isFinite(it.lineCents) ? it.lineCents - (it.discountCents || 0) : centsOf(null, it.totalItem)
                const name = String(it.nombre || "Sin nombre")
                const pKey = `${it.productId || name}`
                const p = products.get(pKey) || { nombre: name, units: 0, grossCents: 0, orders: 0 }
                p.units += qty; p.grossCents += line; p.orders += 1
                products.set(pKey, p)
                for (const cat of (it.categorias || []).slice(0, 10)) {
                    const k = String(cat).toLowerCase()
                    const c = categories.get(k) || { nombre: k, units: 0, grossCents: 0 }
                    c.units += qty; c.grossCents += line
                    categories.set(k, c)
                }
            }

            if (o.coupon?.code) {
                const k = String(o.coupon.code)
                const c = coupons.get(k) || { code: k, uses: 0, discountCents: 0, grossCents: 0 }
                c.uses += 1; c.discountCents += Math.max(o.discountCents || 0, 0); c.grossCents += m.gross
                coupons.set(k, c)
            }

            if (o.shipping?.mode === "pickup") shipping.pickup += 1; else shipping.delivery += 1

            const pais = String(o.shipping?.address?.pais || o.billing?.direccion?.pais || "Sin dato")
            const ct = countries.get(pais) || { pais, orders: 0, grossCents: 0 }
            ct.orders += 1; ct.grossCents += m.gross
            countries.set(pais, ct)

            recent.push({
                _id: o._id, orderId: o.orderId, email: o.email, guest: !!o.guest, status: o.status,
                date, grossCents: m.gross, refundedCents: m.refunded, feeCents: m.fee, netCents: m.net,
            })
        }

        const created  = Object.values(status).reduce((a, n) => a + n, 0)
        const repeat   = [...emails.values()].filter(n => n > 1).length
        const h        = historicAgg[0] || { gross: 0, refunded: 0, lost: 0, count: 0 }
        const hFee     = Math.round(h.gross * FEE_PERCENT / 100) + h.count * FEE_FIXED_CENTS
        const hNetSales = h.gross - h.refunded - h.lost

        res.status(200).json({
            config: {
                currency: "EUR", timezone: BUSINESS_TZ,
                feePercent: FEE_PERCENT, feeFixedCents: FEE_FIXED_CENTS, ivaRate: IVA_RATE,
            },
            range: { type: range, bucket: r.bucket, from: dayKey(r.startCal), to: dayKey(cal(r.endCal.y, r.endCal.m, r.endCal.d - 1)) },
            truncated: docs.length >= MAX_METRIC_DOCS,
            totals: {
                ...totals,
                avgTicketCents: totals.paidOrders ? Math.round(totals.grossCents / totals.paidOrders) : 0,
                refundRate: totals.grossCents ? totals.refundedCents / totals.grossCents : 0,
            },
            previous: r.prevStart ? previous : null,
            historic: {
                grossCents: h.gross, refundedCents: h.refunded + h.lost, feeCents: hFee,
                netCents: hNetSales - hFee, paidOrders: h.count,
            },
            series: [...seriesMap.values()],
            status,
            funnel: { created, paid: totals.paidOrders, rate: created ? totals.paidOrders / created : 0 },
            alerts: { needsReview, openDisputes, openDisputeCents },
            customers: { guests, accounts, unique: emails.size, repeat },
            shipping: { ...shipping, shippingCents: totals.shippingCents },
            topProducts:   topList(products),
            topCategories: topList(categories),
            coupons:       topList(coupons, "uses"),
            countries:     topList(countries),
            recent: recent.sort((a, b) => b.date - a.date).slice(0, TOP_N),
        })
    } catch (error) {
        console.error(`[${new Date().toISOString()}] ERROR MÉTRICAS:`, error)
        res.status(500).json({ message: "Error al calcular las métricas 🔴" })
    }
})

module.exports = paymentsRouter