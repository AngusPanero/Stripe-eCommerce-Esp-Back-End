const express = require('express');
const productRouter = express.Router();
const Product = require('../models/productModel');
const Category = require("../models/CategorySchema")
const Favorite = require("../models/FavoriteSchema")
const Reseñas = require("../models/ReseñasSchema")
const Coupon = require("../models/CouponSchema")
const mongoose = require('mongoose');   

// CSV EXCEL
const multer = require('multer');
const csv = require('csv-parser');
const fs = require('fs');
const { refreshToken } = require('firebase-admin/app');
const upload = multer({ dest: 'uploads/' });

const adminMiddleware = require("../middleware/adminMiddleware")
const verifyToken = require("../middleware/authMiddleware")

const esProduccion = (process.env.NODE_ENV === 'production');

// CREATE INDIVIDUAL
productRouter.post("/api/product/create", adminMiddleware, async (req, res) => {
    const { formData } = req.body;
    console.log("FORM DATA", formData);

    if (!formData.nombre || !formData.sku_padre || !formData.marca || !formData.precio_base || !formData.stock_base) {
        return res.status(400).json({ message: "Faltan campos obligatorios! 🔴" });
    }

    if (!Array.isArray(formData.imagenes_generales) || formData.imagenes_generales.length === 0) {
        return res.status(400).json({ message: "Debes subir al menos una imagen general del producto! 🔴" });
    }

    if (typeof formData.precio_base !== 'number' || typeof formData.stock_base !== 'number') {
        return res.status(409).json({ message: "Error de tipo: precio_base y stock_base deben ser números. 🔴" });
    }

    if (formData.porcentaje_promo && typeof formData.porcentaje_promo !== 'number') {
        return res.status(409).json({ message: "Error de tipo: porcentaje_promo debe ser un número. 🔴" });
    }

    if (formData.en_promocion !== undefined && typeof formData.en_promocion !== 'boolean') {
        return res.status(409).json({ message: "Error de tipo: en_promocion debe ser un valor booleano. 🔴" });
    }

    if (typeof formData.nombre !== 'string' || typeof formData.sku_padre !== 'string' || typeof formData.marca !== 'string') {
        return res.status(409).json({ message: "Error de tipo: nombre, marca y sku_padre deben ser cadenas de texto. 🔴" });
    }

    try {
        const newProduct = await Product.create(formData);
        res.status(201).json({ message: "Product created successfully! 🟢", product: newProduct });

    } catch (error) {
        console.error(`[${new Date().toISOString()}] ERROR en productRouter = POST /create:`, error);

        if (error.code === 11000) {
            return res.status(409).json({ status: 'error', message: 'El SKU_PADRE o uno de los SKU_VARIANTE ya existe en la base de datos.'});
        }
        res.status(500).json({ message: "INTERNAL_SERVER_ERROR_CREATING_PRODUCT 🔴" });
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
        if (!product) {
            return res.status(404).json({ message: "Product not found! 🔴" });
        }
        res.status(200).json({ message: "Product found successfully! 🟢", product });
    } catch(error) {
        console.error(`[${new Date().toISOString()}] ERROR en productRouter = GET /:id:`, error);
        res.status(500).json({ message: "INTERNAL_SERVER_ERROR_READING_PRODUCT! 🔴" });
    }
})

// READ ALL
productRouter.get("/api/products", async (req, res) => {
    try { 
        const products = await Product.find(); 
        res.status(200).json({ message: "Products fetched successfully! 🟢", products });
    } catch(error) {
        console.error(`[${new Date().toISOString()}] ERROR en productRouter = GET :`, error);
        res.status(500).json({ message: "INTERNAL_SERVER_ERROR_READING_PRODUCTS! 🔴" });
    }
});

// READ ALL LIMIT/OFF-SET
productRouter.get("/api/products/limit", async (req, res) => {
    try {
        const limit = Number(req.query.limit) || 20;
        const offset = Number(req.query.offset) || 0;

        const [products, total] = await Promise.all([
            Product.find().sort({ createdAt: -1 }).limit(limit).skip(offset), Product.countDocuments()]);

        res.status(200).json({ message: "Products fetched successfully! 🟢", products, total });
    } catch(error) {
        console.error(`[${new Date().toISOString()}] ERROR en productRouter = GET :`, error);
        res.status(500).json({ message: "INTERNAL_SERVER_ERROR_READING_PRODUCTS! 🔴" });
    }
});

// UPDATE INDIVIDUAL
productRouter.put("/api/product/update/:id", adminMiddleware, async (req, res) => {
    const { id } = req.params
    const { formData } = req.body

    console.log("FORMDATA", formData);

    if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({ message: "ObjectID format is invalid!. 🔴" });
    }

    const { nombre, sku_padre, marca, precio_base, stock_base } = formData;
    if (!nombre || !sku_padre || !marca || precio_base === undefined || stock_base === undefined) {
        return res.status(400).json({ message: "Faltan campos obligatorios (nombre, sku, marca, precio o stock)! 🔴" });
    }

    if (!Array.isArray(formData.imagenes_generales) || formData.imagenes_generales.length === 0) {
        return res.status(400).json({ message: "Debes subir al menos una imagen general del producto! 🔴" });
    }

    if (typeof formData.precio_base !== 'number' || typeof formData.stock_base !== 'number') {
        return res.status(409).json({ message: "Error de tipo: precio_base y stock_base deben ser números. 🔴" });
    }

    if (formData.porcentaje_promo && typeof formData.porcentaje_promo !== 'number') {
        return res.status(409).json({ message: "Error de tipo: porcentaje_promo debe ser un número. 🔴" });
    }

    if (formData.en_promocion !== undefined && typeof formData.en_promocion !== 'boolean') {
        return res.status(409).json({ message: "Error de tipo: en_promocion debe ser un valor booleano. 🔴" });
    }

    if (typeof formData.nombre !== 'string' || typeof formData.sku_padre !== 'string' || typeof formData.marca !== 'string') {
        return res.status(409).json({ message: "Error de tipo: nombre, marca y sku_padre deben ser cadenas de texto. 🔴" });
    }

    try {
        const updatedProduct = await Product.findByIdAndUpdate(id, { $set: formData }, { new: true, runValidators: true, context: 'query' });
        if (!updatedProduct) {
            return res.status(404).json({ message: "Product not found! 🔴" });
        }
        res.status(200).json({ message: "Product updated successfully! 🟢", product: updatedProduct });

    } catch (error) {
        if (error.code === 11000) {
            return res.status(409).json({ status: 'error', message: "Error: El SKU que intentas asignar ya está siendo usado por otro producto. 🔴" });
        }
        console.error(`[${new Date().toISOString()}] ERROR en productRouter = PUT /:id:`, error);
        res.status(500).json({ message: "INTERNAL_SERVER_ERROR_UPDATING_PRODUCT! 🔴" });
    }
})

// UPDATE VARIANT
productRouter.patch("/api/product/update-variant/:variantId", adminMiddleware, async (req, res) => {
    try {
        const { variantId } = req.params;
        const { formData } = req.body; 

        const updateQuery = {};
        for (const llave in formData) {
            updateQuery[`variantes.$.${llave}`] = formData[llave];
        }

        const productoActualizado = await Product.findOneAndUpdate(
            { "variantes._id": variantId },
            { $set: updateQuery },
            { new: true, runValidators: true } 
        );

        if (!productoActualizado) {
            return res.status(404).json({ message: "No se encontró la variante con ese ID ❌" });
        }

        res.status(200).json({ 
            message: "Variante actualizada con éxito ✅", 
            product: productoActualizado 
        });

    } catch (error) {
        console.error(`[${new Date().toISOString()}] ERROR en productRouter = PATCH VARIANT /:id:`, error);
        res.status(500).json({ message: "Error interno" });
    }
});

// MASSIVE UPDATE
productRouter.patch("/api/bulk-update", adminMiddleware, async (req, res) => {
    const { ids, cambios } = req.body;

    if (!Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({ 
            message: "Debes seleccionar al menos un producto para actualizar. 🔴" 
        });
    }

    try {
        let updateQuery = {};
        let setFields = {};

        if (cambios.estado)  setFields.estado = cambios.estado;
        if (cambios.marca)   setFields.marca  = cambios.marca;

        if (typeof cambios.en_promocion !== 'undefined')
            setFields.en_promocion = cambios.en_promocion;

        if (typeof cambios.porcentaje_promo !== 'undefined')
            setFields.porcentaje_promo = cambios.porcentaje_promo;

        if (Object.keys(setFields).length > 0) updateQuery.$set = setFields;

        if (cambios.porcentaje_precio) {
            const factor = 1 + (cambios.porcentaje_precio / 100);
            updateQuery.$mul = { precio_base: factor };
        }

        if (typeof cambios.stock_a_sumar === 'number')
            updateQuery.$inc = { "variantes.$[].stock": cambios.stock_a_sumar };

        const result = await Product.updateMany(
            { _id: { $in: ids } }, 
            updateQuery, 
            { runValidators: true }
        );

        res.status(200).json({ 
            message: "Actualización masiva completada con éxito! 🟢", 
            detalles: { 
                total_seleccionados: ids.length, 
                total_modificados: result.modifiedCount 
            }
        });

    } catch (error) {
        console.error(`[${new Date().toISOString()}] 🚨 ERROR en bulk-update:`, error);
        res.status(500).json({ message: "INTERNAL_SERVER_ERROR_IN_BULK_UPDATE! 🔴" });
    }
});

// DELETE INDIVIDUAL
productRouter.delete("/api/product/delete/:id", adminMiddleware, async (req, res) => {
    const { id } = req.params

    if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({ message: "ObjectID format is invalid!. 🔴" });
    }
    try {
        const deletedProduct = await Product.findByIdAndDelete(id);
        if (!deletedProduct) {
            return res.status(404).json({ message: "Product not found! 🔴" });
        }
        res.status(200).json({ message: "Product deleted successfully! 🟢", product: deletedProduct });
    } catch (error) {
        if (error.code === 11000) {
            return res.status(409).json({ status: 'error', message: "Error: El SKU que intentas asignar ya está siendo usado por otro producto. 🔴" });
        }
        console.error(`[${new Date().toISOString()}] ERROR en productRouter = DELETE /:id:`, error);
        res.status(500).json({ message: "INTERNAL_SERVER_ERROR_DELETING_PRODUCT! 🔴"});
    }
})

// MASSIVE DELETE
productRouter.delete("/api/bulk-delete", adminMiddleware, async (req, res) => {
    const { ids } = req.body;

    if (!Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({ 
            message: "Debes seleccionar al menos un producto para eliminar. 🔴" 
        });
    }
    try {
        const result = await Product.deleteMany({ _id: { $in: ids } }); 
        res.status(200).json({ message: "Massive delete made successfully! 🟢", detalles: { total_seleccionados: ids.length, total_eliminados: result.deletedCount } });
    } catch (error) {
        console.error(`[${new Date().toISOString()}] 🚨 ERROR en bulk-delete:`, error);
        res.status(500).json({ message: "INTERNAL_SERVER_ERROR_IN_BULK_DELETE! 🔴"});
    }
});

// GET EXPORT CSV
productRouter.get("/api/products/export-csv", adminMiddleware, async (req, res) => {
    try {
        const productos = await Product.find({}).lean();
        const BOM = '\uFEFF';
        
        const headers = [
            "_id", "nombre", "marca", "sku_padre", "estado", "precio_base", 
            "stock_base", "en_promocion", "porcentaje_promo",
            "categorias", "descripcion", "imagenes_generales", 
            "peso", "ancho", "alto", "largo", 
            "variantes"
        ];

        let csvContent = headers.join(";") + "\n";

        productos.forEach(p => {
            const categoriasStr = p.categorias ? p.categorias.join(" | ") : "";
            const imagenesStr   = p.imagenes_generales ? p.imagenes_generales.join(" | ") : "";
            
            const variantesStr = p.variantes ? p.variantes.map(v => 
                `${v.sku_variante || ''},${v.talle || ''},${v.color || ''},${v.medida || ''},${v.stock || 0},${v.precio_adicional || 0},${v.foto_variante || ''}`
            ).join(" | ") : "";

            const row = [
                p._id,
                `"${p.nombre}"`,
                `"${p.marca}"`,
                `"${p.sku_padre}"`,
                p.estado,
                p.precio_base,
                p.stock_base || 0,
                p.en_promocion ? "true" : "false",
                p.porcentaje_promo || 0,
                `"${categoriasStr}"`,
                `"${(p.descripcion || "").replace(/;/g, ',').replace(/\n/g, ' ')}"`,
                `"${imagenesStr}"`,
                p.medidas_empaque?.peso || 0,
                p.medidas_empaque?.ancho || 0,
                p.medidas_empaque?.alto || 0,
                p.medidas_empaque?.largo || 0,
                `"${variantesStr}"`
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

// UPLOAD EXPORT CSV
productRouter.post("/api/products/bulk-import", upload.single('archivo'), adminMiddleware, async (req, res) => {
    if (!req.file) return res.status(400).json({ message: "Archivo no encontrado" });

    const resultados = [];
    let procesados = 0;

    const procesar = () => {
        return new Promise((resolve, reject) => {
            fs.createReadStream(req.file.path)
                .pipe(csv({ separator: ';' }))
                .on('data', (data) => resultados.push(data))
                .on('end', async () => {
                    try {
                        for (const fila of resultados) {
                            if (!fila.sku_padre) continue;

                            let variantesArray = [];
                            if (fila.variantes && fila.variantes.trim() !== "") {
                                variantesArray = fila.variantes.split('|').map(vStr => {
                                    const campos = vStr.split(',').map(s => s.trim());
                                    return {
                                        sku_variante:     campos[0],
                                        talle:            campos[1] || null,
                                        color:            campos[2] || null,
                                        medida:           campos[3] || null,
                                        gb:               campos[4] || null,
                                        largo_cable:      campos[5] || null,
                                        stock:            Number(campos[6]) || 0,
                                        precio_adicional: Number(campos[7]) || 0,
                                        foto_variante:    campos[8] || null
                                    };
                                }).filter(v => v.sku_variante);
                            }

                            const datosProducto = {
                                nombre:            fila.nombre?.replace(/"/g, ''),
                                marca:             fila.marca?.replace(/"/g, ''),
                                sku_padre:         fila.sku_padre.trim().replace(/"/g, ''),
                                precio_base:       Number(fila.precio_base) || 0,
                                stock_base:        Number(fila.stock_base) || 0,
                                en_promocion:      fila.en_promocion === 'true',
                                porcentaje_promo:  Number(fila.porcentaje_promo) || 0,
                                estado:            fila.estado || 'activo',
                                descripcion:       fila.descripcion?.replace(/"/g, ''),
                                categorias:        fila.categorias ? fila.categorias.replace(/"/g, '').split('|').map(c => c.trim()) : [],
                                imagenes_generales:fila.imagenes_generales ? fila.imagenes_generales.replace(/"/g, '').split('|').map(i => i.trim()) : [],
                                variantes:         variantesArray,
                                medidas_empaque: {
                                    peso:  Number(fila.peso)  || 0,
                                    ancho: Number(fila.ancho) || 0,
                                    alto:  Number(fila.alto)  || 0,
                                    largo: Number(fila.largo) || 0
                                }
                            };

                            await Product.findOneAndUpdate(
                                { sku_padre: datosProducto.sku_padre },
                                { $set: datosProducto },
                                { upsert: true, runValidators: true }
                            );
                            procesados++;
                        }
                        resolve();
                    } catch (err) { reject(err); }
                });
        });
    };

    try {
        await procesar();
        if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        res.status(200).json({ message: `Se procesaron ${procesados} productos correctamente.` });
    } catch (error) {
        if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        console.error(`[${new Date().toISOString()}] ERROR en IMPORT CSV = POST`, error);
        res.status(500).json({ message: "Error en importación", error: error.message });
    }
});

// CATEGORIA CREATE
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

// READ CATEGORÍA
productRouter.get("/api/categories", async (req, res) => {
    try {
        const categorias = await Category.find();
        res.status(200).json({ message: "Categories found successfully! 🟢", categorias });
    } catch(error) {
        console.error(`[${new Date().toISOString()}] ERROR en productRouter LEER CATEGORIAS = GET :`, error);
        res.status(500).json({ message: "INTERNAL_SERVER_ERROR_READING_PRODUCTS! 🔴"});
    }
})

// BORRAR CATEGORÍA
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

// FAVORITOS
productRouter.post('/api/product/toggle-fav', verifyToken, async (req, res) => {
    console.log("BODY COMPLETO:", JSON.stringify(req.body, null, 2));
    const { nombre, userEmail, productId, isFavorite, img } = req.body;
    console.log("IMG RECIBIDO:", img, typeof img);
    console.log("FAVORITO", req.body);
    
    if (!userEmail || !productId) {
        return res.status(400).json({ message: "Faltan datos requeridos" });
    }

    try {
        if (isFavorite) {
            const newFavorite = new Favorite({ nombre, userEmail, productId, img });
            await newFavorite.save();
            return res.status(201).json({ message: "Agregado a favoritos", active: true });
        } else {
            await Favorite.findOneAndDelete({ nombre, userEmail, productId });
            return res.status(200).json({ message: "Eliminado de favoritos", active: false });
        }
    } catch (error) {
        if (error.code === 11000) {
            return res.status(200).json({ message: "Ya estaba en favoritos", active: true });
        }
        console.error(`[${new Date().toISOString()}] ERROR AL GUARDAR FAVORITOS, POST`, error);
        res.status(500).json({ message: "Error en el servidor", error });
    }
});

productRouter.get('/api/product/fav/:email', verifyToken, async (req, res) => {
    try {
        const favorites = await Favorite.find({ userEmail: req.params.email })
        res.status(200).json(favorites);
    } catch (error) {
        console.error(`[${new Date().toISOString()}] ERROR AL OBTENER FAVORITOS, GET`, error);
        res.status(500).json({ message: "Error al obtener favoritos" });
    }
});

// FILTROS
productRouter.get('/api/products/brands', async (req, res) => {
    try {
        const brands = await Product.distinct('marca', { estado: 'activo' });
        res.status(200).json(brands.sort());
    } catch (error) {
        console.error(`[${new Date().toISOString()}] ERROR AL OBTENER PRODUCTOR POR FILTRO DE MARCA, GET /brands`, error);
        res.status(500).json([]);
    }
});

productRouter.get(['/api/products/limit', '/api/products/filter'], async (req, res) => {
    try {
        const { limit = 20, offset = 0, nombre, marca, categoria, talle, minPre, maxPre, promo, stock } = req.query;
        let query = { estado: 'activo' };

        // ── BÚSQUEDA POR STRING ───────────────────────────────────
        if (nombre && nombre !== "") {
            const terminos = nombre.trim().split(/\s+/).filter(Boolean);

            const condicionesPorTermino = terminos.map(termino => {
                const fuzzyRegex = termino.length <= 3
                    ? new RegExp(termino, 'i')
                    : new RegExp(
                        termino.split('').map((_, i) =>
                            termino.slice(0, i) + '.?' + termino.slice(i + 1)
                        ).join('|') + '|' + termino,
                        'i'
                    );

                return {
                    $or: [
                        { nombre:                   { $regex: termino, $options: 'i' } },
                        { marca:                    { $regex: termino, $options: 'i' } },
                        { sku_padre:                { $regex: termino, $options: 'i' } },
                        { descripcion:              { $regex: termino, $options: 'i' } },
                        { categorias:               { $regex: termino, $options: 'i' } },
                        { 'variantes.talle':        { $regex: termino, $options: 'i' } },
                        { 'variantes.color':        { $regex: termino, $options: 'i' } },
                        { 'variantes.medida':       { $regex: termino, $options: 'i' } },
                        { 'variantes.gb':           { $regex: termino, $options: 'i' } },
                        { 'variantes.largo_cable':  { $regex: termino, $options: 'i' } },
                        { 'variantes.sku_variante': { $regex: termino, $options: 'i' } },
                        ...(termino.length >= 4 ? [
                            { nombre:     { $regex: fuzzyRegex } },
                            { marca:      { $regex: fuzzyRegex } },
                            { categorias: { $regex: fuzzyRegex } },
                        ] : [])
                    ]
                };
            });

            query.$and = condicionesPorTermino;
        }

        // ── FILTROS EXACTOS ───────────────────────────────────────
        if (marca     && marca !== "")     query.marca      = { $regex: new RegExp(`^${marca}$`, 'i') };
        if (categoria && categoria !== "") query.categorias = { $regex: new RegExp(`^${categoria}$`, 'i') };
        if (promo === 'true')              query.en_promocion = true;

        if (minPre || maxPre) {
            query.precio_base = {};
            if (minPre && minPre !== "") query.precio_base.$gte = Number(minPre);
            if (maxPre && maxPre !== "") query.precio_base.$lte = Number(maxPre);
        }

        if (stock === 'true') {
            query.$or = [{ stock_base: { $gt: 0 } }, { 'variantes.stock': { $gt: 0 } }];
        }

        if (talle && talle !== "") query['variantes.talle'] = talle;

        // ── QUERY ─────────────────────────────────────────────────
        const [products, total] = await Promise.all([
            Product.find(query).sort({ createdAt: -1 }).limit(Number(limit)).skip(Number(offset)),
            Product.countDocuments(query)
        ]);

        res.status(200).json({ products, total });
    } catch (error) {
        console.error(`[${new Date().toISOString()}] ERROR productRouter GET [ limit-filter ]`, error);
        res.status(500).json({ error: "INTERNAL_ERROR" });
    }
});

// RESEÑAS PRODUCTOS
productRouter.post("/api/product/rating", verifyToken, async (req, res) => {
    const { reviewData } = req.body
    try {
        if(!reviewData){
            return res.status(400).json({ message: "All fields are required to create a product review! 🔴" })
        }
        const review = await Reseñas.create(reviewData)
        res.status(201).json({ message: "Review created successfully! 🟢", review })
    } catch (error) {
        console.error(`[${new Date().toISOString()}] ERROR AL CREAR REVIEW DE PRODUCTO`, error);
        res.status(500).json({ error: "INTERNAL_ERROR_PRODUCT REVIEW" });
    }
})

productRouter.get("/api/product-reviews", async (req, res) => {
    try {
        const reviews = await Reseñas.find()
        res.status(200).json({ message: "Reviews downloaded successfully! 🟢", reviews })
    } catch (error) {
        console.error(`[${new Date().toISOString()}] ERROR TRAER REVIEWS DE PRODUCTO`, error);
        res.status(500).json({ error: "INTERNAL ERROR TRAER REVIEWs DE PRODUCTO" });   
    }
})

module.exports = productRouter;