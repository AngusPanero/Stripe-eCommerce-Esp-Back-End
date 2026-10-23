const express = require('express');
const productRouter = express.Router();
const Product   = require('../models/productModel');
const Category  = require("../models/CategorySchema");
const Attribute = require("../models/AttributeSchema");
const Favorite  = require("../models/FavoriteSchema");
const Reseñas   = require("../models/ReseñasSchema");
const mongoose  = require('mongoose');

// CSV
const multer = require('multer');
const csv    = require('csv-parser');
const fs     = require('fs');
const upload = multer({ dest: 'uploads/', limits: { fileSize: 10 * 1024 * 1024 } });

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
            if (v?._id && mongoose.Types.ObjectId.isValid(v._id)) out._id = v._id;   // conserva el id (carritos/favoritos)
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

// READ ALL
productRouter.get("/api/products", async (req, res) => {
    try {
        const products = await Product.find();
        res.status(200).json({ message: "Products fetched successfully! 🟢", products });
    } catch (error) {
        console.error(`[${new Date().toISOString()}] ERROR en productRouter = GET :`, error);
        res.status(500).json({ message: "INTERNAL_SERVER_ERROR_READING_PRODUCTS! 🔴" });
    }
});

// GET EXPORT CSV  (va antes de /api/product/:id para que no lo capture)
// Formato de la columna variantes:  SKU ~ stock ~ extra ~ color: Azul / capacidad: 128GB  |  SKU2 ~ ...
productRouter.get("/api/products/export-csv", adminMiddleware, async (req, res) => {
    try {
        const productos = await Product.find({}).lean();
        const BOM  = '\uFEFF';
        const cell = (v) => `"${String(v ?? "").replace(/"/g, '""').replace(/\r?\n/g, " ")}"`;

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

// READ INDIVIDUAL
productRouter.get("/api/product/:id", async (req, res) => {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({ message: "ObjectID format is invalid!. 🔴" });
    }
    try {
        const product = await Product.findById(id);
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
    if (!mongoose.Types.ObjectId.isValid(id)) {
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
    if (!mongoose.Types.ObjectId.isValid(variantId)) return res.status(400).json({ message: "ID de variante inválido 🔴" });

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
    const { ids, cambios = {} } = req.body;

    if (!Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({ message: "Debes seleccionar al menos un producto para actualizar. 🔴" });
    }
    const validIds = ids.filter(id => mongoose.Types.ObjectId.isValid(id));

    const setFields = {};
    if (["activo", "pausado", "borrado"].includes(cambios.estado)) setFields.estado = cambios.estado;
    if (typeof cambios.marca === "string" && cambios.marca.trim()) setFields.marca = cambios.marca.trim().toLowerCase();
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
        if (pct <= -100) return res.status(400).json({ message: "El ajuste de precio no puede ser de -100% o menos 🔴" });
        pipeline.push({ $set: { precio_base: { $round: [{ $multiply: ["$precio_base", 1 + pct / 100] }, 2] } } });
    }

    const delta = toNum(cambios.stock_a_sumar);
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
    if (!mongoose.Types.ObjectId.isValid(id)) {
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
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({ message: "Debes seleccionar al menos un producto para eliminar. 🔴" });
    }
    try {
        const result = await Product.deleteMany({ _id: { $in: ids.filter(id => mongoose.Types.ObjectId.isValid(id)) } });
        res.status(200).json({ message: "Massive delete made successfully! 🟢", detalles: { total_seleccionados: ids.length, total_eliminados: result.deletedCount } });
    } catch (error) {
        console.error(`[${new Date().toISOString()}] 🚨 ERROR en bulk-delete:`, error);
        res.status(500).json({ message: "INTERNAL_SERVER_ERROR_IN_BULK_DELETE! 🔴" });
    }
});

// IMPORT CSV — admin primero, después se acepta el archivo
productRouter.post("/api/products/bulk-import", adminMiddleware, upload.single('archivo'), async (req, res) => {
    if (!req.file) return res.status(400).json({ message: "Archivo no encontrado" });

    const borrarArchivo = () => { if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path); };
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
            fs.createReadStream(req.file.path)
                .pipe(csv({ separator: ';', mapHeaders: ({ header }) => header.replace(/^\uFEFF/, "").trim() }))
                .on('data', (d) => out.push(d))
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
                errores.push(`Fila ${i + 2} (${sku}): ${err.code === 11000 ? "SKU duplicado" : err.message}`);
            }
        }

        borrarArchivo();
        res.status(200).json({
            message: `Se procesaron ${procesados} productos${errores.length ? ` · ${errores.length} con errores` : ""}.`,
            errores: errores.slice(0, 50),
        });
    } catch (error) {
        borrarArchivo();
        console.error(`[${new Date().toISOString()}] ERROR en IMPORT CSV = POST`, error);
        res.status(500).json({ message: "Error en importación", error: error.message });
    }
});

/* ════════════════════════════════════════════════════════════════════════════
   CATEGORÍAS
════════════════════════════════════════════════════════════════════════════ */
productRouter.post("/api/categories", adminMiddleware, async (req, res) => {
    try {
        const { nombre } = req.body;
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
    try {
        await Category.findByIdAndDelete(req.params.id);
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
productRouter.post('/api/product/toggle-fav', verifyToken, async (req, res) => {
    const { nombre, productId, isFavorite, img } = req.body;
    const userEmail = req.user?.email?.toLowerCase();

    if (!userEmail || !productId) return res.status(400).json({ message: "Faltan datos requeridos" });

    try {
        if (isFavorite) {
            const newFavorite = new Favorite({ nombre, userEmail, productId, img });
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
        const favorites = await Favorite.find({ userEmail: req.params.email.toLowerCase() });
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
        const { nombre, marca, categoria, talle, attr, minPre, maxPre, promo, stock } = req.query;
        const limit  = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
        const offset = Math.max(Number(req.query.offset) || 0, 0);
        const query  = { estado: 'activo' };
        const and    = [];

        // ── BÚSQUEDA POR TEXTO ──
        if (nombre && String(nombre).trim()) {
            const terminos = String(nombre).trim().split(/\s+/).filter(Boolean).slice(0, 6);

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

        if (minPre || maxPre) {
            query.precio_base = {};
            if (minPre) query.precio_base.$gte = Number(minPre);
            if (maxPre) query.precio_base.$lte = Number(maxPre);
        }

        if (stock === 'true') {
            and.push({ $or: [{ stock_base: { $gt: 0 } }, { variantes: { $elemMatch: { stock: { $gt: 0 }, activo: { $ne: false } } } }] });
        }

        // ── CARACTERÍSTICAS DE VARIANTE ──
        const pares = [];
        if (talle) pares.push(["talle", String(talle)]);
        if (attr) {
            String(attr).split(",").forEach(par => {
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
productRouter.post("/api/product/rating", verifyToken, async (req, res) => {
    const { reviewData } = req.body;
    try {
        if (!reviewData) {
            return res.status(400).json({ message: "All fields are required to create a product review! 🔴" });
        }
        const review = await Reseñas.create(reviewData);
        res.status(201).json({ message: "Review created successfully! 🟢", review });
    } catch (error) {
        console.error(`[${new Date().toISOString()}] ERROR AL CREAR REVIEW DE PRODUCTO`, error);
        res.status(500).json({ error: "INTERNAL_ERROR_PRODUCT REVIEW" });
    }
});

productRouter.get("/api/product-reviews", async (req, res) => {
    try {
        const reviews = await Reseñas.find();
        res.status(200).json({ message: "Reviews downloaded successfully! 🟢", reviews });
    } catch (error) {
        console.error(`[${new Date().toISOString()}] ERROR TRAER REVIEWS DE PRODUCTO`, error);
        res.status(500).json({ error: "INTERNAL ERROR TRAER REVIEWs DE PRODUCTO" });
    }
});

module.exports = productRouter;