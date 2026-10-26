const express = require('express');
const cartRouter = express.Router();
const Coupon  = require("../models/CouponSchema");
const Cart    = require("../models/CartSchema");
const Product = require("../models/productModel");
const mongoose = require('mongoose');
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

const parseDay = (str, endOfDay) => {
    if (typeof str !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(str)) return null;
    const d = new Date(`${str}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`);
    return isNaN(d.getTime()) ? null : d;
};

/* ═══════════════════════════════════════════════
   CUPONES
═══════════════════════════════════════════════ */

// CREAR NUEVO CUPÓN
// couponData: { code, discount, type, description?, startDate?, expiryDate?, maxUses?,
//               onePerUser?, minPurchase?, scope?, allowedProducts?, allowedCategories? }
cartRouter.post("/api/coupons/create", adminMiddleware, requireSignPin, async (req, res) => {
    const { couponData } = req.body;

    if (!couponData || typeof couponData !== 'object') {
        return res.status(400).json({ message: "Datos de cupón no proporcionados o formato inválido 🔴" });
    }

    const { code, discount, type, description, startDate, expiryDate, maxUses, onePerUser, minPurchase, scope, allowedProducts, allowedCategories } = couponData;

    if (!code || !discount || !type) {
        return res.status(400).json({ message: "Faltan campos obligatorios: code, discount y type son requeridos 🔴" });
    }
    if (typeof code !== 'string' || typeof type !== 'string') {
        return res.status(400).json({ message: "code y type deben ser strings 🔴" });
    }
    if (!/^[A-Za-z0-9_-]{3,30}$/.test(code.trim())) {
        return res.status(400).json({ message: "El código debe tener 3 a 30 caracteres (letras, números, - o _) 🔴" });
    }

    const discountNum = Number(discount);
    if (isNaN(discountNum) || discountNum < 1 || discountNum > 100) {
        return res.status(400).json({ message: "El descuento debe ser un número entre 1 y 100 🔴" });
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
        if (!Number.isInteger(n) || n < 1) return res.status(400).json({ message: "maxUses debe ser un entero >= 1 🔴" });
        maxUsesFinal = n;
    }
    if (type === 'limited_uses' && maxUsesFinal === null) {
        return res.status(400).json({ message: "Los cupones con límite de usos requieren maxUses 🔴" });
    }

    const minPurchaseNum = minPurchase ? Number(minPurchase) : 0;
    if (isNaN(minPurchaseNum) || minPurchaseNum < 0) return res.status(400).json({ message: "minPurchase debe ser un número >= 0 🔴" });

    const validScopes = ['all', 'products', 'categories'];
    const finalScope = scope || 'all';
    if (!validScopes.includes(finalScope)) {
        return res.status(400).json({ message: "Scope inválido. Use 'all', 'products' o 'categories' 🔴" });
    }
    if (finalScope === 'products') {
        if (!Array.isArray(allowedProducts) || allowedProducts.length === 0 || !allowedProducts.every(s => typeof s === 'string' && s.trim() !== '')) {
            return res.status(400).json({ message: "Debés especificar al menos un SKU (padre o de variante) válido 🔴" });
        }
    }
    if (finalScope === 'categories') {
        if (!Array.isArray(allowedCategories) || allowedCategories.length === 0 || !allowedCategories.every(c => typeof c === 'string' && c.trim() !== '')) {
            return res.status(400).json({ message: "Debés especificar al menos una categoría válida 🔴" });
        }
    }

    try {
        const sanitizedCode = code.trim().toUpperCase();
        const exists = await Coupon.findOne({ code: sanitizedCode });
        if (exists) return res.status(409).json({ message: "El código de cupón ya existe en el sistema 🔴" });

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
        console.error(`[${new Date().toISOString()}] ERROR_COUPON_CREATE:`, error);
        res.status(500).json({ message: "Error interno al procesar el cupón 🔴" });
    }
});

// VALIDAR CUPÓN — vista previa con la misma cotización que se usa para cobrar.
// El email sale del token (no del body) para que nadie use cupones "de un solo uso por persona" ajenos.
cartRouter.post("/api/coupons/validate", verifyToken, async (req, res) => {
    const { code, cartItems, shippingMode } = req.body;
    const email = req.user?.email?.toLowerCase();

    if (!code || typeof code !== 'string' || !code.trim()) {
        return res.status(400).json({ message: "El código debe ser un string 🔴" });
    }
    if (!email) return res.status(401).json({ message: "No autenticado 🔴" });
    if (!Array.isArray(cartItems) || cartItems.length === 0) {
        return res.status(400).json({ message: "Agregá productos al carrito antes de aplicar un cupón 🔴" });
    }

    try {
        const quote = await buildQuote({
            items: cartItemsToQuoteItems(cartItems),
            couponCode: code,
            email,
            shippingMode,
        });
        const coupon = await Coupon.findOne({ code: quote.coupon.code }).lean();

        res.status(200).json({
            message: "Cupón aplicado con éxito 🟢",
            coupon: {
                code:              coupon.code,
                discount:          coupon.discount,
                type:              coupon.type,
                scope:             coupon.scope,
                allowedProducts:   coupon.allowedProducts,
                allowedCategories: coupon.allowedCategories,
                expiryDate:        coupon.expiryDate,
                minPurchase:       coupon.minPurchase,
            },
            preview: publicQuote(quote),
        });
    } catch (error) {
        if (error instanceof CheckoutError) {
            return res.status(error.status === 409 ? 409 : 400).json({ message: `${error.message} 🔴`, code: error.code });
        }
        console.error(`[${new Date().toISOString()}] ERROR en validar cupón:`, error);
        res.status(500).json({ message: "Error interno al validar cupón" });
    }
});

// OBTENER TODOS LOS CUPONES
cartRouter.get("/api/coupons/all", adminMiddleware, async (req, res) => {
    try {
        const coupons = await Coupon.find().sort({ createdAt: -1 });
        res.status(200).json(coupons);
    } catch (error) {
        res.status(500).json({ message: "Error al obtener cupones 🔴" });
    }
});

// ACTIVAR / DESACTIVAR CUPÓN
cartRouter.patch("/api/coupons/:id/toggle", adminMiddleware, async (req, res) => {
    try {
        const coupon = await Coupon.findById(req.params.id);
        if (!coupon) return res.status(404).json({ message: "Cupón no encontrado 🔴" });
        coupon.isActive = !coupon.isActive;
        coupon.autoDeactivated = false;   // un cambio manual manda sobre el automático
        await coupon.save();
        res.status(200).json({ message: `Cupón ${coupon.isActive ? "activado" : "desactivado"} 🟢`, coupon });
    } catch (error) {
        res.status(500).json({ message: "Error al actualizar el cupón 🔴" });
    }
});

// ELIMINAR CUPÓN
cartRouter.delete("/api/coupons/:id", adminMiddleware, requireSignPin, async (req, res) => {
    try {
        await Coupon.findByIdAndDelete(req.params.id);
        res.status(200).json({ message: "Cupón eliminado correctamente 🟢" });
    } catch (error) {
        res.status(500).json({ message: "Error al eliminar el cupón 🔴" });
    }
});

/* ═══════════════════════════════════════════════
   CARRITO
═══════════════════════════════════════════════ */

const sameEmail = (req, email) => req.user?.email?.toLowerCase() === String(email || "").trim().toLowerCase();

// CREAR / SINCRONIZAR CARRITO
cartRouter.post("/api/cart/sync", verifyToken, async (req, res) => {
    const { email, items, appliedCoupon, merge = false } = req.body;
    const sanitizedEmail = email?.trim().toLowerCase();

    if (!sanitizedEmail || !Array.isArray(items)) {
        return res.status(400).json({ message: "Datos inválidos 🔴" });
    }
    if (!sameEmail(req, sanitizedEmail)) {
        return res.status(403).json({ message: "No tenés permiso sobre este carrito 🔴" });
    }

    try {
        let existingCart = await Cart.findOne({ userEmail: sanitizedEmail });

        if (!existingCart) {
            existingCart = new Cart({ userEmail: sanitizedEmail, items, appliedCoupon });
        } else {
            if (merge) {
                items.forEach(newItem => {
                    // se compara por id de variante/producto: dos colores del mismo producto son líneas distintas
                    const idx = existingCart.items.findIndex(i => String(i.id) === String(newItem.id));
                    if (idx > -1) {
                        existingCart.items[idx].cantidad += Number(newItem.cantidad) || 0;
                    } else {
                        existingCart.items.push(newItem);
                    }
                });
            } else {
                existingCart.items = items;
            }
            if (appliedCoupon) existingCart.appliedCoupon = appliedCoupon;
        }

        existingCart.checked = false;
        await existingCart.save();
        res.status(200).json({ message: "Sincronizado ✅", items: existingCart.items });
    } catch (error) {
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
    try {
        await Cart.findByIdAndUpdate(req.params.id, { checked: true });
        res.json({ ok: true });
    } catch (err) {
        console.error("ERROR CHECK CART:", err);
        res.status(500).json({ message: "Error al marcar carrito" });
    }
});

// POST /api/cart/send-recovery
cartRouter.post("/api/cart/send-recovery", adminMiddleware, async (req, res) => {
    const { email, items, couponCode } = req.body;

    if (!email || !Array.isArray(items) || items.length === 0)
        return res.status(400).json({ message: "email e items son requeridos" });

    const transporter = nodemailer.createTransport({
        service: "gmail",
        auth: { user: process.env.EMAIL_FROM, pass: process.env.PASS_EMAIL },
    });

    const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    const eur = (n) => Number(n || 0).toLocaleString("es-ES", { style: "currency", currency: "EUR" });

    const itemRows = items.map(item => `
        <tr>
          <td style="padding:14px 0;border-bottom:1px solid rgba(255,255,255,0.06);vertical-align:middle;">
            <table role="presentation" cellpadding="0" cellspacing="0">
              <tr>
                <td style="padding-right:14px;vertical-align:middle;">
                  ${item.imagen
                    ? `<img src="${esc(item.imagen)}" alt="${esc(item.nombre)}" width="52" height="52" style="display:block;object-fit:cover;border:1px solid rgba(232,75,26,0.25);"/>`
                    : `<div style="width:52px;height:52px;background:rgba(232,75,26,0.08);border:1px solid rgba(232,75,26,0.2);"></div>`
                  }
                </td>
                <td style="vertical-align:middle;">
                  <p style="font-family:'Barlow Condensed','Arial Narrow',Arial,sans-serif;font-size:14px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#F0EBE5;margin:0 0 3px;">${esc(item.nombre)}</p>
                  <p style="font-family:'Barlow',Arial,sans-serif;font-size:12px;font-weight:300;color:rgba(240,235,229,0.45);margin:0;">
                    Cant: ${Number(item.cantidad) || 1}
                    ${item.varianteLabel ? `· ${esc(item.varianteLabel)}` : ""}
                    ${!item.varianteLabel && item.talle ? `· Talle: ${esc(item.talle)}` : ""}
                    ${!item.varianteLabel && item.color ? `· Color: ${esc(item.color)}` : ""}
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

    const totalBruto = items.reduce((acc, i) => acc + (Number(i.precio) || 0) * (Number(i.cantidad) || 0), 0);

    const couponBlock = couponCode ? `
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
          style="margin-top:24px;background:rgba(232,75,26,0.07);border:1px solid rgba(232,75,26,0.3);">
          <tr>
            <td style="padding:18px 20px;">
              <p style="font-family:'Barlow Condensed','Arial Narrow',Arial,sans-serif;font-size:10px;font-weight:700;letter-spacing:0.28em;text-transform:uppercase;color:#E84B1A;margin:0 0 6px;">CUPÓN EXCLUSIVO PARA TI</p>
              <p style="font-family:'Barlow Condensed','Arial Narrow',Arial,sans-serif;font-size:28px;font-weight:800;letter-spacing:0.1em;color:#ffffff;margin:0;">${esc(couponCode.toUpperCase())}</p>
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
                          <a href="${process.env.FRONTEND_URL || "#"}" style="display:inline-block;padding:14px 32px;font-family:'Barlow Condensed','Arial Narrow',Arial,sans-serif;font-size:13px;font-weight:800;letter-spacing:.18em;text-transform:uppercase;color:#ffffff;text-decoration:none;">
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

    try {
        await transporter.sendMail({
            from:    process.env.EMAIL_FROM,
            to:      email,
            subject: couponCode ? `🛒 Completa tu compra — tienes un cupón exclusivo` : `🛒 Dejaste productos en tu carrito — Dekin Hogar`,
            html,
        });
        res.json({ ok: true, message: "Mail enviado" });
    } catch (err) {
        console.error("ERROR SEND RECOVERY:", err);
        res.status(500).json({ message: "Error al enviar mail", detail: err.message });
    }
});

// OBTENER CARRITO — precio y stock siempre recalculados desde la DB
cartRouter.get("/api/cart/:email", verifyToken, async (req, res) => {
    const { email } = req.params;
    if (!sameEmail(req, email)) {
        return res.status(403).json({ message: "No tenés permiso sobre este carrito 🔴" });
    }

    try {
        const cart = await Cart.findOne({ userEmail: email.toLowerCase() }).populate('items.productId');

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
            const variante   = esVariante ? product.variantes.find(v => String(v._id) === String(item.id)) : null;

            if (esVariante && (!variante || variante.activo === false)) {
                return { ...base, productId: product._id, stockMax: 0, cantidad: 0, alert: "Esta opción ya no está disponible" };
            }

            const stock = variante ? variante.stock : product.stock_base;
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
                precio:        fromCents(unitCents),
                stockMax:      stock,
                skuPadre:      product.sku_padre,
                categorias:    product.categorias,
                cantidad,
                alert
            };
        });

        res.status(200).json({
            message: "Carrito verificado con éxito 🟢",
            items: updatedItems,
            appliedCoupon: cart.appliedCoupon || null
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
        await Cart.findOneAndDelete({ userEmail: email.toLowerCase() });
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
        const { productIds } = req.body;
        if (!Array.isArray(productIds) || productIds.length === 0) return res.status(200).json([]);

        const ids = productIds.map(String).filter(id => mongoose.Types.ObjectId.isValid(id)).slice(0, 100);

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