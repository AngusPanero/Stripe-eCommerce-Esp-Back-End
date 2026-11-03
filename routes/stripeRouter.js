/* ════════════════════════════════════════════════════════════════════════════
   stripeRouter.js — Cobros con Stripe (PaymentIntents + Webhook)

   FLUJO
   1. POST /stripe-create-payment-intent  (con cuenta O como invitado)
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

   INVITADOS (sin sesión)
   · Pueden cotizar y pagar. El email llega en el body y se valida.
   · NO pueden usar cupones (los cupones se registran con el email de la cuenta).
   · El stock nunca se reserva: se comprueba al cotizar / crear el pago y se
     descuenta en el webhook de forma condicional (igual que con cuenta).
   · El pedido lleva un statusToken (se guarda solo su hash). Con él el
     invitado consulta el estado y reutiliza el pedido si reintenta.
   · Nunca se toca el carrito en BD de una cuenta con ese mismo email.

   ADMIN  (todas las acciones piden la clave de firma: { pin } en el body)
   GET  /api/admin/orders                  listado (filtros status / needsReview) — solo lectura, sin pin
   POST /api/admin/orders/:id/refund       reembolso total o parcial (+ reponer stock / liberar cupón)  🔑
   POST /api/admin/orders/:id/reconcile    re-sincroniza con Stripe (si el webhook no llegó)            🔑
   POST /api/admin/orders/:id/cancel       cancela un pedido pendiente                                  🔑
   PATCH /api/admin/orders/:id/review      marca una revisión como resuelta                             🔑

   CLIENTE
   GET  /api/orders/mine                   sus pedidos (reemplaza a /tickets)
════════════════════════════════════════════════════════════════════════════ */

const express    = require("express");
const mongoose   = require("mongoose");
const crypto     = require("crypto");
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
const { getClientIp }  = adminMiddleware;
const requireSignPin  = require("../middleware/requireSignPin");
const { notifyNewSale } = require("../sseManager/sseManajer");
const { mail }          = require("./contactRouter");   // transporte y diseño compartidos de los mails

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
const ADMIN_STATUSES       = [...PAID_STATUSES, ...OPEN_STATUSES, "canceled", "review"];

const STORE_NAME  = process.env.STORE_NAME || "Dekin Hogar";
const ADMIN_EMAIL = mail.destinoAdmin;   // ADMIN_EMAIL → EMAIL_TO → EMAIL_FROM

// cookie(s) de sesión que lee authMiddleware (separadas por coma en el .env).
// La sesión del proyecto va en la cookie "idToken": si no se reconoce, un
// usuario logueado entraría como invitado (sin cupones y con pedido de invitado).
const SESSION_COOKIES = (process.env.SESSION_COOKIE_NAMES || "idToken")
    .split(",").map(s => s.trim()).filter(Boolean);

// ════════════════════════════════════════════════════════════════════════════
//  HELPERS
// ════════════════════════════════════════════════════════════════════════════
const toCents   = (eur)   => Math.round(Number(eur || 0) * 100);
const fromCents = (cents) => Math.round(Number(cents || 0)) / 100;
const formatEUR = (cents) => fromCents(cents).toLocaleString("es-ES", { style: "currency", currency: "EUR" });
const isId      = (v)     => mongoose.Types.ObjectId.isValid(String(v || ""));
const capitalize = (s)    => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const cleanStr  = (v, max = 200) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");

const EMAIL_RE   = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const cleanEmail = (v) => {
    const e = typeof v === "string" ? v.trim().toLowerCase() : "";
    return e.length <= 254 && EMAIL_RE.test(e) ? e : null;
};

// token para que un invitado consulte / reutilice SU pedido (se guarda solo el hash)
const newStatusToken = () => crypto.randomBytes(24).toString("hex");
const hashToken      = (t) => crypto.createHash("sha256").update(String(t)).digest("hex");

// ════════════════════════════════════════════════════════════════════════════
//  LÍMITES (en memoria, mismo patrón que el resto de routers)
//  · crear pago: cada llamada crea un pedido y un PaymentIntent → spam y
//    "card testing" (probar tarjetas robadas contra tu cuenta de Stripe)
//  · cotizar / consultar estado: consultas a Mongo y a la API de Stripe
//  · fallos de cupón: evita adivinar códigos probando en /stripe-quote
// ════════════════════════════════════════════════════════════════════════════
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
            if (mapa.size > 5000) for (const [kk, v] of mapa) if (now - v.first > ventanaMs) mapa.delete(kk);
        },
    };
}

const limitePagoIp     = crearLimite(15, 15 * 60 * 1000);    // 15 intentos de pago / 15 min por IP
const limitePagoCuenta = crearLimite(10, 15 * 60 * 1000);    // 10 / 15 min por cuenta o email invitado
const limiteCotizar    = crearLimite(120, 10 * 60 * 1000);   // el checkout recotiza al cambiar envío / cupón
const limiteEstado     = crearLimite(120, 5 * 60 * 1000);    // el polling hace 12 consultas por pago
const fallosCupon      = crearLimite(8, 15 * 60 * 1000);     // mismo criterio que cartRouter

const demasiados = (res, msg = "Demasiadas solicitudes. Espera unos minutos e inténtalo de nuevo 🔴") =>
    res.status(429).json({ message: msg, code: "RATE_LIMIT" });

const claveCuenta = (req) => (req.user?.uid ? `uid:${req.user.uid}` : null);
const COUPON_LOCKED_MSG = "Demasiados intentos con cupones. Prueba más tarde 🔴";

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

// el hash del statusToken del invitado no sale nunca en una respuesta
function sinSecretos(order) {
    const o = typeof order?.toObject === "function" ? order.toObject() : { ...(order || {}) };
    delete o.statusTokenHash;
    return o;
}

function pushHistory(order, status, note) {
    order.history.push({ at: new Date(), status, note });
}

// ════════════════════════════════════════════════════════════════════════════
//  AUTH OPCIONAL — si trae credenciales se valida con verifyToken (un token
//  inválido sigue dando 401); si no trae ninguna, entra como invitado.
// ════════════════════════════════════════════════════════════════════════════
function leerCookie(req, nombre) {
    if (req.cookies && req.cookies[nombre]) return req.cookies[nombre];   // con cookie-parser
    const par = (req.headers.cookie || "").split(";").map(c => c.trim()).find(c => c.startsWith(`${nombre}=`));
    return par ? decodeURIComponent(par.slice(nombre.length + 1)) : null;
}

function traeCredenciales(req) {
    if (/^Bearer\s+\S+/i.test(req.headers.authorization || "")) return true;
    return SESSION_COOKIES.some(n => !!leerCookie(req, n));
}

function optionalAuth(req, res, next) {
    if (!traeCredenciales(req)) {
        req.user    = undefined;
        req.isGuest = true;
        return next();
    }
    return verifyToken(req, res, (err) => {
        if (err) return next(err);
        req.isGuest = !req.user?.email;
        next();
    });
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
async function buildQuote({ items, couponCode, email, shippingMode = "delivery", guest = false }) {
    if (!Array.isArray(items) || items.length === 0) throw new CheckoutError(400, "El carrito está vacío");
    if (items.length > MAX_LINES) throw new CheckoutError(400, "Demasiados productos en el carrito");

    // los cupones quedan registrados con el email de la cuenta → solo con sesión
    if (guest && couponCode && String(couponCode).trim()) {
        throw new CheckoutError(403, "Debes iniciar sesión para usar cupones", "COUPON");
    }

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
            if (!it.varianteId) throw new CheckoutError(400, `Elige una opción para "${p.nombre}"`);
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
//  El transporte y la plantilla están en contactRouter (`mail`): todos los
//  correos de la tienda comparten diseño. Aquí solo se arma el contenido.
// ════════════════════════════════════════════════════════════════════════════
const escapeHtml = mail.esc;
const STRIPE_TEST = String(process.env.STRIPE_SECRET_KEY || "").startsWith("sk_test");
const stripeLink = (piId) =>
    /^pi_[A-Za-z0-9]+$/.test(String(piId || "")) ? `https://dashboard.stripe.com/${STRIPE_TEST ? "test/" : ""}payments/${piId}` : null;
const stripeCta = (piId, label = "Ver el pago en Stripe") => {
    const href = stripeLink(piId);
    return href ? { label, href } : null;
};
const primerNombre = (o) => String(o?.billing?.nombre || o?.nombre || "").trim().split(/\s+/)[0] || "";

// Los fallos de mail nunca frenan un cobro ni un webhook: se registran y listo
async function sendMail(to, subject, html) {
    if (!mail.configurado || !to) return;
    try {
        await mail.enviar({ to, subject, html });
    } catch (err) {
        console.error(`[MAIL] Error enviando "${subject}" a ${to}:`, err.message);
    }
}

const itemsCount = (o) => (o.items || []).reduce((a, i) => a + (Number(i.cantidad) || 0), 0);

// Productos + totales del pedido
function resumenPedido(order, label = "Pedido") {
    const items = mail.itemsTable((order.items || []).map(i => ({
        nombre:     capitalize(i.nombre),
        detalle:    i.varianteLabel || "",
        cantidad:   i.cantidad,
        totalCents: (i.lineCents || 0) - (i.discountCents || 0),
        imagen:     i.imagen,
    })));
    const pickup = order.shipping?.mode === "pickup";
    const tot = mail.totals([
        ["Subtotal", order.subtotalCents],
        order.discountCents ? [`Cupón ${order.coupon?.code || ""}`.trim(), -order.discountCents, { color: "#E84B1A" }] : null,
        pickup ? ["Recogida en tienda", 0, { text: "Sin coste" }]
               : ["Envío", order.shippingCents, order.shippingCents ? {} : { text: "Gratis" }],
        ["Total", order.totalCents, { strong: true }],
    ]);
    return mail.section(label, items + tot);
}

function direccionTexto(d = {}) {
    return [
        [d.calle, d.numero, d.piso].filter(Boolean).join(" "),
        [d.codigoPostal, d.ciudad].filter(Boolean).join(" "),
        d.provincia,
        d.pais,
    ].filter(Boolean).join(", ");
}

function datosEntrega(o, label = "Entrega") {
    if (o.shipping?.mode === "pickup") {
        return mail.section(label, mail.rows([["Modalidad", "Recogida en tienda"], ["Coordinación", "Te escribimos por email"]]));
    }
    const dir = direccionTexto(o.shipping?.address);
    return dir ? mail.section(label, mail.rows([["Modalidad", "Envío a domicilio"], ["Dirección", dir]])) : "";
}

function datosFactura(o, label = "Facturación") {
    const b = o.billing || {};
    const doc = b.documento || b.cif;
    if (!doc) return "";
    const tipoDoc = b.tipoDocumento === "vat_ue" ? "NIF-IVA" : (b.tipoDocumento || "NIF").toUpperCase();
    return mail.section(label, mail.rows([
        [b.type === "empresa" ? "Razón social" : "Titular", titularFactura(b) || "—"],
        [tipoDoc, doc, { mono: true }],
        ["Dirección fiscal", direccionTexto(b.direccion) || "—"],
    ]));
}

function datosCliente(o) {
    return mail.section("Cliente", mail.rows([
        ["Nombre", o.nombre || "—"],
        ["Email", `<a href="mailto:${escapeHtml(o.email)}" style="color:#1A1614;text-decoration:underline;">${escapeHtml(o.email)}</a>`, { raw: true }],
        ["Teléfono", o.telefono || "—"],
        ["Cuenta", o.guest ? "Compra sin cuenta" : "Cliente registrado"],
    ]));
}

const notasRevision = (o) => (o.reviewNotes || []).map(n => mail.note(escapeHtml(n), "warn")).join("");

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
            //    (un pedido de invitado nunca lleva cupón; se protege igual)
            if (!order.guest && order.coupon?.code && !order.couponBurned && !order.couponConflict) {
                const burn = await burnCoupon(order.coupon.couponId, order.email, new Date(pi.created * 1000), session);
                if (burn.ok) {
                    order.couponBurned = true;
                } else {
                    order.couponConflict = burn.reason;
                    order.needsReview    = true;
                    order.reviewNotes.push(`Cupón ${order.coupon.code}: ${burn.reason}. El cliente pagó con el descuento aplicado.`);
                }
            }

            // 4. estado — paidAt marca "ya cobrado y avisado". No se usa el estado porque
            //    un contracargo puede llegar antes que este evento y dejarlo en "disputed":
            //    así igual se avisa la venta, una sola vez.
            if (!order.paidAt) {
                justPaid             = true;
                order.paidAt         = new Date();
                order.failureMessage = null;
                if (!PAID_STATUSES.includes(order.status)) order.status = "approved";
                pushHistory(order, order.status, `Pago confirmado por Stripe (${pi.id})`);
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
    // un invitado no tiene carrito en BD; y si su email coincide con el de una
    // cuenta, NO se debe tocar el carrito de esa cuenta
    if (!order.guest) {
        try { await Cart.findOneAndDelete({ userEmail: order.email }); }
        catch (err) { console.error("[STRIPE] No se pudo vaciar el carrito:", err.message); }
    }

    try { notifyNewSale(order); }
    catch (err) { console.error("[STRIPE] Error SSE:", err.message); }

    const pickup = order.shipping?.mode === "pickup";
    const n      = itemsCount(order);
    const nombre = primerNombre(order);

    await sendMail(
        ADMIN_EMAIL,
        `🟢 Nueva venta ${order.orderId} — ${formatEUR(order.totalCents)}${order.guest ? " (sin cuenta)" : ""}${order.needsReview ? " (REVISAR)" : ""}`,
        mail.layout({
            audience:  "admin",
            preheader: `${formatEUR(order.totalCents)} · ${n} artículo${n === 1 ? "" : "s"} · ${order.nombre || order.email}`,
            eyebrow:   order.needsReview ? "Venta a revisar" : "Venta confirmada",
            tone:      order.needsReview ? "warn" : "ok",
            title:     "Nueva venta",
            accent:    formatEUR(order.totalCents),
            intro:     `Stripe confirmó el pago${order.guest ? " de un cliente sin cuenta" : ""}. ${pickup ? "El cliente pasará a recogerlo por la tienda." : "Prepara el envío a la dirección de abajo."}`,
            ref:       order.orderId,
            body:      `${notasRevision(order)}${datosCliente(order)}${datosEntrega(order)}${datosFactura(order)}${resumenPedido(order)}`,
            cta:       stripeCta(order.stripePaymentIntentId),
        })
    );
    await sendMail(
        order.email,
        `Pedido ${order.orderId} confirmado — ${STORE_NAME}`,
        mail.layout({
            preheader: `Pedido ${order.orderId} · ${formatEUR(order.totalCents)}. ${pickup ? "Te escribimos para coordinar la recogida." : "Te avisamos en cuanto salga."}`,
            eyebrow:   "Pago confirmado",
            tone:      "ok",
            title:     nombre ? "Gracias," : "Gracias por",
            accent:    nombre ? `${nombre}.` : "tu compra.",
            intro:     `Hemos recibido tu pago y ya estamos preparando tu pedido. ${pickup ? "Te escribiremos para coordinar el día y la hora de la recogida." : "Te avisaremos en cuanto salga hacia ti."}`,
            ref:       order.orderId,
            body:      `${resumenPedido(order, "Tu pedido")}${datosEntrega(order)}${datosFactura(order)}${mail.para("¿Algo no está bien? Responde a este correo y lo revisamos contigo.")}`,
            cta:       mail.siteUrl ? { label: "Seguir comprando", href: mail.siteUrl } : null,
        })
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
                    mail.layout({
                        audience:  "admin",
                        preheader: `Stripe cobró ${formatEUR(obj.amount_received)} sin un pedido en la tienda.`,
                        eyebrow:   "Revisión necesaria",
                        title:     "Pago sin",
                        accent:    "pedido",
                        intro:     "Stripe confirmó un cobro que no corresponde a ningún pedido de la tienda. Puede ser un pago de prueba o uno creado a mano desde Stripe. Si no lo reconoces, revísalo y reembólsalo desde ahí.",
                        ref:       obj.id,
                        body:      mail.section("Pago", mail.rows([
                            ["Importe", formatEUR(obj.amount_received)],
                            ["Email del pago", obj.receipt_email || "—"],
                            ["PaymentIntent", obj.id, { mono: true }],
                        ])),
                        cta:       stripeCta(obj.id),
                    }));
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
                mail.layout({
                    audience:  "admin",
                    preheader: `${formatEUR(order.totalCents)} todavía sin confirmar. No envíes el pedido aún.`,
                    eyebrow:   "Pago en proceso",
                    tone:      "warn",
                    title:     "Pago",
                    accent:    "pendiente",
                    intro:     "El banco todavía no confirmó el cobro (transferencia SEPA, Klarna o revisión del banco). <strong>No envíes el pedido</strong> hasta que llegue el aviso de venta confirmada.",
                    ref:       order.orderId,
                    body:      `${datosCliente(order)}${resumenPedido(order)}`,
                    cta:       stripeCta(order.stripePaymentIntentId),
                }));
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
                    mail.layout({
                        audience:  "admin",
                        preheader: "El pago en proceso se canceló: no hay que enviar este pedido.",
                        eyebrow:   "Pago cancelado",
                        tone:      "info",
                        title:     "Pago",
                        accent:    "cancelado",
                        intro:     "El pago que estaba en proceso fue cancelado. <strong>No hay que enviar este pedido.</strong>",
                        ref:       order.orderId,
                        body:      datosCliente(order),
                    }));
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

            // Stripe manda 4 eventos por cada reembolso, casi a la vez. Cada alta y cada
            // paso a "fallido" se marca con un update condicional: solo el primer evento
            // lo consigue, así el aviso sale una vez. Los reembolsos hechos desde el
            // panel (metadata.source = "panel") los registra la propia ruta y no se avisan.
            const list = await stripe.refunds.list({ payment_intent: piId, limit: 100 });
            const externos = [];
            const fallidos = [];

            for (const r of list.data) {
                const desdePanel = r.metadata?.source === "panel";
                if (!desdePanel) {
                    const alta = await PaymentsMongo.updateOne(
                        { _id: order._id, "refunds.refundId": { $ne: r.id } },
                        { $push: { refunds: {
                            // si ya llega fallido se guarda como pendiente: el paso a "failed" de abajo dispara el aviso una sola vez
                            refundId: r.id, amountCents: r.amount, status: r.status === "failed" ? "pending" : r.status,
                            reason: r.reason || null, note: r.metadata?.note || null,
                            failureReason: r.failure_reason || null,
                            createdBy: r.metadata?.createdBy || "stripe_dashboard",
                            createdAt: new Date(r.created * 1000),
                        } } }
                    );
                    if (alta.modifiedCount === 1 && r.status !== "failed") externos.push(r);
                }
                if (r.status === "failed") {
                    const f = await PaymentsMongo.updateOne(
                        { _id: order._id, refunds: { $elemMatch: { refundId: r.id, status: { $ne: "failed" } } } },
                        { $set: { "refunds.$.status": "failed", "refunds.$.failureReason": r.failure_reason || null } }
                    );
                    if (f.modifiedCount === 1) fallidos.push(r);
                } else {
                    await PaymentsMongo.updateOne(
                        { _id: order._id, "refunds.refundId": r.id },
                        { $set: { "refunds.$.status": r.status, "refunds.$.amountCents": r.amount } }
                    );
                }
            }

            // estado e importe reembolsado, recalculados sobre el pedido ya actualizado
            const fresh = await PaymentsMongo.findById(order._id);
            if (!fresh) return;
            recomputeRefundState(fresh);
            await fresh.save();

            const nuevo = externos.reduce((a, r) => a + r.amount, 0);
            if (nuevo > 0) {
                await sendMail(ADMIN_EMAIL, `↩️ Reembolso ${fresh.orderId} — ${formatEUR(nuevo)}`,
                    mail.layout({
                        audience:  "admin",
                        preheader: `Se devolvieron ${formatEUR(nuevo)} desde Stripe.`,
                        eyebrow:   "Reembolso registrado",
                        tone:      "warn",
                        title:     "Reembolso",
                        accent:    formatEUR(nuevo),
                        intro:     "Se registró un reembolso hecho desde el panel de Stripe (no desde la tienda).",
                        ref:       fresh.orderId,
                        body:      `${mail.section("Importes", mail.rows([
                            ["Total del pedido", formatEUR(fresh.totalCents)],
                            ["Reembolsado en total", formatEUR(fresh.refundedCents), { color: "#B7650B" }],
                            ["Queda cobrado", formatEUR(Math.max(fresh.totalCents - fresh.refundedCents, 0))],
                        ]))}${datosCliente(fresh)}`,
                        cta:       stripeCta(fresh.stripePaymentIntentId),
                    }));
            }
            if (fallidos.length) {
                await sendMail(ADMIN_EMAIL, `🔴 Falló un reembolso ${fresh.orderId}`,
                    mail.layout({
                        audience:  "admin",
                        preheader: "Stripe no pudo devolver el dinero al cliente.",
                        eyebrow:   "Acción necesaria",
                        title:     "Reembolso",
                        accent:    "fallido",
                        intro:     "Stripe no pudo completar un reembolso de este pedido (tarjeta cancelada o cuenta cerrada, por ejemplo). Revísalo en Stripe y coordina la devolución con el cliente.",
                        ref:       fresh.orderId,
                        body:      `${mail.section("Reembolso", mail.rows(fallidos.map(r => [formatEUR(r.amount), r.failure_reason || "sin motivo informado"])))}${datosCliente(fresh)}`,
                        cta:       stripeCta(fresh.stripePaymentIntentId, "Revisar en Stripe"),
                    }));
            }
            return;
        }

        case "charge.dispute.created": {
            const piId = typeof obj.payment_intent === "string" ? obj.payment_intent : obj.payment_intent?.id;
            const order = piId ? await PaymentsMongo.findOne({ stripePaymentIntentId: piId }) : null;
            if (!order || order.dispute?.disputeId === obj.id) return;
            order.dispute = { disputeId: obj.id, status: obj.status, reason: obj.reason, amountCents: obj.amount, prevStatus: PAID_STATUSES.includes(order.status) && order.status !== "disputed" ? order.status : "approved" };
            order.status      = "disputed";
            order.needsReview = true;
            order.reviewNotes.push(`Contracargo abierto: ${obj.reason}`);
            pushHistory(order, "disputed", `Disputa ${obj.id} (${obj.reason})`);
            await order.save();
            const limite = obj.evidence_details?.due_by
                ? new Date(obj.evidence_details.due_by * 1000).toLocaleDateString("es-ES", { dateStyle: "long" })
                : null;
            await sendMail(ADMIN_EMAIL, `🔴 Contracargo en ${order.orderId} — ${formatEUR(obj.amount)}`,
                mail.layout({
                    audience:  "admin",
                    preheader: `El cliente disputó ${formatEUR(obj.amount)}${limite ? `. Plazo: ${limite}` : ""}.`,
                    eyebrow:   "Contracargo abierto",
                    title:     "Contracargo",
                    accent:    formatEUR(obj.amount),
                    intro:     "El cliente disputó el cobro con su banco. Responde desde Stripe antes de la fecha límite, con la prueba de entrega y la factura.",
                    ref:       order.orderId,
                    body:      `${mail.section("Disputa", mail.rows([
                        ["Motivo", obj.reason || "—"],
                        ["Fecha límite", limite || "Ver en Stripe", { color: "#E84B1A" }],
                        ["Disputa", obj.id, { mono: true }],
                    ]))}${datosCliente(order)}${resumenPedido(order)}`,
                    cta:       stripeCta(order.stripePaymentIntentId, "Responder en Stripe"),
                }));
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
            const ganada = obj.status === "won";
            await sendMail(ADMIN_EMAIL, `Disputa cerrada en ${order.orderId}: ${ganada ? "GANADA" : String(obj.status).toUpperCase()}`,
                mail.layout({
                    audience:  "admin",
                    preheader: ganada ? "El banco falló a tu favor." : `Resultado de la disputa: ${obj.status}.`,
                    eyebrow:   "Disputa cerrada",
                    tone:      ganada ? "ok" : "accent",
                    title:     "Disputa",
                    accent:    ganada ? "ganada" : obj.status === "lost" ? "perdida" : String(obj.status),
                    intro:     ganada
                        ? "El banco falló a tu favor: el cobro se mantiene y el pedido vuelve a su estado anterior."
                        : obj.status === "lost"
                            ? "El banco falló a favor del cliente: el importe se devolvió y Stripe descuenta la comisión de disputa."
                            : `Estado final informado por Stripe: ${escapeHtml(obj.status)}.`,
                    ref:       order.orderId,
                    body:      datosCliente(order),
                    cta:       stripeCta(order.stripePaymentIntentId),
                }));
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
//  Con o sin sesión. Sin sesión no se aceptan cupones.
// ════════════════════════════════════════════════════════════════════════════
stripeRouter.post("/stripe-quote", optionalAuth, async (req, res) => {
    const ip = getClientIp(req);
    if (limiteCotizar.bloqueado(ip)) return demasiados(res);
    limiteCotizar.sumar(ip);

    const email = req.user?.email?.toLowerCase() || null;
    const guest = !email;
    const cuenta = claveCuenta(req);

    const { items, couponCode, shipping } = req.body || {};
    const traeCupon = typeof couponCode === "string" && couponCode.trim() !== "";
    if (traeCupon && cuenta && fallosCupon.bloqueado(cuenta)) {
        return res.status(429).json({ message: COUPON_LOCKED_MSG, code: "COUPON_LOCKED" });
    }
    try {
        const quote = await buildQuote({
            items: cartItemsToQuoteItems(items),
            couponCode,
            email,
            guest,
            shippingMode: shipping?.mode === "pickup" ? "pickup" : "delivery",
        });
        res.status(200).json({ quote: publicQuote(quote) });
    } catch (error) {
        if (error instanceof CheckoutError) {
            if (error.code === "COUPON" && cuenta) fallosCupon.sumar(cuenta);
            return res.status(error.status).json({ message: `${error.message} 🔴`, code: error.code });
        }
        console.error(`[${new Date().toISOString()}] ERROR COTIZANDO:`, error);
        res.status(500).json({ message: "Error interno al calcular el total 🔴" });
    }
});

// ════════════════════════════════════════════════════════════════════════════
//  POST /stripe-create-payment-intent
//  Body: { items:[{productId, varianteId?, cantidad}], couponCode?, shipping:{mode, address},
//          billing?, nombre?, telefono?, orderId? (para reutilizar el pedido al cambiar el carrito),
//          email? (solo invitados), statusToken? (solo invitados, para reutilizar su pedido) }
// ════════════════════════════════════════════════════════════════════════════
const ADDRESS_FIELDS = ["calle", "numero", "piso", "ciudad", "provincia", "codigoPostal", "pais", "paisCodigo"];

/* ── Datos de facturación ────────────────────────────────────────────────────
   Particular: nombre + apellidos + NIF / NIE / pasaporte
   Empresa / autónomo: razón social + CIF / NIF / NIF-IVA UE
   Siempre con dirección fiscal completa.
──────────────────────────────────────────────────────────────────────────── */
const DOC_TYPES  = ["nif", "nie", "cif", "vat_ue", "pasaporte"];
const DNI_LETRAS = "TRWAGMYFPDXBNJZSQVHLCKE";

const normalizarDoc = (v) => String(v || "").toUpperCase().replace(/[\s.\-\/]/g, "");
const letraDNIok    = (numero, letra) => DNI_LETRAS[Number(numero) % 23] === letra;

function validarCIF(v) {
    if (!/^[ABCDEFGHJNPQRSUVW]\d{7}[0-9A-J]$/.test(v)) return false;
    const d = v.slice(1, 8).split("").map(Number);
    const pares = d[1] + d[3] + d[5];
    let impares = 0;
    [d[0], d[2], d[4], d[6]].forEach(n => { const x = n * 2; impares += Math.floor(x / 10) + (x % 10); });
    const control = (10 - ((pares + impares) % 10)) % 10;
    return v[8] === String(control) || v[8] === "JABCDEFGHI"[control];
}

function validarDocumento(tipo, raw) {
    const v = normalizarDoc(raw);
    if (!v) return false;
    switch (tipo) {
        case "nif":       return (/^\d{8}[A-Z]$/.test(v) && letraDNIok(v.slice(0, 8), v[8])) || validarCIF(v);
        case "nie":       return /^[XYZ]\d{7}[A-Z]$/.test(v) && letraDNIok("XYZ".indexOf(v[0]) + v.slice(1, 8), v[8]);
        case "cif":       return validarCIF(v) || (/^\d{8}[A-Z]$/.test(v) && letraDNIok(v.slice(0, 8), v[8]));
        case "vat_ue":    return /^[A-Z]{2}[A-Z0-9]{2,13}$/.test(v);
        case "pasaporte": return /^[A-Z0-9]{5,20}$/.test(v);
        default:          return false;
    }
}

function sanitizeAddress(raw = {}) {
    const out = {};
    for (const k of ADDRESS_FIELDS) out[k] = cleanStr(raw?.[k], 120);
    out.paisCodigo = out.paisCodigo.toUpperCase().slice(0, 2);
    return out;
}

function sanitizeBilling(raw = {}, shippingAddress = null) {
    const type          = raw?.type === "empresa" ? "empresa" : "fisica";
    const nombre        = cleanStr(raw?.nombre, 80);
    const apellidos     = cleanStr(raw?.apellidos, 120);
    const razonSocial   = cleanStr(raw?.razonSocial, 150);
    const tipoDocumento = DOC_TYPES.includes(raw?.tipoDocumento) ? raw.tipoDocumento : (type === "empresa" ? "cif" : "nif");
    const documento     = normalizarDoc(raw?.documento).slice(0, 20);

    const usarEnvio = raw?.mismaDireccion === true && shippingAddress;
    const direccion = sanitizeAddress(usarEnvio ? shippingAddress : raw?.direccion);

    let error = null;
    if (type === "fisica" && (!nombre || !apellidos))      error = "Completa nombre y apellidos para la factura";
    else if (type === "empresa" && !razonSocial)            error = "Completa la razón social para la factura";
    else if (!validarDocumento(tipoDocumento, documento))   error = "El documento de facturación (NIF / NIE / CIF) no es válido";
    else if (!direccion.calle || !direccion.codigoPostal || !direccion.ciudad || !direccion.pais) {
        error = "Completa la dirección de facturación";
    }

    return {
        error,
        data: {
            type, nombre, apellidos, razonSocial, tipoDocumento, documento, direccion,
            // compatibilidad con el panel actual
            cif:             documento,
            direccionFiscal: [direccion.calle, direccion.numero, direccion.piso].filter(Boolean).join(" "),
            ciudadFiscal:    direccion.ciudad,
            cpFiscal:        direccion.codigoPostal,
        },
    };
}

const titularFactura = (b) =>
    b?.type === "empresa" ? b.razonSocial : [b?.nombre, b?.apellidos].filter(Boolean).join(" ");

stripeRouter.post("/stripe-create-payment-intent", optionalAuth, async (req, res) => {
    const { items, couponCode, shipping, billing, nombre, telefono, orderId, statusToken: tokenCliente } = req.body || {};

    // con sesión el email sale del token; como invitado, del body (validado)
    const sessionEmail = req.user?.email?.toLowerCase() || null;
    const guest        = !sessionEmail;
    const email        = sessionEmail || cleanEmail(req.body?.email);
    if (!email) {
        return res.status(400).json({ message: "Introduce un email válido: ahí te llegan la confirmación y la factura 🔴", code: "EMAIL" });
    }

    // cada llamada puede crear un pedido + PaymentIntent: se limita por IP y por cuenta / email
    const ip     = getClientIp(req);
    const cuenta = claveCuenta(req) || `guest:${email}`;
    if (limitePagoIp.bloqueado(ip) || limitePagoCuenta.bloqueado(cuenta)) {
        return demasiados(res, "Demasiados intentos de pago. Espera unos minutos antes de volver a intentarlo 🔴");
    }
    limitePagoIp.sumar(ip);
    limitePagoCuenta.sumar(cuenta);

    const traeCupon = typeof couponCode === "string" && couponCode.trim() !== "";
    if (traeCupon && !guest && fallosCupon.bloqueado(cuenta)) {
        return res.status(429).json({ message: COUPON_LOCKED_MSG, code: "COUPON_LOCKED" });
    }

    try {
        const shippingMode = shipping?.mode === "pickup" ? "pickup" : "delivery";

        const address = sanitizeAddress(shipping?.address);
        if (shippingMode === "delivery" && (!address.calle || !address.ciudad || !address.codigoPostal || !address.pais)) {
            return res.status(400).json({ message: "Completa la dirección de envío (calle, ciudad, código postal y país) 🔴" });
        }

        const { data: billingData, error: billingError } = sanitizeBilling(billing, shippingMode === "delivery" ? address : null);
        if (billingError) return res.status(400).json({ message: `${billingError} 🔴`, code: "BILLING" });

        const contacto = [billingData.nombre, billingData.apellidos].filter(Boolean).join(" ");

        // buildQuote vuelve a comprobar el stock real en este momento (409 STOCK si falta)
        const quote = await buildQuote({ items: cartItemsToQuoteItems(items), couponCode, email, guest, shippingMode });

        const orderData = {
            client_id: guest ? `guest:${email}` : (req.user?.uid || email),
            email,
            guest,
            nombre:   contacto || titularFactura(billingData) || cleanStr(nombre, 120),
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
        const metadata = { orderId: "", email, guest: guest ? "1" : "0", couponCode: quote.coupon?.code || "" };

        // ── Reutilizar el pedido si el carrito cambió o la tarjeta fue rechazada ──
        //    Con cuenta: el pedido debe ser de ese email.
        //    Invitado: además tiene que presentar el statusToken de ese pedido.
        if (orderId && isId(orderId) && (!guest || tokenCliente)) {
            const filtro = guest
                ? { _id: orderId, guest: true, statusTokenHash: hashToken(tokenCliente), status: { $in: ["pending", "rejected"] } }
                : { _id: orderId, email, guest: { $ne: true }, status: { $in: ["pending", "rejected"] } };

            const existing = await PaymentsMongo.findOne(filtro);
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
                        amount:        quote.totalCents,
                        receipt_email: email,
                        metadata:      { ...metadata, orderId: String(existing._id), orderRef: existing.orderId },
                    });
                    return res.status(200).json({
                        clientSecret: updated.client_secret,
                        orderId:      existing._id,
                        orderRef:     existing.orderId,
                        statusToken:  guest ? tokenCliente : undefined,
                        quote:        publicQuote(quote),
                    });
                }
            }
        }

        // ── Pedido nuevo ──
        const statusToken = guest ? newStatusToken() : null;

        const order = await PaymentsMongo.create({
            ...orderData,
            statusTokenHash: statusToken ? hashToken(statusToken) : undefined,
            orderId: `ORD-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
            status:  "pending",
            history: [{ at: new Date(), status: "pending", note: guest ? "Pedido creado (sin cuenta)" : "Pedido creado" }],
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

        res.status(200).json({
            clientSecret: pi.client_secret,
            orderId:      order._id,
            orderRef:     order.orderId,
            statusToken:  statusToken || undefined,
            quote:        publicQuote(quote),
        });

    } catch (error) {
        if (error instanceof CheckoutError) {
            if (error.code === "COUPON" && !guest) fallosCupon.sumar(cuenta);
            return res.status(error.status).json({ message: `${error.message} 🔴`, code: error.code });
        }
        console.error(`[${new Date().toISOString()}] ERROR CREANDO PAYMENT INTENT:`, error);
        res.status(500).json({ message: "Error interno al preparar el pago 🔴" });
    }
});

// ════════════════════════════════════════════════════════════════════════════
//  GET /stripe-order-status/:orderId — el front consulta después de confirmPayment
//  Con cuenta: el pedido tiene que ser de su email.
//  Invitado:   ?t=<statusToken> del pedido.
// ════════════════════════════════════════════════════════════════════════════
stripeRouter.get("/stripe-order-status/:orderId", optionalAuth, async (req, res) => {
    const email = req.user?.email?.toLowerCase() || null;
    const token = typeof req.query?.t === "string" ? req.query.t : null;
    const { orderId } = req.params;
    if (!isId(orderId)) return res.status(400).json({ message: "Pedido inválido 🔴" });
    if (!email && !token) return res.status(401).json({ message: "No autorizado 🔴" });
    if (token && token.length > 100) return res.status(400).json({ message: "Pedido inválido 🔴" });

    // cada consulta puede pegarle a la API de Stripe: se limita por IP
    const ip = getClientIp(req);
    if (limiteEstado.bloqueado(ip)) return demasiados(res);
    limiteEstado.sumar(ip);

    try {
        let order = null;
        if (email) order = await PaymentsMongo.findOne({ _id: orderId, email });
        if (!order && token) order = await PaymentsMongo.findOne({ _id: orderId, guest: true, statusTokenHash: hashToken(token) });
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
//  Los pedidos hechos sin cuenta no aparecen aquí: cualquiera puede escribir
//  un email ajeno al comprar como invitado.
// ════════════════════════════════════════════════════════════════════════════
stripeRouter.get("/api/orders/mine", verifyToken, async (req, res) => {
    const email = req.user?.email?.toLowerCase();
    if (!email) return res.status(401).json({ message: "No autenticado 🔴" });

    try {
        const orders = await PaymentsMongo.find({ email, guest: { $ne: true }, status: { $nin: ["pending", "rejected", "canceled"] } })
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
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
        const page  = Math.min(Math.max(parseInt(req.query.page, 10) || 1, 1), 10000);

        const query = {};
        const estados = typeof status === "string"
            ? status.split(",").map(s => s.trim()).filter(s => ADMIN_STATUSES.includes(s))
            : [];
        if (estados.length) query.status = { $in: estados };
        else        query.status = { $ne: "pending" };
        if (needsReview === "true") query.needsReview = true;

        const [orders, total] = await Promise.all([
            PaymentsMongo.find(query).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).select("-statusTokenHash").lean(),
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
stripeRouter.post("/api/admin/orders/:id/refund", adminMiddleware, requireSignPin, async (req, res) => {
    const { id } = req.params;
    if (!isId(id)) return res.status(400).json({ message: "Pedido inválido 🔴" });

    const { amount, reason, note, restock = false, releaseCoupon: liberarCupon = false } = req.body || {};

    try {
        const order = await PaymentsMongo.findById(id);
        if (!order) return res.status(404).json({ message: "Pedido no encontrado 🔴" });
        // "review" = cobrado pero con importe a revisar: también se puede devolver
        const esRevision = order.status === "review" && order.amountReceivedCents > 0;
        if (!["approved", "partially_refunded"].includes(order.status) && !esRevision) {
            return res.status(409).json({ message: `No se puede reembolsar un pedido en estado "${order.status}" 🔴` });
        }
        if (!order.stripePaymentIntentId) return res.status(400).json({ message: "El pedido no tiene pago en Stripe 🔴" });

        await syncRefunds(order);                     // estado real antes de calcular
        // el tope es lo que Stripe cobró de verdad (no lo que decía el pedido)
        const cobrado  = order.amountReceivedCents || order.totalCents;
        const restante = cobrado - order.refundedCents;
        const amountCents = amount === undefined || amount === null || amount === "" ? restante : toCents(amount);

        if (!Number.isInteger(amountCents) || amountCents <= 0) return res.status(400).json({ message: "Importe de reembolso inválido 🔴" });
        if (amountCents > restante) return res.status(400).json({ message: `Solo quedan ${formatEUR(restante)} por reembolsar 🔴` });

        const validReasons = ["duplicate", "fraudulent", "requested_by_customer"];
        const refund = await stripe.refunds.create({
            payment_intent: order.stripePaymentIntentId,
            amount:         amountCents,
            ...(validReasons.includes(reason) ? { reason } : {}),
            metadata: { orderId: String(order._id), source: "panel", createdBy: req.user?.email || "admin", note: cleanStr(note, 400) },
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
        if ((restock === true || Array.isArray(restock)) && order.stockApplied) {
            repuestos = await restockItems(order, Array.isArray(restock) ? restock : null);
            entry.restocked = repuestos.length > 0;
        }

        // liberar el uso del cupón (solo si es reembolso total)
        if (liberarCupon === true && order.status === "refunded" && order.couponBurned && !order.couponReleased && order.coupon?.couponId) {
            order.couponReleased = await releaseCoupon(order.coupon.couponId, order.email);
            entry.couponReleased = order.couponReleased;
        }

        pushHistory(order, order.status, `Reembolso ${formatEUR(amountCents)} por ${req.user?.email || "admin"}${repuestos.length ? ` · stock repuesto: ${repuestos.join(", ")}` : ""}`);
        await order.save();

        const nombreCliente = primerNombre(order);
        await sendMail(order.email, `Reembolso de tu pedido ${order.orderId} — ${STORE_NAME}`,
            mail.layout({
                preheader: `Devolvemos ${formatEUR(amountCents)} a tu método de pago.`,
                eyebrow:   "Reembolso solicitado",
                tone:      "ok",
                title:     "Tu reembolso",
                accent:    "está en camino",
                intro:     `${nombreCliente ? `Hola, ${escapeHtml(nombreCliente)}. ` : ""}Hemos solicitado la devolución de <strong style="color:#1A1614;">${formatEUR(amountCents)}</strong> a tu método de pago. Según tu banco, puede tardar entre 5 y 10 días hábiles en verse reflejado.`,
                ref:       order.orderId,
                body:      `${mail.section("Reembolso", mail.rows([
                    ["Pedido", order.orderId, { mono: true }],
                    ["Importe devuelto", formatEUR(amountCents), { color: "#2F7A4B" }],
                    ["Total reembolsado", `${formatEUR(order.refundedCents)} de ${formatEUR(order.totalCents)}`],
                ]))}${mail.para("Si pasados 10 días hábiles no lo ves en tu cuenta, responde a este correo y lo revisamos.")}`,
            }));

        res.status(200).json({ message: `Reembolso de ${formatEUR(amountCents)} solicitado 🟢`, refund: { id: refund.id, status: refund.status }, order: sinSecretos(order) });

    } catch (error) {
        console.error(`[${new Date().toISOString()}] ERROR REEMBOLSO:`, error);
        res.status(500).json({ message: error?.raw?.message || "Error al procesar el reembolso 🔴" });
    }
});

stripeRouter.post("/api/admin/orders/:id/reconcile", adminMiddleware, requireSignPin, async (req, res) => {
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
        res.status(200).json({ message: `Sincronizado con Stripe (${pi.status}) 🟢`, order: sinSecretos(order) });
    } catch (error) {
        console.error(`[${new Date().toISOString()}] ERROR RECONCILE:`, error);
        res.status(500).json({ message: "Error al sincronizar con Stripe 🔴" });
    }
});

stripeRouter.post("/api/admin/orders/:id/cancel", adminMiddleware, requireSignPin, async (req, res) => {
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
        res.status(200).json({ message: "Pedido cancelado 🟢", order: sinSecretos(order) });
    } catch (error) {
        console.error(`[${new Date().toISOString()}] ERROR CANCEL ORDER:`, error);
        res.status(500).json({ message: "Error al cancelar el pedido 🔴" });
    }
});

stripeRouter.patch("/api/admin/orders/:id/review", adminMiddleware, requireSignPin, async (req, res) => {
    const { id } = req.params;
    if (!isId(id)) return res.status(400).json({ message: "Pedido inválido 🔴" });

    try {
        const order = await PaymentsMongo.findById(id);
        if (!order) return res.status(404).json({ message: "Pedido no encontrado 🔴" });
        order.needsReview = false;
        pushHistory(order, order.status, `Revisión resuelta por ${req.user?.email || "admin"}${req.body?.note ? `: ${cleanStr(req.body.note, 300)}` : ""}`);
        await order.save();
        res.status(200).json({ message: "Revisión marcada como resuelta 🟢", order: sinSecretos(order) });
    } catch (error) {
        console.error(`[${new Date().toISOString()}] ERROR REVIEW ORDER:`, error);
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
    optionalAuth,
});