// Express y Router
const express = require("express")
const mercadoPagoRouter = express.Router()
// Mercado Pago
const { MercadoPagoConfig, Payment } =require("mercadopago")
const { v4 } = require("uuid")
// Mongo
const PaymentsMongo = require("../models/Payments")
const Coupon = require("../models/CouponSchema")

const { notifyNewSale } = require("../sseManager/sseManajer")

const Product = require("../models/productModel")
const Cart = require("../models/CartSchema")

const client = new MercadoPagoConfig({ 
    accessToken: process.env.MP_ACCESS_TOKEN 
});

const paymentInstance = new Payment(client);

const esProduccion = (process.env.NODE_ENV === 'production');

// Intereses 
const INTEREST_RATES = { 1: 0, 3: 0.05, 6: 0.10, 9: 0.15, 12: 0.20 };

mercadoPagoRouter.post("/mercado-pago-payments", async (req, res) => {
    const { token, issuer_id, payment_method_id, installments, payer, idempotencyKey, items, couponCode, tel } = req.body;

    if (!token || !payment_method_id || !installments || !payer || !idempotencyKey
        || !items || !Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ message: "Faltan datos críticos para procesar el pago 🔴" });
    }

    const cuotas         = Number(installments);
    const sanitizedEmail = payer.email.toLowerCase();

    if (![1, 3, 6, 9, 12].includes(cuotas)) {
        return res.status(400).json({ message: "Cantidad de cuotas no válida 🔴" });
    }

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
                nombre:             padre.nombre,   // ← directo, sin productDoc
                variante,                           // ← para el label
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

        // ── 4. CALCULAR MONTO — orden: base → cupón → interés ────────
        const transaction_amount = Math.round(
            enrichedItems.reduce((acc, item) => {
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

                const aplicaInteres = !item.cuotas_sin_interes || cuotas > item.cuotas_sin_interes;
                const tasa          = aplicaInteres ? (INTEREST_RATES[cuotas] || 0) : 0;

                return acc + subtotalConDescuento * (1 + tasa);
            }, 0)
        );

        // ── 5. PROCESAR PAGO CON MP ───────────────────────────────────
        const paymentData = {
            body: {
                transaction_amount,
                token,
                description:       "Dekin Hogar - Compra Digital",
                installments:      cuotas,
                payment_method_id,
                issuer_id:         issuer_id ? String(issuer_id) : undefined,
                payer: {
                    email:          sanitizedEmail,
                    identification: payer.identification
                },
            },
            requestOptions: { idempotencyKey }
        };

        const result = await paymentInstance.create(paymentData);

        if (result.status === "approved") {
            // ── 6. ACTUALIZAR STOCK ───────────────────────────────────
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

            // ── 7. QUEMAR CUPÓN ───────────────────────────────────────
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

            await Cart.findOneAndDelete({ userEmail: sanitizedEmail });
        }

        // ── 8. REGISTRAR PAGO ─────────────────────────────────────────
        const newPayment = new PaymentsMongo({
            orderId:       `ORD-${Date.now()}`,
            client_id:     payer.id_internal || "guest",
            email:         sanitizedEmail,
            plan:          "Compra General",
            amount:        transaction_amount,
            mp_payment_id: String(result.id),
            status:        result.status,
            date:          new Date(),
            telefono:      tel || "N/A",

            items: enrichedItems.map(item => ({
                nombre:         item.nombre,        // ← directo desde enrichedItems
                cantidad:       item.cantidad,
                precioUnitario: item.precioUnitario,
                totalItem:      Math.round(item.precioUnitario * item.cantidad),
                skuPadre:       item.skuPadre,      // ← directo desde enrichedItems
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

        res.status(201).json({ status: result.status, status_detail: result.status_detail, id: result.id });

    } catch (error) {
        console.error(`[${new Date().toISOString()}] ERROR CRÍTICO EN PAGO:`, error.response?.data || error.message);
        res.status(500).json({ error: "Error interno al procesar la transacción 🔴" });
    }
});
 
// WEBHOOK — notificaciones de MP
mercadoPagoRouter.post("/webhooks", async (req, res) => {
    try {
        const { query, body } = req;
        const id   = query["data.id"] || body?.data?.id || body?.id;
        const type = query.type || body?.type;
 
        if (type === "payment" && id && id !== "123456") {
            const payment = await paymentInstance.get({ id });
            await PaymentsMongo.findOneAndUpdate(
                { mpId: id.toString() },
                { status: payment.status, statusDetail: payment.status_detail }
            );
        }
 
        res.status(200).send("OK");
    } catch (error) {
        console.error(esProduccion ? "Error en Webhook 🔴" : `Error en Webhook 🔴: ${error.message}`);
        res.status(200).send("OK");
    }
});
 
module.exports = mercadoPagoRouter;