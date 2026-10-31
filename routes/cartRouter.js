const express = require('express');
const cartRouter = express.Router();
const Coupon  = require("../models/CouponSchema");
const Cart    = require("../models/CartSchema");
const Product = require("../models/productModel");
const verifyToken     = require('../middleware/authMiddleware');
const adminMiddleware = require('../middleware/adminMiddleware');
const nodemailer = require("nodemailer");
const requireSignPin = require("../middleware/requireSignPin");

// Misma lógica de precios y cupones que el cobro real
const {
    buildQuote,
    publicQuote,
    cartItemsToQuoteItems,
    unitPriceCents,
    variantLabel,
    fromCents,
    CheckoutError,
} = require("./stripeRouter");

const esProduccion = (process.env.NODE_ENV === 'production');

/* ═══════════════════════════════════════════════
   CONFIG Y HELPERS
═══════════════════════════════════════════════ */

// Mismos límites que buildQuote en stripeRouter
const MAX_LINES        = 50;
const MAX_QTY_PER_LINE = 99;

// Tope de descuento: un cupón del 100 % filtrado = producto gratis.
// Si de verdad necesitás 100, poné MAX_COUPON_DISCOUNT=100 en el .env
const MAX_COUPON_DISCOUNT = Math.min(100, Math.max(1, Number(process.env.MAX_COUPON_DISCOUNT) || 90));
const MAX_SCOPE_ITEMS     = 200;   // SKUs o categorías por cupón
const MAX_SCOPE_LEN       = 60;    // largo de cada SKU / categoría
const MAX_MIN_PURCHASE    = 100000;

// Zona horaria del negocio (España). Las fechas del cupón se interpretan en esta zona.
const BUSINESS_TZ = process.env.BUSINESS_TZ || "Europe/Madrid";

const isId      = (v) => typeof v === "string" && /^[a-f\d]{24}$/i.test(v);
const normEmail = (v) => (typeof v === "string" ? v.trim().toLowerCase().slice(0, 254) : "");
const EMAIL_RE  = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const CODE_RE   = /^[A-Za-z0-9_-]{3,30}$/;

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const eur = (n) => Number(n || 0).toLocaleString("es-ES", { style: "currency", currency: "EUR" });

// ── Fechas en la zona del negocio ──
const tzFmt = new Intl.DateTimeFormat("en-US", {
    timeZone: BUSINESS_TZ, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
});

// Diferencia (ms) entre la hora local del negocio y UTC en un instante dado
function tzOffsetMs(ms) {
    const v = {};
    for (const p of tzFmt.formatToParts(new Date(ms))) v[p.type] = p.value;
    const comoUtc = Date.UTC(+v.year, +v.month - 1, +v.day, +v.hour, +v.minute, +v.second);
    return comoUtc - Math.floor(ms / 1000) * 1000;
}

// "AAAA-MM-DD" → inicio o fin de ese día en BUSINESS_TZ (contempla el cambio de hora)
const parseDay = (str, endOfDay) => {
    if (typeof str !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(str)) return null;
    const [y, m, d] = str.split("-").map(Number);

    // rechaza fechas que no existen (2026-02-31)
    const check = new Date(Date.UTC(y, m - 1, d));
    if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) return null;

    const local = endOfDay ? Date.UTC(y, m - 1, d, 23, 59, 59, 999) : Date.UTC(y, m - 1, d, 0, 0, 0, 0);
    let ts = local - tzOffsetMs(local);
    ts = local - tzOffsetMs(ts);   // segunda pasada por si cae en el día del cambio de hora
    return new Date(ts);
};

// ── Freno a la fuerza bruta de códigos de cupón (por usuario, en memoria) ──
const COUPON_FAIL_MAX    = 8;
const COUPON_FAIL_WINDOW = 15 * 60 * 1000;
const couponFails = new Map();   // uid -> { count, first }

const cuponBloqueado = (uid) => {
    const r = couponFails.get(uid);
    if (!r) return false;
    if (Date.now() - r.first > COUPON_FAIL_WINDOW) { couponFails.delete(uid); return false; }
    return r.count >= COUPON_FAIL_MAX;
};
const sumarFalloCupon = (uid) => {
    const now = Date.now();
    const r = couponFails.get(uid);
    if (!r || now - r.first > COUPON_FAIL_WINDOW) couponFails.set(uid, { count: 1, first: now });
    else r.count += 1;
    // limpieza para que el Map no crezca sin límite
    if (couponFails.size > 5000) {
        for (const [k, v] of couponFails) if (now - v.first > COUPON_FAIL_WINDOW) couponFails.delete(k);
    }
};

// ── Ítems del carrito armados SIEMPRE desde la BD ──
// Del cliente solo se acepta { id, cantidad }. Nombre, precio, imagen, stock, SKU y
// categorías salen de Product: así nadie guarda precios falsos ni HTML en su carrito.
async function buildCartItems(raw) {
    const pedidos = new Map();   // id → cantidad (las líneas repetidas se suman)
    for (const it of Array.isArray(raw) ? raw : []) {
        const id = String(it?.id ?? "");
        if (!isId(id)) continue;
        const n = Math.floor(Number(it?.cantidad));
        if (!Number.isFinite(n) || n < 1) continue;
        pedidos.set(id, Math.min((pedidos.get(id) || 0) + n, MAX_QTY_PER_LINE));
    }
    if (pedidos.size > MAX_LINES) throw new CheckoutError(400, "Demasiados productos en el carrito");
    if (pedidos.size === 0) return [];

    const ids = [...pedidos.keys()];
    const products = await Product.find({
        estado: "activo",
        $or: [{ _id: { $in: ids } }, { "variantes._id": { $in: ids } }],
    }).lean();

    const items = [];
    for (const [id, cantidadPedida] of pedidos) {
        const p = products.find(prod =>
            String(prod._id) === id || (prod.variantes || []).some(v => String(v._id) === id)
        );
        if (!p) continue;

        const variantes = p.variantes || [];
        const variante  = variantes.find(v => String(v._id) === id) || null;
        if (!variante && variantes.length > 0) continue;        // producto con variantes: hace falta elegir una
        if (variante && variante.activo === false) continue;

        const stock = Math.max(0, Number(variante ? variante.stock : p.stock_base) || 0);
        const { unitCents } = unitPriceCents(p, variante);

        items.push({
            id,
            productId:     p._id,
            varianteId:    variante ? String(variante._id) : null,
            nombre:        String(p.nombre ?? ""),
            precio:        fromCents(unitCents),   // solo visual: el cobro lo recalcula buildQuote
            imagen:        variante?.foto_variante || p.imagenes_generales?.[0] || "",
            cantidad:      stock > 0 ? Math.min(cantidadPedida, stock) : cantidadPedida,
            stockMax:      stock,
            categorias:    (p.categorias || []).map(c => String(c).toLowerCase()),
            skuPadre:      p.sku_padre || "",
            varianteLabel: variantLabel(variante) || "",
        });
    }
    return items;
}

// El cupón guardado en el carrito, o null si no hay
const cuponDeCarrito = (cart) => (cart?.appliedCoupon?.code ? cart.appliedCoupon : null);

/* ═══════════════════════════════════════════════
   CUPONES
═══════════════════════════════════════════════ */

// CREAR NUEVO CUPÓN
// couponData: { code, discount, type, description?, startDate?, expiryDate?, maxUses?,
//               onePerUser?, minPurchase?, scope?, allowedProducts?, allowedCategories? }
cartRouter.post("/api/coupons/create", adminMiddleware, requireSignPin, async (req, res) => {
    const { couponData } = req.body ?? {};

    if (!couponData || typeof couponData !== 'object' || Array.isArray(couponData)) {
        return res.status(400).json({ message: "Datos de cupón no proporcionados o formato inválido 🔴" });
    }

    const { code, discount, type, description, startDate, expiryDate, maxUses, onePerUser, minPurchase, scope, allowedProducts, allowedCategories } = couponData;

    if (!code || !discount || !type) {
        return res.status(400).json({ message: "Faltan campos obligatorios: code, discount y type son requeridos 🔴" });
    }
    if (typeof code !== 'string' || typeof type !== 'string') {
        return res.status(400).json({ message: "code y type deben ser strings 🔴" });
    }
    if (!CODE_RE.test(code.trim())) {
        return res.status(400).json({ message: "El código debe tener 3 a 30 caracteres (letras, números, - o _) 🔴" });
    }

    const discountNum = Number(discount);
    if (!Number.isInteger(discountNum) || discountNum < 1 || discountNum > MAX_COUPON_DISCOUNT) {
        return res.status(400).json({ message: `El descuento debe ser un entero entre 1 y ${MAX_COUPON_DISCOUNT} 🔴` });
    }

    const validTypes = ['single_use', 'date_limited', 'limited_uses'];
    if (!validTypes.includes(type)) {
        return res.status(400).json({ message: "Tipo de cupón inválido 🔴" });
    }

    // fechas: opcionales en cualquier tipo, expiryDate obligatoria en date_limited
    const start  = startDate  ? parseDay(startDate, false) : null;
    const expiry = expiryDate ? parseDay(expiryDate, true) : null;
    if (startDate && !start)   return res.status(400).json({ message: "startDate inválida (formato AAAA-MM-DD) 🔴" });
    if (expiryDate && !expiry) return res.status(400).json({ message: "expiryDate inválida (formato AAAA-MM-DD) 🔴" });
    if (type === 'date_limited' && !expiry) {
        return res.status(400).json({ message: "Los cupones por fecha requieren una expiryDate 🔴" });
    }
    if (expiry && expiry <= new Date()) return res.status(400).json({ message: "La fecha de expiración debe ser futura 🔴" });
    if (start && expiry && start >= expiry) return res.status(400).json({ message: "La fecha de inicio debe ser anterior al vencimiento 🔴" });

    // usos: obligatorio en limited_uses, opcional en date_limited, ignorado en single_use
    let maxUsesFinal = null;
    if (type !== 'single_use' && maxUses !== undefined && maxUses !== null && maxUses !== "") {
        const n = Number(maxUses);
        if (!Number.isInteger(n) || n < 1 || n > 1_000_000) return res.status(400).json({ message: "maxUses debe ser un entero entre 1 y 1.000.000 🔴" });
        maxUsesFinal = n;
    }
    if (type === 'limited_uses' && maxUsesFinal === null) {
        return res.status(400).json({ message: "Los cupones con límite de usos requieren maxUses 🔴" });
    }

    const minPurchaseNum = minPurchase ? Number(minPurchase) : 0;
    if (!Number.isFinite(minPurchaseNum) || minPurchaseNum < 0 || minPurchaseNum > MAX_MIN_PURCHASE) {
        return res.status(400).json({ message: `minPurchase debe ser un número entre 0 y ${MAX_MIN_PURCHASE} 🔴` });
    }

    const validScopes = ['all', 'products', 'categories'];
    const finalScope = scope || 'all';
    if (!validScopes.includes(finalScope)) {
        return res.status(400).json({ message: "Scope inválido. Use 'all', 'products' o 'categories' 🔴" });
    }

    // listas: strings no vacíos, con tope de cantidad y de largo
    const listaValida = (arr) =>
        Array.isArray(arr) && arr.length > 0 && arr.length <= MAX_SCOPE_ITEMS &&
        arr.every(s => typeof s === 'string' && s.trim() !== '' && s.trim().length <= MAX_SCOPE_LEN);

    if (finalScope === 'products' && !listaValida(allowedProducts)) {
        return res.status(400).json({ message: `Indicá entre 1 y ${MAX_SCOPE_ITEMS} SKUs válidos 🔴` });
    }
    if (finalScope === 'categories' && !listaValida(allowedCategories)) {
        return res.status(400).json({ message: `Indicá entre 1 y ${MAX_SCOPE_ITEMS} categorías válidas 🔴` });
    }

    try {
        const sanitizedCode = code.trim().toUpperCase();

        const newCoupon = await Coupon.create({
            code:        sanitizedCode,
            description: typeof description === 'string' ? description.trim().slice(0, 200) : "",
            discount:    discountNum,
            type,
            startDate:   start,
            expiryDate:  expiry,
            maxUses:     type === 'single_use' ? 1 : maxUsesFinal,
            usesCount:   0,
            onePerUser:  type === 'single_use' ? true : onePerUser === true,
            minPurchase: minPurchaseNum,
            scope:       finalScope,
            allowedProducts:   finalScope === 'products'   ? [...new Set(allowedProducts.map(s => s.trim().toUpperCase()))]   : [],
            allowedCategories: finalScope === 'categories' ? [...new Set(allowedCategories.map(c => c.trim().toLowerCase()))] : [],
            isActive: true,
            usedBy:   []
        });

        res.status(201).json({ message: "Cupón creado con éxito 🟢", coupon: newCoupon });
    } catch (error) {
        // índice único sobre code: dos altas simultáneas con el mismo código
        if (error?.code === 11000) {
            return res.status(409).json({ message: "El código de cupón ya existe en el sistema 🔴" });
        }
        console.error(`[${new Date().toISOString()}] ERROR_COUPON_CREATE:`, error);
        res.status(500).json({ message: "Error interno al procesar el cupón 🔴" });
    }
});

// VALIDAR CUPÓN — vista previa con la misma cotización que se usa para cobrar.
// El email sale del token. Del carrito solo se usan id / productId / varianteId / cantidad;
// SKU y categorías los lee buildQuote de la BD.
// Si es válido, el cupón queda guardado en el carrito desde aquí (nunca desde /cart/sync).
cartRouter.post("/api/coupons/validate", verifyToken, async (req, res) => {
    const { code, cartItems, shippingMode } = req.body ?? {};
    const email = normEmail(req.user?.email);
    const uid   = req.user?.uid;

    if (!email || !uid) return res.status(401).json({ message: "No autenticado 🔴" });
    if (typeof code !== 'string' || !CODE_RE.test(code.trim())) {
        return res.status(400).json({ message: "Código de cupón inválido 🔴", code: "COUPON" });
    }
    if (!Array.isArray(cartItems) || cartItems.length === 0) {
        return res.status(400).json({ message: "Agregá productos al carrito antes de aplicar un cupón 🔴" });
    }
    if (cartItems.length > MAX_LINES) {
        return res.status(400).json({ message: "Demasiados productos en el carrito 🔴" });
    }
    if (cuponBloqueado(uid)) {
        return res.status(429).json({ message: "Demasiados intentos con cupones. Probá más tarde 🔴", code: "COUPON_LOCKED" });
    }

    try {
        const quote = await buildQuote({
            items: cartItemsToQuoteItems(cartItems),
            couponCode: code,
            email,
            shippingMode: shippingMode === "pickup" ? "pickup" : "delivery",
        });

        // Puede haberse borrado justo entre la cotización y esta lectura
        const coupon = await Coupon.findOne({ code: quote.coupon.code }).lean();
        if (!coupon) {
            return res.status(400).json({ message: "El cupón no existe o no está activo 🔴", code: "COUPON" });
        }

        const datosCupon = {
            code:              coupon.code,
            discount:          coupon.discount,
            type:              coupon.type,
            scope:             coupon.scope,
            allowedProducts:   coupon.allowedProducts,
            allowedCategories: coupon.allowedCategories,
        };

        // Se guarda en el carrito del usuario (solo si ya existe; no crea uno)
        await Cart.updateOne(
            { userEmail: email },
            { $set: { appliedCoupon: { ...datosCupon, appliedAt: new Date() } } }
        ).catch(err => console.error("No se pudo guardar el cupón en el carrito 🟡", err.message));

        res.status(200).json({
            message: "Cupón aplicado con éxito 🟢",
            coupon: { ...datosCupon, expiryDate: coupon.expiryDate, minPurchase: coupon.minPurchase },
            preview: publicQuote(quote),
        });
    } catch (error) {
        if (error instanceof CheckoutError) {
            if (error.code === "COUPON") {
                sumarFalloCupon(uid);
                // el cupón anterior deja de valer también en la BD
                await Cart.updateOne({ userEmail: email }, { $unset: { appliedCoupon: "" } }).catch(() => {});
            }
            return res.status(error.status === 409 ? 409 : 400).json({ message: `${error.message} 🔴`, code: error.code });
        }
        console.error(`[${new Date().toISOString()}] ERROR en validar cupón:`, error);
        res.status(500).json({ message: "Error interno al validar cupón" });
    }
});

// OBTENER TODOS LOS CUPONES
cartRouter.get("/api/coupons/all", adminMiddleware, async (req, res) => {
    try {
        const coupons = await Coupon.find().sort({ createdAt: -1 }).limit(500).lean();
        res.status(200).json(coupons);
    } catch (error) {
        console.error(`[${new Date().toISOString()}] ERROR_COUPON_LIST:`, error);
        res.status(500).json({ message: "Error al obtener cupones 🔴" });
    }
});

// ACTIVAR / DESACTIVAR CUPÓN — reactivar un cupón es tan sensible como crearlo: lleva firma
cartRouter.patch("/api/coupons/:id/toggle", adminMiddleware, requireSignPin, async (req, res) => {
    const { id } = req.params;
    if (!isId(id)) return res.status(400).json({ message: "Cupón inválido 🔴" });

    try {
        const coupon = await Coupon.findById(id);
        if (!coupon) return res.status(404).json({ message: "Cupón no encontrado 🔴" });
        coupon.isActive = !coupon.isActive;
        coupon.autoDeactivated = false;   // un cambio manual manda sobre el automático
        await coupon.save();
        res.status(200).json({ message: `Cupón ${coupon.isActive ? "activado" : "desactivado"} 🟢`, coupon });
    } catch (error) {
        console.error(`[${new Date().toISOString()}] ERROR_COUPON_TOGGLE:`, error);
        res.status(500).json({ message: "Error al actualizar el cupón 🔴" });
    }
});

// ELIMINAR CUPÓN
cartRouter.delete("/api/coupons/:id", adminMiddleware, requireSignPin, async (req, res) => {
    const { id } = req.params;
    if (!isId(id)) return res.status(400).json({ message: "Cupón inválido 🔴" });

    try {
        const borrado = await Coupon.findByIdAndDelete(id);
        if (!borrado) return res.status(404).json({ message: "Cupón no encontrado 🔴" });
        res.status(200).json({ message: "Cupón eliminado correctamente 🟢" });
    } catch (error) {
        console.error(`[${new Date().toISOString()}] ERROR_COUPON_DELETE:`, error);
        res.status(500).json({ message: "Error al eliminar el cupón 🔴" });
    }
});

/* ═══════════════════════════════════════════════
   CARRITO
═══════════════════════════════════════════════ */

const sameEmail = (req, email) => normEmail(req.user?.email) === normEmail(email);

// CREAR / SINCRONIZAR CARRITO
// Body: { items: [{ id, cantidad }], merge?: boolean }
// · El email sale del token (si llega uno en el body y no coincide → 403).
// · appliedCoupon del body se IGNORA: solo lo escribe /api/coupons/validate.
// · Los ítems se rearman desde Product (precio, nombre, imagen, stock, SKU, categorías).
cartRouter.post("/api/cart/sync", verifyToken, async (req, res) => {
    const email = normEmail(req.user?.email);
    if (!email) return res.status(401).json({ message: "No autenticado 🔴" });

    const { items, merge } = req.body ?? {};
    if (req.body?.email !== undefined && !sameEmail(req, req.body.email)) {
        return res.status(403).json({ message: "No tenés permiso sobre este carrito 🔴" });
    }
    if (!Array.isArray(items) || items.length > MAX_LINES) {
        return res.status(400).json({ message: "Datos inválidos 🔴" });
    }

    try {
        let raw = items;
        if (merge === true) {
            // login: lo del navegador se suma a lo que ya había en la BD
            const existente = await Cart.findOne({ userEmail: email }).lean();
            raw = [...(existente?.items || []).map(i => ({ id: i.id, cantidad: i.cantidad })), ...items];
        }

        const built = await buildCartItems(raw);

        const update = { $set: { items: built, checked: false } };
        if (built.length === 0) update.$unset = { appliedCoupon: "" };   // carrito vacío = sin cupón

        const guardar = () => Cart.findOneAndUpdate(
            { userEmail: email },
            update,
            { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true }
        );

        let cart;
        try {
            cart = await guardar();
        } catch (err) {
            // dos syncs simultáneos creando el carrito: el segundo choca con el índice único
            if (err?.code === 11000) cart = await guardar();
            else throw err;
        }

        res.status(200).json({ message: "Sincronizado ✅", items: cart.items, appliedCoupon: cuponDeCarrito(cart) });
    } catch (error) {
        if (error instanceof CheckoutError) {
            return res.status(error.status).json({ message: `${error.message} 🔴` });
        }
        console.error(`[${new Date().toISOString()}] ERROR SYNC CART:`, error);
        res.status(500).json({ message: "Error en servidor" });
    }
});

// GET /api/cart/abandoned
cartRouter.get("/api/cart/abandoned", adminMiddleware, async (req, res) => {
    try {
        const horas     = 3;
        const sinceDate = new Date(Date.now() - horas * 60 * 60 * 1000);

        const carts = await Cart.find({ "items.0": { $exists: true }, updatedAt: { $lte: sinceDate } })
            .sort({ updatedAt: -1 })
            .limit(100)
            .lean();

        const cartsConTemp = carts.map(c => {
            const hs = Math.floor((Date.now() - new Date(c.updatedAt).getTime()) / 3600000);
            return { ...c, horasInactivo: hs, temperatura: hs < 3 ? "caliente" : hs < 24 ? "tibio" : "frio" };
        });

        res.json({ carts: cartsConTemp, total: cartsConTemp.length });
    } catch (err) {
        console.error("ERROR GET ABANDONED:", err);
        res.status(500).json({ message: "Error al obtener carritos abandonados" });
    }
});

cartRouter.patch("/api/cart/check/:id", adminMiddleware, async (req, res) => {
    const { id } = req.params;
    if (!isId(id)) return res.status(400).json({ message: "Carrito inválido 🔴" });

    try {
        const r = await Cart.updateOne({ _id: id }, { $set: { checked: true } });
        if (r.matchedCount === 0) return res.status(404).json({ message: "Carrito no encontrado 🔴" });
        res.json({ ok: true });
    } catch (err) {
        console.error("ERROR CHECK CART:", err);
        res.status(500).json({ message: "Error al marcar carrito" });
    }
});

// POST /api/cart/send-recovery
// Body: { email, couponCode? }  (si llega `items` se ignora)
// Productos, precios y total salen del carrito guardado + Product, nunca del body.
cartRouter.post("/api/cart/send-recovery", adminMiddleware, async (req, res) => {
    const email = normEmail(req.body?.email);
    const rawCoupon = req.body?.couponCode;

    if (!EMAIL_RE.test(email)) return res.status(400).json({ message: "Email inválido 🔴" });

    let couponCode = null;
    if (rawCoupon !== undefined && rawCoupon !== null && rawCoupon !== "") {
        if (typeof rawCoupon !== "string" || !CODE_RE.test(rawCoupon.trim())) {
            return res.status(400).json({ message: "Código de cupón inválido 🔴" });
        }
        couponCode = rawCoupon.trim().toUpperCase();
    }

    try {
        const cart = await Cart.findOne({ userEmail: email }).lean();
        if (!cart || !cart.items?.length) {
            return res.status(404).json({ message: "Ese email no tiene un carrito con productos 🔴" });
        }

        // el cupón que se ofrece tiene que existir y estar activo
        if (couponCode) {
            const cupon = await Coupon.findOne({ code: couponCode, isActive: true }).lean();
            if (!cupon) return res.status(400).json({ message: "El cupón no existe o no está activo 🔴" });
        }

        const items = await buildCartItems(cart.items.map(i => ({ id: i.id, cantidad: i.cantidad })));
        if (!items.length) {
            return res.status(409).json({ message: "Ningún producto de ese carrito sigue disponible 🔴" });
        }

        const itemRows = items.map(item => `
        <tr>
          <td style="padding:14px 0;border-bottom:1px solid rgba(255,255,255,0.06);vertical-align:middle;">
            <table role="presentation" cellpadding="0" cellspacing="0">
              <tr>
                <td style="padding-right:14px;vertical-align:middle;">
                  ${/^https:\/\//i.test(item.imagen)
                    ? `<img src="${esc(item.imagen)}" alt="${esc(item.nombre)}" width="52" height="52" style="display:block;object-fit:cover;border:1px solid rgba(232,75,26,0.25);"/>`
                    : `<div style="width:52px;height:52px;background:rgba(232,75,26,0.08);border:1px solid rgba(232,75,26,0.2);"></div>`
                  }
                </td>
                <td style="vertical-align:middle;">
                  <p style="font-family:'Barlow Condensed','Arial Narrow',Arial,sans-serif;font-size:14px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#F0EBE5;margin:0 0 3px;">${esc(item.nombre)}</p>
                  <p style="font-family:'Barlow',Arial,sans-serif;font-size:12px;font-weight:300;color:rgba(240,235,229,0.45);margin:0;">
                    Cant: ${item.cantidad}
                    ${item.varianteLabel ? `· ${esc(item.varianteLabel)}` : ""}
                  </p>
                </td>
              </tr>
            </table>
          </td>
          <td style="padding:14px 0;border-bottom:1px solid rgba(255,255,255,0.06);text-align:right;vertical-align:middle;">
            <p style="font-family:'Barlow Condensed','Arial Narrow',Arial,sans-serif;font-size:16px;font-weight:800;color:#F0EBE5;margin:0;">
              ${eur(item.precio * item.cantidad)}
            </p>
          </td>
        </tr>
    `).join("");

        const totalBruto = items.reduce((acc, i) => acc + i.precio * i.cantidad, 0);

        const couponBlock = couponCode ? `
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
          style="margin-top:24px;background:rgba(232,75,26,0.07);border:1px solid rgba(232,75,26,0.3);">
          <tr>
            <td style="padding:18px 20px;">
              <p style="font-family:'Barlow Condensed','Arial Narrow',Arial,sans-serif;font-size:10px;font-weight:700;letter-spacing:0.28em;text-transform:uppercase;color:#E84B1A;margin:0 0 6px;">CUPÓN EXCLUSIVO PARA TI</p>
              <p style="font-family:'Barlow Condensed','Arial Narrow',Arial,sans-serif;font-size:28px;font-weight:800;letter-spacing:0.1em;color:#ffffff;margin:0;">${esc(couponCode)}</p>
              <p style="font-family:'Barlow',Arial,sans-serif;font-size:12px;font-weight:300;color:rgba(240,235,229,0.5);margin:6px 0 0;">Introdúcelo al finalizar tu compra para obtener tu descuento.</p>
            </td>
            <td style="padding:18px 20px;text-align:right;vertical-align:middle;">
              <div style="width:48px;height:48px;background:rgba(232,75,26,0.15);border:1px solid rgba(232,75,26,0.4);display:inline-block;text-align:center;line-height:48px;font-size:22px;">🎁</div>
            </td>
          </tr>
        </table>
    ` : "";

        const html = `
        <!DOCTYPE html>
        <html lang="es">
        <head>
          <meta charset="UTF-8"/>
          <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
          <title>Completa tu compra — Dekin Hogar</title>
        </head>
        <body style="margin:0;padding:0;background-color:#F2EDE8;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#F2EDE8;padding:40px 16px;">
            <tr><td align="center">
              <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background-color:#1A1614;">
                <tr>
                  <td style="background-color:#E84B1A;padding:32px 40px 28px;">
                    <p style="font-family:'Barlow Condensed','Arial Narrow',Arial,sans-serif;font-size:36px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#fff;line-height:1;margin:0;">DEKIN</p>
                    <p style="font-family:'Barlow',Arial,sans-serif;font-size:10px;font-weight:300;letter-spacing:.42em;text-transform:uppercase;color:rgba(255,255,255,.75);margin:3px 0 0 2px;">HOGAR</p>
                  </td>
                </tr>
                <tr>
                  <td style="background-color:#1A1614;padding:48px 40px 40px;">
                    <p style="font-family:'Barlow Condensed','Arial Narrow',Arial,sans-serif;font-size:32px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;color:#F0EBE5;line-height:1.1;margin:0 0 16px;">
                      Dejaste productos<br/><span style="color:#E84B1A;">en tu carrito</span>
                    </p>
                    <p style="font-family:'Barlow',Arial,sans-serif;font-size:16px;font-weight:300;color:rgba(240,235,229,.7);line-height:1.65;margin:0 0 32px;">
                      Tienes artículos esperándote. El stock es limitado, ¡no pierdas lo que ya elegiste!
                    </p>
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                      ${itemRows}
                      <tr>
                        <td style="padding-top:16px;">
                          <p style="font-family:'Barlow Condensed','Arial Narrow',Arial,sans-serif;font-size:10px;font-weight:700;letter-spacing:.22em;text-transform:uppercase;color:rgba(240,235,229,.35);margin:0;">TOTAL ESTIMADO</p>
                        </td>
                        <td style="padding-top:16px;text-align:right;">
                          <p style="font-family:'Barlow Condensed','Arial Narrow',Arial,sans-serif;font-size:22px;font-weight:800;color:#F0EBE5;margin:0;">${eur(totalBruto)}</p>
                        </td>
                      </tr>
                    </table>
                    ${couponBlock}
                    <table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:32px;">
                      <tr>
                        <td style="background-color:#E84B1A;">
                          <a href="${esc(process.env.FRONTEND_URL || "#")}" style="display:inline-block;padding:14px 32px;font-family:'Barlow Condensed','Arial Narrow',Arial,sans-serif;font-size:13px;font-weight:800;letter-spacing:.18em;text-transform:uppercase;color:#ffffff;text-decoration:none;">
                            COMPLETAR MI COMPRA →
                          </a>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
                <tr>
                  <td style="background-color:#E84B1A;padding:14px 40px;">
                    <p style="font-family:'Barlow',Arial,sans-serif;font-size:10px;font-weight:300;letter-spacing:.08em;color:rgba(255,255,255,.65);margin:0;">
                      © ${new Date().getFullYear()} DEKIN HOGAR · Desarrollado por <a href="https://www.deepdev.com.ar" target="_blank" style="color:rgba(255,255,255,.85);text-decoration:none;font-weight:600;">DeepDev Studio</a>
                    </p>
                  </td>
                </tr>
              </table>
            </td></tr>
          </table>
        </body>
        </html>
    `;

        const transporter = nodemailer.createTransport({
            service: "gmail",
            auth: { user: process.env.EMAIL_FROM, pass: process.env.PASS_EMAIL },
        });

        await transporter.sendMail({
            from:    process.env.EMAIL_FROM,
            to:      email,
            subject: couponCode ? `🛒 Completa tu compra — tienes un cupón exclusivo` : `🛒 Dejaste productos en tu carrito — Dekin Hogar`,
            html,
        });
        res.json({ ok: true, message: "Mail enviado" });
    } catch (err) {
        console.error("ERROR SEND RECOVERY:", err);
        res.status(500).json({ message: "Error al enviar mail 🔴" });   // sin detalles internos
    }
});

// OBTENER CARRITO — precio y stock siempre recalculados desde la DB
cartRouter.get("/api/cart/:email", verifyToken, async (req, res) => {
    const { email } = req.params;
    if (!sameEmail(req, email)) {
        return res.status(403).json({ message: "No tenés permiso sobre este carrito 🔴" });
    }

    try {
        const cart = await Cart.findOne({ userEmail: normEmail(email) }).populate('items.productId');

        if (!cart) {
            return res.status(200).json({ message: "Carrito no encontrado", items: [], appliedCoupon: null });
        }

        const updatedItems = cart.items.map(item => {
            const base = item.toObject();
            const product = item.productId;

            if (!product || product.estado !== "activo") {
                return { ...base, productId: product?._id || null, stockMax: 0, cantidad: 0, alert: "Este producto ya no está disponible" };
            }

            const esVariante = String(item.id) !== String(product._id);
            const variante   = esVariante ? (product.variantes || []).find(v => String(v._id) === String(item.id)) : null;

            if (esVariante && (!variante || variante.activo === false)) {
                return { ...base, productId: product._id, stockMax: 0, cantidad: 0, alert: "Esta opción ya no está disponible" };
            }

            const stock = Math.max(0, Number(variante ? variante.stock : product.stock_base) || 0);
            const { unitCents } = unitPriceCents(product, variante);

            let alert = null;
            let cantidad = item.cantidad;
            if (stock <= 0) {
                alert = "Producto agotado 🔴";
                cantidad = 0;
            } else if (item.cantidad > stock) {
                alert = `Stock reducido a ${stock} unidades ⚠️`;
                cantidad = stock;
            }

            return {
                ...base,
                productId:     product._id,
                varianteId:    variante ? String(variante._id) : null,
                varianteLabel: variantLabel(variante) || base.varianteLabel || "",
                nombre:        product.nombre,
                imagen:        variante?.foto_variante || product.imagenes_generales?.[0] || "",
                precio:        fromCents(unitCents),
                stockMax:      stock,
                skuPadre:      product.sku_padre,
                categorias:    (product.categorias || []).map(c => String(c).toLowerCase()),
                cantidad,
                alert
            };
        });

        res.status(200).json({
            message: "Carrito verificado con éxito 🟢",
            items: updatedItems,
            appliedCoupon: cuponDeCarrito(cart)
        });

    } catch (error) {
        console.error(`[${new Date().toISOString()}] ERROR GET CART:`, error);
        res.status(500).json({ message: "Error al recuperar el carrito 🔴" });
    }
});

// VACIAR CARRITO
cartRouter.delete("/api/cart/clear/:email", verifyToken, async (req, res) => {
    const { email } = req.params;
    try {
        if (!sameEmail(req, email)) {
            return res.status(403).json({ message: "No tienes permiso para vaciar este carrito 🔴" });
        }
        await Cart.findOneAndDelete({ userEmail: normEmail(email) });
        res.status(200).json({ message: "Carrito vaciado correctamente 🟢" });
    } catch (error) {
        console.error(`[${new Date().toISOString()}] ERROR DELETE CART:`, error);
        res.status(500).json({ message: "Error al vaciar el carrito 🔴" });
    }
});

// ⚠️ /api/checkout/success ELIMINADO: descontaba stock y quemaba cupones con datos
// del front y sin autenticación. Ahora lo hace solo el webhook de Stripe.

// RECHECK PRECIOS DB — precios en euros con céntimos (sin redondear a enteros)
cartRouter.post('/api/products/validate-prices', async (req, res) => {
    try {
        const { productIds } = req.body ?? {};
        if (!Array.isArray(productIds) || productIds.length === 0) return res.status(200).json([]);

        const ids = productIds.slice(0, 100).map(String).filter(isId);
        if (!ids.length) return res.status(200).json([]);

        const products = await Product.find({
            estado: "activo",
            $or: [
                { _id: { $in: ids } },
                { "variantes._id": { $in: ids } }
            ]
        }).select('nombre precio_base en_promocion porcentaje_promo stock_base variantes').lean();

        const formatted = ids.map(id => {
            const p = products.find(prod =>
                String(prod._id) === id || (prod.variantes || []).some(v => String(v._id) === id)
            );
            if (!p) return null;

            const variante = (p.variantes || []).find(v => String(v._id) === id) || null;
            if (variante && variante.activo === false) return null;

            const { listCents, unitCents } = unitPriceCents(p, variante);
            return {
                productId:     id,
                precio:        fromCents(unitCents),
                precioLista:   fromCents(listCents),
                precioCents:   unitCents,
                stockMax:      variante ? (variante.stock || 0) : (p.stock_base || 0),
                varianteLabel: variantLabel(variante),
            };
        }).filter(Boolean);

        res.status(200).json(formatted);
    } catch (error) {
        console.error(`[${new Date().toISOString()}] ERROR VALIDATE PRECIOS:`, error);
        res.status(500).json({ message: "Error al validar precios" });
    }
});

module.exports = cartRouter;