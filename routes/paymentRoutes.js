// Express y Router
const express = require("express")
const paymentsRouter = express.Router()
// Mongo
const PaymentsMongo = require("../models/Payments")

const Coupon = require("../models/CouponSchema")
const Product = require("../models/productModel")
const Cart = require("../models/CartSchema")

const adminMiddleware = require("../middleware/adminMiddleware")
const verifyToken = require("../middleware/authMiddleware")

const { notifyNewSale } = require("../sseManager/sseManajer")

const esProduccion = (process.env.NODE_ENV === 'production');

paymentsRouter.post("/tickets", verifyToken, async (req, res) => {
    const { email } = req.body
    
    if(!email){
        return res.status(400).json({ message: "All fields are required! 🔴" })
    }
    try {
        const payments = await PaymentsMongo.find({ email: email })
        if(!payments){
            return res.status(404).json({ message: "Cannot find availiable tickets! 🔴" })
        }
        return res.status(200).json(payments)
    } catch (error) {
        console.error(esProduccion ? "Error gettings tickets! 🔴" : "Error getting tickets!", error)
        res.status(500).json({ message: "Error gettings tickets! 🔴" })
    }
})

paymentsRouter.get("/all-tickets", adminMiddleware, async (req, res) => {
    try {
        // Buscamos todos los registros sin filtros, ordenados por fecha (más recientes primero)
        const allPayments = await PaymentsMongo.find().sort({ createdAt: -1 });

        if (!allPayments || allPayments.length === 0) {
            return res.status(404).json({ message: "No sales records found! 🔴" });
        }
        
        return res.status(200).json(allPayments);
    } catch (error) {
        console.error(esProduccion ? "Error fetching all tickets! 🔴" : "Error fetching all tickets!", error);
        res.status(500).json({ message: "Internal Server Error 🔴" });
    }
});

// TEST REAL PAYMENT
paymentsRouter.post("/test-payment-complete", async (req, res) => {
    const {
        payer, idempotencyKey,
        items, couponCode, tel,
        shipping, billing,
    } = req.body;

    console.log("🧪 [STRIPE TEST] Iniciando simulación completa...");

    if (!payer || !items || !Array.isArray(items) || items.length === 0 || !idempotencyKey) {
        return res.status(400).json({ message: "Faltan datos críticos para simular el pago 🔴" });
    }

    const sanitizedEmail = payer.email?.toLowerCase() || "test@email.com";

    try {
        // ── 1. BUSCAR PRODUCTOS EN DB ──────────────────────────────────
        const productIds = items.map(i => i.productId);
        const variantIds = items.filter(i => i.varianteId).map(i => i.varianteId);

        const products = await Product.find({
            $or: [
                { _id: { $in: productIds } },
                { "variantes._id": { $in: variantIds } }
            ]
        }).select('precio_base en_promocion porcentaje_promo stock_base variantes cuotas_sin_interes sku_padre categorias nombre');

        // ── 2. VALIDAR STOCK Y ENRIQUECER ITEMS ───────────────────────
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
                nombre:             padre.nombre,
                variante,
            });

            console.log(`✅ [STRIPE TEST] "${padre.nombre}" → precio: €${precioUnitario} | stock: ${stockDisponible}`);
        }

        // ── 3. VALIDAR CUPÓN — lógica intacta ─────────────────────────
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
            console.log(`✅ [STRIPE TEST] Cupón "${sanitizedCode}" validado — ${coupon.discount}% (scope: ${coupon.scope})`);
        }

        // ── 4. CALCULAR MONTO — sin intereses (Stripe/Europa) ─────────
        // Stripe maneja cuotas del lado de Klarna, no hay interés propio
        let subtotalBase   = 0;
        let descuentoCupon = 0;
        const detalleItems = [];

        for (const item of enrichedItems) {
            const subtotalItem = item.precioUnitario * item.cantidad;
            subtotalBase      += subtotalItem;

            let itemConDescuento = subtotalItem;
            let itemDescuento    = 0;

            if (couponData) {
                let aplica = couponData.scope === 'all';
                if (couponData.scope === 'products')
                    aplica = couponData.allowedProducts.includes(item.skuPadre?.toUpperCase());
                if (couponData.scope === 'categories')
                    aplica = item.categorias.some(cat => couponData.allowedCategories.includes(cat.toLowerCase()));

                if (aplica) {
                    itemDescuento    = subtotalItem * (couponData.discount / 100);
                    itemConDescuento = subtotalItem - itemDescuento;
                    descuentoCupon  += itemDescuento;
                }
            }

            detalleItems.push({
                nombre:         item.nombre,
                cantidad:       item.cantidad,
                precioUnitario: item.precioUnitario,
                subtotal:       subtotalItem,
                descuentoCupon: Math.round(itemDescuento),
                totalItem:      Math.round(itemConDescuento),
            });
        }

        // Sumar costo de envío si aplica
        const shippingCost = (shipping?.mode === "delivery" && !shipping?.ownerCovers)
            ? (shipping?.cost || 0)
            : 0;

        const transaction_amount = Math.round(subtotalBase - descuentoCupon + shippingCost);

        console.log("💰 [STRIPE TEST] Desglose:");
        console.log(`   Subtotal base:    €${subtotalBase}`);
        console.log(`   Descuento cupón: -€${Math.round(descuentoCupon)}`);
        console.log(`   Envío:           +€${shippingCost}`);
        console.log(`   TOTAL FINAL:      €${transaction_amount}`);

        // ── 5. STRIPE SIMULADO ────────────────────────────────────────
        const fakeStripeResult = {
            id:     `pi_test_${Date.now()}_${Math.floor(Math.random() * 99999)}`,
            status: "approved",
        };
        console.log(`🧪 [STRIPE TEST] PaymentIntent simulado → ${fakeStripeResult.id}`);

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
        console.log("✅ [STRIPE TEST] Stock actualizado.");

        // ── 7. QUEMAR CUPÓN — lógica intacta ──────────────────────────
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
            console.log(`✅ [STRIPE TEST] Cupón "${couponData.code}" quemado.`);
        }

        // ── 8. LIMPIAR CARRITO ────────────────────────────────────────
        await Cart.findOneAndDelete({ userEmail: sanitizedEmail });
        console.log("✅ [STRIPE TEST] Carrito eliminado.");

        // ── 9. REGISTRAR PAGO ─────────────────────────────────────────
        const nuevoPago = new PaymentsMongo({
            orderId:       `STRIPE-TEST-${Date.now()}`,
            client_id:     sanitizedEmail,
            email:         sanitizedEmail,
            plan:          "Compra General",
            amount:        transaction_amount,
            mp_payment_id: fakeStripeResult.id,
            status:        "approved",
            date:          new Date(),
            telefono:      tel || "N/A",

            items: enrichedItems.map(item => ({
                nombre:         item.nombre,
                cantidad:       item.cantidad,
                precioUnitario: item.precioUnitario,
                totalItem:      Math.round(item.precioUnitario * item.cantidad),
                descuentoCupon: detalleItems.find(d => d.nombre === item.nombre)?.descuentoCupon || 0,
                aplicaInteres:  false, // Stripe no aplica interés propio
                tasa:           "0%",
                skuPadre:       item.skuPadre,
                productId:      item.productId,
                varianteId:     item.varianteId || null,
                varianteLabel:  item.variante
                    ? [
                        item.variante.color,
                        item.variante.gb          ? item.variante.gb + 'GB'         : null,
                        item.variante.talle       ? 'Talle: ' + item.variante.talle : null,
                        item.variante.medida      ? item.variante.medida + 'cm'      : null,
                        item.variante.largo_cable ? item.variante.largo_cable + 'm'  : null,
                      ].filter(Boolean).join(' · ')
                    : null,
            })),

            // ── shipping ──────────────────────────────────────────────
            shipping: shipping ? {
                mode:        shipping.mode || "delivery",
                cost:        shippingCost,
                ownerCovers: shipping.ownerCovers || false,
                address:     shipping.address || null,
            } : null,

            // ── billing — datos de factura si empresa ─────────────────
            billing: billing ? {
                type:            billing.type || "fisica",
                razonSocial:     billing.razonSocial     || null,
                cif:             billing.cif             || null,
                direccionFiscal: billing.direccionFiscal || null,
                ciudadFiscal:    billing.ciudadFiscal    || null,
                cpFiscal:        billing.cpFiscal        || null,
            } : { type: "fisica" },
        });

        await nuevoPago.save();
        notifyNewSale(nuevoPago);
        console.log("✅ [STRIPE TEST] Pago registrado en DB.");

        res.status(200).json({
            message:    "✅ Simulación Stripe completa",
            mp_status:  "approved",
            mp_id:      fakeStripeResult.id,
            db_updated: true,
            calculo: {
                subtotalBase,
                descuentoCupon:    Math.round(descuentoCupon),
                shippingCost,
                totalFinal:        transaction_amount,
                moneda:            "EUR",
                cupon: couponData
                    ? { code: couponData.code, discount: couponData.discount, scope: couponData.scope }
                    : null,
            },
            items:    detalleItems,
            shipping: shipping || null,
            billing:  billing  || null,
        });

    } catch (error) {
        console.error(`❌ [STRIPE TEST ERROR]:`, error.message);
        res.status(500).json({ error: "Error en la simulación", details: error.message });
    }
});

paymentsRouter.patch("/api/payments/:id/checked", adminMiddleware, async (req, res) => {
    await PaymentsMongo.findByIdAndUpdate(req.params.id, { checked: req.body.checked });
    res.json({ ok: true });
});

module.exports = paymentsRouter