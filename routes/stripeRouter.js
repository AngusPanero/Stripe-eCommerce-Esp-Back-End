// Express y Router
const express      = require("express");
const stripeRouter = express.Router();
// Stripe
const Stripe = require("stripe");
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const { v4 } = require("uuid");
// Mongo
const PaymentsMongo = require("../models/Payments");
const Coupon        = require("../models/CouponSchema");
const Product       = require("../models/productModel");
const Cart          = require("../models/CartSchema");

const { notifyNewSale } = require("../sseManager/sseManajer");

// ── SHIPPING CONFIG — mismo valor que en el frontend ─────────────────────
const SHIPPING_CONFIG = {
  ownerCoversShipping: false, // true = negocio cubre el envío
  shippingCost:        9.99,  // costo en euros
};

// ════════════════════════════════════════════════════════════════════════════
//  POST /stripe-create-payment-intent
//  Crea el PaymentIntent y devuelve el clientSecret al frontend.
//  El frontend lo usa para montar el PaymentElement de Stripe.
// ════════════════════════════════════════════════════════════════════════════
stripeRouter.post("/stripe-create-payment-intent", async (req, res) => {
    const { items, couponCode, email, idempotencyKey, shipping } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0 || !email) {
        return res.status(400).json({ message: "Faltan datos críticos para crear el pago 🔴" });
    }

    const sanitizedEmail = email.toLowerCase();

    try {
        // ── 1. BUSCAR PRODUCTOS EN DB ─────────────────────────────────
        const productIds = items.map(i => i.productId);
        const variantIds = items.filter(i => i.varianteId).map(i => i.varianteId);

        const products = await Product.find({
            $or: [
                { _id: { $in: productIds } },
                { "variantes._id": { $in: variantIds } }
            ]
        }).select('precio_base en_promocion porcentaje_promo stock_base variantes cuotas_sin_interes sku_padre categorias nombre');

        // ── 2. VALIDAR STOCK Y CONSTRUIR ITEMS ENRIQUECIDOS ──────────
        const enrichedItems = [];

        for (const item of items) {
            if (typeof item.cantidad !== 'number' || isNaN(item.cantidad) || item.cantidad <= 0) {
                return res.status(409).json({ message: `Cantidad no válida en uno de los productos 🔴` });
            }

            const padre = products.find(p =>
                p._id.toString() === item.productId ||
                (item.varianteId && p.variantes.some(v => v._id.toString() === item.varianteId))
            );

            if (!padre) {
                return res.status(404).json({ message: `Producto no encontrado en DB 🔴` });
            }

            const tienePromo = padre.en_promocion && padre.porcentaje_promo > 0;
            const esVariante = !!item.varianteId;
            const variante   = esVariante
                ? padre.variantes.find(v => v._id.toString() === item.varianteId)
                : null;

            let precioUnitario, stockDisponible;

            if (esVariante && variante) {
                const base     = padre.precio_base + (variante.precio_adicional || 0);
                precioUnitario = tienePromo ? base * (1 - padre.porcentaje_promo / 100) : base;
                stockDisponible = variante.stock;
            } else {
                precioUnitario  = tienePromo
                    ? padre.precio_base * (1 - padre.porcentaje_promo / 100)
                    : padre.precio_base;
                stockDisponible = padre.stock_base;
            }

            precioUnitario = Math.round(precioUnitario);

            if (item.cantidad > stockDisponible) {
                return res.status(409).json({ message: `Stock insuficiente para "${padre.nombre}" 🔴` });
            }

            enrichedItems.push({
                ...item,
                precioUnitario,
                stockDisponible,
                cuotas_sin_interes: padre.cuotas_sin_interes || 0,
                skuPadre:           padre.sku_padre,
                categorias:         padre.categorias || [],
                nombre:             padre.nombre,
                variante,
            });
        }

        // ── 3. VALIDAR CUPÓN ──────────────────────────────────────────
        let couponData = null;
        if (couponCode) {
            const sanitizedCode = couponCode.toUpperCase().trim();
            const coupon        = await Coupon.findOne({ code: sanitizedCode, isActive: true });

            if (!coupon)
                return res.status(404).json({ message: "El cupón no existe o no está activo 🔴" });
            if (coupon.type === 'date_limited' && coupon.expiryDate < new Date())
                return res.status(400).json({ message: "El cupón ha expirado ⚠️" });
            if (coupon.type === 'single_use' && coupon.usedBy.includes(sanitizedEmail))
                return res.status(400).json({ message: "Este cupón ya fue utilizado por tu cuenta 🔴" });
            if (coupon.type === 'limited_uses' && coupon.maxUses !== null && coupon.usesCount >= coupon.maxUses)
                return res.status(400).json({ message: "Este cupón alcanzó su límite de usos ⚠️" });

            if (coupon.scope !== 'all') {
                const aplica = enrichedItems.some(item => {
                    if (coupon.scope === 'products')
                        return coupon.allowedProducts.includes(item.skuPadre?.toUpperCase());
                    if (coupon.scope === 'categories')
                        return item.categorias.some(cat => coupon.allowedCategories.includes(cat.toLowerCase()));
                    return false;
                });
                if (!aplica)
                    return res.status(400).json({ message: "Este cupón no aplica a los productos del carrito 🔴" });
            }
            couponData = coupon;
        }

        // ── 4. CALCULAR MONTO — igual que MP, sin intereses ──────────
        // Stripe no maneja cuotas con interés — precio plano en euros
        const totalEuros = enrichedItems.reduce((acc, item) => {
            const subtotalItem = item.precioUnitario * item.cantidad;

            let subtotalConDescuento = subtotalItem;
            if (couponData) {
                let aplicaCupon = couponData.scope === 'all';
                if (couponData.scope === 'products')
                    aplicaCupon = couponData.allowedProducts.includes(item.skuPadre?.toUpperCase());
                if (couponData.scope === 'categories')
                    aplicaCupon = item.categorias.some(cat => couponData.allowedCategories.includes(cat.toLowerCase()));
                if (aplicaCupon) subtotalConDescuento *= (1 - couponData.discount / 100);
            }

            return acc + subtotalConDescuento;
        }, 0);

        // Stripe trabaja en centimos — mínimo 50 centimos
        // Sumamos el costo de envío si aplica
        const shippingCost = (shipping?.mode === "delivery" && !SHIPPING_CONFIG.ownerCoversShipping)
            ? SHIPPING_CONFIG.shippingCost
            : 0;
        const amountInCents = Math.max(50, Math.round((totalEuros + shippingCost) * 100));

        // ── 5. CREAR PAYMENT INTENT EN STRIPE ────────────────────────
        const paymentIntent = await stripe.paymentIntents.create(
            {
                amount:   amountInCents,
                currency: "eur",
                automatic_payment_methods: { enabled: true }, // tarjeta + Klarna automático
                receipt_email: sanitizedEmail,
                metadata: {
                    email:         sanitizedEmail,
                    couponCode:    couponCode || "",
                    idempotencyKey,
                },
            },
            { idempotencyKey } // previene duplicados
        );

        // Devolvemos el clientSecret al frontend — es lo único que necesita
        res.status(200).json({ clientSecret: paymentIntent.client_secret });

    } catch (error) {
        console.error(`[${new Date().toISOString()}] ERROR CREANDO PAYMENT INTENT:`, error.message);
        res.status(500).json({ error: "Error interno al crear el pago 🔴" });
    }
});


// ════════════════════════════════════════════════════════════════════════════
//  POST /stripe-payments
//  Webhook / confirmación post-pago.
//  Stripe llama a este endpoint cuando el pago se confirma.
//  Aquí descontamos stock, quemamos cupón y registramos en DB.
// ════════════════════════════════════════════════════════════════════════════
stripeRouter.post("/stripe-payments", async (req, res) => {
    const { paymentIntentId, items, couponCode, email, tel, idempotencyKey, nombre, shipping } = req.body;

    if (!paymentIntentId || !items || !Array.isArray(items) || items.length === 0 || !email) {
        return res.status(400).json({ message: "Faltan datos críticos para confirmar el pago 🔴" });
    }

    const sanitizedEmail = email.toLowerCase();

    try {
        // ── 1. VERIFICAR EL PAGO EN STRIPE — nunca confiamos en el frontend ──
        const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);

        if (paymentIntent.status !== "succeeded") {
            return res.status(400).json({ message: `Pago no aprobado. Estado: ${paymentIntent.status} 🔴` });
        }

        // ── 2. BUSCAR PRODUCTOS EN DB ─────────────────────────────────
        const productIds = items.map(i => i.productId);
        const variantIds = items.filter(i => i.varianteId).map(i => i.varianteId);

        const products = await Product.find({
            $or: [
                { _id: { $in: productIds } },
                { "variantes._id": { $in: variantIds } }
            ]
        }).select('precio_base en_promocion porcentaje_promo stock_base variantes cuotas_sin_interes sku_padre categorias nombre');

        // ── 3. VALIDAR STOCK Y CONSTRUIR ITEMS ENRIQUECIDOS ──────────
        const enrichedItems = [];

        for (const item of items) {
            if (typeof item.cantidad !== 'number' || isNaN(item.cantidad) || item.cantidad <= 0) {
                return res.status(409).json({ message: `Cantidad no válida en uno de los productos 🔴` });
            }

            const padre = products.find(p =>
                p._id.toString() === item.productId ||
                (item.varianteId && p.variantes.some(v => v._id.toString() === item.varianteId))
            );

            if (!padre) return res.status(404).json({ message: `Producto no encontrado en DB 🔴` });

            const tienePromo = padre.en_promocion && padre.porcentaje_promo > 0;
            const esVariante = !!item.varianteId;
            const variante   = esVariante
                ? padre.variantes.find(v => v._id.toString() === item.varianteId)
                : null;

            let precioUnitario, stockDisponible;

            if (esVariante && variante) {
                const base      = padre.precio_base + (variante.precio_adicional || 0);
                precioUnitario  = tienePromo ? base * (1 - padre.porcentaje_promo / 100) : base;
                stockDisponible = variante.stock;
            } else {
                precioUnitario  = tienePromo
                    ? padre.precio_base * (1 - padre.porcentaje_promo / 100)
                    : padre.precio_base;
                stockDisponible = padre.stock_base;
            }

            precioUnitario = Math.round(precioUnitario);

            if (item.cantidad > stockDisponible) {
                return res.status(409).json({ message: `Stock insuficiente para "${padre.nombre}" 🔴` });
            }

            enrichedItems.push({
                ...item,
                precioUnitario,
                stockDisponible,
                cuotas_sin_interes: padre.cuotas_sin_interes || 0,
                skuPadre:           padre.sku_padre,
                categorias:         padre.categorias || [],
                nombre:             padre.nombre,
                variante,
            });
        }

        // ── 4. VALIDAR CUPÓN ──────────────────────────────────────────
        let couponData = null;
        if (couponCode) {
            const sanitizedCode = couponCode.toUpperCase().trim();
            const coupon        = await Coupon.findOne({ code: sanitizedCode, isActive: true });

            if (!coupon)
                return res.status(404).json({ message: "El cupón no existe o no está activo 🔴" });
            if (coupon.type === 'date_limited' && coupon.expiryDate < new Date())
                return res.status(400).json({ message: "El cupón ha expirado ⚠️" });
            if (coupon.type === 'single_use' && coupon.usedBy.includes(sanitizedEmail))
                return res.status(400).json({ message: "Este cupón ya fue utilizado por tu cuenta 🔴" });
            if (coupon.type === 'limited_uses' && coupon.maxUses !== null && coupon.usesCount >= coupon.maxUses)
                return res.status(400).json({ message: "Este cupón alcanzó su límite de usos ⚠️" });

            couponData = coupon;
        }

        // ── 5. CALCULAR MONTO REAL (verificación interna) ─────────────
        const totalEuros = enrichedItems.reduce((acc, item) => {
            const subtotalItem = item.precioUnitario * item.cantidad;
            let subtotalConDescuento = subtotalItem;
            if (couponData) {
                let aplicaCupon = couponData.scope === 'all';
                if (couponData.scope === 'products')
                    aplicaCupon = couponData.allowedProducts.includes(item.skuPadre?.toUpperCase());
                if (couponData.scope === 'categories')
                    aplicaCupon = item.categorias.some(cat => couponData.allowedCategories.includes(cat.toLowerCase()));
                if (aplicaCupon) subtotalConDescuento *= (1 - couponData.discount / 100);
            }
            return acc + subtotalConDescuento;
        }, 0);

        const shippingCost = (shipping?.mode === "delivery" && !SHIPPING_CONFIG.ownerCoversShipping)
            ? SHIPPING_CONFIG.shippingCost
            : 0;
        const amountInCents = Math.max(50, Math.round((totalEuros + shippingCost) * 100));

        // Verificar que Stripe cobró lo correcto
        if (paymentIntent.amount !== amountInCents) {
            console.error(`Monto no coincide. Stripe: ${paymentIntent.amount} | Calculado: ${amountInCents}`);
            return res.status(400).json({ message: "El monto del pago no coincide con el pedido 🔴" });
        }

        // ── 6. ACTUALIZAR STOCK ───────────────────────────────────────
        const stockOperations = enrichedItems.map(item => {
            if (item.varianteId) {
                return {
                    updateOne: {
                        filter: { _id: item.productId, "variantes._id": item.varianteId },
                        update: { $inc: { "variantes.$.stock": -item.cantidad } }
                    }
                };
            }
            return {
                updateOne: {
                    filter: { _id: item.productId },
                    update: { $inc: { stock_base: -item.cantidad } }
                }
            };
        });
        await Product.bulkWrite(stockOperations);

        // ── 7. QUEMAR CUPÓN ───────────────────────────────────────────
        if (couponData) {
            const updateOp = {
                $addToSet: { usedBy: sanitizedEmail },
                $inc:      { usesCount: 1 }
            };
            if (couponData.type === 'single_use') {
                updateOp.$set = { isActive: false };
            }
            if (couponData.type === 'limited_uses' &&
                couponData.maxUses !== null &&
                couponData.usesCount + 1 >= couponData.maxUses) {
                updateOp.$set = { isActive: false };
            }
            await Coupon.findByIdAndUpdate(couponData._id, updateOp);
        }

        // ── 8. LIMPIAR CARRITO ────────────────────────────────────────
        await Cart.findOneAndDelete({ userEmail: sanitizedEmail });

        // ── 9. REGISTRAR PAGO ─────────────────────────────────────────
        const newPayment = new PaymentsMongo({
            orderId:       `ORD-${Date.now()}`,
            client_id:     sanitizedEmail,
            email:         sanitizedEmail,
            plan:          "Compra General",
            amount:        totalEuros,
            mp_payment_id: paymentIntent.id, // reutilizamos el campo para el ID de Stripe
            status:        "approved",
            date:          new Date(),
            telefono:      tel || "N/A",
            shipping: shipping ? {
                mode:        shipping.mode,
                cost:        shipping.cost || 0,
                ownerCovers: SHIPPING_CONFIG.ownerCoversShipping,
                address:     shipping.address || null,
            } : null,

            items: enrichedItems.map(item => ({
                nombre:         item.nombre,
                cantidad:       item.cantidad,
                precioUnitario: item.precioUnitario,
                totalItem:      Math.round(item.precioUnitario * item.cantidad),
                skuPadre:       item.skuPadre,
                productId:      item.productId,
                varianteId:     item.varianteId || null,
                varianteLabel:  item.variante
                    ? [
                        item.variante.color,
                        item.variante.gb          ? item.variante.gb + 'GB'              : null,
                        item.variante.talle       ? 'Talle: ' + item.variante.talle      : null,
                        item.variante.medida      ? item.variante.medida + 'cm'           : null,
                        item.variante.largo_cable ? item.variante.largo_cable + 'm'       : null,
                      ].filter(Boolean).join(' · ')
                    : null,
            })),
        });
        await newPayment.save();
        notifyNewSale(newPayment);

        res.status(201).json({ status: "approved", id: paymentIntent.id });

    } catch (error) {
        console.error(`[${new Date().toISOString()}] ERROR CRÍTICO EN CONFIRMACIÓN:`, error.message);
        res.status(500).json({ error: "Error interno al confirmar la transacción 🔴" });
    }
});


// ════════════════════════════════════════════════════════════════════════════
//  POST /stripe-webhook
//  Stripe llama aquí para notificar eventos (pago fallido, disputas, etc.)
//  Verificamos la firma para asegurarnos que viene de Stripe de verdad.
// ════════════════════════════════════════════════════════════════════════════
stripeRouter.post("/stripe-webhook", express.raw({ type: "application/json" }), async (req, res) => {
    const sig     = req.headers["stripe-signature"];
    const secret  = process.env.STRIPE_WEBHOOK_SECRET;

    let event;
    try {
        event = stripe.webhooks.constructEvent(req.body, sig, secret);
    } catch (err) {
        console.error("Webhook signature inválida 🔴:", err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Actualizar estado en DB si el pago falla o se disputa
    if (event.type === "payment_intent.payment_failed") {
        const pi = event.data.object;
        await PaymentsMongo.findOneAndUpdate(
            { mp_payment_id: pi.id },
            { status: "failed" }
        );
    }

    if (event.type === "charge.dispute.created") {
        const dispute = event.data.object;
        await PaymentsMongo.findOneAndUpdate(
            { mp_payment_id: dispute.payment_intent },
            { status: "disputed" }
        );
    }

    res.status(200).send("OK");
});

module.exports = stripeRouter;