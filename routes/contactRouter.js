const express    = require("express");
const mongoose   = require("mongoose");
const nodemailer = require("nodemailer");
const multer     = require("multer");
const Contact         = require("../models/ContactSchema");
const PaymentsMongo   = require("../models/Payments");
const adminMiddleware = require("../middleware/adminMiddleware");
const { getClientIp } = adminMiddleware;

const contactRouter = express.Router();
const esProduccion  = (process.env.NODE_ENV === 'production');

/* ════════════════════════════════════════════════════════════════════════════
   contactRouter — contacto, facturas y TODOS los mails de Dekin Hogar

   POST /contact              público (validado + límite por IP + honeypot)
   POST /:id/send-invoice     admin  (adjunta la factura al cliente del pedido)

   Además exporta `mail`: el transporte único y el diseño de los correos.
   Lo usan stripeRouter (ventas, reembolsos, disputas) y cartRouter
   (carrito abandonado), así todos los mails comparten la misma estética.

   .env
     EMAIL_FROM   cuenta que envía (Gmail)            PASS_EMAIL   contraseña de aplicación
     EMAIL_TO     recibe las consultas del formulario  ADMIN_EMAIL  recibe avisos de ventas
     STORE_NAME   (Dekin Hogar)  STORE_ADDRESS  (opcional)  FRONTEND_URL  (link de los botones)
════════════════════════════════════════════════════════════════════════════ */

/* ═══════════════════════════════════════════════
   TRANSPORTE ÚNICO
═══════════════════════════════════════════════ */
const STORE_NAME    = process.env.STORE_NAME || "Dekin Hogar";
const STORE_ADDRESS = process.env.STORE_ADDRESS || "";
const SITE_URL      = /^https?:\/\//i.test(process.env.FRONTEND_URL || "") ? process.env.FRONTEND_URL.replace(/\/+$/, "") : "";

const MAIL_CONFIGURADO = !!(process.env.EMAIL_FROM && process.env.PASS_EMAIL);
const DESTINO_CONTACTO = process.env.EMAIL_TO    || process.env.ADMIN_EMAIL || process.env.EMAIL_FROM || "";
const DESTINO_ADMIN    = process.env.ADMIN_EMAIL || process.env.EMAIL_TO    || process.env.EMAIL_FROM || "";

if (!MAIL_CONFIGURADO) {
    console.warn("[MAIL] Faltan EMAIL_FROM y/o PASS_EMAIL en el .env: no se va a enviar ningún mail 🟡");
} else {
    if (!process.env.EMAIL_TO)    console.warn(`[MAIL] Falta EMAIL_TO: las consultas del formulario van a ${DESTINO_CONTACTO} 🟡`);
    if (!process.env.ADMIN_EMAIL) console.warn(`[MAIL] Falta ADMIN_EMAIL: los avisos de ventas van a ${DESTINO_ADMIN} 🟡`);
}

const transporter = MAIL_CONFIGURADO
    ? nodemailer.createTransport({ service: "gmail", auth: { user: process.env.EMAIL_FROM, pass: process.env.PASS_EMAIL } })
    : null;

/* ═══════════════════════════════════════════════
   DISEÑO DE LOS MAILS
   Editorial y sobrio: hoja blanca sobre hueso, carbón para el texto,
   naranja solo como acento. Todo en tablas e inline (Gmail, Outlook, Apple Mail).
═══════════════════════════════════════════════ */
const C = {
    paper:  "#EFEAE4",   // fondo exterior
    sheet:  "#FFFFFF",
    ink:    "#1A1614",   // carbón
    body:   "#4A4340",
    muted:  "#8C847F",
    line:   "#E9E3DD",
    soft:   "#F7F4F1",
    accent: "#E84B1A",   // naranja Dekin
    green:  "#2F7A4B",
    amber:  "#B7650B",
};
const F_DISPLAY = "'Barlow Condensed','Arial Narrow','Helvetica Neue',Arial,sans-serif";
const F_BODY    = "'Barlow','Helvetica Neue',Helvetica,Arial,sans-serif";
const F_MONO    = "'SFMono-Regular',Menlo,Consolas,'Liberation Mono',monospace";

// Todo lo que viene de un usuario se escapa antes de meterlo en el HTML
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const eur = (cents) => (Math.round(Number(cents || 0)) / 100).toLocaleString("es-ES", { style: "currency", currency: "EUR" });
const safeHref = (u) => (/^(https?:|mailto:|tel:)/i.test(String(u || "")) ? esc(u) : "#");

const TONOS = {
    accent: { dot: C.accent, bg: "#FDF0EB", text: C.ink },
    ok:     { dot: C.green,  bg: "#EEF6F1", text: C.ink },
    warn:   { dot: C.amber,  bg: "#FBF4E8", text: C.ink },
    info:   { dot: C.muted,  bg: C.soft,    text: C.ink },
};

// Párrafo de cuerpo
const para = (html) =>
    `<p style="margin:0 0 16px;font-family:${F_BODY};font-size:15px;line-height:1.65;color:${C.body};">${html}</p>`;

// Aviso destacado (alertas al admin, notas al cliente)
const note = (html, tone = "accent") => {
    const t = TONOS[tone] || TONOS.accent;
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px;">
      <tr><td style="background:${t.bg};border-left:3px solid ${t.dot};padding:14px 18px;font-family:${F_BODY};font-size:14px;line-height:1.55;color:${t.text};">${html}</td></tr>
    </table>`;
};

// Sección con rótulo ("Resumen", "Datos del cliente"…)
const section = (label, html) =>
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0 28px;">
      <tr><td style="padding:0 0 10px;border-bottom:1px solid ${C.ink};font-family:${F_DISPLAY};font-size:12px;font-weight:700;letter-spacing:.2em;text-transform:uppercase;color:${C.ink};">${esc(label)}</td></tr>
      <tr><td style="padding:0;">${html}</td></tr>
    </table>`;

// Filas clave → valor. rows([["Pedido", "ORD-1"], ["Email", "<a…>", { raw: true }]])
const rows = (list) =>
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${list.filter(Boolean).map(([k, v, o = {}]) => `
      <tr>
        <td style="padding:11px 0;border-bottom:1px solid ${C.line};font-family:${F_BODY};font-size:13px;color:${C.muted};vertical-align:top;width:38%;">${esc(k)}</td>
        <td style="padding:11px 0;border-bottom:1px solid ${C.line};font-family:${o.mono ? F_MONO : F_BODY};font-size:${o.mono ? 13 : 14}px;font-weight:${o.mono ? 400 : 600};color:${o.color || C.ink};text-align:right;vertical-align:top;word-break:break-word;">${o.raw ? v : esc(v)}</td>
      </tr>`).join("")}
    </table>`;

// Productos. items: [{ nombre, detalle?, cantidad, totalCents, imagen? }]
// Si algún producto tiene foto, todos llevan la columna (los que no, un cuadro neutro)
const itemsTable = (items) => {
    const conFotos = items.some(i => /^https:\/\//i.test(i.imagen || ""));
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${items.map(i => {
        const td = `padding:14px 0;border-bottom:1px solid ${C.line};vertical-align:top;`;
        const img = !conFotos ? "" : /^https:\/\//i.test(i.imagen || "")
            ? `<td width="70" style="${td}padding-right:14px;"><img src="${esc(i.imagen)}" width="56" height="56" alt="" style="display:block;width:56px;height:56px;object-fit:cover;border:0;background:${C.soft};"/></td>`
            : `<td width="70" style="${td}padding-right:14px;"><div style="width:56px;height:56px;background:${C.soft};"></div></td>`;
        return `<tr>
        ${img}
        <td style="${td}">
          <p style="margin:0;font-family:${F_BODY};font-size:15px;font-weight:600;color:${C.ink};line-height:1.35;">${esc(i.nombre)}</p>
          <p style="margin:3px 0 0;font-family:${F_BODY};font-size:13px;color:${C.muted};">${i.detalle ? `${esc(i.detalle)} · ` : ""}Cantidad ${Number(i.cantidad) || 0}</p>
        </td>
        <td style="${td}padding-left:12px;font-family:${F_BODY};font-size:15px;font-weight:600;color:${C.ink};text-align:right;white-space:nowrap;">${eur(i.totalCents)}</td>
      </tr>`;
    }).join("")}
    </table>`;
};

// Totales. totals([["Subtotal", 1000], ["Cupón X", -100, { color }], ["Total", 900, { strong: true }]])
const totals = (list) =>
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:6px;">${list.filter(Boolean).map(([k, cents, o = {}]) => o.strong ? `
      <tr>
        <td style="padding:16px 0 0;border-top:1px solid ${C.ink};font-family:${F_DISPLAY};font-size:15px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:${C.ink};">${esc(k)}</td>
        <td style="padding:16px 0 0;border-top:1px solid ${C.ink};font-family:${F_DISPLAY};font-size:30px;font-weight:700;color:${C.ink};text-align:right;line-height:1;">${eur(cents)}</td>
      </tr>` : `
      <tr>
        <td style="padding:6px 0;font-family:${F_BODY};font-size:14px;color:${C.muted};">${esc(k)}</td>
        <td style="padding:6px 0;font-family:${F_BODY};font-size:14px;color:${o.color || C.body};text-align:right;">${o.text ? esc(o.text) : eur(cents)}</td>
      </tr>`).join("")}
    </table>`;

// Bloque de código (cupón)
const code = (value, caption = "") =>
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:4px 0 24px;">
      <tr><td align="center" style="border:1.5px dashed ${C.ink};padding:22px 16px;">
        <p style="margin:0 0 8px;font-family:${F_DISPLAY};font-size:11px;font-weight:700;letter-spacing:.24em;text-transform:uppercase;color:${C.accent};">Tu código</p>
        <p style="margin:0;font-family:${F_MONO};font-size:26px;font-weight:700;letter-spacing:.16em;color:${C.ink};">${esc(value)}</p>
        ${caption ? `<p style="margin:10px 0 0;font-family:${F_BODY};font-size:13px;color:${C.muted};">${esc(caption)}</p>` : ""}
      </td></tr>
    </table>`;

// Botón (sin imágenes, funciona en Outlook)
const button = (label, href, variant = "dark") => {
    const bg = variant === "accent" ? C.accent : C.ink;
    return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 4px;">
      <tr><td style="background:${bg};">
        <a href="${safeHref(href)}" target="_blank" style="display:inline-block;padding:16px 30px;font-family:${F_DISPLAY};font-size:15px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:#FFFFFF;text-decoration:none;">${esc(label)}&nbsp;&nbsp;→</a>
      </td></tr>
    </table>`;
};

/* Plantilla base
   layout({ preheader, eyebrow, tone, title, accent, intro, body, cta:{label,href}, ref, audience })
   · title: primera línea del titular · accent: segunda línea en naranja (opcional)
   · audience "admin" cambia el pie (aviso interno) */
function layout({ preheader = "", eyebrow = "", tone = "accent", title = "", accent = "", intro = "", body = "", cta = null, ref = "", audience = "cliente" }) {
    const t = TONOS[tone] || TONOS.accent;
    const pie = audience === "admin"
        ? "Aviso interno del panel de la tienda. No lo reenvíes: puede contener datos personales de clientes."
        : `Recibes este correo por tu actividad en ${esc(STORE_NAME)}. Si no fuiste tú, puedes ignorarlo.`;

    return `<!DOCTYPE html>
<html lang="es" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<meta name="x-apple-disable-message-reformatting"/>
<meta name="color-scheme" content="light"/>
<meta name="supported-color-schemes" content="light"/>
<title>${esc(title)}</title>
<link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@600;700&family=Barlow:wght@400;500;600&display=swap" rel="stylesheet"/>
<style>
  body{margin:0!important;padding:0!important;background:${C.paper};}
  a{color:${C.ink};}
  @media (max-width:620px){
    .dk-pad{padding-left:24px!important;padding-right:24px!important;}
    .dk-title{font-size:38px!important;}
  }
</style>
</head>
<body style="margin:0;padding:0;background:${C.paper};-webkit-text-size-adjust:100%;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">${esc(preheader)}&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.paper};">
  <tr><td align="center" style="padding:36px 12px 28px;">

    <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:${C.sheet};">

      <!-- cabecera: marca + referencia -->
      <tr><td class="dk-pad" style="padding:30px 44px 26px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
          <td style="vertical-align:bottom;">
            <span style="font-family:${F_DISPLAY};font-size:26px;font-weight:700;letter-spacing:.2em;color:${C.ink};line-height:1;">DEKIN</span><span style="display:inline-block;width:7px;height:7px;background:${C.accent};margin:0 0 3px 4px;"></span>
            <div style="font-family:${F_BODY};font-size:10px;font-weight:500;letter-spacing:.46em;text-transform:uppercase;color:${C.muted};margin-top:4px;">Hogar</div>
          </td>
          <td style="vertical-align:bottom;text-align:right;font-family:${F_MONO};font-size:11px;color:${C.muted};">${esc(ref)}</td>
        </tr></table>
      </td></tr>

      <!-- regla: segmento naranja + línea -->
      <tr><td class="dk-pad" style="padding:0 44px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
          <td width="48" style="height:3px;background:${C.accent};font-size:0;line-height:0;">&nbsp;</td>
          <td style="height:3px;font-size:0;line-height:0;border-bottom:1px solid ${C.line};">&nbsp;</td>
        </tr></table>
      </td></tr>

      <!-- titular -->
      <tr><td class="dk-pad" style="padding:40px 44px 8px;">
        ${eyebrow ? `<p style="margin:0 0 16px;font-family:${F_DISPLAY};font-size:12px;font-weight:700;letter-spacing:.24em;text-transform:uppercase;color:${t.dot};"><span style="display:inline-block;width:6px;height:6px;background:${t.dot};margin:0 8px 2px 0;"></span>${esc(eyebrow)}</p>` : ""}
        <h1 class="dk-title" style="margin:0 0 20px;font-family:${F_DISPLAY};font-size:46px;font-weight:700;line-height:.98;letter-spacing:-.005em;text-transform:uppercase;color:${C.ink};">${esc(title)}${accent ? `<br/><span style="color:${C.accent};">${esc(accent)}</span>` : ""}</h1>
        ${intro ? `<p style="margin:0 0 8px;font-family:${F_BODY};font-size:16px;line-height:1.65;color:${C.body};max-width:470px;">${intro}</p>` : ""}
      </td></tr>

      <!-- cuerpo -->
      <tr><td class="dk-pad" style="padding:24px 44px 8px;">
        ${body}
        ${cta ? button(cta.label, cta.href, cta.variant) : ""}
      </td></tr>

      <!-- cierre -->
      <tr><td class="dk-pad" style="padding:28px 44px 40px;">
        <p style="margin:0;font-family:${F_BODY};font-size:14px;line-height:1.6;color:${C.muted};">${audience === "admin" ? "— Panel de la tienda" : `Un saludo,<br/><span style="color:${C.ink};font-weight:600;">El equipo de ${esc(STORE_NAME)}</span>`}</p>
      </td></tr>

      <!-- pie oscuro -->
      <tr><td class="dk-pad" style="background:${C.ink};padding:28px 44px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
          <td style="vertical-align:top;">
            <span style="font-family:${F_DISPLAY};font-size:16px;font-weight:700;letter-spacing:.2em;color:#FFFFFF;">DEKIN</span><span style="display:inline-block;width:5px;height:5px;background:${C.accent};margin:0 0 2px 3px;"></span>
            <p style="margin:8px 0 0;font-family:${F_BODY};font-size:12px;line-height:1.6;color:rgba(255,255,255,.55);">
              Calefacción, parrillas y hogares${STORE_ADDRESS ? `<br/>${esc(STORE_ADDRESS)}` : ""}
            </p>
          </td>
          <td style="vertical-align:top;text-align:right;">
            ${SITE_URL ? `<a href="${esc(SITE_URL)}" target="_blank" style="font-family:${F_DISPLAY};font-size:12px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:#FFFFFF;text-decoration:none;">Ir a la tienda →</a>` : ""}
          </td>
        </tr></table>
      </td></tr>
    </table>

    <!-- legal -->
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;">
      <tr><td style="padding:18px 24px 0;text-align:center;font-family:${F_BODY};font-size:11px;line-height:1.6;color:${C.muted};">
        ${pie}<br/>© ${new Date().getFullYear()} ${esc(STORE_NAME)} · Desarrollado por <a href="https://www.deepdev.com.ar" target="_blank" style="color:${C.muted};text-decoration:underline;">DeepDev Studio</a>
      </td></tr>
    </table>

  </td></tr>
</table>
</body>
</html>`;
}

// Versión en texto plano (mejora la entrega y la lectura en relojes / clientes sin HTML)
function htmlToText(html) {
    return String(html)
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<div style="display:none[\s\S]*?<\/div>/i, "")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/(p|tr|h1|table)>/gi, "\n")
        .replace(/<\/td>/gi, "  ")
        .replace(/<a [^>]*href="([^"#][^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, "$2 ($1)")
        .replace(/<[^>]+>/g, "")
        .replace(/&nbsp;|&#8199;|&#847;/g, " ")
        .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
        .replace(/[ \t]+/g, " ")
        .replace(/\n\s*\n\s*\n+/g, "\n\n")
        .trim();
}

// Envía un mail. Lanza error si falla (quien llama decide si lo tolera).
async function enviar({ to, subject, html, replyTo, attachments }) {
    if (!transporter) throw Object.assign(new Error("Mail no configurado (EMAIL_FROM / PASS_EMAIL)"), { code: "MAIL_OFF" });
    if (!to) throw Object.assign(new Error("Mail sin destinatario"), { code: "MAIL_NO_TO" });
    return transporter.sendMail({
        from: `"${STORE_NAME}" <${process.env.EMAIL_FROM}>`,
        to, subject, html,
        text: htmlToText(html),
        ...(replyTo ? { replyTo } : {}),
        ...(attachments ? { attachments } : {}),
    });
}

const mail = {
    configurado: MAIL_CONFIGURADO,
    destinoAdmin: DESTINO_ADMIN,
    destinoContacto: DESTINO_CONTACTO,
    siteUrl: SITE_URL,
    storeName: STORE_NAME,
    enviar, layout, para, note, section, rows, itemsTable, totals, code, button, esc, eur,
};

/* ═══════════════════════════════════════════════
   CONTACTO — validación (mismos límites que ContactMinimal.tsx)
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

/* Freno al spam (por IP, en memoria): CONTACT_MAX envíos cada CONTACT_WINDOW */
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
    if (envios.size > 5000) {
        for (const [k, v] of envios) if (now - v.first > CONTACT_WINDOW) envios.delete(k);
    }
};

// Aviso al negocio. No se manda copia al cliente a propósito: sería un endpoint
// público que envía mails a cualquier dirección (spam con la marca de la tienda).
async function sendContactEmail({ name, surname, email, tel, text, trabajo }) {
    const nombre  = `${name} ${surname}`;
    const mensaje = esc(text).replace(/\n/g, "<br/>");
    const fecha   = new Date().toLocaleString("es-ES", { timeZone: process.env.BUSINESS_TZ || "Europe/Madrid", dateStyle: "long", timeStyle: "short" });

    const html = layout({
        audience:  "admin",
        preheader: `${nombre} · ${trabajo} — ${text.slice(0, 90)}`,
        eyebrow:   "Formulario web",
        title:     "Nueva consulta",
        accent:    trabajo,
        intro:     `<strong style="color:${C.ink};">${esc(nombre)}</strong> escribió desde la web. Si respondes a este correo, le contestas directamente.`,
        ref:       fecha,
        body: `
          ${section("Mensaje", `<div style="padding:18px 0 4px;font-family:${F_BODY};font-size:16px;line-height:1.7;color:${C.ink};">${mensaje}</div>`)}
          ${section("Contacto", rows([
              ["Nombre",   nombre],
              ["Email",    `<a href="mailto:${esc(email)}" style="color:${C.ink};text-decoration:underline;">${esc(email)}</a>`, { raw: true }],
              ["Teléfono", `<a href="tel:${esc(tel.replace(/[^\d+]/g, ""))}" style="color:${C.ink};text-decoration:none;">${esc(tel)}</a>`, { raw: true }],
              ["Asunto",   trabajo],
          ]))}`,
        cta: { label: `Responder a ${name}`, href: `mailto:${email}?subject=${encodeURIComponent(`Re: tu consulta sobre ${trabajo} — ${STORE_NAME}`)}` },
    });

    await enviar({
        to:      DESTINO_CONTACTO,
        replyTo: email,                       // "Responder" le contesta directo al cliente
        subject: `Nueva consulta · ${trabajo} — ${nombre}`,
        html,
    });
}

/* ═══════════════════════════════════════════════
   POST /contact
═══════════════════════════════════════════════ */
contactRouter.post("/contact", async (req, res) => {
    const ip = getClientIp(req);

    if (contactoBloqueado(ip)) {
        return res.status(429).json({ message: "Demasiadas consultas seguidas. Prueba de nuevo más tarde. 🔴" });
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
        return res.status(400).json({ message: "Revisa los datos del formulario. 🔴", errors });
    }

    // Cuenta el intento antes de guardar: así 100 pedidos en paralelo no pasan todos
    sumarEnvio(ip);

    try {
        await Contact.create({ name, surname, email, tel, text, trabajo });
    } catch (error) {
        console.error("Error al crear contacto! 🔴", esProduccion ? error.message : error);
        return res.status(500).json({ message: "Error interno del servidor al procesar el contacto. 🔴" });
    }

    // Si el mail falla, la consulta ya quedó guardada: se responde igual 201 y se loguea
    try {
        await sendContactEmail({ name, surname, email, tel, text, trabajo });
    } catch (error) {
        console.error("Error enviando aviso de contacto 🟡", esProduccion ? error.message : error);
    }

    return res.status(201).json({ message: "¡Formulario de contacto enviado con éxito! 🟢" });
});

/* ═══════════════════════════════════════════════
   ENVIAR FACTURA — POST /:id/send-invoice (solo admin)
   · adminMiddleware ANTES de multer: nadie sin sesión sube archivos a la memoria
   · El email sale del pedido en la BD, no del body
   · Solo PDF, PNG o JPEG, hasta 10 MB, con la firma del archivo verificada
═══════════════════════════════════════════════ */
const INVOICE_MAX_BYTES = 10 * 1024 * 1024;
const INVOICE_TYPES = {
    "application/pdf": [".pdf"],
    "image/png":       [".png"],
    "image/jpeg":      [".jpg", ".jpeg"],
};
// pedidos cobrados (los mismos estados que PAID_STATUSES de stripeRouter)
const INVOICE_STATUSES = ["approved", "partially_refunded", "refunded", "disputed"];

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: INVOICE_MAX_BYTES, files: 1, fields: 5 },
    fileFilter: (req, file, cb) => {
        const ext = (file.originalname.match(/\.[^.]+$/)?.[0] || "").toLowerCase();
        const ok = INVOICE_TYPES[file.mimetype]?.includes(ext);
        cb(ok ? null : Object.assign(new Error("Tipo de archivo no permitido"), { code: "INVALID_TYPE" }), !!ok);
    },
});

// El archivo tiene que ser lo que dice ser (no un .exe renombrado a .pdf)
function firmaValida(buffer, mimetype) {
    if (!buffer || buffer.length < 4) return false;
    if (mimetype === "application/pdf") return buffer.slice(0, 4).toString("latin1") === "%PDF";
    if (mimetype === "image/png")       return buffer.slice(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    if (mimetype === "image/jpeg")      return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
    return false;
}

// Nombre del adjunto sin rutas ni caracteres raros
const nombreSeguro = (n) => String(n || "factura").replace(/[\\/]/g, "_").replace(/[^\w.\- ]/g, "").slice(0, 100) || "factura";

contactRouter.post("/:id/send-invoice", adminMiddleware, (req, res) => {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({ message: "Pedido inválido 🔴" });
    }
    if (!MAIL_CONFIGURADO) {
        return res.status(503).json({ message: "El envío de mails no está configurado en el servidor (EMAIL_FROM / PASS_EMAIL) 🔴" });
    }

    upload.single("invoice")(req, res, async (err) => {
        if (err) {
            if (err.code === "LIMIT_FILE_SIZE")    return res.status(413).json({ message: "El archivo supera los 10 MB 🔴" });
            if (err.code === "INVALID_TYPE")       return res.status(400).json({ message: "Solo se aceptan PDF, PNG o JPEG 🔴" });
            if (err instanceof multer.MulterError) return res.status(400).json({ message: "Archivo inválido 🔴" });
            console.error("Error subiendo factura 🔴", err);
            return res.status(500).json({ message: "Error al procesar el archivo 🔴" });
        }

        const file = req.file;
        if (!file) return res.status(400).json({ message: "Falta el archivo de la factura 🔴" });
        if (!firmaValida(file.buffer, file.mimetype)) {
            return res.status(400).json({ message: "El archivo no es un PDF, PNG o JPEG válido 🔴" });
        }

        try {
            const order = await PaymentsMongo.findById(id).select("email status orderId nombre totalCents amount paidAt createdAt").lean();
            if (!order) return res.status(404).json({ message: "Pedido no encontrado 🔴" });
            if (!INVOICE_STATUSES.includes(order.status)) {
                return res.status(409).json({ message: `No se puede facturar un pedido en estado "${order.status}" 🔴` });
            }
            if (!order.email) return res.status(409).json({ message: "El pedido no tiene email 🔴" });

            const filename  = nombreSeguro(file.originalname);
            const nombre    = String(order.nombre || "").split(" ")[0];
            const total     = Number.isFinite(order.totalCents) ? order.totalCents : Math.round(Number(order.amount || 0) * 100);
            const fecha     = new Date(order.paidAt || order.createdAt).toLocaleDateString("es-ES", { dateStyle: "long" });
            const formato   = file.mimetype === "application/pdf" ? "PDF" : file.mimetype === "image/png" ? "PNG" : "JPEG";

            const html = layout({
                preheader: `Adjuntamos la factura de tu pedido ${order.orderId || ""}.`,
                eyebrow:   "Factura disponible",
                tone:      "ok",
                title:     "Tu factura",
                accent:    "ya está aquí",
                intro:     `${nombre ? `Hola, ${esc(nombre)}. ` : ""}Te enviamos adjunta la factura de tu compra. Guárdala: la necesitarás para cualquier cambio o garantía.`,
                ref:       order.orderId || "",
                body: `
                  ${section("Documento", rows([
                      ["Pedido",  order.orderId || "—", { mono: true }],
                      ["Fecha",   fecha],
                      ["Importe", eur(total)],
                      ["Archivo", `${filename} · ${formato}`],
                  ]))}
                  ${para("¿Algún dato de la factura no es correcto? Responde a este correo y la corregimos.")}`,
                cta: SITE_URL ? { label: "Ir a mis pedidos", href: `${SITE_URL}` } : null,
            });

            await enviar({
                to:      order.email,
                subject: `Factura de tu pedido ${order.orderId || ""} — ${STORE_NAME}`.replace(/\s+/g, " "),
                html,
                attachments: [{ filename, content: file.buffer, contentType: file.mimetype }],
            });

            await PaymentsMongo.updateOne({ _id: id }, {
                $set: { invoiceSent: true, invoiceSentAt: new Date(), invoiceFilename: filename },
            });

            return res.json({ ok: true });
        } catch (error) {
            console.error("Error enviando factura 🔴", esProduccion ? error.message : error);
            if (error?.code === "EAUTH") {
                return res.status(502).json({ message: "Gmail rechazó el usuario o la contraseña de aplicación (EMAIL_FROM / PASS_EMAIL) 🔴" });
            }
            return res.status(500).json({ message: "Error al enviar la factura 🔴" });
        }
    });
});

module.exports = contactRouter;
module.exports.mail = mail;
module.exports.sendContactEmail = sendContactEmail;