/* ════════════════════════════════════════════════════════════════════════════
   stripeRouter.js — Cobros con Stripe (PaymentIntents + Webhook)

   FLUJO
   1. POST /stripe-create-payment-intent  (usuario logueado)
      → el backend calcula TODO (precios, promo, cupón, envío) en céntimos,
        crea el pedido en estado "pending" y el PaymentIntent.
        El front solo manda: productId, varianteId, cantidad, couponCode,
        modo de envío y dirección. Nunca precios.
   2. El front confirma con stripe.confirmPayment().
      Si la tarjeta es rechazada, reintenta con el MISMO clientSecret.
   3. El WEBHOOK es la fuente de verdad: payment_intent.succeeded descuenta
      stock y quema el cupón (validándolo de nuevo) dentro de una transacción.
      Si algo falla devolvemos 500 → Stripe reintenta. El pedido ya existe,
      así que nunca queda un pago sin rastro.
   4. GET /stripe-order-status/:orderId → el front consulta el estado real.

   ADMIN
   GET  /api/admin/orders                  listado (filtros status / needsReview)
   POST /api/admin/orders/:id/refund       reembolso total o parcial (+ reponer stock / liberar cupón)
   POST /api/admin/orders/:id/reconcile    re-sincroniza con Stripe (si el webhook no llegó)
   POST /api/admin/orders/:id/cancel       cancela un pedido pendiente
   PATCH /api/admin/orders/:id/review      marca una revisión como resuelta

   CLIENTE
   GET  /api/orders/mine                   sus pedidos (reemplaza a /tickets)
════════════════════════════════════════════════════════════════════════════ */

const express    = require("express");
const mongoose   = require("mongoose");
const nodemailer = require("nodemailer");
const Stripe     = require("stripe");

if (!process.env.STRIPE_SECRET_KEY) {
    throw new Error("Falta STRIPE_SECRET_KEY en el .env (¿dotenv se carga antes de requerir los routers?)");
}
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const PaymentsMongo   = require("../models/Payments");
const Coupon          = require("../models/CouponSchema");
const Product         = require("../models/productModel");
const Cart            = require("../models/CartSchema");
const verifyToken     = require("../middleware/authMiddleware");
const adminMiddleware = require("../middleware/adminMiddleware");
const { notifyNewSale } = require("../sseManager/sseManajer");

const stripeRouter = express.Router();

// ════════════════════════════════════════════════════════════════════════════
//  CONFIG
// ════════════════════════════════════════════════════════════════════════════
const CURRENCY = "eur";
const SHIPPING_CONFIG = {
    ownerCoversShipping:   false,   // true = el negocio paga el envío
    shippingCostCents:     999,     // 9,99 €
    freeShippingFromCents: null,    // ej: 5000 → envío gratis desde 50 € (después de cupón)
};
const MIN_AMOUNT_CENTS     = 50;    // mínimo que acepta Stripe en EUR
const MAX_QTY_PER_LINE     = 99;
const MAX_LINES            = 50;
const REUSABLE_PI_STATUSES = ["requires_payment_method", "requires_confirmation"];
const PAID_STATUSES        = ["approved", "partially_refunded", "refunded", "disputed"];
const OPEN_STATUSES        = ["pending", "in_process", "rejected"];

const STORE_NAME  = process.env.STORE_NAME || "Dekin Hogar";
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || process.env.EMAIL_FROM;

// ════════════════════════════════════════════════════════════════════════════
//  HELPERS
// ════════════════════════════════════════════════════════════════════════════
const toCents   = (eur)   => Math.round(Number(eur || 0) * 100);
const fromCents = (cents) => Math.round(Number(cents || 0)) / 100;
const formatEUR = (cents) => fromCents(cents).toLocaleString("es-ES", { style: "currency", currency: "EUR" });
const isId      = (v)     => mongoose.Types.ObjectId.isValid(String(v || ""));
const capitalize = (s)    => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const cleanStr  = (v, max = 200) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");

class CheckoutError extends Error {
    constructor(status, message, code = "CHECKOUT") {
        super(message);
        this.status = status;
        this.code   = code;
    }
}

const variantLabel = (v) =>
    v?.atributos?.length ? v.atributos.map(a => `${capitalize(a.nombre)}: ${a.valor}`).join(" · ") : null;

// Precio unitario real (céntimos) de un producto o variante, con promo aplicada
function unitPriceCents(product, variante = null) {
    const listCents = toCents(product.precio_base) + (variante ? toCents(variante.precio_adicional) : 0);
    const promo = product.en_promocion && product.porcentaje_promo > 0 ? product.porcentaje_promo : 0;
    return {
        listCents,
        unitCents: Math.round(listCents * (1 - promo / 100)),
    };
}

function pushHistory(order, status, note) {
    order.history.push({ at: new Date(), status, note });
}

// ════════════════════════════════════════════════════════════════════════════
//  CUPONES
// ════════════════════════════════════════════════════════════════════════════
const effectiveMaxUses = (c) =>
    c.type === "single_use" ? 1 : (Number.isInteger(c.maxUses) && c.maxUses > 0 ? c.maxUses : null);

const isOnePerUser = (c) => c.type === "single_use" || c.onePerUser === true;

function couponAppliesToLine(coupon, line) {
    if (!coupon) return false;
    if (coupon.scope === "all") return true;

    if (coupon.scope === "products") {
        const allowed = (coupon.allowedProducts || []).map(s => String(s).trim().toUpperCase());
        return allowed.includes(String(line.skuPadre || "").toUpperCase()) ||
               (!!line.skuVariante && allowed.includes(String(line.skuVariante).toUpperCase()));
    }

    if (coupon.scope === "categories") {
        const allowed = (coupon.allowedCategories || []).map(c => String(c).trim().toLowerCase());
        return (line.categorias || []).some(c => allowed.includes(String(c).toLowerCase()));
    }
    return false;
}

// Devuelve null si el cupón es válido, o el motivo si no lo es
function checkCouponRules(coupon, { email, at = new Date(), eligibleSubtotalCents = null } = {}) {
    if (!coupon || !coupon.isActive) return "El cupón no existe o no está activo";
    if (coupon.startDate  && new Date(coupon.startDate)  > at) return "El cupón todavía no está vigente";
    if (coupon.expiryDate && new Date(coupon.expiryDate) < at) return "El cupón ha expirado";

    const max = effectiveMaxUses(coupon);
    if (max !== null && (coupon.usesCount || 0) >= max) return "El cupón alcanzó su límite de usos";
    if (isOnePerUser(coupon) && email && (coupon.usedBy || []).includes(email)) return "Ya utilizaste este cupón con tu cuenta";

    if (eligibleSubtotalCents !== null && coupon.minPurchase > 0 && eligibleSubtotalCents < toCents(coupon.minPurchase)) {
        return `Este cupón requiere una compra mínima de ${formatEUR(toCents(coupon.minPurchase))} en productos aplicables`;
    }
    return null;
}

// Quema atómica del cupón DESPUÉS del cobro. La validez de fechas se mide
// contra el momento en que se creó el pago (lo que se le cotizó al cliente).
async function burnCoupon(couponId, email, at, session) {
    const coupon = await Coupon.findById(couponId).session(session);
    if (!coupon) return { ok: false, reason: "El cupón fue eliminado antes de confirmarse el pago" };

    const motivo = checkCouponRules(coupon, { email, at });
    if (motivo) return { ok: false, reason: motivo };

    const max    = effectiveMaxUses(coupon);
    const filter = { _id: coupon._id, isActive: true };
    if (max !== null)          filter.usesCount = { $lt: max };
    if (isOnePerUser(coupon))  filter.usedBy    = { $ne: email };

    const updated = await Coupon.findOneAndUpdate(
        filter,
        { $inc: { usesCount: 1 }, $addToSet: { usedBy: email } },
        { new: true, session }
    );
    if (!updated) return { ok: false, reason: "El cupón se agotó o ya fue usado mientras se procesaba el pago" };

    if (max !== null && updated.usesCount >= max) {
        updated.isActive        = false;
        updated.autoDeactivated = true;
        await updated.save({ session });
    }
    return { ok: true };
}

// Devuelve el uso de un cupón (reembolso total). Solo reactiva si se apagó solo.
async function releaseCoupon(couponId, email) {
    const coupon = await Coupon.findOne({ _id: couponId, usesCount: { $gt: 0 } });
    if (!coupon) return false;

    coupon.usesCount -= 1;
    coupon.usedBy = coupon.usedBy.filter(e => e !== email);
    if (coupon.autoDeactivated) {
        coupon.isActive        = true;
        coupon.autoDeactivated = false;
    }
    await coupon.save();
    return true;
}

// ════════════════════════════════════════════════════════════════════════════
//  COTIZACIÓN — único lugar donde se calcula el dinero
// ════════════════════════════════════════════════════════════════════════════
async function buildQuote({ items, couponCode, email, shippingMode = "delivery" }) {
    if (!Array.isArray(items) || items.length === 0) throw new CheckoutError(400, "El carrito está vacío");
    if (items.length > MAX_LINES) throw new CheckoutError(400, "Demasiados productos en el carrito");

    // normalizar y agrupar líneas repetidas
    const merged = new Map();
    for (const it of items) {
        const productId  = String(it?.productId || "");
        const varianteId = it?.varianteId ? String(it.varianteId) : null;
        const cantidad   = Number(it?.cantidad);

        if (!isId(productId) || (varianteId && !isId(varianteId))) throw new CheckoutError(400, "Producto inválido en el carrito");
        if (!Number.isInteger(cantidad) || cantidad < 1)           throw new CheckoutError(400, "Cantidad no válida en uno de los productos");

        const key  = `${productId}:${varianteId || ""}`;
        const prev = merged.get(key);
        const total = (prev?.cantidad || 0) + cantidad;
        if (total > MAX_QTY_PER_LINE) throw new CheckoutError(400, `Máximo ${MAX_QTY_PER_LINE} unidades por producto`);
        merged.set(key, { productId, varianteId, cantidad: total });
    }

    const ids      = [...new Set([...merged.values()].map(i => i.productId))];
    const products = await Product.find({ _id: { $in: ids } }).lean();
    const byId     = new Map(products.map(p => [String(p._id), p]));

    const lines = [];
    for (const it of merged.values()) {
        const p = byId.get(it.productId);
        if (!p || p.estado !== "activo") throw new CheckoutError(404, "Un producto del carrito ya no está disponible", "UNAVAILABLE");

        const tieneVariantes = (p.variantes || []).length > 0;
        let variante = null;
        let stock;

        if (tieneVariantes) {
            if (!it.varianteId) throw new CheckoutError(400, `Elegí una opción para "${p.nombre}"`);
            variante = p.variantes.find(v => String(v._id) === it.varianteId);
            if (!variante || variante.activo === false) {
                throw new CheckoutError(404, `La opción elegida de "${p.nombre}" ya no está disponible`, "UNAVAILABLE");
            }
            stock = variante.stock || 0;
        } else {
            if (it.varianteId) throw new CheckoutError(400, `"${p.nombre}" no tiene variantes`);
            stock = p.stock_base || 0;
        }

        if (it.cantidad > stock) {
            throw new CheckoutError(409, stock > 0
                ? `Solo quedan ${stock} unidades de "${p.nombre}"`
                : `"${p.nombre}" está agotado`, "STOCK");
        }

        const { listCents, unitCents } = unitPriceCents(p, variante);

        lines.push({
            productId:     it.productId,
            varianteId:    it.varianteId,
            nombre:        p.nombre,
            skuPadre:      p.sku_padre,
            skuVariante:   variante?.sku_variante || null,
            varianteLabel: variantLabel(variante),
            imagen:        variante?.foto_variante || p.imagenes_generales?.[0] || null,
            categorias:    (p.categorias || []).map(c => String(c).toLowerCase()),
            cantidad:      it.cantidad,
            listUnitCents: listCents,
            unitCents,
            lineCents:     unitCents * it.cantidad,
            discountCents: 0,
            couponApplies: false,
        });
    }

    const subtotalCents = lines.reduce((a, l) => a + l.lineCents, 0);

    // ── cupón ──
    let coupon = null;
    if (couponCode && String(couponCode).trim()) {
        const code = String(couponCode).trim().toUpperCase();
        const doc  = await Coupon.findOne({ code }).lean();

        const eligible = doc ? lines.filter(l => couponAppliesToLine(doc, l)) : [];
        const eligibleSubtotalCents = eligible.reduce((a, l) => a + l.lineCents, 0);

        const motivo = checkCouponRules(doc, { email, at: new Date(), eligibleSubtotalCents: eligible.length ? eligibleSubtotalCents : null });
        if (motivo) throw new CheckoutError(400, motivo, "COUPON");
        if (!eligible.length) throw new CheckoutError(400, "Este cupón no aplica a los productos del carrito", "COUPON");

        for (const l of eligible) {
            l.discountCents = Math.round(l.lineCents * doc.discount / 100);
            l.couponApplies = true;
        }
        coupon = { couponId: doc._id, code: doc.code, discount: doc.discount, type: doc.type, scope: doc.scope };
    }

    const discountCents   = lines.reduce((a, l) => a + l.discountCents, 0);
    const itemsTotalCents = subtotalCents - discountCents;

    // ── envío ──
    const mode = shippingMode === "pickup" ? "pickup" : "delivery";
    const envioGratis = SHIPPING_CONFIG.freeShippingFromCents !== null && itemsTotalCents >= SHIPPING_CONFIG.freeShippingFromCents;
    const shippingCents = mode === "delivery" && !SHIPPING_CONFIG.ownerCoversShipping && !envioGratis
        ? SHIPPING_CONFIG.shippingCostCents
        : 0;

    const totalCents = itemsTotalCents + shippingCents;
    if (totalCents < MIN_AMOUNT_CENTS) {
        throw new CheckoutError(400, `El importe mínimo para pagar con tarjeta es ${formatEUR(MIN_AMOUNT_CENTS)}`);
    }

    return { lines, subtotalCents, discountCents, shippingCents, totalCents, coupon, shippingMode: mode };
}

// Lo que se le muestra al cliente (sin datos internos)
function publicQuote(q) {
    return {
        currency: CURRENCY,
        items: q.lines.map(l => ({
            productId:     l.productId,
            varianteId:    l.varianteId,
            nombre:        l.nombre,
            varianteLabel: l.varianteLabel,
            imagen:        l.imagen,
            cantidad:      l.cantidad,
            precioLista:   fromCents(l.listUnitCents),
            precioUnitario:fromCents(l.unitCents),
            subtotal:      fromCents(l.lineCents),
            descuento:     fromCents(l.discountCents),
            cuponAplica:   l.couponApplies,
        })),
        subtotal:  fromCents(q.subtotalCents),
        descuento: fromCents(q.discountCents),
        envio:     fromCents(q.shippingCents),
        total:     fromCents(q.totalCents),
        totalCents: q.totalCents,
        cupon:     q.coupon ? { code: q.coupon.code, discount: q.coupon.discount, scope: q.coupon.scope } : null,
    };
}

// Normaliza ítems del carrito del front → ítems de cotización
function cartItemsToQuoteItems(arr = []) {
    return (Array.isArray(arr) ? arr : []).map(i => {
        const productId = String(i?.productId?._id || i?.productId || "");
        const rawVar    = i?.varianteId || (i?.id && String(i.id) !== productId ? i.id : null);
        return { productId, varianteId: rawVar ? String(rawVar) : null, cantidad: Number(i?.cantidad) };
    });
}

// ════════════════════════════════════════════════════════════════════════════
//  MAILS (aviso al dueño + confirmaciones al cliente)
// ════════════════════════════════════════════════════════════════════════════
const mailer = process.env.EMAIL_FROM && process.env.PASS_EMAIL
    ? nodemailer.createTransport({ service: "gmail", auth: { user: process.env.EMAIL_FROM, pass: process.env.PASS_EMAIL } })
    : null;

const escapeHtml = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const p = (txt) => `<p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:rgba(240,235,229,.8);">${txt}</p>`;
const alertBox = (txt) => `<p style="margin:0 0 16px;padding:12px 14px;background:rgba(232,75,26,.12);border-left:3px solid #E84B1A;font-size:14px;color:#F0EBE5;">${txt}</p>`;

async function sendMail(to, subject, html) {
    if (!mailer || !to) return;
    try {
        await mailer.sendMail({ from: `"${STORE_NAME}" <${process.env.EMAIL_FROM}>`, to, subject, html });
    } catch (err) {
        console.error(`[MAIL] Error enviando "${subject}" a ${to}:`, err.message);
    }
}

function mailLayout(titulo, contenido) {
    return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"/></head>
<body style="margin:0;padding:32px 12px;background:#F2EDE8;font-family:Arial,Helvetica,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#1A1614;">
  <tr><td style="background:#E84B1A;padding:22px 32px;font-size:22px;font-weight:800;letter-spacing:.08em;color:#fff;text-transform:uppercase;">${escapeHtml(STORE_NAME)}</td></tr>
  <tr><td style="padding:32px;color:#F0EBE5;">
    <p style="margin:0 0 18px;font-size:20px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;color:#F0EBE5;">${escapeHtml(titulo)}</p>
    ${contenido}
  </td></tr>
  <tr><td style="padding:16px 32px;background:#F2EDE8;font-size:11px;color:rgba(26,22,20,.45);">Mensaje automático · ${escapeHtml(STORE_NAME)}</td></tr>
</table></td></tr></table></body></html>`;
}

function orderSummaryHtml(order) {
    const td  = "padding:8px 0;border-bottom:1px solid rgba(255,255,255,.08);font-size:14px;color:#F0EBE5;";
    const rows = order.items.map(i => `<tr>
        <td style="${td}">${escapeHtml(capitalize(i.nombre))} × ${i.cantidad}${i.varianteLabel ? `<br><span style="font-size:12px;color:rgba(240,235,229,.55);">${escapeHtml(i.varianteLabel)}</span>` : ""}</td>
        <td style="${td}text-align:right;">${formatEUR(i.lineCents - (i.discountCents || 0))}</td></tr>`).join("");
    const line = (label, cents, strong = false) => `<tr>
        <td style="padding:6px 0;font-size:13px;color:rgba(240,235,229,.6);">${label}</td>
        <td style="padding:6px 0;text-align:right;font-size:${strong ? 17 : 13}px;color:#F0EBE5;${strong ? "font-weight:800;" : ""}">${formatEUR(cents)}</td></tr>`;

    return `${p(`Pedido <strong style="color:#fff;">${escapeHtml(order.orderId)}</strong>`)}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      ${rows}
      ${line("Subtotal", order.subtotalCents)}
      ${order.discountCents ? line(`Cupón ${escapeHtml(order.coupon?.code || "")}`, -order.discountCents) : ""}
      ${line(order.shipping?.mode === "pickup" ? "Recogida en tienda" : "Envío", order.shippingCents)}
      ${line("Total", order.totalCents, true)}
    </table>`;
}

const clienteHtml = (o) => p(`Cliente: <strong style="color:#fff;">${escapeHtml(o.nombre || "-")}</strong> · ${escapeHtml(o.email)} · ${escapeHtml(o.telefono || "-")}`);

// ════════════════════════════════════════════════════════════════════════════
//  FULFILLMENT — idempotente: Stripe puede mandar el mismo evento varias veces
// ════════════════════════════════════════════════════════════════════════════
async function findOrderForPI(pi) {
    const metaId = pi?.metadata?.orderId;
    if (metaId && isId(metaId)) {
        const order = await PaymentsMongo.findById(metaId);
        if (order) return order;
    }
    return PaymentsMongo.findOne({ stripePaymentIntentId: pi.id });
}

async function fulfillOrder(orderId, pi) {
    const session = await mongoose.startSession();
    let justPaid = false;
    let order    = null;

    try {
        await session.withTransaction(async () => {
            justPaid = false;
            order = await PaymentsMongo.findById(orderId).session(session);
            if (!order) throw new Error(`Pedido ${orderId} no encontrado`);
            if (order.stripePaymentIntentId && order.stripePaymentIntentId !== pi.id) {
                throw new Error(`El PaymentIntent ${pi.id} no corresponde al pedido ${order.orderId}`);
            }

            const received = pi.amount_received || pi.amount;
            order.amountReceivedCents = received;
            order.stripeChargeId = (typeof pi.latest_charge === "string" ? pi.latest_charge : pi.latest_charge?.id) || order.stripeChargeId;

            // 1. el importe cobrado tiene que ser exactamente el del pedido
            if (received !== order.totalCents || pi.currency !== CURRENCY) {
                if (order.status !== "review") {
                    order.status      = "review";
                    order.needsReview = true;
                    order.reviewNotes.push(`Stripe cobró ${formatEUR(received)} ${pi.currency} y el pedido es de ${formatEUR(order.totalCents)}`);
                    pushHistory(order, "review", "Importe cobrado no coincide con el pedido");
                }
                await order.save({ session });
                return;
            }

            // 2. stock (condicional: nunca deja stock negativo)
            if (!order.stockApplied) {
                const conflicts = [];
                for (const item of order.items) {
                    const filter = item.varianteId
                        ? { _id: item.productId, variantes: { $elemMatch: { _id: item.varianteId, stock: { $gte: item.cantidad } } } }
                        : { _id: item.productId, stock_base: { $gte: item.cantidad } };
                    const update = item.varianteId
                        ? { $inc: { "variantes.$.stock": -item.cantidad } }
                        : { $inc: { stock_base: -item.cantidad } };

                    const r = await Product.updateOne(filter, update, { session });
                    if (r.modifiedCount === 1) {
                        item.stockDiscounted = true;
                    } else {
                        conflicts.push({ productId: item.productId, varianteId: item.varianteId, nombre: item.nombre, solicitado: item.cantidad });
                    }
                }
                order.stockApplied   = true;
                order.stockConflicts = conflicts;
                if (conflicts.length) {
                    order.needsReview = true;
                    order.reviewNotes.push(`Sin stock suficiente al confirmar el pago: ${conflicts.map(c => `${c.nombre} (${c.solicitado})`).join(", ")}`);
                }
            }

            // 3. cupón: se valida OTRA VEZ y se quema solo ahora que está cobrado
            if (order.coupon?.code && !order.couponBurned && !order.couponConflict) {
                const burn = await burnCoupon(order.coupon.couponId, order.email, new Date(pi.created * 1000), session);
                if (burn.ok) {
                    order.couponBurned = true;
                } else {
                    order.couponConflict = burn.reason;
                    order.needsReview    = true;
                    order.reviewNotes.push(`Cupón ${order.coupon.code}: ${burn.reason}. El cliente pagó con el descuento aplicado.`);
                }
            }

            // 4. estado
            if (!PAID_STATUSES.includes(order.status)) {
                justPaid           = true;
                order.status       = "approved";
                order.paidAt       = new Date();
                order.failureMessage = null;
                pushHistory(order, "approved", `Pago confirmado por Stripe (${pi.id})`);
            }

            await order.save({ session });
        });
    } finally {
        await session.endSession();
    }

    if (justPaid) afterPaid(order).catch(err => console.error("[STRIPE] Error en tareas post-pago:", err));
    return order;
}

async function afterPaid(order) {
    try { await Cart.findOneAndDelete({ userEmail: order.email }); }
    catch (err) { console.error("[STRIPE] No se pudo vaciar el carrito:", err.message); }

    try { notifyNewSale(order); }
    catch (err) { console.error("[STRIPE] Error SSE:", err.message); }

    const alertas = (order.reviewNotes || []).map(n => alertBox(`⚠️ ${escapeHtml(n)}`)).join("");

    await sendMail(
        ADMIN_EMAIL,
        `🟢 Nueva venta ${order.orderId} — ${formatEUR(order.totalCents)}${order.needsReview ? " (REVISAR)" : ""}`,
        mailLayout("Nueva venta aprobada", `${alertas}${clienteHtml(order)}${orderSummaryHtml(order)}`)
    );
    await sendMail(
        order.email,
        `Confirmación de tu pedido ${order.orderId}`,
        mailLayout("¡Gracias por tu compra!", `${p("Hemos recibido tu pago correctamente. Te avisaremos cuando tu pedido esté en camino.")}${orderSummaryHtml(order)}`)
    );
}

// Recalcula reembolsos desde Stripe (fuente de verdad) y ajusta el estado
async function syncRefunds(order) {
    if (!order.stripePaymentIntentId) return order;

    const list = await stripe.refunds.list({ payment_intent: order.stripePaymentIntentId, limit: 100 });
    for (const r of list.data) {
        const existing = order.refunds.find(x => x.refundId === r.id);
        if (existing) {
            existing.status        = r.status;
            existing.amountCents   = r.amount;
            existing.failureReason = r.failure_reason || null;
        } else {
            order.refunds.push({
                refundId:    r.id,
                amountCents: r.amount,
                status:      r.status,
                reason:      r.reason || null,
                note:        r.metadata?.note || null,
                createdBy:   r.metadata?.createdBy || "stripe_dashboard",
                createdAt:   new Date(r.created * 1000),
            });
        }
    }
    recomputeRefundState(order);
    return order;
}

function recomputeRefundState(order) {
    order.refundedCents = order.refunds
        .filter(r => ["succeeded", "pending", "requires_action"].includes(r.status))
        .reduce((a, r) => a + r.amountCents, 0);

    if (order.status === "disputed" || !["approved", "partially_refunded", "refunded"].includes(order.status)) return;

    const nuevo = order.refundedCents <= 0 ? "approved"
        : order.refundedCents >= order.totalCents ? "refunded"
        : "partially_refunded";

    if (nuevo !== order.status) {
        order.status = nuevo;
        pushHistory(order, nuevo, `Reembolsado ${formatEUR(order.refundedCents)} de ${formatEUR(order.totalCents)}`);
    }
}

// Reponer stock. restockList: [{ index, cantidad }] — si es null repone todo lo pendiente
async function restockItems(order, restockList = null) {
    const lista = restockList ?? order.items.map((it, index) => ({ index, cantidad: it.cantidad }));
    const repuestos = [];

    for (const { index, cantidad } of lista) {
        const item = order.items[index];
        if (!item || !item.stockDiscounted) continue;

        const qty = Math.min(Number(cantidad) || 0, item.cantidad - (item.restockedQty || 0));
        if (qty <= 0) continue;

        const r = item.varianteId
            ? await Product.updateOne({ _id: item.productId, "variantes._id": item.varianteId }, { $inc: { "variantes.$.stock": qty } })
            : await Product.updateOne({ _id: item.productId }, { $inc: { stock_base: qty } });

        if (r.modifiedCount === 1) {
            item.restockedQty = (item.restockedQty || 0) + qty;
            repuestos.push(`${item.nombre}${item.varianteLabel ? ` (${item.varianteLabel})` : ""} × ${qty}`);
        }
    }
    return repuestos;
}

// ════════════════════════════════════════════════════════════════════════════
//  WEBHOOK
// ════════════════════════════════════════════════════════════════════════════
async function handleStripeEvent(event) {
    const obj = event.data.object;

    switch (event.type) {

        case "payment_intent.succeeded": {
            const order = await findOrderForPI(obj);
            if (!order) {
                console.error(`[STRIPE] Pago ${obj.id} sin pedido asociado`);
                await sendMail(ADMIN_EMAIL, `🔴 Pago sin pedido asociado (${obj.id})`,
                    mailLayout("Pago sin pedido", p(`Stripe confirmó un pago de ${formatEUR(obj.amount_received)} (${escapeHtml(obj.receipt_email || "")}) que no corresponde a ningún pedido. Revisalo en el panel de Stripe.`)));
                return;
            }
            await fulfillOrder(order._id, obj);
            return;
        }

        case "payment_intent.processing": {
            const order = await findOrderForPI(obj);
            if (!order || !OPEN_STATUSES.includes(order.status) || order.status === "in_process") return;
            order.status = "in_process";
            pushHistory(order, "in_process", "Stripe está procesando el pago");
            await order.save();
            await sendMail(ADMIN_EMAIL, `🟡 Pago pendiente ${order.orderId} — ${formatEUR(order.totalCents)}`,
                mailLayout("Pago en proceso", `${p("El pago todavía no está confirmado (transferencia SEPA, Klarna o revisión del banco). No envíes el pedido hasta que pase a aprobado.")}${clienteHtml(order)}${orderSummaryHtml(order)}`));
            return;
        }

        case "payment_intent.payment_failed": {
            const order = await findOrderForPI(obj);
            if (!order || !OPEN_STATUSES.includes(order.status)) return;   // nunca pisar un aprobado
            order.status         = "rejected";
            order.failureMessage = obj.last_payment_error?.message || "Pago rechazado";
            pushHistory(order, "rejected", order.failureMessage);
            await order.save();
            return;
        }

        case "payment_intent.canceled": {
            const order = await findOrderForPI(obj);
            if (!order || !OPEN_STATUSES.includes(order.status)) return;
            const estabaEnProceso = order.status === "in_process";
            order.status = "canceled";
            pushHistory(order, "canceled", obj.cancellation_reason || "PaymentIntent cancelado");
            await order.save();
            if (estabaEnProceso) {
                await sendMail(ADMIN_EMAIL, `⚪ Pago cancelado ${order.orderId}`,
                    mailLayout("Pago cancelado", `${p("El pago que estaba en proceso fue cancelado. No hay que enviar este pedido.")}${clienteHtml(order)}`));
            }
            return;
        }

        case "charge.refunded":
        case "charge.refund.updated":
        case "refund.created":
        case "refund.updated":
        case "refund.failed": {
            const piId = typeof obj.payment_intent === "string" ? obj.payment_intent : obj.payment_intent?.id;
            if (!piId) return;
            const order = await PaymentsMongo.findOne({ stripePaymentIntentId: piId });
            if (!order) return;

            const antes      = order.refundedCents;
            const fallidoAntes = order.refunds.filter(r => r.status === "failed").length;
            await syncRefunds(order);
            await order.save();

            if (order.refundedCents > antes) {
                await sendMail(ADMIN_EMAIL, `↩️ Reembolso ${order.orderId} — ${formatEUR(order.refundedCents - antes)}`,
                    mailLayout("Reembolso registrado", `${p(`Reembolsado en total: <strong style="color:#fff;">${formatEUR(order.refundedCents)}</strong> de ${formatEUR(order.totalCents)}.`)}${clienteHtml(order)}`));
            }
            if (order.refunds.filter(r => r.status === "failed").length > fallidoAntes) {
                await sendMail(ADMIN_EMAIL, `🔴 Falló un reembolso ${order.orderId}`,
                    mailLayout("Reembolso fallido", `${alertBox("Stripe no pudo completar un reembolso. Revisalo en el panel de Stripe.")}${clienteHtml(order)}`));
            }
            return;
        }

        case "charge.dispute.created": {
            const piId = typeof obj.payment_intent === "string" ? obj.payment_intent : obj.payment_intent?.id;
            const order = piId ? await PaymentsMongo.findOne({ stripePaymentIntentId: piId }) : null;
            if (!order || order.dispute?.disputeId === obj.id) return;
            order.dispute = { disputeId: obj.id, status: obj.status, reason: obj.reason, amountCents: obj.amount, prevStatus: order.status };
            order.status      = "disputed";
            order.needsReview = true;
            order.reviewNotes.push(`Contracargo abierto: ${obj.reason}`);
            pushHistory(order, "disputed", `Disputa ${obj.id} (${obj.reason})`);
            await order.save();
            await sendMail(ADMIN_EMAIL, `🔴 Contracargo en ${order.orderId} — ${formatEUR(obj.amount)}`,
                mailLayout("Contracargo abierto", `${alertBox(`Motivo: ${escapeHtml(obj.reason)}. Tenés que responder la disputa desde el panel de Stripe antes de la fecha límite.`)}${clienteHtml(order)}${orderSummaryHtml(order)}`));
            return;
        }

        case "charge.dispute.closed": {
            const piId = typeof obj.payment_intent === "string" ? obj.payment_intent : obj.payment_intent?.id;
            const order = piId ? await PaymentsMongo.findOne({ stripePaymentIntentId: piId }) : null;
            if (!order || order.dispute?.status === obj.status) return;
            order.dispute.status = obj.status;
            if (obj.status === "won") order.status = order.dispute.prevStatus || "approved";
            pushHistory(order, order.status, `Disputa cerrada: ${obj.status}`);
            await order.save();
            await sendMail(ADMIN_EMAIL, `Disputa cerrada en ${order.orderId}: ${obj.status === "won" ? "GANADA" : obj.status.toUpperCase()}`,
                mailLayout("Disputa cerrada", p(`Resultado: <strong style="color:#fff;">${escapeHtml(obj.status)}</strong>.`)));
            return;
        }

        default:
            return;
    }
}

// Se monta en index.js ANTES de express.json() (necesita el body crudo)
async function webhookHandler(req, res) {
    let event;
    try {
        event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
        console.error("[STRIPE] Firma de webhook inválida:", err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {
        await handleStripeEvent(event);
        res.status(200).json({ received: true });
    } catch (err) {
        // 500 → Stripe reintenta el evento (hasta 3 días). Todo es idempotente.
        console.error(`[${new Date().toISOString()}] [STRIPE] Error procesando ${event.type} (${event.id}):`, err);
        res.status(500).json({ error: "Error procesando el evento" });
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  POST /stripe-quote — cotización sin crear pedido (lo que muestra el checkout)
//  Body: { items:[{productId, varianteId?, cantidad}], couponCode?, shipping:{mode} }
// ════════════════════════════════════════════════════════════════════════════
stripeRouter.post("/stripe-quote", verifyToken, async (req, res) => {
    const email = req.user?.email?.toLowerCase();
    if (!email) return res.status(401).json({ message: "Tenés que iniciar sesión 🔴" });

    const { items, couponCode, shipping } = req.body || {};
    try {
        const quote = await buildQuote({
            items: cartItemsToQuoteItems(items),
            couponCode,
            email,
            shippingMode: shipping?.mode === "pickup" ? "pickup" : "delivery",
        });
        res.status(200).json({ quote: publicQuote(quote) });
    } catch (error) {
        if (error instanceof CheckoutError) {
            return res.status(error.status).json({ message: `${error.message} 🔴`, code: error.code });
        }
        console.error(`[${new Date().toISOString()}] ERROR COTIZANDO:`, error);
        res.status(500).json({ message: "Error interno al calcular el total 🔴" });
    }
});

// ════════════════════════════════════════════════════════════════════════════
//  POST /stripe-create-payment-intent
//  Body: { items:[{productId, varianteId?, cantidad}], couponCode?, shipping:{mode, address},
//          billing?, nombre?, telefono?, orderId? (para reutilizar el pedido al cambiar el carrito) }
// ════════════════════════════════════════════════════════════════════════════
const ADDRESS_FIELDS = ["calle", "numero", "piso", "ciudad", "provincia", "codigoPostal", "pais"];
const BILLING_FIELDS = ["razonSocial", "cif", "direccionFiscal", "ciudadFiscal", "cpFiscal"];

stripeRouter.post("/stripe-create-payment-intent", verifyToken, async (req, res) => {
    const email = req.user?.email?.toLowerCase();
    if (!email) return res.status(401).json({ message: "Tenés que iniciar sesión para pagar 🔴" });

    const { items, couponCode, shipping, billing, nombre, telefono, orderId } = req.body || {};

    try {
        const shippingMode = shipping?.mode === "pickup" ? "pickup" : "delivery";

        const address = {};
        for (const k of ADDRESS_FIELDS) address[k] = cleanStr(shipping?.address?.[k], 120);
        if (shippingMode === "delivery" && (!address.calle || !address.ciudad || !address.codigoPostal)) {
            return res.status(400).json({ message: "Completá la dirección de envío (calle, ciudad y código postal) 🔴" });
        }

        const billingData = { type: billing?.type === "empresa" ? "empresa" : "fisica" };
        for (const k of BILLING_FIELDS) billingData[k] = cleanStr(billing?.[k], 150);

        const quote = await buildQuote({ items: cartItemsToQuoteItems(items), couponCode, email, shippingMode });

        const orderData = {
            client_id: req.user?.uid || email,
            email,
            nombre:   cleanStr(nombre, 120),
            telefono: cleanStr(telefono, 40) || "N/A",
            items: quote.lines.map(l => ({
                ...l,
                precioUnitario: fromCents(l.unitCents),
                totalItem:      fromCents(l.lineCents - l.discountCents),
                descuentoCupon: fromCents(l.discountCents),
            })),
            subtotalCents: quote.subtotalCents,
            discountCents: quote.discountCents,
            shippingCents: quote.shippingCents,
            totalCents:    quote.totalCents,
            amount:        fromCents(quote.totalCents),
            coupon:        quote.coupon || { couponId: null, code: null, discount: null, type: null, scope: null },
            shipping: {
                mode:        shippingMode,
                cost:        fromCents(quote.shippingCents),
                ownerCovers: SHIPPING_CONFIG.ownerCoversShipping,
                address:     shippingMode === "delivery" ? address : undefined,
            },
            billing: billingData,
        };
        const metadata = { orderId: "", email, couponCode: quote.coupon?.code || "" };

        // ── Reutilizar el pedido si el carrito cambió antes de pagar ──
        if (orderId && isId(orderId)) {
            const existing = await PaymentsMongo.findOne({ _id: orderId, email, status: { $in: ["pending", "rejected"] } });
            if (existing?.stripePaymentIntentId) {
                const pi = await stripe.paymentIntents.retrieve(existing.stripePaymentIntentId);
                if (REUSABLE_PI_STATUSES.includes(pi.status)) {
                    existing.set(orderData);
                    if (existing.status === "rejected") {
                        existing.status = "pending";
                        pushHistory(existing, "pending", "Pedido actualizado por el cliente");
                    }
                    await existing.save();

                    const updated = await stripe.paymentIntents.update(pi.id, {
                        amount:   quote.totalCents,
                        metadata: { ...metadata, orderId: String(existing._id), orderRef: existing.orderId },
                    });
                    return res.status(200).json({ clientSecret: updated.client_secret, orderId: existing._id, orderRef: existing.orderId, quote: publicQuote(quote) });
                }
            }
        }

        // ── Pedido nuevo ──
        const order = await PaymentsMongo.create({
            ...orderData,
            orderId: `ORD-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
            status:  "pending",
            history: [{ at: new Date(), status: "pending", note: "Pedido creado" }],
        });

        // idempotencyKey generada en el servidor y única por pedido
        const pi = await stripe.paymentIntents.create({
            amount:   quote.totalCents,
            currency: CURRENCY,
            automatic_payment_methods: { enabled: true },
            receipt_email: email,
            description:   `${STORE_NAME} · ${order.orderId}`,
            metadata:      { ...metadata, orderId: String(order._id), orderRef: order.orderId },
        }, { idempotencyKey: `pi_create_${order._id}` });

        order.stripePaymentIntentId = pi.id;
        await order.save();

        res.status(200).json({ clientSecret: pi.client_secret, orderId: order._id, orderRef: order.orderId, quote: publicQuote(quote) });

    } catch (error) {
        if (error instanceof CheckoutError) {
            return res.status(error.status).json({ message: `${error.message} 🔴`, code: error.code });
        }
        console.error(`[${new Date().toISOString()}] ERROR CREANDO PAYMENT INTENT:`, error);
        res.status(500).json({ message: "Error interno al preparar el pago 🔴" });
    }
});

// ════════════════════════════════════════════════════════════════════════════
//  GET /stripe-order-status/:orderId — el front consulta después de confirmPayment
// ════════════════════════════════════════════════════════════════════════════
stripeRouter.get("/stripe-order-status/:orderId", verifyToken, async (req, res) => {
    const email = req.user?.email?.toLowerCase();
    const { orderId } = req.params;
    if (!isId(orderId)) return res.status(400).json({ message: "Pedido inválido 🔴" });

    try {
        let order = await PaymentsMongo.findOne({ _id: orderId, email });
        if (!order) return res.status(404).json({ message: "Pedido no encontrado 🔴" });

        // Si el webhook todavía no llegó, preguntamos a Stripe directamente
        if (OPEN_STATUSES.includes(order.status) && order.stripePaymentIntentId) {
            const pi = await stripe.paymentIntents.retrieve(order.stripePaymentIntentId);
            if (pi.status === "succeeded") {
                order = await fulfillOrder(order._id, pi);
            } else if (pi.status === "processing" && order.status !== "in_process") {
                order.status = "in_process";
                pushHistory(order, "in_process", "Detectado al consultar estado");
                await order.save();
            } else if (pi.status === "requires_payment_method" && pi.last_payment_error && order.status === "pending") {
                order.status = "rejected";
                order.failureMessage = pi.last_payment_error.message;
                await order.save();
            }
        }

        res.status(200).json({
            orderId:        order._id,
            orderRef:       order.orderId,
            status:         order.status,
            total:          fromCents(order.totalCents),
            failureMessage: order.failureMessage,
            paidAt:         order.paidAt,
        });
    } catch (error) {
        console.error(`[${new Date().toISOString()}] ERROR ORDER STATUS:`, error);
        res.status(500).json({ message: "Error consultando el pedido 🔴" });
    }
});

// ════════════════════════════════════════════════════════════════════════════
//  GET /api/orders/mine — pedidos del usuario logueado (reemplaza /tickets)
//  El email sale del token, nunca del body ni de la URL.
// ════════════════════════════════════════════════════════════════════════════
stripeRouter.get("/api/orders/mine", verifyToken, async (req, res) => {
    const email = req.user?.email?.toLowerCase();
    if (!email) return res.status(401).json({ message: "No autenticado 🔴" });

    try {
        const orders = await PaymentsMongo.find({ email, status: { $nin: ["pending", "rejected", "canceled"] } })
            .sort({ createdAt: -1 })
            .limit(100)
            .select("orderId status items.nombre items.varianteLabel items.cantidad items.imagen items.unitCents items.lineCents items.discountCents subtotalCents discountCents shippingCents totalCents refundedCents coupon.code shipping billing paidAt createdAt invoiceSent")
            .lean();
        res.status(200).json({ orders });
    } catch (error) {
        console.error(`[${new Date().toISOString()}] ERROR MIS PEDIDOS:`, error);
        res.status(500).json({ message: "Error al obtener tus pedidos 🔴" });
    }
});

// ════════════════════════════════════════════════════════════════════════════
//  ADMIN
// ════════════════════════════════════════════════════════════════════════════
stripeRouter.get("/api/admin/orders", adminMiddleware, async (req, res) => {
    try {
        const { status, needsReview } = req.query;
        const limit = Math.min(Number(req.query.limit) || 50, 200);
        const page  = Math.max(Number(req.query.page) || 1, 1);

        const query = {};
        if (status) query.status = { $in: String(status).split(",") };
        else        query.status = { $ne: "pending" };
        if (needsReview === "true") query.needsReview = true;

        const [orders, total] = await Promise.all([
            PaymentsMongo.find(query).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
            PaymentsMongo.countDocuments(query),
        ]);
        res.status(200).json({ orders, total, page });
    } catch (error) {
        console.error(`[${new Date().toISOString()}] ERROR ADMIN ORDERS:`, error);
        res.status(500).json({ message: "Error al listar pedidos 🔴" });
    }
});

// Body: { amount?: euros (vacío = todo lo que queda), reason?, note?,
//         restock?: true | [{ index, cantidad }], releaseCoupon?: boolean }
stripeRouter.post("/api/admin/orders/:id/refund", adminMiddleware, async (req, res) => {
    const { id } = req.params;
    if (!isId(id)) return res.status(400).json({ message: "Pedido inválido 🔴" });

    const { amount, reason, note, restock = false, releaseCoupon: liberarCupon = false } = req.body || {};

    try {
        const order = await PaymentsMongo.findById(id);
        if (!order) return res.status(404).json({ message: "Pedido no encontrado 🔴" });
        if (!["approved", "partially_refunded"].includes(order.status)) {
            return res.status(409).json({ message: `No se puede reembolsar un pedido en estado "${order.status}" 🔴` });
        }

        await syncRefunds(order);                     // estado real antes de calcular
        const restante = order.totalCents - order.refundedCents;
        const amountCents = amount === undefined || amount === null || amount === "" ? restante : toCents(amount);

        if (!Number.isInteger(amountCents) || amountCents <= 0) return res.status(400).json({ message: "Importe de reembolso inválido 🔴" });
        if (amountCents > restante) return res.status(400).json({ message: `Solo quedan ${formatEUR(restante)} por reembolsar 🔴` });

        const validReasons = ["duplicate", "fraudulent", "requested_by_customer"];
        const refund = await stripe.refunds.create({
            payment_intent: order.stripePaymentIntentId,
            amount:         amountCents,
            ...(validReasons.includes(reason) ? { reason } : {}),
            metadata: { orderId: String(order._id), createdBy: req.user?.email || "admin", note: cleanStr(note, 400) },
        }, { idempotencyKey: `refund_${order._id}_${order.refunds.length}_${amountCents}` });

        let entry = order.refunds.find(r => r.refundId === refund.id);
        if (!entry) {
            order.refunds.push({
                refundId:    refund.id,
                amountCents: refund.amount,
                status:      refund.status,
                reason:      refund.reason || null,
                note:        cleanStr(note, 400) || null,
                createdBy:   req.user?.email || "admin",
            });
            entry = order.refunds[order.refunds.length - 1];
        }
        recomputeRefundState(order);

        // reponer stock
        let repuestos = [];
        if (restock && order.stockApplied) {
            repuestos = await restockItems(order, Array.isArray(restock) ? restock : null);
            entry.restocked = repuestos.length > 0;
        }

        // liberar el uso del cupón (solo si es reembolso total)
        if (liberarCupon && order.status === "refunded" && order.couponBurned && !order.couponReleased && order.coupon?.couponId) {
            order.couponReleased = await releaseCoupon(order.coupon.couponId, order.email);
            entry.couponReleased = order.couponReleased;
        }

        pushHistory(order, order.status, `Reembolso ${formatEUR(amountCents)} por ${req.user?.email || "admin"}${repuestos.length ? ` · stock repuesto: ${repuestos.join(", ")}` : ""}`);
        await order.save();

        await sendMail(order.email, `Reembolso de tu pedido ${order.orderId}`,
            mailLayout("Reembolso en camino", `${p(`Hemos solicitado un reembolso de <strong style="color:#fff;">${formatEUR(amountCents)}</strong> a tu método de pago. Según tu banco puede tardar entre 5 y 10 días hábiles en verse reflejado.`)}${p(`Pedido ${escapeHtml(order.orderId)}`)}`));

        res.status(200).json({ message: `Reembolso de ${formatEUR(amountCents)} solicitado 🟢`, refund: { id: refund.id, status: refund.status }, order });

    } catch (error) {
        console.error(`[${new Date().toISOString()}] ERROR REEMBOLSO:`, error);
        res.status(500).json({ message: error?.raw?.message || "Error al procesar el reembolso 🔴" });
    }
});

stripeRouter.post("/api/admin/orders/:id/reconcile", adminMiddleware, async (req, res) => {
    const { id } = req.params;
    if (!isId(id)) return res.status(400).json({ message: "Pedido inválido 🔴" });

    try {
        let order = await PaymentsMongo.findById(id);
        if (!order) return res.status(404).json({ message: "Pedido no encontrado 🔴" });
        if (!order.stripePaymentIntentId) return res.status(400).json({ message: "El pedido no tiene pago en Stripe 🔴" });

        const pi = await stripe.paymentIntents.retrieve(order.stripePaymentIntentId);

        if (pi.status === "succeeded") {
            order = await fulfillOrder(order._id, pi);
            await syncRefunds(order);
            await order.save();
        } else if (OPEN_STATUSES.includes(order.status)) {
            const map = { processing: "in_process", canceled: "canceled", requires_payment_method: pi.last_payment_error ? "rejected" : "pending" };
            const nuevo = map[pi.status];
            if (nuevo && nuevo !== order.status) {
                order.status = nuevo;
                pushHistory(order, nuevo, `Reconciliado manualmente (Stripe: ${pi.status})`);
                await order.save();
            }
        }
        res.status(200).json({ message: `Sincronizado con Stripe (${pi.status}) 🟢`, order });
    } catch (error) {
        console.error(`[${new Date().toISOString()}] ERROR RECONCILE:`, error);
        res.status(500).json({ message: "Error al sincronizar con Stripe 🔴" });
    }
});

stripeRouter.post("/api/admin/orders/:id/cancel", adminMiddleware, async (req, res) => {
    const { id } = req.params;
    if (!isId(id)) return res.status(400).json({ message: "Pedido inválido 🔴" });

    try {
        const order = await PaymentsMongo.findById(id);
        if (!order) return res.status(404).json({ message: "Pedido no encontrado 🔴" });
        if (!["pending", "rejected"].includes(order.status)) {
            return res.status(409).json({ message: "Solo se pueden cancelar pedidos sin cobrar. Para uno cobrado usá reembolso 🔴" });
        }
        if (order.stripePaymentIntentId) {
            const pi = await stripe.paymentIntents.retrieve(order.stripePaymentIntentId);
            if (REUSABLE_PI_STATUSES.includes(pi.status) || pi.status === "requires_action") {
                await stripe.paymentIntents.cancel(pi.id);
            }
        }
        order.status = "canceled";
        pushHistory(order, "canceled", `Cancelado por ${req.user?.email || "admin"}`);
        await order.save();
        res.status(200).json({ message: "Pedido cancelado 🟢", order });
    } catch (error) {
        console.error(`[${new Date().toISOString()}] ERROR CANCEL ORDER:`, error);
        res.status(500).json({ message: "Error al cancelar el pedido 🔴" });
    }
});

stripeRouter.patch("/api/admin/orders/:id/review", adminMiddleware, async (req, res) => {
    const { id } = req.params;
    if (!isId(id)) return res.status(400).json({ message: "Pedido inválido 🔴" });

    try {
        const order = await PaymentsMongo.findById(id);
        if (!order) return res.status(404).json({ message: "Pedido no encontrado 🔴" });
        order.needsReview = false;
        pushHistory(order, order.status, `Revisión resuelta por ${req.user?.email || "admin"}${req.body?.note ? `: ${cleanStr(req.body.note, 300)}` : ""}`);
        await order.save();
        res.status(200).json({ message: "Revisión marcada como resuelta 🟢", order });
    } catch (error) {
        res.status(500).json({ message: "Error al actualizar la revisión 🔴" });
    }
});

// ════════════════════════════════════════════════════════════════════════════
module.exports = Object.assign(stripeRouter, {
    webhookHandler,
    // reutilizados por cartRouter (validar cupón / precios con la MISMA lógica)
    buildQuote,
    publicQuote,
    cartItemsToQuoteItems,
    unitPriceCents,
    variantLabel,
    toCents,
    fromCents,
    CheckoutError,
});