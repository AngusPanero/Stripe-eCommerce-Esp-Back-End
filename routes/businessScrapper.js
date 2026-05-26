const express       = require("express");
const nodemailer    = require("nodemailer");
const adminMiddleware = require("../middleware/adminMiddleware");

const businessRouter = express.Router();

// ─── Constantes scraper ───────────────────────────────────────────────────────

const EMAIL_REGEX = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;

const IGNORED_DOMAINS = [
    "xxx.com"
];

const PRIORITY_PREFIXES = [
    "info@", "contacto@", "contact@", "hola@", "ventas@",
    "admin@", "consultas@", "atencion@", "reservas@","gmail.com", "hotmail.com", "yahoo.com", "outlook.com",
    "live.com", "icloud.com", "protonmail.com", "hotmail.com.ar",
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isValidBusinessEmail(email) {
    const lower  = email.toLowerCase();
    const domain = lower.split("@")[1];
    if (!domain) return false;
    if (IGNORED_DOMAINS.includes(domain)) return false;
    if (lower.includes(".png") || lower.includes(".jpg") || lower.includes(".gif") || lower.includes(".svg")) return false;
    if (email.length < 6) return false;
    return true;
}

async function fetchEmailFromUrl(url) {
    const controller = new AbortController();
    const timeout    = setTimeout(() => controller.abort(), 8000);
    try {
        const fetchFn  = typeof fetch !== "undefined" ? fetch : require("node-fetch");
        const response = await fetchFn(url, {
            signal:  controller.signal,
            headers: {
                "User-Agent":      "Mozilla/5.0 (compatible; ContactBot/1.0)",
                "Accept":          "text/html,application/xhtml+xml",
                "Accept-Language": "es-AR,es;q=0.9",
            },
        });
        clearTimeout(timeout);
        if (!response.ok) return null;
        const html           = await response.text();
        const matches        = [...new Set(html.match(EMAIL_REGEX) ?? [])];
        const businessEmails = matches.filter(isValidBusinessEmail);
        if (businessEmails.length === 0) return null;
        const priority = businessEmails.find((e) =>
            PRIORITY_PREFIXES.some((p) => e.toLowerCase().startsWith(p))
        );
        return priority ?? businessEmails[0];
    } catch (err) {
        clearTimeout(timeout);
        if (err.name === "AbortError") console.warn(`[scrapeEmail] Timeout: ${url}`);
        else console.warn(`[scrapeEmail] Error: ${url}`, err.message);
        return null;
    }
}

const createTransporter = () => nodemailer.createTransport({
    service: "gmail",
    auth: { user: process.env.EMAIL_FROM, pass: process.env.PASS_EMAIL }
});

// ─── HTML de presentación Dekin ───────────────────────────────────────────────

function buildPresentationHtml(introText) {
    const year = new Date().getFullYear();
    return `
<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>Dekin — Calefactores y Parrillas</title>
<link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@700;800&family=Barlow:wght@300;400;500&display=swap" rel="stylesheet">
</head>
<body style="margin:0;padding:0;background:#F2EDE8;font-family:'Barlow',Georgia,sans-serif;">

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F2EDE8;padding:40px 16px;">
<tr><td align="center">

  <!-- CARD -->
  <table role="presentation" width="600" cellpadding="0" cellspacing="0"
    style="max-width:600px;width:100%;background:#1A1614;font-family:'Barlow',Georgia,sans-serif;">

    <!-- CABECERA NARANJA -->
    <tr>
      <td style="background:#E84B1A;padding:0;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          <tr><td style="height:4px;background:repeating-linear-gradient(90deg,#fff 0px,#fff 6px,transparent 6px,transparent 14px);opacity:0.18;"></td></tr>
        </table>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          <tr><td style="padding:32px 40px 28px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
              <td>
                <p style="font-family:'Barlow Condensed','Arial Narrow',Arial,sans-serif;font-size:36px;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;color:#fff;line-height:1;margin:0;">DEKIN</p>
                <p style="font-family:'Barlow',Arial,sans-serif;font-size:10px;font-weight:300;letter-spacing:0.42em;text-transform:uppercase;color:rgba(255,255,255,0.75);margin:3px 0 0 2px;">CALEFACTORES · PARRILLAS</p>
              </td>
              <td style="text-align:right;vertical-align:bottom;padding-bottom:2px;">
                <p style="font-family:'Barlow Condensed','Arial Narrow',Arial,sans-serif;font-size:11px;font-weight:700;letter-spacing:0.22em;text-transform:uppercase;color:rgba(255,255,255,0.55);margin:0;">FABRICACIÓN NACIONAL<br/>DESDE 1998</p>
              </td>
            </tr></table>
          </td></tr>
        </table>
      </td>
    </tr>

    <!-- CUERPO -->
    <tr>
      <td style="background:#1A1614;padding:48px 40px 40px;">

        <!-- badge -->
        <table role="presentation" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
          <tr><td>
            <p style="font-family:'Barlow Condensed','Arial Narrow',Arial,sans-serif;font-size:10px;font-weight:700;letter-spacing:0.28em;text-transform:uppercase;background:rgba(232,75,26,0.1);color:#E84B1A;border:1px solid rgba(232,75,26,0.3);display:inline-block;padding:4px 12px;margin:0;">
              PRODUCTOS DE CALIDAD
            </p>
          </td></tr>
        </table>

        <!-- headline -->
        <p style="font-family:'Barlow Condensed','Arial Narrow',Arial,sans-serif;font-size:32px;font-weight:800;letter-spacing:0.04em;text-transform:uppercase;color:#F0EBE5;line-height:1.1;margin:0 0 16px;">
          Calor e identidad<br/>
          <span style="color:#E84B1A;">en cada hogar.</span>
        </p>

        <!-- intro personalizado -->
        ${introText ? `<p style="font-family:'Barlow',Arial,sans-serif;font-size:15px;font-weight:400;color:rgba(240,235,229,0.8);line-height:1.7;margin:0 0 28px;">${introText.replace(/\n/g,"<br/>")}</p>` : ""}

        <!-- descripción -->
        <p style="font-family:'Barlow',Arial,sans-serif;font-size:15px;font-weight:300;color:rgba(240,235,229,0.7);line-height:1.7;margin:0 0 32px;">
          En <strong style="color:#F0EBE5;font-weight:600;">Dekin</strong> fabricamos calefactores, estufas y parrillas de acero de alta calidad en Argentina desde 1998. Nuestros productos combinan eficiencia energética, durabilidad y diseño para ambientes residenciales y comerciales.
        </p>

        <!-- divisor -->
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:32px;">
          <tr><td style="border-top:1px solid rgba(255,255,255,0.07);"></td></tr>
        </table>

        <!-- PRODUCTOS — 3 columnas -->
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:32px;">
          <tr>
            <!-- Calefactores -->
            <td width="32%" style="vertical-align:top;padding-right:14px;">
              <p style="font-size:22px;margin:0 0 10px;">🔥</p>
              <p style="font-family:'Barlow Condensed','Arial Narrow',Arial,sans-serif;font-size:13px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:#E84B1A;margin:0 0 6px;">CALEFACTORES</p>
              <p style="font-family:'Barlow',Arial,sans-serif;font-size:13px;font-weight:300;color:rgba(240,235,229,0.5);line-height:1.55;margin:0;">
                Estufas y calefactores a gas de bajo consumo. Ideales para ambientes de hasta 80 m². Garantía 3 años.
              </p>
            </td>
            <!-- Parrillas -->
            <td width="32%" style="vertical-align:top;padding-right:14px;">
              <p style="font-size:22px;margin:0 0 10px;">🥩</p>
              <p style="font-family:'Barlow Condensed','Arial Narrow',Arial,sans-serif;font-size:13px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:#E84B1A;margin:0 0 6px;">PARRILLAS</p>
              <p style="font-family:'Barlow',Arial,sans-serif;font-size:13px;font-weight:300;color:rgba(240,235,229,0.5);line-height:1.55;margin:0;">
                Parrillas de acero inoxidable y hierro fundido para uso doméstico y comercial. Diseños a medida.
              </p>
            </td>
            <!-- Por qué Dekin -->
            <td width="36%" style="vertical-align:top;">
              <p style="font-size:22px;margin:0 0 10px;">🏭</p>
              <p style="font-family:'Barlow Condensed','Arial Narrow',Arial,sans-serif;font-size:13px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:#E84B1A;margin:0 0 6px;">POR QUÉ DEKIN</p>
              <p style="font-family:'Barlow',Arial,sans-serif;font-size:13px;font-weight:300;color:rgba(240,235,229,0.5);line-height:1.55;margin:0;">
                25+ años de experiencia · Envíos a todo el país · Atención personalizada · Garantía extendida.
              </p>
            </td>
          </tr>
        </table>

        <!-- divisor -->
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:28px;">
          <tr><td style="border-top:1px solid rgba(255,255,255,0.07);"></td></tr>
        </table>

        <!-- CTA -->
        <table role="presentation" cellpadding="0" cellspacing="0">
          <tr><td>
            <a href="https://www.dekin.com.ar"
              style="display:inline-block;background:#E84B1A;color:#fff;font-family:'Barlow Condensed','Arial Narrow',Arial,sans-serif;font-size:13px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;padding:14px 32px;text-decoration:none;">
              VER CATÁLOGO COMPLETO →
            </a>
          </td></tr>
        </table>

      </td>
    </tr>

    <!-- FIRMA -->
    <tr>
      <td style="background:#F2EDE8;padding:28px 40px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
          <td style="vertical-align:middle;">
            <p style="font-family:'Barlow Condensed','Arial Narrow',Arial,sans-serif;font-size:18px;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;color:#1A1614;margin:0 0 2px;">DEKIN HOGAR</p>
            <p style="font-family:'Barlow',Arial,sans-serif;font-size:12px;font-weight:300;letter-spacing:0.2em;text-transform:uppercase;color:rgba(26,22,20,0.4);margin:0;">Diseño · Calidad · Confianza</p>
          </td>
          <td style="text-align:right;vertical-align:middle;">
            <p style="font-family:'Barlow',Arial,sans-serif;font-size:11px;color:rgba(26,22,20,0.35);margin:0;line-height:1.6;">
              Este es un mensaje comercial.<br/>
              Respondé este correo para más información.
            </p>
          </td>
        </tr></table>
      </td>
    </tr>

    <!-- BARRA INFERIOR -->
    <tr>
      <td style="background:#E84B1A;padding:14px 40px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
          <td>
            <p style="font-family:'Barlow Condensed','Arial Narrow',Arial,sans-serif;font-size:10px;font-weight:700;letter-spacing:0.22em;text-transform:uppercase;color:rgba(255,255,255,0.65);margin:0;">
              © ${year} DEKIN HOGAR · TODOS LOS DERECHOS RESERVADOS · ARGENTINA
            </p>
          </td>
        </tr></table>
      </td>
    </tr>

  </table>
  <!-- / CARD -->

  <!-- nota al pie -->
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;margin-top:20px;">
    <tr><td>
      <p style="font-family:'Barlow',Arial,sans-serif;font-size:11px;font-weight:300;color:rgba(26,22,20,0.4);text-align:center;line-height:1.6;margin:0;">
        Recibiste este mensaje porque tu negocio aparece en Google Maps.<br/>
        Si no deseás recibir más información, respondé con "no gracias".
      </p>
    </td></tr>
  </table>

</td></tr>
</table>

</body>
</html>`;
}

// ─── /api/scrape-email ────────────────────────────────────────────────────────

businessRouter.post("/api/scrape-email", adminMiddleware, async (req, res) => {
    const { url } = req.body;
    if (!url || typeof url !== "string") return res.status(400).json({ error: "Se requiere 'url'" });
    let parsed;
    try { parsed = new URL(url); } catch { return res.status(400).json({ error: "URL inválida" }); }
    if (!["http:","https:"].includes(parsed.protocol)) return res.status(400).json({ error: "Solo http o https" });
    const email = await fetchEmailFromUrl(url);
    return res.json({ email });
});

// ─── /api/send-bulk-email ─────────────────────────────────────────────────────

businessRouter.post("/api/send-bulk-email", adminMiddleware, async (req, res) => {
    const { email, subject, message } = req.body;

    if (!email || !subject) {
        return res.status(400).json({ message: "Faltan email y subject 🔴" });
    }

    const transporter = createTransporter();

    try {
        await transporter.sendMail({
            from:    process.env.EMAIL_FROM,
            to:      email,
            subject,
            html:    buildPresentationHtml(message || ""),
        });
        res.json({ ok: true });
    } catch (error) {
        console.error(`[send-bulk-email] Error → ${email}:`, error.message);
        res.status(500).json({ message: "Error al enviar 🔴", error: error.message });
    }
});

module.exports = businessRouter;