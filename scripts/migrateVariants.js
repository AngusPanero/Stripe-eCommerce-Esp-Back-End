/* ════════════════════════════════════════════════════════════════════════════
   scripts/migrateVariants.js
   Convierte los productos viejos (talle / color / medida / gb / largo_cable
   como campos fijos) al modelo nuevo de atributos libres.

   Uso:
     node scripts/migrateVariants.js --dry   → muestra qué haría, sin escribir
     node scripts/migrateVariants.js         → migra

   Reglas:
   ─ Cada campo viejo con valor pasa a { nombre, valor } en variantes[].atributos
   ─ Producto con 1 sola variante → se convierte en producto único
     (su stock pasa a stock_base y su precio extra se suma al precio base)
   ─ Variantes sin ninguna característica distinta → "opción: Opción N"
   ─ Se conservan los _id de las variantes (carritos y favoritos siguen andando)
════════════════════════════════════════════════════════════════════════════ */
require("dotenv").config();
const mongoose  = require("mongoose");
const Product   = require("../models/productModel");
const Attribute = require("../models/AttributeSchema");

const DRY = process.argv.includes("--dry");

const LEGACY = [
    ["talle",       "talle"],
    ["color",       "color"],
    ["medida",      "medida"],
    ["gb",          "capacidad"],
    ["largo_cable", "largo de cable"],
];

(async () => {
    await mongoose.connect(process.env.MONGO_URI);
    const col = Product.collection;   // acceso directo: el schema nuevo ya no conoce los campos viejos

    const productos = await col.find({ "variantes.0": { $exists: true } }).toArray();
    let migrados = 0, aUnico = 0, sinCambios = 0;

    for (const p of productos) {
        const yaMigrado = p.variantes.every(v => Array.isArray(v.atributos) && v.atributos.length);
        if (yaMigrado) { sinCambios++; continue; }

        // ── 1 variante → producto único ──
        if (p.variantes.length === 1) {
            const v = p.variantes[0];
            const update = {
                $set: {
                    stock_base:  v.stock || 0,
                    precio_base: Math.round(((p.precio_base || 0) + (v.precio_adicional || 0)) * 100) / 100,
                    variantes:   [],
                    opciones:    [],
                },
            };
            console.log(`→ ÚNICO   ${p.sku_padre}  (stock ${v.stock || 0})`);
            if (!DRY) await col.updateOne({ _id: p._id }, update);
            aUnico++;
            continue;
        }

        // ── características usadas por alguna variante ──
        const usados = LEGACY.filter(([campo]) => p.variantes.some(v => v[campo] !== null && v[campo] !== undefined && String(v[campo]).trim() !== ""));

        const variantes = p.variantes.map((v, i) => {
            let atributos = usados
                .map(([campo, nombre]) => ({ nombre, valor: String(v[campo] ?? "").trim() || "—" }));
            if (!atributos.length) atributos = [{ nombre: "opción", valor: `Opción ${i + 1}` }];

            return {
                _id:              v._id,
                sku_variante:     v.sku_variante,
                atributos,
                stock:            v.stock || 0,
                precio_adicional: v.precio_adicional || 0,
                foto_variante:    v.foto_variante || null,
                activo:           true,
            };
        });

        // combinaciones repetidas → desempatar
        const vistos = new Map();
        variantes.forEach((v, i) => {
            const k = v.atributos.map(a => `${a.nombre}=${a.valor.toLowerCase()}`).join("|");
            if (vistos.has(k)) v.atributos.push({ nombre: "opción", valor: `Opción ${i + 1}` });
            vistos.set(k, true);
        });
        // si se agregó "opción" a alguna, todas deben tenerla
        if (variantes.some(v => v.atributos.some(a => a.nombre === "opción"))) {
            variantes.forEach((v, i) => {
                if (!v.atributos.some(a => a.nombre === "opción")) v.atributos.push({ nombre: "opción", valor: `Opción ${i + 1}` });
            });
        }

        const orden = variantes[0].atributos.map(a => a.nombre);
        const opciones = orden.map(nombre => ({
            nombre,
            valores: [...new Set(variantes.map(v => v.atributos.find(a => a.nombre === nombre)?.valor).filter(Boolean))],
        }));

        console.log(`→ VARIANTES ${p.sku_padre}  [${orden.join(", ")}]  ${variantes.length} variantes`);
        if (!DRY) {
            await col.updateOne({ _id: p._id }, { $set: { variantes, opciones, stock_base: 0 } });
            await Attribute.registrar(opciones);
        }
        migrados++;
    }

    // categorías en minúscula (el schema viejo tenía un typo y no las normalizaba)
    if (!DRY) {
        const todos = await col.find({}, { projection: { categorias: 1 } }).toArray();
        for (const p of todos) {
            const cats = (p.categorias || []).map(c => String(c).trim().toLowerCase());
            if (JSON.stringify(cats) !== JSON.stringify(p.categorias || [])) {
                await col.updateOne({ _id: p._id }, { $set: { categorias: cats } });
            }
        }
    }

    console.log(`\n${DRY ? "[DRY RUN] " : ""}Migrados con variantes: ${migrados} · Pasados a único: ${aUnico} · Ya estaban OK: ${sinCambios}`);
    await mongoose.disconnect();
})().catch(async (err) => {
    console.error("Error en la migración:", err);
    await mongoose.disconnect();
    process.exit(1);
});