const express = require("express");
const contactRouter = express.Router();
const Contact = require("../models/ContactSchema");
const { getClientIp } = require("../middleware/adminMiddleware");
const { sendContactEmail } = require("../nodemailer/nodemailer");

const esProduccion = (process.env.NODE_ENV === 'production');

/* ═══════════════════════════════════════════════
   VALIDACIÓN
   Mismos límites que los inputs de ContactMinimal.tsx
═══════════════════════════════════════════════ */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const NAME_RE  = /^\p{L}[\p{L}' .-]{1,59}$/u;           // letras, espacios, apóstrofo, punto, guion (2–60)
const TEL_RE   = /^\+?[\d\s()-]{6,25}$/;                 // dígitos, espacios, paréntesis, guiones, + inicial
const TEXT_MIN = 10;
const TEXT_MAX = 2000;

// Las mismas opciones del <select> del front: nada fuera de esta lista
const TRABAJOS = ["Calefactor", "Parrilla", "Hogar", "Estufa", "Distribuidor", "Service", "Presupuesto", "Otro"];

const limpiar = (v) => (typeof v === "string" ? v.trim().replace(/\s+/g, " ") : "");
const limpiarTexto = (v) => (typeof v === "string" ? v.trim().replace(/\r\n/g, "\n") : "");

/* ═══════════════════════════════════════════════
   FRENO AL SPAM (por IP, en memoria)
   Máximo CONTACT_MAX envíos cada CONTACT_WINDOW por IP.
═══════════════════════════════════════════════ */
const CONTACT_MAX    = 5;
const CONTACT_WINDOW = 30 * 60 * 1000;
const envios = new Map();   // ip -> { count, first }

const contactoBloqueado = (ip) => {
    const r = envios.get(ip);
    if (!r) return false;
    if (Date.now() - r.first > CONTACT_WINDOW) { envios.delete(ip); return false; }
    return r.count >= CONTACT_MAX;
};
const sumarEnvio = (ip) => {
    const now = Date.now();
    const r = envios.get(ip);
    if (!r || now - r.first > CONTACT_WINDOW) envios.set(ip, { count: 1, first: now });
    else r.count += 1;
    // limpieza para que el Map no crezca sin límite
    if (envios.size > 5000) {
        for (const [k, v] of envios) if (now - v.first > CONTACT_WINDOW) envios.delete(k);
    }
};

/* ═══════════════════════════════════════════════
   POST /contact
═══════════════════════════════════════════════ */
contactRouter.post("/contact", async (req, res) => {
    const ip = getClientIp(req);

    if (contactoBloqueado(ip)) {
        return res.status(429).json({ message: "Demasiadas consultas seguidas. Probá de nuevo más tarde. 🔴" });
    }

    const body = req.body ?? {};

    // Honeypot: campo oculto que una persona nunca ve ni completa. Si llega con algo, es un bot.
    // Se responde igual que un éxito para no darle pistas, pero no se guarda nada.
    if (typeof body.website === "string" && body.website.trim() !== "") {
        sumarEnvio(ip);
        return res.status(201).json({ message: "¡Formulario de contacto enviado con éxito! 🟢" });
    }

    // Solo strings y solo los campos permitidos (lista blanca): nada de objetos con $ ni campos extra
    const name    = limpiar(body.name);
    const surname = limpiar(body.surname);
    const email   = limpiar(body.email).toLowerCase();
    const tel     = limpiar(body.tel);
    const text    = limpiarTexto(body.text);
    const trabajo = limpiar(body.trabajo);

    if (!name || !surname || !email || !tel || !text || !trabajo) {
        return res.status(400).json({ message: "Faltan campos obligatorios. 🔴" });
    }

    const errors = {};
    if (!NAME_RE.test(name))                                   errors.name    = "Nombre no válido (de 2 a 60 letras).";
    if (!NAME_RE.test(surname))                                errors.surname = "Apellido no válido (de 2 a 60 letras).";
    if (email.length > 254 || !EMAIL_RE.test(email))           errors.email   = "Email no válido.";
    if (!TEL_RE.test(tel))                                     errors.tel     = "Teléfono no válido.";
    if (text.length < TEXT_MIN || text.length > TEXT_MAX)      errors.text    = `El mensaje debe tener entre ${TEXT_MIN} y ${TEXT_MAX} caracteres.`;
    if (!TRABAJOS.includes(trabajo))                           errors.trabajo = "Asunto no válido.";

    if (Object.keys(errors).length) {
        return res.status(400).json({ message: "Revisá los datos del formulario. 🔴", errors });
    }

    // Cuenta el intento antes de guardar: así 100 pedidos en paralelo no pasan todos
    sumarEnvio(ip);

    try {
        await Contact.create({ name, surname, email, tel, text, trabajo });
    } catch (error) {
        // Log sin los datos personales del formulario
        console.error("Error al crear contacto! 🔴", esProduccion ? error.message : error);
        return res.status(500).json({ message: "Error interno del servidor al procesar el contacto. 🔴" });
    }

    // Aviso por mail desde el servidor (antes lo pedía el front a /send-email, una ruta pública).
    // Si el mail falla, la consulta ya quedó guardada: se responde igual 201 y se loguea.
    try {
        await sendContactEmail({ name, surname, email, tel, text, trabajo });
    } catch (error) {
        console.error("Error enviando aviso de contacto 🟡", esProduccion ? error.message : error);
    }

    return res.status(201).json({ message: "¡Formulario de contacto enviado con éxito! 🟢" });
});

module.exports = contactRouter;