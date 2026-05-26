const express = require('express');
const cartRouter = express.Router();
const Coupon  = require("../models/CouponSchema");
const Cart    = require("../models/CartSchema");
const Product = require("../models/productModel");
const mongoose = require('mongoose');
const verifyToken    = require('../middleware/authMiddleware');
const adminMiddleware = require('../middleware/adminMiddleware');
const nodemailer = require("nodemailer")

const esProduccion = (process.env.NODE_ENV === 'production');

// CREAR NUEVO CUPÓN
cartRouter.post("/api/coupons/create", adminMiddleware, async (req, res) => {
    const { couponData } = req.body;
 
    if (!couponData || typeof couponData !== 'object') {
        return res.status(400).json({ message: "Datos de cupón no proporcionados o formato inválido 🔴" });
    }
 
    const { code, discount, type, expiryDate, maxUses, scope, allowedProducts, allowedCategories } = couponData;
 
    // campos obligatorios base
    if (!code || !discount || !type) {
        return res.status(400).json({ message: "Faltan campos obligatorios: code, discount y type son requeridos 🔴" });
    }
 
    // tipos de dato correctos
    if (typeof code !== 'string' || typeof type !== 'string') {
        return res.status(400).json({ message: "code y type deben ser strings 🔴" });
    }
 
    const discountNum = Number(discount);
    if (isNaN(discountNum) || discountNum <= 0 || discountNum > 100) {
        return res.status(400).json({ message: "El descuento debe ser un número entre 1 y 100 🔴" });
    }
 
    const validTypes = ['single_use', 'date_limited', 'limited_uses'];
    if (!validTypes.includes(type)) {
        return res.status(400).json({ message: "Tipo de cupón inválido 🔴" });
    }
 
    // validaciones por tipo
    if (type === 'date_limited') {
        if (!expiryDate || typeof expiryDate !== 'string') {
            return res.status(400).json({ message: "Los cupones por fecha requieren una 'expiryDate' string 🔴" });
        }
        const date = new Date(expiryDate + "T23:59:59.000Z");
        if (isNaN(date.getTime()) || date <= new Date()) {
            return res.status(400).json({ message: "La fecha de expiración debe ser una fecha válida y futura 🔴" });
        }
    }
 
    if (type === 'limited_uses') {
        const maxUsesNum = Number(maxUses);
        if (!maxUses || isNaN(maxUsesNum) || !Number.isInteger(maxUsesNum) || maxUsesNum < 1) {
            return res.status(400).json({ message: "Los cupones con límite de usos requieren un maxUses entero >= 1 🔴" });
        }
    }
 
    // validaciones de scope
    const validScopes = ['all', 'products', 'categories'];
    const finalScope = scope || 'all';
    if (!validScopes.includes(finalScope)) {
        return res.status(400).json({ message: "Scope inválido. Use 'all', 'products' o 'categories' 🔴" });
    }
 
    if (finalScope === 'products') {
        if (!Array.isArray(allowedProducts) || allowedProducts.length === 0) {
            return res.status(400).json({ message: "Debés especificar al menos un SKU de producto 🔴" });
        }
        if (!allowedProducts.every(s => typeof s === 'string' && s.trim() !== '')) {
            return res.status(400).json({ message: "allowedProducts debe ser un array de strings no vacíos 🔴" });
        }
    }
 
    if (finalScope === 'categories') {
        if (!Array.isArray(allowedCategories) || allowedCategories.length === 0) {
            return res.status(400).json({ message: "Debés especificar al menos una categoría 🔴" });
        }
        if (!allowedCategories.every(c => typeof c === 'string' && c.trim() !== '')) {
            return res.status(400).json({ message: "allowedCategories debe ser un array de strings no vacíos 🔴" });
        }
    }
 
    try {
        const sanitizedCode = code.trim().toUpperCase();
 
        const exists = await Coupon.findOne({ code: sanitizedCode });
        if (exists) {
            return res.status(409).json({ message: "El código de cupón ya existe en el sistema 🔴" });
        }
 
        const newCoupon = await Coupon.create({
            code:       sanitizedCode,
            discount:   discountNum,
            type,
            expiryDate: type === 'date_limited' ? new Date(expiryDate + "T23:59:59.000Z") : null,
            maxUses:    type === 'limited_uses'  ? Number(maxUses) : null,
            usesCount:  0,
            scope:      finalScope,
            allowedProducts:   finalScope === 'products'   ? allowedProducts.map(s => s.trim().toUpperCase())   : [],
            allowedCategories: finalScope === 'categories' ? allowedCategories.map(c => c.trim().toLowerCase()) : [],
            isActive: true,
            usedBy:   []
        });
 
        res.status(201).json({ message: "Cupón creado con éxito 🟢", coupon: newCoupon });
 
    } catch (error) {
        console.error(`[${new Date().toISOString()}] ERROR_COUPON_CREATE:`, error);
        res.status(500).json({ message: "Error interno al procesar el cupón 🔴" });
    }
});


// VALIDAR CUPÓN
cartRouter.post("/api/coupons/validate", verifyToken, async (req, res) => {
    const { code, email, cartItems } = req.body;
    console.log(`Validando cupón: code=${code}, email=${email}, cartItemsCount=${Array.isArray(cartItems) ? cartItems.length : 0}`);
 
    // validar tipos de entrada
    if (!code || typeof code !== 'string') {
        return res.status(400).json({ message: "El código debe ser un string 🔴" });
    }
    if (!email || typeof email !== 'string') {
        return res.status(400).json({ message: "El email debe ser un string 🔴" });
    }
 
    const sanitizedCode  = code.trim().toUpperCase();
    const sanitizedEmail = email.trim().toLowerCase();
 
    if (!sanitizedCode || !sanitizedEmail) {
        return res.status(400).json({ message: "Código y email son requeridos 🔴" });
    }
 
    try {
        const coupon = await Coupon.findOne({ code: sanitizedCode, isActive: true });
 
        if (!coupon) {
            return res.status(404).json({ message: "Cupón no encontrado o inactivo 🔴" });
        }
 
        if (coupon.type === 'date_limited' && coupon.expiryDate < new Date()) {
            return res.status(400).json({ message: "El cupón ha expirado ⚠️" });
        }
 
        if (coupon.type === 'single_use' && coupon.usedBy.includes(sanitizedEmail)) {
            return res.status(400).json({ message: "Ya has utilizado este cupón 🔴" });
        }
 
        if (coupon.type === 'limited_uses') {
            if (coupon.maxUses !== null && coupon.usesCount >= coupon.maxUses) {
                return res.status(400).json({ message: "Este cupón ya alcanzó su límite de usos ⚠️" });
            }
        }
 
        // chequeo de scope
        if (coupon.scope !== 'all') {
            if (!Array.isArray(cartItems) || cartItems.length === 0) {
                return res.status(400).json({
                    message: "Este cupón aplica solo a productos específicos. Agregá productos al carrito primero 🔴"
                });
            }
 
            const aplica = cartItems.some(item => {
                if (coupon.scope === 'products') {
                    const itemSku   = item.skuPadre?.toString().trim().toUpperCase();
                    const resultado = coupon.allowedProducts.includes(itemSku);
                    console.log(`SKU item: "${itemSku}" | allowedProducts: ${JSON.stringify(coupon.allowedProducts)} | match: ${resultado}`);
                    return resultado;
                }
                if (coupon.scope === 'categories') {
                    if (!Array.isArray(item.categorias)) return false;
                    return item.categorias.some(cat =>
                        typeof cat === 'string' &&
                        coupon.allowedCategories.includes(cat.toLowerCase())
                    );
                }
                return true;
            });
 
            if (!aplica) {
                return res.status(400).json({
                    message: "Este cupón no aplica a ninguno de los productos en tu carrito 🔴"
                });
            }
        }
 
        res.status(200).json({
            message: "Cupón aplicado con éxito 🟢",
            coupon: {
                code:              coupon.code,
                discount:          coupon.discount,
                type:              coupon.type,
                scope:             coupon.scope,
                allowedProducts:   coupon.allowedProducts,
                allowedCategories: coupon.allowedCategories
            }
        });
 
    } catch (error) {
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

// ELIMINAR CUPÓN
cartRouter.delete("/api/coupons/:id", adminMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        await Coupon.findByIdAndDelete(id);
        res.status(200).json({ message: "Cupón eliminado correctamente 🟢" });
    } catch (error) {
        res.status(500).json({ message: "Error al eliminar el cupón 🔴" });
    }
});

/* ═══════════════════════════════════════════════
   CARRITO
═══════════════════════════════════════════════ */

// CREAR / SINCRONIZAR CARRITO
cartRouter.post("/api/cart/sync", verifyToken, async (req, res) => {
    const { email, items, appliedCoupon, merge = false } = req.body;

    const sanitizedEmail = email?.trim().toLowerCase();

    if (!sanitizedEmail || !Array.isArray(items)) {
        return res.status(400).json({ message: "Datos inválidos 🔴" });
    }

    try {
        let existingCart = await Cart.findOne({ userEmail: sanitizedEmail });

        if (!existingCart) {
            existingCart = new Cart({ userEmail: sanitizedEmail, items, appliedCoupon });
        } else {
            if (merge) {
                items.forEach(newItem => {
                    const idx = existingCart.items.findIndex(i =>
                        i.productId.toString() === newItem.productId.toString()
                    );
                    if (idx > -1) {
                        existingCart.items[idx].quantity += newItem.quantity;
                    } else {
                        existingCart.items.push(newItem);
                    }
                });
            } else {
                existingCart.items = items;
            }
            if (appliedCoupon) existingCart.appliedCoupon = appliedCoupon;
        }

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
        const horas     = 3 /* Math.max(parseInt(req.query.horas) || 1, 0) */;
        const sinceMs   = Date.now() - horas * 60 * 60 * 1000;
        const sinceDate = new Date(sinceMs);

        console.log("🔍 Buscando carritos anteriores a:", sinceDate.toISOString());
        console.log("🕐 Horas umbral:", horas);

        const query = horas === 0
            ? { "items.0": { $exists: true } }
            : { "items.0": { $exists: true }, updatedAt: { $lte: sinceDate } };

        const carts = await Cart.find(query)
            .sort({ updatedAt: -1 })
            .limit(100)
            .lean();

        console.log("🛒 Carritos encontrados:", carts.length);

        const cartsConTemp = carts.map(c => {
            const hs = Math.floor((Date.now() - new Date(c.updatedAt).getTime()) / 3600000);
            return {
                ...c,
                horasInactivo: hs,
                temperatura: hs < 3 ? "caliente" : hs < 24 ? "tibio" : "frio",
            };
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

    const itemRows = items.map(item => `
        <tr>
          <td style="padding:14px 0;border-bottom:1px solid rgba(255,255,255,0.06);vertical-align:middle;">
            <table role="presentation" cellpadding="0" cellspacing="0">
              <tr>
                <td style="padding-right:14px;vertical-align:middle;">
                  ${item.imagen
                    ? `<img src="${item.imagen}" alt="${item.nombre}" width="52" height="52" style="display:block;object-fit:cover;border:1px solid rgba(232,75,26,0.25);"/>`
                    : `<div style="width:52px;height:52px;background:rgba(232,75,26,0.08);border:1px solid rgba(232,75,26,0.2);"></div>`
                  }
                </td>
                <td style="vertical-align:middle;">
                  <p style="font-family:'Barlow Condensed','Arial Narrow',Arial,sans-serif;font-size:14px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#F0EBE5;margin:0 0 3px;">${item.nombre}</p>
                  <p style="font-family:'Barlow',Arial,sans-serif;font-size:12px;font-weight:300;color:rgba(240,235,229,0.45);margin:0;">
                    Cant: ${item.cantidad}
                    ${item.talle ? `· Talle: ${item.talle}` : ""}
                    ${item.color ? `· Color: ${item.color}` : ""}
                  </p>
                </td>
              </tr>
            </table>
          </td>
          <td style="padding:14px 0;border-bottom:1px solid rgba(255,255,255,0.06);text-align:right;vertical-align:middle;">
            <p style="font-family:'Barlow Condensed','Arial Narrow',Arial,sans-serif;font-size:16px;font-weight:800;color:#F0EBE5;margin:0;">
              $${Math.round(item.precio * item.cantidad).toLocaleString("es-AR")}
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
              <p style="font-family:'Barlow Condensed','Arial Narrow',Arial,sans-serif;font-size:10px;font-weight:700;letter-spacing:0.28em;text-transform:uppercase;color:#E84B1A;margin:0 0 6px;">CUPÓN EXCLUSIVO PARA VOS</p>
              <p style="font-family:'Barlow Condensed','Arial Narrow',Arial,sans-serif;font-size:28px;font-weight:800;letter-spacing:0.1em;color:#ffffff;margin:0;">${couponCode.toUpperCase()}</p>
              <p style="font-family:'Barlow',Arial,sans-serif;font-size:12px;font-weight:300;color:rgba(240,235,229,0.5);margin:6px 0 0;">Ingresalo al finalizar tu compra para obtener tu descuento.</p>
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
          <title>Completá tu compra — Dekin Hogar</title>
          <style>
            @import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@700;800&family=Barlow:wght@300;400;500&display=swap');
            * { box-sizing:border-box; margin:0; padding:0; }
            body { background-color:#F2EDE8; font-family:'Barlow',Georgia,sans-serif; }
          </style>
        </head>
        <body style="margin:0;padding:0;background-color:#F2EDE8;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#F2EDE8;padding:40px 16px;">
            <tr><td align="center">
              <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background-color:#1A1614;">

                <tr>
                  <td style="background-color:#E84B1A;padding:0;">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                      <tr><td style="height:4px;background:repeating-linear-gradient(90deg,#fff 0,#fff 6px,transparent 6px,transparent 14px);opacity:.18;"></td></tr>
                    </table>
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                      <tr><td style="padding:32px 40px 28px;">
                        <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
                          <tr>
                            <td>
                              <p style="font-family:'Barlow Condensed','Arial Narrow',Arial,sans-serif;font-size:36px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#fff;line-height:1;margin:0;">DEKIN</p>
                              <p style="font-family:'Barlow',Arial,sans-serif;font-size:10px;font-weight:300;letter-spacing:.42em;text-transform:uppercase;color:rgba(255,255,255,.75);margin:3px 0 0 2px;">HOGAR</p>
                            </td>
                            <td style="text-align:right;vertical-align:bottom;padding-bottom:2px;">
                              <p style="font-family:'Barlow Condensed','Arial Narrow',Arial,sans-serif;font-size:11px;font-weight:700;letter-spacing:.22em;text-transform:uppercase;color:rgba(255,255,255,.55);margin:0;">OLVIDASTE ALGO</p>
                            </td>
                          </tr>
                        </table>
                      </td></tr>
                    </table>
                  </td>
                </tr>

                <tr>
                  <td style="background-color:#1A1614;padding:48px 40px 40px;">
                    <table role="presentation" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
                      <tr>
                        <td><div style="width:56px;height:56px;background:rgba(232,75,26,.12);border:1px solid rgba(232,75,26,.3);display:inline-block;text-align:center;line-height:56px;font-size:26px;">🛒</div></td>
                        <td style="padding-left:14px;vertical-align:middle;">
                          <p style="font-family:'Barlow Condensed','Arial Narrow',Arial,sans-serif;font-size:10px;font-weight:700;letter-spacing:.28em;text-transform:uppercase;background:rgba(232,75,26,.1);color:#E84B1A;border:1px solid rgba(232,75,26,.3);display:inline-block;padding:4px 12px;margin:0;">CARRITO PENDIENTE</p>
                        </td>
                      </tr>
                    </table>

                    <p style="font-family:'Barlow Condensed','Arial Narrow',Arial,sans-serif;font-size:32px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;color:#F0EBE5;line-height:1.1;margin:0 0 16px;">
                      Dejaste productos<br/><span style="color:#E84B1A;">en tu carrito</span>
                    </p>
                    <p style="font-family:'Barlow',Arial,sans-serif;font-size:16px;font-weight:300;color:rgba(240,235,229,.7);line-height:1.65;margin:0 0 32px;">
                      Notamos que tenés artículos esperándote. El stock es limitado, ¡no pierdas lo que ya elegiste!
                    </p>

                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
                      <tr><td style="border-top:1px solid rgba(255,255,255,.07);"></td></tr>
                    </table>

                    <p style="font-family:'Barlow Condensed','Arial Narrow',Arial,sans-serif;font-size:10px;font-weight:700;letter-spacing:.22em;text-transform:uppercase;color:rgba(240,235,229,.35);margin:0 0 8px;padding-left:6px;border-left:2px solid #E84B1A;">TUS PRODUCTOS</p>

                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                      ${itemRows}
                      <tr>
                        <td style="padding-top:16px;">
                          <p style="font-family:'Barlow Condensed','Arial Narrow',Arial,sans-serif;font-size:10px;font-weight:700;letter-spacing:.22em;text-transform:uppercase;color:rgba(240,235,229,.35);margin:0;">TOTAL ESTIMADO</p>
                        </td>
                        <td style="padding-top:16px;text-align:right;">
                          <p style="font-family:'Barlow Condensed','Arial Narrow',Arial,sans-serif;font-size:22px;font-weight:800;color:#F0EBE5;margin:0;">
                            $${Math.round(totalBruto).toLocaleString("es-AR")}
                          </p>
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
                  <td style="background-color:#F2EDE8;padding:32px 40px;">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                      <tr>
                        <td style="vertical-align:middle;">
                          <p style="font-family:'Barlow Condensed','Arial Narrow',Arial,sans-serif;font-size:18px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#1A1614;margin:0 0 2px;">DEKIN HOGAR</p>
                          <p style="font-family:'Barlow',Arial,sans-serif;font-size:12px;font-weight:300;letter-spacing:.2em;text-transform:uppercase;color:rgba(26,22,20,.4);margin:0;">Diseño · Calidad · Confianza</p>
                        </td>
                        <td style="text-align:right;vertical-align:middle;">
                          <p style="font-family:'Barlow',Arial,sans-serif;font-size:11px;color:rgba(26,22,20,.35);margin:0;line-height:1.6;">Este es un mensaje automático.<br/>Por favor no respondas a esta dirección.</p>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>

                <tr>
                  <td style="background-color:#E84B1A;padding:14px 40px;">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                      <tr>
                        <td><p style="font-family:'Barlow Condensed','Arial Narrow',Arial,sans-serif;font-size:10px;font-weight:700;letter-spacing:.22em;text-transform:uppercase;color:rgba(255,255,255,.65);margin:0;">© ${new Date().getFullYear()} DEKIN HOGAR · TODOS LOS DERECHOS RESERVADOS</p></td>
                        <td style="text-align:right;"><p style="font-family:'Barlow Condensed','Arial Narrow',Arial,sans-serif;font-size:10px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:rgba(255,255,255,.65);margin:0;">ARGENTINA</p></td>
                      </tr>
                      <tr>
                        <td colspan="2" style="padding-top:8px;border-top:1px solid rgba(255,255,255,.2);">
                          <p style="font-family:'Barlow',Arial,sans-serif;font-size:10px;font-weight:300;letter-spacing:.08em;color:rgba(255,255,255,.5);margin:0;padding-top:8px;">
                            Desarrollado por <a href="https://www.deepdev.com.ar" target="_blank" style="color:rgba(255,255,255,.85);text-decoration:none;font-weight:600;border-bottom:1px solid rgba(255,255,255,.35);">DeepDev Studio</a>
                          </p>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>

              </table>

              <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;margin-top:20px;">
                <tr><td>
                  <p style="font-family:'Barlow',Arial,sans-serif;font-size:11px;font-weight:300;color:rgba(26,22,20,.4);text-align:center;line-height:1.6;margin:0;">
                    Recibiste este correo porque tenés un carrito activo en Dekin Hogar.<br/>
                    Si no reconocés esta actividad, por favor ignoralo.
                  </p>
                </td></tr>
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
            subject: couponCode
                ? `🛒 Completá tu compra — tenés un cupón exclusivo`
                : `🛒 Dejaste productos en tu carrito — Dekin Hogar`,
            html,
        });
        res.json({ ok: true, message: "Mail enviado" });
    } catch (err) {
        console.error("ERROR SEND RECOVERY:", err);
        res.status(500).json({ message: "Error al enviar mail", detail: err.message });
    }
});

// OBTENER CARRITO
cartRouter.get("/api/cart/:email", verifyToken, async (req, res) => {
    const { email } = req.params;

    try {
        const cart = await Cart.findOne({ userEmail: email.toLowerCase() }).populate('items.productId');

        if (!cart) {
            return res.status(200).json({ message: "Carrito no encontrado", items: [], appliedCoupon: null });
        }

        const couponToReturn = cart.appliedCoupon || null;

        const updatedItems = cart.items.map(item => {
            const realProduct = item.productId;
            let alert = null;
            let currentQuantity = item.cantidad;

            if (!realProduct) {
                alert = "Este producto ya no está disponible";
                return { ...item._doc, stockMax: 0, alert };
            }

            if (realProduct.stock <= 0) {
                alert = "Producto agotado 🔴";
                currentQuantity = 0;
            } else if (item.cantidad > realProduct.stock) {
                alert = `Stock reducido a ${realProduct.stock} unidades ⚠️`;
                currentQuantity = realProduct.stock;
            }

            return {
                ...item._doc,
                productId:  realProduct._id,
                nombre:     realProduct.nombre || item.nombre,
                precio:     realProduct.precio  || item.precio,
                stockMax:   realProduct.stock,
                cantidad:   currentQuantity,
                alert
            };
        });

        res.status(200).json({
            message: "Carrito verificado con éxito 🟢",
            items: updatedItems,
            appliedCoupon: couponToReturn
        });

    } catch (error) {
        console.error(`[${new Date().toISOString()}] ERROR GET CART:`, error);
        res.status(500).json({ message: "Error al recuperar el carrito 🔴", error: error.message });
    }
});

// VACIAR CARRITO
cartRouter.delete("/api/cart/clear/:email", verifyToken, async (req, res) => {
    const { email } = req.params;
    try {
        if (req.user.email !== email) {
            return res.status(403).json({ message: "No tienes permiso para vaciar este carrito 🔴" });
        }
        await Cart.findOneAndDelete({ userEmail: email.toLowerCase() });
        res.status(200).json({ message: "Carrito vaciado correctamente 🟢" });
    } catch (error) {
        console.error(`[${new Date().toISOString()}] ERROR DELETE CART:`, error);
        res.status(500).json({ message: "Error al vaciar el carrito 🔴" });
    }
});

// CHECKOUT SUCCESS — actualiza stock + quema cupón
cartRouter.post("/api/checkout/success", async (req, res) => {
    const { email, couponCode, items } = req.body;
    const sanitizedEmail = email.toLowerCase();

    if (!items || !Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ message: "No hay productos para procesar 🔴" });
    }

    try {
        // actualizar stock
        const stockOperations = items.map(item => {
            if (typeof item.cantidad !== 'number' || typeof item.stockMax !== 'number') {
                throw new Error("Valores no numéricos en item");
            }
            if (isNaN(item.cantidad) || isNaN(item.stockMax))  throw new Error("NaN en item");
            if (item.cantidad > item.stockMax) throw new Error("Cantidad excede stock");
            if (item.cantidad <= 0) throw new Error("Cantidad <= 0");

            if (item.id !== item.productId) {
                return {
                    updateOne: {
                        filter: { _id: item.productId, "variantes._id": item.id },
                        update: { $inc: { "variantes.$.stock": -item.cantidad } }
                    }
                };
            } else {
                return {
                    updateOne: {
                        filter: { _id: item.productId },
                        update: { $inc: { stock_base: -item.cantidad } }
                    }
                };
            }
        });

        await Product.bulkWrite(stockOperations);

        // quemar cupón
        if (couponCode) {
            const sanitizedCode = couponCode.toUpperCase().trim();
            const coupon = await Coupon.findOne({ code: sanitizedCode });

            if (coupon) {
                const updateOp = {
                    $addToSet: { usedBy: sanitizedEmail },
                    $inc:      { usesCount: 1 }
                };

                // si era limited_uses y llegó al máximo → desactivar
                if (coupon.type === 'limited_uses' &&
                    coupon.maxUses !== null &&
                    coupon.usesCount + 1 >= coupon.maxUses) {
                    updateOp.$set = { isActive: false };
                }

                // si era single_use → desactivar
                if (coupon.type === 'single_use') {
                    updateOp.$set = { isActive: false };
                }

                await Coupon.findByIdAndUpdate(coupon._id, updateOp);
            }
        }

        await Cart.findOneAndDelete({ userEmail: sanitizedEmail });

        res.status(200).json({ message: "Compra procesada: Stock actualizado correctamente 🟢" });

    } catch (error) {
        console.error(`[${new Date().toISOString()}] ERROR SUCCESS PROCESS:`, error);
        res.status(500).json({ message: "Error crítico al finalizar la compra 🔴", detail: error.message });
    }
});

// RECHECK PRECIOS DB
cartRouter.post('/api/products/validate-prices', async (req, res) => {
    try {
        const { productIds } = req.body;

        const products = await Product.find({
            $or: [
                { _id: { $in: productIds } },
                { "variantes._id": { $in: productIds } }
            ]
        }).select('precio_base en_promocion porcentaje_promo stock_base variantes cuotas_sin_interes');

        const formatted = productIds.map(id => {
            const p = products.find(prod =>
                prod._id.toString() === id ||
                prod.variantes.some(v => v._id.toString() === id)
            );
            if (!p) return null;

            const tienePromo = p.en_promocion && p.porcentaje_promo > 0;
            const variante   = p.variantes.find(v => v._id.toString() === id);

            if (variante) {
                const base = p.precio_base + (variante.precio_adicional || 0);
                const precio = tienePromo ? base * (1 - p.porcentaje_promo / 100) : base;
                return {
                    productId: id,
                    precio:    Math.round(precio),
                    stockMax:  variante.stock || 0,
                    cuotas_sin_interes: p.cuotas_sin_interes || 0
                };
            } else {
                const precio = tienePromo
                    ? p.precio_base * (1 - p.porcentaje_promo / 100)
                    : p.precio_base;
                return {
                    productId: id,
                    precio:    Math.round(precio),
                    stockMax:  p.stock_base || 0,
                    cuotas_sin_interes: p.cuotas_sin_interes || 0
                };
            }
        }).filter(item => item !== null);

        res.status(200).json(formatted);
    } catch (error) {
        console.error(`[${new Date().toISOString()}] ERROR VALIDATE PRECIOS:`, error);
        res.status(500).json({ message: "Error al validar precios" });
    }
});


module.exports = cartRouter;