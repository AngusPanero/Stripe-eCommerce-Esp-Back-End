const express = require('express');
const productRouter = express.Router();
const Product   = require('../models/productModel');
const Category  = require("../models/CategorySchema");
const Attribute = require("../models/AttributeSchema");
const Favorite  = require("../models/FavoriteSchema");
const Reseñas   = require("../models/ReseñasSchema");
const mongoose  = require('mongoose');
const crypto    = require('crypto');

// CSV — solo .csv, hasta 10 MB, un archivo
const multer = require('multer');
const csv    = require('csv-parser');
const fs     = require('fs');
const upload = multer({
    dest: 'uploads/',
    limits: { fileSize: 10 * 1024 * 1024, files: 1 },
    fileFilter: (req, file, cb) => {
        const ok = /\.csv$/i.test(file.originalname) &&
            ["text/csv", "application/vnd.ms-excel", "text/plain", "application/csv", "application/octet-stream"].includes(file.mimetype);
        cb(ok ? null : Object.assign(new Error("Solo se aceptan archivos .csv"), { code: "INVALID_TYPE" }), ok);
    },
});
const MAX_CSV_ROWS = 2000;

const adminMiddleware = require("../middleware/adminMiddleware");
const verifyToken     = require("../middleware/authMiddleware");

const esProduccion = (process.env.NODE_ENV === 'production');

/* ════════════════════════════════════════════════════════════════════════════
   NORMALIZACIÓN DE PRODUCTO
   Un solo lugar que valida y limpia lo que llega del admin (o del CSV).
════════════════════════════════════════════════════════════════════════════ */
const MAX_IMAGES    = 10;
const MAX_FAQS      = 20;
const MAX_OPCIONES  = 3;
const MAX_VARIANTES = 100;

const cleanStr = (v, max = 200) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
const toNum = (v) => {
    if (typeof v === "number") return v;
    if (typeof v === "string" && v.trim() !== "") return Number(v.trim().replace(",", "."));
    return NaN;
};
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const isHttps = (u) => typeof u === "string" && /^https:\/\//i.test(u.trim());
const isId    = (v) => typeof v === "string" && /^[a-f\d]{24}$/i.test(v);
// query string: si llega repetida (?x=a&x=b) es un array → se toma solo si es string
const qStr    = (v, max = 100) => (typeof v === "string" ? v.slice(0, max) : "");

// Límites de las acciones masivas
const MAX_BULK_IDS   = 500;
const MAX_PRICE_UP   = 500;    // +500 % como máximo en un ajuste masivo
const MAX_PRICE_DOWN = -90;    // -90 % como máximo
const MAX_STOCK_DELTA = 100000;

// Freno simple en memoria por clave (uid), mismo patrón que cupones y contacto
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
const limiteResenas = crearLimite(5, 60 * 60 * 1000);   // 5 reseñas por usuario por hora

// "marcelo@gmail.com" → "ma•••@gmail.com" (las reseñas son públicas)
const enmascararEmail = (e) => {
    const [u = "", d = ""] = String(e || "").split("@");
    return d ? `${u.slice(0, 2)}•••@${d}` : "anónimo";
};

function sanitizeProductPayload(raw = {}) {
    const errors = [];

    const nombre      = cleanStr(raw.nombre, 150);
    const marca       = cleanStr(raw.marca, 80);
    const sku_padre   = cleanStr(raw.sku_padre, 60);
    const descripcion = typeof raw.descripcion === "string" ? raw.descripcion.trim().slice(0, 5000) : "";

    if (!nombre)    errors.push("El nombre es obligatorio");
    if (!marca)     errors.push("La marca es obligatoria");
    if (!sku_padre) errors.push("El SKU padre es obligatorio");

    const precio_base = toNum(raw.precio_base);
    if (!Number.isFinite(precio_base) || precio_base <= 0) errors.push("El precio base debe ser mayor a 0");

    const imagenes_generales = (Array.isArray(raw.imagenes_generales) ? raw.imagenes_generales : [])
        .filter(isHttps).map(u => u.trim()).slice(0, MAX_IMAGES);
    if (!imagenes_generales.length) errors.push("Debés subir al menos una imagen del producto");

    const categorias = [...new Set((Array.isArray(raw.categorias) ? raw.categorias : [])
        .map(c => cleanStr(c, 50).toLowerCase()).filter(Boolean))];

    const en_promocion = raw.en_promocion === true || raw.en_promocion === "true";
    const porcentaje_promo = en_promocion ? toNum(raw.porcentaje_promo) : 0;
    if (en_promocion && (!Number.isFinite(porcentaje_promo) || porcentaje_promo < 1 || porcentaje_promo > 99)) {
        errors.push("El porcentaje de promoción debe estar entre 1 y 99");
    }

    const estado = ["activo", "pausado"].includes(raw.estado) ? raw.estado : "activo";

    const m = raw.medidas_empaque || {};
    const medidas_empaque = {};
    for (const k of ["peso", "ancho", "alto", "largo"]) {
        const n = toNum(m[k]);
        medidas_empaque[k] = Number.isFinite(n) && n >= 0 ? n : 0;
    }

    // ── FAQs ──
    const faqs = (Array.isArray(raw.faqs) ? raw.faqs : [])
        .map(f => ({
            pregunta:  cleanStr(f?.pregunta, 200),
            respuesta: typeof f?.respuesta === "string" ? f.respuesta.trim().slice(0, 1500) : "",
        }))
        .filter(f => f.pregunta && f.respuesta);
    if (faqs.length > MAX_FAQS) errors.push(`Máximo ${MAX_FAQS} preguntas frecuentes`);

    // ── VARIANTES ──
    const rawVars = Array.isArray(raw.variantes) ? raw.variantes : [];
    const variantes = [];
    let opciones   = [];
    let stock_base = 0;

    if (rawVars.length === 0) {
        stock_base = toNum(raw.stock_base);
        if (!Number.isInteger(stock_base) || stock_base < 0) {
            errors.push("El stock debe ser un número entero mayor o igual a 0");
            stock_base = 0;
        }
    } else {
        if (rawVars.length < 2)            errors.push("Un producto con variantes necesita al menos 2. Si es único, no cargues variantes.");
        if (rawVars.length > MAX_VARIANTES) errors.push(`Máximo ${MAX_VARIANTES} variantes por producto`);

        const skus = new Set();
        const combos = new Set();
        const valoresPorOpcion = new Map();
        let ref = null;

        rawVars.forEach((v, i) => {
            const n   = i + 1;
            const sku = cleanStr(v?.sku_variante, 60);

            if (!sku) errors.push(`Variante ${n}: falta el SKU`);
            else if (sku.toUpperCase() === sku_padre.toUpperCase()) errors.push(`Variante ${n}: el SKU no puede ser igual al SKU padre`);
            else if (skus.has(sku.toUpperCase())) errors.push(`SKU de variante repetido: ${sku}`);
            skus.add(sku.toUpperCase());

            const atributos = (Array.isArray(v?.atributos) ? v.atributos : [])
                .map(a => ({ nombre: cleanStr(a?.nombre, 40).toLowerCase(), valor: cleanStr(a?.valor, 60) }))
                .filter(a => a.nombre && a.valor);
            const nombres = atributos.map(a => a.nombre);

            if (!atributos.length) errors.push(`Variante ${n}: necesita al menos una característica (ej. color)`);
            if (atributos.length > MAX_OPCIONES) errors.push(`Variante ${n}: máximo ${MAX_OPCIONES} características`);
            if (new Set(nombres).size !== nombres.length) errors.push(`Variante ${n}: tiene una característica repetida`);

            const firma = [...nombres].sort().join("|");
            if (ref === null) ref = { firma, orden: nombres };
            else if (firma !== ref.firma) {
                errors.push(`Variante ${n}: todas las variantes deben tener las mismas características (${ref.orden.join(", ")})`);
            }

            const combo = [...atributos].sort((a, b) => a.nombre.localeCompare(b.nombre))
                .map(a => `${a.nombre}=${a.valor.toLowerCase()}`).join("|");
            if (atributos.length && combos.has(combo)) errors.push(`Variante ${n}: esa combinación ya existe`);
            combos.add(combo);

            atributos.forEach(a => {
                if (!valoresPorOpcion.has(a.nombre)) valoresPorOpcion.set(a.nombre, []);
                const arr = valoresPorOpcion.get(a.nombre);
                if (!arr.some(x => x.toLowerCase() === a.valor.toLowerCase())) arr.push(a.valor);
            });

            const stock = toNum(v?.stock);
            if (!Number.isInteger(stock) || stock < 0) errors.push(`Variante ${n}: el stock debe ser un entero ≥ 0`);

            const extra = toNum(v?.precio_adicional ?? 0);
            if (!Number.isFinite(extra) || extra < 0) errors.push(`Variante ${n}: el precio extra no puede ser negativo`);

            const out = {
                sku_variante:     sku,
                atributos,
                stock:            Number.isInteger(stock) && stock >= 0 ? stock : 0,
                precio_adicional: Number.isFinite(extra) && extra >= 0 ? Math.round(extra * 100) / 100 : 0,
                foto_variante:    isHttps(v?.foto_variante) ? v.foto_variante.trim() : null,
                activo:           v?.activo !== false,
            };
            if (v?._id && isId(String(v._id))) out._id = String(v._id);   // conserva el id (carritos/favoritos)
            variantes.push(out);
        });

        if (ref) {
            // mismo orden de características en todas las variantes
            variantes.forEach(v => v.atributos.sort((a, b) => ref.orden.indexOf(a.nombre) - ref.orden.indexOf(b.nombre)));
            opciones = ref.orden.map(nombre => ({ nombre, valores: valoresPorOpcion.get(nombre) || [] }));
        }
    }

    return {
        errors,
        data: {
            nombre, marca, sku_padre, descripcion,
            precio_base: Number.isFinite(precio_base) ? Math.round(precio_base * 100) / 100 : 0,
            stock_base,
            imagenes_generales, categorias,
            en_promocion, porcentaje_promo: en_promocion && Number.isFinite(porcentaje_promo) ? porcentaje_promo : 0,
            estado, medidas_empaque,
            opciones, variantes, faqs,
        },
    };
}

function mongooseErrorResponse(res, error, fallback) {
    if (error.code === 11000) {
        return res.status(409).json({ message: "El SKU padre o uno de los SKU de variante ya existe en otro producto 🔴" });
    }
    if (error.name === "ValidationError") {
        const first = Object.values(error.errors)[0]?.message;
        return res.status(400).json({ message: `${first || "Datos inválidos"} 🔴` });
    }
    return res.status(500).json({ message: fallback });
}

const registrarAtributos = (opciones) =>
    Attribute.registrar(opciones).catch(err => console.error("[ATRIBUTOS] No se pudieron registrar:", err.message));

/* ════════════════════════════════════════════════════════════════════════════
   CRUD
════════════════════════════════════════════════════════════════════════════ */

// CREATE INDIVIDUAL
productRouter.post("/api/product/create", adminMiddleware, async (req, res) => {
    const { data, errors } = sanitizeProductPayload(req.body?.formData);
    if (errors.length) return res.status(400).json({ message: `${errors[0]} 🔴`, errors });

    try {
        const newProduct = await Product.create(data);
        registrarAtributos(data.opciones);
        res.status(201).json({ message: "Producto creado con éxito 🟢", product: newProduct });
    } catch (error) {
        console.error(`[${new Date().toISOString()}] ERROR en productRouter = POST /create:`, error);
        mongooseErrorResponse(res, error, "INTERNAL_SERVER_ERROR_CREATING_PRODUCT 🔴");
    }
});

// ATRIBUTOS EXISTENTES (autocompletado del admin)
productRouter.get("/api/attributes", adminMiddleware, async (req, res) => {
    try {
        const atributos = await Attribute.find().sort({ usos: -1, nombre: 1 }).lean();
        res.status(200).json({ atributos: atributos.map(a => ({ nombre: a.nombre, valores: a.valores })) });
    } catch (error) {
        console.error(`[${new Date().toISOString()}] ERROR GET ATRIBUTOS:`, error);
        res.status(500).json({ message: "Error al obtener atributos 🔴" });
    }
});

// FIRMA PARA SUBIR IMÁGENES A CLOUDINARY (solo admin)
// Reemplaza al preset "unsigned": con él, cualquiera que viera el cloud name y el nombre
// del preset en el bundle del front podía subir archivos a tu cuenta (incluido SVG).
// La firma dura 1 hora, fija la carpeta y solo deja subir JPG, PNG o WEBP.
const CLOUDINARY_FOLDER  = process.env.CLOUDINARY_FOLDER || "dekin/products";
const CLOUDINARY_FORMATS = "jpg,jpeg,png,webp";

// Acepta las dos formas en que Cloudinary entrega las credenciales:
//   · CLOUDINARY_URL=cloudinary://API_KEY:API_SECRET@CLOUD_NAME   (copiada tal cual del panel)
//   · CLOUDINARY_CLOUD_NAME + CLOUDINARY_API_KEY + CLOUDINARY_API_SECRET
// Si están las dos, mandan las variables sueltas.
function cloudinaryConfig() {
    let cloudName = process.env.CLOUDINARY_CLOUD_NAME || "";
    let apiKey    = process.env.CLOUDINARY_API_KEY || "";
    let apiSecret = process.env.CLOUDINARY_API_SECRET || "";

    if ((!cloudName || !apiKey || !apiSecret) && process.env.CLOUDINARY_URL) {
        try {
            const u = new URL(process.env.CLOUDINARY_URL.trim());
            if (u.protocol === "cloudinary:") {
                cloudName = cloudName || u.hostname;
                apiKey    = apiKey    || decodeURIComponent(u.username);
                apiSecret = apiSecret || decodeURIComponent(u.password);
            }
        } catch { /* formato inválido: se avisa abajo */ }
    }
    return cloudName && apiKey && apiSecret ? { cloudName, apiKey, apiSecret } : null;
}

// Aviso al arrancar (sin mostrar el secret) para no enterarse recién al subir una foto
if (!cloudinaryConfig()) {
    console.warn("⚠️ [CLOUDINARY] Sin credenciales: definí CLOUDINARY_URL o CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET. La subida de imágenes del panel no va a funcionar.");
}

productRouter.post("/api/admin/upload-signature", adminMiddleware, (req, res) => {
    const cfg = cloudinaryConfig();
    if (!cfg) {
        console.error("[CLOUDINARY] Faltan credenciales en el .env (CLOUDINARY_URL o las tres variables sueltas)");
        return res.status(500).json({ message: "Subida de imágenes no configurada 🔴" });
    }
    const { cloudName: CLOUDINARY_CLOUD_NAME, apiKey: CLOUDINARY_API_KEY, apiSecret: CLOUDINARY_API_SECRET } = cfg;

    const timestamp = Math.floor(Date.now() / 1000);
    // Cloudinary firma los parámetros ordenados alfabéticamente: k=v&k=v + secret (SHA-1)
    const params = { allowed_formats: CLOUDINARY_FORMATS, folder: CLOUDINARY_FOLDER, timestamp };
    const aFirmar = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join("&");
    const signature = crypto.createHash("sha1").update(aFirmar + CLOUDINARY_API_SECRET).digest("hex");

    res.set("Cache-Control", "no-store");
    return res.status(200).json({
        cloudName: CLOUDINARY_CLOUD_NAME,
        apiKey:    CLOUDINARY_API_KEY,   // la api key no es secreta; el secret nunca sale del back
        timestamp,
        signature,
        folder:          CLOUDINARY_FOLDER,
        allowed_formats: CLOUDINARY_FORMATS,
    });
});

// READ ALL (público) — solo productos activos
// Antes devolvía también pausados y borrados: cualquiera veía lo que todavía no salió a la venta.
productRouter.get("/api/products", async (req, res) => {
    try {
        const products = await Product.find({ estado: "activo" });
        res.status(200).json({ message: "Products fetched successfully! 🟢", products });
    } catch (error) {
        console.error(`[${new Date().toISOString()}] ERROR en productRouter = GET :`, error);
        res.status(500).json({ message: "INTERNAL_SERVER_ERROR_READING_PRODUCTS! 🔴" });
    }
});

// READ ALL (admin) — todos los estados, para el inventario
productRouter.get("/api/admin/products", adminMiddleware, async (req, res) => {
    try {
        const products = await Product.find();
        res.set("Cache-Control", "no-store");
        res.status(200).json({ message: "Products fetched successfully! 🟢", products });
    } catch (error) {
        console.error(`[${new Date().toISOString()}] ERROR en productRouter = GET admin:`, error);
        res.status(500).json({ message: "INTERNAL_SERVER_ERROR_READING_PRODUCTS! 🔴" });
    }
});

// GET EXPORT CSV  (va antes de /api/product/:id para que no lo capture)
// Formato de la columna variantes:  SKU ~ stock ~ extra ~ color: Azul / capacidad: 128GB  |  SKU2 ~ ...
productRouter.get("/api/products/export-csv", adminMiddleware, async (req, res) => {
    try {
        const productos = await Product.find({}).lean();
        const BOM  = '\uFEFF';
        // Una celda que empieza con = + - @ Excel la ejecuta como fórmula al abrir el archivo
        // (CSV injection): se le antepone un apóstrofo para que quede como texto.
        const cell = (v) => {
            let s = String(v ?? "").replace(/\r?\n/g, " ");
            if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
            return `"${s.replace(/"/g, '""')}"`;
        };

        const headers = [
            "_id", "nombre", "marca", "sku_padre", "estado", "precio_base",
            "stock_base", "en_promocion", "porcentaje_promo",
            "categorias", "descripcion", "imagenes_generales",
            "peso", "ancho", "alto", "largo",
            "variantes"
        ];

        let csvContent = headers.join(";") + "\n";

        productos.forEach(p => {
            const variantesStr = (p.variantes || []).map(v => [
                v.sku_variante || "",
                v.stock || 0,
                v.precio_adicional || 0,
                (v.atributos || []).map(a => `${a.nombre}: ${a.valor}`).join(" / "),
            ].join(" ~ ")).join(" | ");

            const row = [
                p._id,
                cell(p.nombre),
                cell(p.marca),
                cell(p.sku_padre),
                p.estado,
                p.precio_base,
                p.stock_base || 0,
                p.en_promocion ? "true" : "false",
                p.porcentaje_promo || 0,
                cell((p.categorias || []).join(" | ")),
                cell(p.descripcion || ""),
                cell((p.imagenes_generales || []).join(" | ")),
                p.medidas_empaque?.peso  || 0,
                p.medidas_empaque?.ancho || 0,
                p.medidas_empaque?.alto  || 0,
                p.medidas_empaque?.largo || 0,
                cell(variantesStr),
            ];
            csvContent += row.join(";") + "\n";
        });

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename=productos_db.csv');
        return res.status(200).send(BOM + csvContent);
    } catch (error) {
        console.error(`[${new Date().toISOString()}] ERROR en EXPORT CSV = GET`, error);
        res.status(500).json({ message: "Error al exportar" });
    }
});

// READ INDIVIDUAL (público) — un producto pausado o borrado responde 404
productRouter.get("/api/product/:id", async (req, res) => {
    const { id } = req.params;
    if (!isId(id)) {
        return res.status(400).json({ message: "ObjectID format is invalid!. 🔴" });
    }
    try {
        const product = await Product.findOne({ _id: id, estado: "activo" });
        if (!product) return res.status(404).json({ message: "Product not found! 🔴" });
        res.status(200).json({ message: "Product found successfully! 🟢", product });
    } catch (error) {
        console.error(`[${new Date().toISOString()}] ERROR en productRouter = GET /:id:`, error);
        res.status(500).json({ message: "INTERNAL_SERVER_ERROR_READING_PRODUCT! 🔴" });
    }
});

// UPDATE INDIVIDUAL — usa save() para que corran las validaciones del modelo
productRouter.put("/api/product/update/:id", adminMiddleware, async (req, res) => {
    const { id } = req.params;
    if (!isId(id)) {
        return res.status(400).json({ message: "ObjectID format is invalid!. 🔴" });
    }

    const { data, errors } = sanitizeProductPayload(req.body?.formData);
    if (errors.length) return res.status(400).json({ message: `${errors[0]} 🔴`, errors });

    try {
        const product = await Product.findById(id);
        if (!product) return res.status(404).json({ message: "Product not found! 🔴" });

        product.set(data);
        await product.save();
        registrarAtributos(data.opciones);

        res.status(200).json({ message: "Producto actualizado con éxito 🟢", product });
    } catch (error) {
        console.error(`[${new Date().toISOString()}] ERROR en productRouter = PUT /:id:`, error);
        mongooseErrorResponse(res, error, "INTERNAL_SERVER_ERROR_UPDATING_PRODUCT! 🔴");
    }
});

// UPDATE VARIANT — solo campos permitidos (las características se editan desde el producto completo)
productRouter.patch("/api/product/update-variant/:variantId", adminMiddleware, async (req, res) => {
    const { variantId } = req.params;
    const { formData = {} } = req.body;
    if (!isId(variantId)) return res.status(400).json({ message: "ID de variante inválido 🔴" });

    const set = {};
    if (formData.stock !== undefined) {
        const n = toNum(formData.stock);
        if (!Number.isInteger(n) || n < 0) return res.status(400).json({ message: "El stock debe ser un entero ≥ 0 🔴" });
        set["variantes.$.stock"] = n;
    }
    if (formData.precio_adicional !== undefined) {
        const n = toNum(formData.precio_adicional);
        if (!Number.isFinite(n) || n < 0) return res.status(400).json({ message: "El precio extra no puede ser negativo 🔴" });
        set["variantes.$.precio_adicional"] = Math.round(n * 100) / 100;
    }
    if (formData.sku_variante !== undefined) {
        const sku = cleanStr(formData.sku_variante, 60);
        if (!sku) return res.status(400).json({ message: "El SKU no puede quedar vacío 🔴" });
        set["variantes.$.sku_variante"] = sku;
    }
    if (formData.activo !== undefined)        set["variantes.$.activo"] = formData.activo === true;
    if (formData.foto_variante !== undefined) set["variantes.$.foto_variante"] = isHttps(formData.foto_variante) ? formData.foto_variante.trim() : null;

    if (!Object.keys(set).length) return res.status(400).json({ message: "No hay cambios válidos 🔴" });

    try {
        const productoActualizado = await Product.findOneAndUpdate(
            { "variantes._id": variantId },
            { $set: set },
            { new: true, runValidators: true }
        );
        if (!productoActualizado) return res.status(404).json({ message: "No se encontró la variante con ese ID ❌" });

        res.status(200).json({ message: "Variante actualizada con éxito ✅", product: productoActualizado });
    } catch (error) {
        console.error(`[${new Date().toISOString()}] ERROR en productRouter = PATCH VARIANT:`, error);
        mongooseErrorResponse(res, error, "Error interno");
    }
});

// MASSIVE UPDATE — pipeline para que el stock nunca quede negativo y el precio redondee a céntimos
productRouter.patch("/api/bulk-update", adminMiddleware, async (req, res) => {
    const { ids } = req.body ?? {};
    const cambios = req.body?.cambios && typeof req.body.cambios === "object" ? req.body.cambios : {};

    if (!Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({ message: "Debes seleccionar al menos un producto para actualizar. 🔴" });
    }
    if (ids.length > MAX_BULK_IDS) {
        return res.status(400).json({ message: `Máximo ${MAX_BULK_IDS} productos por operación 🔴` });
    }
    const validIds = ids.filter(isId);
    if (!validIds.length) return res.status(400).json({ message: "Ningún id válido 🔴" });

    const setFields = {};
    if (["activo", "pausado", "borrado"].includes(cambios.estado)) setFields.estado = cambios.estado;
    if (typeof cambios.marca === "string" && cleanStr(cambios.marca, 80)) setFields.marca = cleanStr(cambios.marca, 80).toLowerCase();
    if (typeof cambios.en_promocion === "boolean") setFields.en_promocion = cambios.en_promocion;
    if (cambios.porcentaje_promo !== undefined) {
        const n = toNum(cambios.porcentaje_promo);
        if (!Number.isFinite(n) || n < 0 || n > 99) return res.status(400).json({ message: "El porcentaje de promo debe estar entre 0 y 99 🔴" });
        setFields.porcentaje_promo = n;
    }
    if (setFields.en_promocion === true && !(setFields.porcentaje_promo > 0)) {
        return res.status(400).json({ message: "Indicá un porcentaje de promoción mayor a 0 🔴" });
    }

    const pipeline = [];
    if (Object.keys(setFields).length) {
        const literal = {};
        for (const [k, v] of Object.entries(setFields)) literal[k] = { $literal: v };
        pipeline.push({ $set: literal });
    }

    const pct = toNum(cambios.porcentaje_precio);
    if (Number.isFinite(pct) && pct !== 0) {
        // Con una sesión de admin robada, un -99 % dejaba toda la tienda casi gratis
        if (pct < MAX_PRICE_DOWN || pct > MAX_PRICE_UP) {
            return res.status(400).json({ message: `El ajuste de precio debe estar entre ${MAX_PRICE_DOWN}% y +${MAX_PRICE_UP}% 🔴` });
        }
        pipeline.push({ $set: { precio_base: { $round: [{ $multiply: ["$precio_base", 1 + pct / 100] }, 2] } } });
    }

    const delta = toNum(cambios.stock_a_sumar);
    if (Number.isInteger(delta) && Math.abs(delta) > MAX_STOCK_DELTA) {
        return res.status(400).json({ message: `El ajuste de stock no puede superar ±${MAX_STOCK_DELTA} 🔴` });
    }
    if (Number.isInteger(delta) && delta !== 0) {
        pipeline.push({
            $set: {
                stock_base: {
                    $cond: [
                        { $gt: [{ $size: { $ifNull: ["$variantes", []] } }, 0] },
                        0,
                        { $max: [0, { $add: [{ $ifNull: ["$stock_base", 0] }, delta] }] }
                    ]
                },
                variantes: {
                    $map: {
                        input: { $ifNull: ["$variantes", []] },
                        as: "v",
                        in: { $mergeObjects: ["$$v", { stock: { $max: [0, { $add: [{ $ifNull: ["$$v.stock", 0] }, delta] }] } }] }
                    }
                }
            }
        });
    }

    if (!pipeline.length) return res.status(400).json({ message: "No hay cambios para aplicar 🔴" });

    try {
        const result = await Product.updateMany({ _id: { $in: validIds } }, pipeline);
        res.status(200).json({
            message: "Actualización masiva completada con éxito! 🟢",
            detalles: { total_seleccionados: ids.length, total_modificados: result.modifiedCount }
        });
    } catch (error) {
        console.error(`[${new Date().toISOString()}] 🚨 ERROR en bulk-update:`, error);
        res.status(500).json({ message: "INTERNAL_SERVER_ERROR_IN_BULK_UPDATE! 🔴" });
    }
});

// DELETE INDIVIDUAL
productRouter.delete("/api/product/delete/:id", adminMiddleware, async (req, res) => {
    const { id } = req.params;
    if (!isId(id)) {
        return res.status(400).json({ message: "ObjectID format is invalid!. 🔴" });
    }
    try {
        const deletedProduct = await Product.findByIdAndDelete(id);
        if (!deletedProduct) return res.status(404).json({ message: "Product not found! 🔴" });
        res.status(200).json({ message: "Product deleted successfully! 🟢", product: deletedProduct });
    } catch (error) {
        console.error(`[${new Date().toISOString()}] ERROR en productRouter = DELETE /:id:`, error);
        res.status(500).json({ message: "INTERNAL_SERVER_ERROR_DELETING_PRODUCT! 🔴" });
    }
});

// MASSIVE DELETE
productRouter.delete("/api/bulk-delete", adminMiddleware, async (req, res) => {
    const { ids } = req.body ?? {};
    if (!Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({ message: "Debes seleccionar al menos un producto para eliminar. 🔴" });
    }
    if (ids.length > MAX_BULK_IDS) {
        return res.status(400).json({ message: `Máximo ${MAX_BULK_IDS} productos por operación 🔴` });
    }
    const validIds = ids.filter(isId);
    if (!validIds.length) return res.status(400).json({ message: "Ningún id válido 🔴" });
    try {
        const result = await Product.deleteMany({ _id: { $in: validIds } });
        res.status(200).json({ message: "Massive delete made successfully! 🟢", detalles: { total_seleccionados: ids.length, total_eliminados: result.deletedCount } });
    } catch (error) {
        console.error(`[${new Date().toISOString()}] 🚨 ERROR en bulk-delete:`, error);
        res.status(500).json({ message: "INTERNAL_SERVER_ERROR_IN_BULK_DELETE! 🔴" });
    }
});

// IMPORT CSV — admin primero, después se acepta el archivo
// Los errores de multer (tipo o tamaño) se responden aquí con 400/413, no como 500 genérico
const subirCsv = (req, res, next) => upload.single('archivo')(req, res, (err) => {
    if (!err) return next();
    if (err.code === "LIMIT_FILE_SIZE") return res.status(413).json({ message: "El CSV supera los 10 MB 🔴" });
    if (err.code === "INVALID_TYPE")    return res.status(400).json({ message: "Solo se aceptan archivos .csv 🔴" });
    return res.status(400).json({ message: "Archivo inválido 🔴" });
});

productRouter.post("/api/products/bulk-import", adminMiddleware, subirCsv, async (req, res) => {
    if (!req.file) return res.status(400).json({ message: "Archivo no encontrado" });

    const borrarArchivo = () => {
        try { if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path); }
        catch (e) { console.error("[CSV] No se pudo borrar el temporal:", e.message); }
    };
    const splitList = (s) => String(s || "").split("|").map(x => x.trim()).filter(Boolean);

    // Formato nuevo: "SKU ~ stock ~ extra ~ color: Azul / capacidad: 128GB"
    // Formato viejo: "SKU,talle,color,medida,stock,extra,foto"
    const parseVariante = (seg) => {
        if (seg.includes("~")) {
            const [sku, stock, extra, attrs = ""] = seg.split("~").map(s => s.trim());
            const atributos = attrs.split(" / ").map(par => {
                const i = par.indexOf(":");
                return i > 0 ? { nombre: par.slice(0, i).trim(), valor: par.slice(i + 1).trim() } : null;
            }).filter(Boolean);
            return { sku_variante: sku, stock: toNum(stock) || 0, precio_adicional: toNum(extra) || 0, atributos };
        }
        const c = seg.split(",").map(s => s.trim());
        const atributos = [["talle", c[1]], ["color", c[2]], ["medida", c[3]]]
            .filter(([, v]) => v).map(([nombre, valor]) => ({ nombre, valor }));
        return { sku_variante: c[0], stock: toNum(c[4]) || 0, precio_adicional: toNum(c[5]) || 0, foto_variante: c[6] || null, atributos };
    };

    try {
        const filas = await new Promise((resolve, reject) => {
            const out = [];
            const stream = fs.createReadStream(req.file.path);
            stream
                .pipe(csv({ separator: ';', mapHeaders: ({ header }) => header.replace(/^\uFEFF/, "").trim() }))
                .on('data', (d) => {
                    out.push(d);
                    // Tope de filas: cada una hace consultas a la BD
                    if (out.length > MAX_CSV_ROWS) {
                        stream.destroy();
                        reject(Object.assign(new Error("Demasiadas filas"), { code: "TOO_MANY_ROWS" }));
                    }
                })
                .on('end', () => resolve(out))
                .on('error', reject);
        });

        let procesados = 0;
        const errores = [];

        for (const [i, fila] of filas.entries()) {
            const sku = String(fila.sku_padre || "").trim();
            if (!sku) continue;

            const raw = {
                nombre:             fila.nombre,
                marca:              fila.marca,
                sku_padre:          sku,
                descripcion:        fila.descripcion,
                precio_base:        fila.precio_base,
                stock_base:         fila.stock_base,
                en_promocion:       fila.en_promocion === "true",
                porcentaje_promo:   fila.porcentaje_promo,
                estado:             fila.estado,
                categorias:         splitList(fila.categorias),
                imagenes_generales: splitList(fila.imagenes_generales),
                medidas_empaque:    { peso: fila.peso, ancho: fila.ancho, alto: fila.alto, largo: fila.largo },
                variantes:          splitList(fila.variantes).map(parseVariante),
            };

            const existing = await Product.findOne({ sku_padre: sku });

            // conservar los _id de variantes existentes (carritos y favoritos apuntan a ellos)
            if (existing) {
                raw.variantes.forEach(v => {
                    const prev = existing.variantes.find(x => x.sku_variante.toUpperCase() === String(v.sku_variante).toUpperCase());
                    if (prev) v._id = prev._id;
                });
            }

            const { data, errors } = sanitizeProductPayload(raw);
            if (errors.length) { errores.push(`Fila ${i + 2} (${sku}): ${errors[0]}`); continue; }

            try {
                if (existing) {
                    delete data.faqs;              // el CSV no trae FAQs: se conservan las cargadas
                    existing.set(data);
                    await existing.save();
                } else {
                    await Product.create(data);
                }
                registrarAtributos(data.opciones);
                procesados++;
            } catch (err) {
                const motivo = err.code === 11000 ? "SKU duplicado"
                    : err.name === "ValidationError" ? (Object.values(err.errors)[0]?.message || "Datos inválidos")
                    : "Error al guardar";
                if (err.code !== 11000 && err.name !== "ValidationError") console.error(`[CSV] Fila ${i + 2}:`, err);
                errores.push(`Fila ${i + 2} (${cleanStr(sku, 60)}): ${motivo}`);
            }
        }

        borrarArchivo();
        res.status(200).json({
            message: `Se procesaron ${procesados} productos${errores.length ? ` · ${errores.length} con errores` : ""}.`,
            errores: errores.slice(0, 50),
        });
    } catch (error) {
        borrarArchivo();
        if (error.code === "TOO_MANY_ROWS") {
            return res.status(400).json({ message: `El CSV no puede tener más de ${MAX_CSV_ROWS} filas 🔴` });
        }
        console.error(`[${new Date().toISOString()}] ERROR en IMPORT CSV = POST`, error);
        res.status(500).json({ message: "Error en importación 🔴" });   // sin detalles internos
    }
});

/* ════════════════════════════════════════════════════════════════════════════
   CATEGORÍAS
════════════════════════════════════════════════════════════════════════════ */
// Letras (con tildes y ñ), números, espacios y guiones. De 2 a 50 caracteres.
const CATEGORY_RE = /^[\p{L}\d][\p{L}\d &-]{1,49}$/u;

productRouter.post("/api/categories", adminMiddleware, async (req, res) => {
    // Solo string; en minúscula igual que en los productos (así el filtro y los cupones coinciden)
    const nombre = cleanStr(req.body?.nombre, 50).toLowerCase();
    if (!CATEGORY_RE.test(nombre)) {
        return res.status(400).json({ message: "Nombre de categoría inválido (2 a 50 letras, números, espacios o guiones) 🔴" });
    }
    try {
        const nuevaCategoria = new Category({ nombre });
        await nuevaCategoria.save();
        res.status(201).json(nuevaCategoria);
    } catch (error) {
        if (error.code === 11000) {
            return res.status(400).json({ message: "ERROR_SYSTEM: LA_CATEGORIA_YA_EXISTE_EN_DB" });
        }
        console.error(`[${new Date().toISOString()}] ERROR en CREAR CATEGORIA POST`, error);
        res.status(500).json({ message: "ERROR_INTERNAL_SERVER" });
    }
});

productRouter.get("/api/categories", async (req, res) => {
    try {
        const categorias = await Category.find();
        res.status(200).json({ message: "Categories found successfully! 🟢", categorias });
    } catch (error) {
        console.error(`[${new Date().toISOString()}] ERROR en productRouter LEER CATEGORIAS = GET :`, error);
        res.status(500).json({ message: "INTERNAL_SERVER_ERROR_READING_PRODUCTS! 🔴" });
    }
});

productRouter.delete("/api/categories/:id", adminMiddleware, async (req, res) => {
    if (!isId(req.params.id)) return res.status(400).json({ message: "Categoría inválida 🔴" });
    try {
        const borrada = await Category.findByIdAndDelete(req.params.id);
        if (!borrada) return res.status(404).json({ message: "Categoría no encontrada 🔴" });
        const categoriasActualizadas = await Category.find();
        res.status(200).json({ message: "Categoría eliminada", categoriasActualizadas });
    } catch (error) {
        console.error(`[${new Date().toISOString()}] ERROR en BORRAR CATEGORIA DELETE`, error);
        res.status(500).json({ message: "Error al borrar" });
    }
});

/* ════════════════════════════════════════════════════════════════════════════
   FAVORITOS
════════════════════════════════════════════════════════════════════════════ */
// Del cliente solo se toman productId e isFavorite. Nombre e imagen salen del producto en la BD:
// antes se guardaba lo que mandara el cliente (un nombre falso o una URL cualquiera).
productRouter.post('/api/product/toggle-fav', verifyToken, async (req, res) => {
    const { productId, isFavorite } = req.body ?? {};
    const userEmail = req.user?.email?.toLowerCase();

    if (!userEmail) return res.status(401).json({ message: "No autenticado 🔴" });
    if (!isId(productId) || typeof isFavorite !== "boolean") {
        return res.status(400).json({ message: "Faltan datos requeridos" });
    }

    try {
        if (isFavorite) {
            const product = await Product.findOne({ _id: productId, estado: "activo" }).select("nombre imagenes_generales").lean();
            if (!product) return res.status(404).json({ message: "Producto no encontrado 🔴" });

            const newFavorite = new Favorite({
                nombre:    product.nombre,
                userEmail,
                productId: product._id,
                img:       product.imagenes_generales?.[0] || "",
            });
            await newFavorite.save();
            return res.status(201).json({ message: "Agregado a favoritos", active: true });
        } else {
            await Favorite.findOneAndDelete({ userEmail, productId });
            return res.status(200).json({ message: "Eliminado de favoritos", active: false });
        }
    } catch (error) {
        if (error.code === 11000) return res.status(200).json({ message: "Ya estaba en favoritos", active: true });
        console.error(`[${new Date().toISOString()}] ERROR AL GUARDAR FAVORITOS, POST`, error);
        res.status(500).json({ message: "Error en el servidor" });
    }
});

productRouter.get('/api/product/fav/:email', verifyToken, async (req, res) => {
    if (req.user?.email?.toLowerCase() !== String(req.params.email).toLowerCase()) {
        return res.status(403).json({ message: "Sin permiso 🔴" });
    }
    try {
        const favorites = await Favorite.find({ userEmail: req.user.email.toLowerCase() }).limit(500);
        res.status(200).json(favorites);
    } catch (error) {
        console.error(`[${new Date().toISOString()}] ERROR AL OBTENER FAVORITOS, GET`, error);
        res.status(500).json({ message: "Error al obtener favoritos" });
    }
});

/* ════════════════════════════════════════════════════════════════════════════
   TIENDA — FILTROS
   ?attr=color:Azul,capacidad:128GB  → filtra por características de una misma variante
   ?talle=M                           → compatibilidad con el filtro anterior
════════════════════════════════════════════════════════════════════════════ */
productRouter.get('/api/products/brands', async (req, res) => {
    try {
        const brands = await Product.distinct('marca', { estado: 'activo' });
        res.status(200).json(brands.sort());
    } catch (error) {
        console.error(`[${new Date().toISOString()}] ERROR AL OBTENER MARCAS, GET /brands`, error);
        res.status(500).json([]);
    }
});

// Valores disponibles por característica para armar filtros en la tienda
productRouter.get('/api/products/attribute-filters', async (req, res) => {
    try {
        const rows = await Product.aggregate([
            { $match: { estado: 'activo' } },
            { $unwind: "$variantes" },
            { $match: { "variantes.activo": { $ne: false } } },
            { $unwind: "$variantes.atributos" },
            { $group: { _id: "$variantes.atributos.nombre", valores: { $addToSet: "$variantes.atributos.valor" } } },
            { $sort: { _id: 1 } },
        ]);
        res.status(200).json(rows.map(r => ({ nombre: r._id, valores: r.valores.sort() })));
    } catch (error) {
        console.error(`[${new Date().toISOString()}] ERROR attribute-filters`, error);
        res.status(500).json([]);
    }
});

productRouter.get(['/api/products/limit', '/api/products/filter'], async (req, res) => {
    try {
        // Solo strings y con largo máximo: un ?nombre=a&nombre=b (array) o un texto gigante
        // no arman regex enormes ni consultas raras
        const nombre    = qStr(req.query.nombre, 100);
        const marca     = qStr(req.query.marca, 80);
        const categoria = qStr(req.query.categoria, 50);
        const talle     = qStr(req.query.talle, 60);
        const attr      = qStr(req.query.attr, 300);
        const minPre    = qStr(req.query.minPre, 20);
        const maxPre    = qStr(req.query.maxPre, 20);
        const promo     = qStr(req.query.promo, 5);
        const stock     = qStr(req.query.stock, 5);
        const limit  = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
        const offset = Math.min(Math.max(Number(req.query.offset) || 0, 0), 10000);
        const query  = { estado: 'activo' };
        const and    = [];

        // ── BÚSQUEDA POR TEXTO ──
        if (nombre && String(nombre).trim()) {
            const terminos = String(nombre).trim().split(/\s+/).filter(Boolean).slice(0, 6).map(t => t.slice(0, 30));

            terminos.forEach(termino => {
                const t = escapeRegex(termino);
                const fuzzy = termino.length >= 4
                    ? new RegExp(termino.split('').map((_, i) => escapeRegex(termino.slice(0, i)) + '.?' + escapeRegex(termino.slice(i + 1))).join('|') + '|' + t, 'i')
                    : null;

                and.push({
                    $or: [
                        { nombre:      { $regex: t, $options: 'i' } },
                        { marca:       { $regex: t, $options: 'i' } },
                        { sku_padre:   { $regex: t, $options: 'i' } },
                        { descripcion: { $regex: t, $options: 'i' } },
                        { categorias:  { $regex: t, $options: 'i' } },
                        { 'variantes.atributos.valor': { $regex: t, $options: 'i' } },
                        { 'variantes.sku_variante':    { $regex: t, $options: 'i' } },
                        ...(fuzzy ? [{ nombre: { $regex: fuzzy } }, { marca: { $regex: fuzzy } }, { categorias: { $regex: fuzzy } }] : [])
                    ]
                });
            });
        }

        // ── FILTROS EXACTOS ──
        if (marca)     query.marca      = { $regex: new RegExp(`^${escapeRegex(marca)}$`, 'i') };
        if (categoria) query.categorias = { $regex: new RegExp(`^${escapeRegex(categoria)}$`, 'i') };
        if (promo === 'true') query.en_promocion = true;

        const min = Number(minPre), max = Number(maxPre);
        if ((minPre && Number.isFinite(min)) || (maxPre && Number.isFinite(max))) {
            query.precio_base = {};
            if (minPre && Number.isFinite(min)) query.precio_base.$gte = min;
            if (maxPre && Number.isFinite(max)) query.precio_base.$lte = max;
        }

        if (stock === 'true') {
            and.push({ $or: [{ stock_base: { $gt: 0 } }, { variantes: { $elemMatch: { stock: { $gt: 0 }, activo: { $ne: false } } } }] });
        }

        // ── CARACTERÍSTICAS DE VARIANTE ──
        const pares = [];
        if (talle) pares.push(["talle", String(talle)]);
        if (attr) {
            String(attr).split(",").slice(0, MAX_OPCIONES).forEach(par => {
                const i = par.indexOf(":");
                if (i > 0) pares.push([par.slice(0, i).trim().toLowerCase(), par.slice(i + 1).trim()]);
            });
        }
        if (pares.length) {
            and.push({
                variantes: {
                    $elemMatch: {
                        activo: { $ne: false },
                        $and: pares.map(([n, v]) => ({
                            atributos: { $elemMatch: { nombre: n, valor: { $regex: new RegExp(`^${escapeRegex(v)}$`, 'i') } } }
                        }))
                    }
                }
            });
        }

        if (and.length) query.$and = and;

        const [products, total] = await Promise.all([
            Product.find(query).sort({ createdAt: -1 }).limit(limit).skip(offset),
            Product.countDocuments(query)
        ]);

        res.status(200).json({ message: "Products fetched successfully! 🟢", products, total });
    } catch (error) {
        console.error(`[${new Date().toISOString()}] ERROR productRouter GET [ limit-filter ]`, error);
        res.status(500).json({ error: "INTERNAL_ERROR" });
    }
});

/* ════════════════════════════════════════════════════════════════════════════
   RESEÑAS
════════════════════════════════════════════════════════════════════════════ */
// Antes: Reseñas.create(reviewData) con el body tal cual. Cualquiera con sesión podía publicar
// reseñas a nombre de otro email, con rating 9999 o -50, y sin límite.
// Ahora: email del token, lista blanca de campos, rating entero 1–5, una reseña por producto
// y por usuario (índice único en el modelo) y máximo 5 por hora.
productRouter.post("/api/product/rating", verifyToken, async (req, res) => {
    const userEmail = req.user?.email?.toLowerCase();
    const uid       = req.user?.uid;
    if (!userEmail || !uid) return res.status(401).json({ message: "No autenticado 🔴" });

    const reviewData = req.body?.reviewData;
    if (!reviewData || typeof reviewData !== "object") {
        return res.status(400).json({ message: "All fields are required to create a product review! 🔴" });
    }

    const productId = reviewData.productId;
    const rating    = Number(reviewData.rating);
    const reseña    = typeof reviewData.reseña === "string"
        ? reviewData.reseña.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim()
        : "";

    if (!isId(productId))                                return res.status(400).json({ message: "Producto inválido 🔴" });
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) return res.status(400).json({ message: "El puntaje debe ser un entero de 1 a 5 🔴" });
    if (reseña.length < 3 || reseña.length > 500)        return res.status(400).json({ message: "La reseña debe tener entre 3 y 500 caracteres 🔴" });

    if (limiteResenas.bloqueado(uid)) {
        return res.status(429).json({ message: "Demasiadas reseñas seguidas. Probá más tarde 🔴" });
    }
    limiteResenas.sumar(uid);

    try {
        const existe = await Product.exists({ _id: productId, estado: "activo" });
        if (!existe) return res.status(404).json({ message: "Producto no encontrado 🔴" });

        const review = await Reseñas.create({ reseña, rating, userEmail, productId });
        res.status(201).json({
            message: "Review created successfully! 🟢",
            review: {
                _id:       review._id,
                reseña:    review.reseña,
                rating:    review.rating,
                productId: review.productId,
                userEmail: enmascararEmail(review.userEmail),
                createdAt: review.createdAt,
            },
        });
    } catch (error) {
        if (error?.code === 11000) {
            return res.status(409).json({ message: "Ya dejaste una reseña para este producto 🔴" });
        }
        console.error(`[${new Date().toISOString()}] ERROR AL CREAR REVIEW DE PRODUCTO`, error);
        res.status(500).json({ error: "INTERNAL_ERROR_PRODUCT REVIEW" });
    }
});

// Reseñas públicas: antes devolvía el email completo de cada cliente a cualquiera.
// Ahora va enmascarado ("ma•••@gmail.com"), con ?productId= opcional y tope de 500.
productRouter.get("/api/product-reviews", async (req, res) => {
    const filtro = {};
    if (req.query.productId !== undefined) {
        if (!isId(req.query.productId)) return res.status(400).json({ message: "Producto inválido 🔴" });
        filtro.productId = req.query.productId;
    }
    try {
        const reviews = await Reseñas.find(filtro)
            .sort({ createdAt: -1 })
            .limit(500)
            .select("reseña rating productId userEmail createdAt")
            .lean();
        res.status(200).json({
            message: "Reviews downloaded successfully! 🟢",
            reviews: reviews.map(r => ({ ...r, userEmail: enmascararEmail(r.userEmail) })),
        });
    } catch (error) {
        console.error(`[${new Date().toISOString()}] ERROR TRAER REVIEWS DE PRODUCTO`, error);
        res.status(500).json({ error: "INTERNAL ERROR TRAER REVIEWs DE PRODUCTO" });
    }
});

module.exports = productRouter;