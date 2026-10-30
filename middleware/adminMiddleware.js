const auth = require("../config/firebase");
const Audit = require("../models/AuditSchema");

const esProduccion = (process.env.NODE_ENV === 'production');

/* ══════════════════════════════════════════════════════════
   CONFIGURACIÓN DE BLOQUEOS (mismo esquema que Boggero)
══════════════════════════════════════════════════════════ */
const MAX_IP_STRIKES   = 10;                   // Intentos sin credenciales válidas antes de bloquear la IP
const IP_WINDOW_MS     = 60 * 60 * 1000;       // Ventana en la que se cuentan esos intentos (1 h)
const IP_BLOCK_MS      = 24 * 60 * 60 * 1000;  // Duración del bloqueo de IP (24 h, temporal a propósito)
const MAX_USER_STRIKES = 3;                    // Llamadas a la API admin de un usuario NO admin antes de banearlo

/* ══════════════════════════════════════════════════════════
   HELPERS
══════════════════════════════════════════════════════════ */

// IP real detrás de Cloudflare / Render (la misma función que usa authRouter)
const getClientIp = (req) => String(
    req.headers["cf-connecting-ip"] ||
    (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    req.ip ||
    req.socket?.remoteAddress ||
    "unknown"
).slice(0, 64);

// Si el navegador avisa que el pedido viene de OTRO sitio, no sumo strikes:
// así nadie puede armar una página que haga que tus clientes (o vos) se bloqueen solos.
const isCrossSite = (req) => req.headers["sec-fetch-site"] === "cross-site";

// Bloqueada = llegó al máximo de strikes y el último fue hace menos de IP_BLOCK_MS
const isIpBlocked = async (ip) => {
    const doc = await Audit.findOne({ ip, event: "intrusion-ip" }).lean();
    if (!doc || (doc.attempts ?? 0) < MAX_IP_STRIKES) return false;
    const last = new Date(doc.lastAttemptAt).getTime();
    return last > Date.now() - IP_BLOCK_MS;
};

// Suma un strike a la IP (visitante sin token o con token falso en zona admin)
const strikeIp = async (req, reason) => {
    if (isCrossSite(req)) return;
    const ip = getClientIp(req);
    const now = Date.now();
    try {
        // Si el último intento es viejo, reinicio el contador (no acumula para siempre)
        await Audit.updateOne(
            { ip, event: "intrusion-ip", lastAttemptAt: { $lt: now - IP_WINDOW_MS } },
            { $set: { attempts: 0 } }
        );

        // Atómico: dos pedidos en paralelo no pisan el contador
        const doc = await Audit.findOneAndUpdate(
            { ip, event: "intrusion-ip" },
            {
                $inc: { attempts: 1 },
                $set: { lastAttemptAt: now, userAgent: String(req.headers["user-agent"] || "").slice(0, 300) }
            },
            { upsert: true, returnDocument: "after" }
        );

        console.warn(`Intrusion attempt (${reason}) from IP ${ip} on ${req.method} ${req.originalUrl} — strike ${doc.attempts}/${MAX_IP_STRIKES} 🟡`);
    } catch (error) {
        console.error("Error registering IP strike 🔴", esProduccion ? error.message : error);
    }
};

// Suma un strike a un usuario logueado que no es admin. Devuelve true si quedó baneado.
const strikeUser = async (req, decoded) => {
    if (isCrossSite(req)) return false;
    const now = Date.now();
    try {
        const doc = await Audit.findOneAndUpdate(
            { uid: decoded.uid, event: "intrusion-user" },
            {
                $inc: { attempts: 1 },
                $set: { lastAttemptAt: now, email: decoded.email, ip: getClientIp(req) }
            },
            { upsert: true, returnDocument: "after" }
        );

        console.warn(`Unauthorized admin API access by ${decoded.email} on ${req.method} ${req.originalUrl} — strike ${doc.attempts}/${MAX_USER_STRIKES} 🟡`);

        if (doc.attempts < MAX_USER_STRIKES) return false;

        const user = await auth.getUser(decoded.uid);
        if (user.customClaims?.admin === true) return false; // A un admin nunca se lo banea automáticamente

        // Merge con las claims que ya tiene (nombre, apellido, planes...): nunca sobrescribir
        await auth.setCustomUserClaims(decoded.uid, {
            ...(user.customClaims || {}),
            banned: true,
            bannedAt: now,
            bannedReason: "Unauthorized access to admin routes"
        });
        await auth.revokeRefreshTokens(decoded.uid); // Invalida sus sesiones abiertas

        return true;
    } catch (error) {
        console.error("Error registering user strike 🔴", esProduccion ? error.message : error);
        return false;
    }
};

// Errores de token que tiene un usuario legítimo (sesión vieja): no suman strike
const BENIGN_TOKEN_ERRORS = ["auth/id-token-expired", "auth/id-token-revoked", "auth/user-disabled", "auth/user-not-found"];

/* ══════════════════════════════════════════════════════════
   MIDDLEWARE: corta pedidos de IPs bloqueadas (login, registro, reset...)
══════════════════════════════════════════════════════════ */
const ipGuard = async (req, res, next) => {
    try {
        if (await isIpBlocked(getClientIp(req))) {
            return res.status(403).json({ code: "auth/ip-blocked", message: "ACCESS_BLOCKED 🔴" });
        }
    } catch (error) {
        // Si Mongo falla no bloqueo a nadie por esto: dejo pasar y lo logueo
        console.error("Error checking IP block 🔴", esProduccion ? error.message : error);
    }
    next();
};

/* ══════════════════════════════════════════════════════════
   MIDDLEWARE ADMIN (todas las rutas de la API admin)
══════════════════════════════════════════════════════════ */
const adminMiddleware = async (req, res, next) => {
    // 1. IP bloqueada → afuera sin mirar nada más
    try {
        if (await isIpBlocked(getClientIp(req))) {
            return res.status(403).json({ code: "auth/ip-blocked", message: "ACCESS_BLOCKED 🔴" });
        }
    } catch (error) {
        console.error("Error checking IP block 🔴", esProduccion ? error.message : error);
    }

    const token = req.cookies?.idToken;

    // 2. Sin token → visitante no logueado en zona admin → strike a la IP
    if (!token || typeof token !== "string") {
        await strikeIp(req, "no-token");
        return res.status(401).json({ code: "auth/no-session", message: "No credentials! 🔴" });
    }

    // 3. checkRevoked = true: si lo banearon o revocaron, deja de valer al instante
    let decodedClaims;
    try {
        decodedClaims = await auth.verifyIdToken(token, true);
    } catch (error) {
        if (!BENIGN_TOKEN_ERRORS.includes(error.code)) await strikeIp(req, "invalid-token");
        console.error(esProduccion ? `Unauthorized! 🔴` : `Unauthorized! 🔴 ${error}`);
        return res.status(401).json({ code: "auth/invalid-session", message: "Unauthorized" });
    }

    // 4. Baneado
    if (decodedClaims.banned === true) {
        return res.status(403).json({ code: "auth/user-banned", message: "User is banned" });
    }

    // 5. Logueado pero NO admin → strike al usuario, a los MAX_USER_STRIKES queda baneado
    if (decodedClaims.admin !== true) {
        const banned = await strikeUser(req, decodedClaims);
        return res.status(403).json({
            code: banned ? "auth/user-banned" : "auth/forbidden",
            message: "ACCESS_DENIED: ADMIN_ONLY_ZONE 🔴"
        });
    }

    req.user = decodedClaims;
    next();
};

module.exports = adminMiddleware;
module.exports.ipGuard = ipGuard;
module.exports.isIpBlocked = isIpBlocked;
module.exports.strikeIp = strikeIp;
module.exports.getClientIp = getClientIp;
module.exports.BENIGN_TOKEN_ERRORS = BENIGN_TOKEN_ERRORS;