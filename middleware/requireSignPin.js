// ═══════════════════════════════════════════════════════════════════════════════
//  middlewares/requireSignPin.js
//  Exige la clave de firma (req.body.pin) antes de dejar pasar la request.
//  Bloqueo: 5 fallos → 15 minutos, guardado en Mongo (sobrevive reinicios de Render).
//
//  Va SIEMPRE después de adminMiddleware (necesita req.user.uid).
// ═══════════════════════════════════════════════════════════════════════════════
const { verifyPin }  = require("../utils/signPin");
const AdminSignGuard = require("../models/AdminSignGuard");

const esProduccion        = process.env.NODE_ENV === "production";
const MAX_FAILED_ATTEMPTS = 5;
const LOCK_MINUTES        = 15;
const TZ_NEGOCIO          = "Europe/Madrid";

async function getLock(adminUid) {
    const guard = await AdminSignGuard.findOne({ adminUid }).lean();
    if (guard?.lockedUntil && guard.lockedUntil > new Date()) return guard.lockedUntil;
    return null;
}

async function registerFailedAttempt(adminUid) {
    const guard = await AdminSignGuard.findOneAndUpdate(
        { adminUid },
        { $inc: { failedCount: 1 }, $set: { lastFailedAt: new Date() } },
        { upsert: true, new: true }
    );
    if (guard.failedCount >= MAX_FAILED_ATTEMPTS) {
        const lockedUntil = new Date(Date.now() + LOCK_MINUTES * 60 * 1000);
        await AdminSignGuard.updateOne({ adminUid }, { $set: { lockedUntil, failedCount: 0 } });
        return { locked: true, remaining: 0 };
    }
    return { locked: false, remaining: MAX_FAILED_ATTEMPTS - guard.failedCount };
}

async function resetAttempts(adminUid) {
    await AdminSignGuard.updateOne({ adminUid }, { $set: { failedCount: 0, lockedUntil: null } });
}

const requireSignPin = async (req, res, next) => {
    const adminUid = req.freshAdmin?.uid || req.user?.uid;
    if (!adminUid) return res.status(401).json({ message: "No autorizado 🔴" });

    const { pin } = req.body || {};

    try {
        // 1. Bloqueo vigente
        const lockedUntil = await getLock(adminUid);
        if (lockedUntil) {
            const hora = lockedUntil.toLocaleTimeString("es-ES", { timeZone: TZ_NEGOCIO, hour: "2-digit", minute: "2-digit" });
            return res.status(429).json({
                message: `Demasiados intentos fallidos. Reintentá después de las ${hora} 🔴`,
                code:    "CLAVE_BLOQUEADA",
                lockedUntil,
            });
        }

        // 2. Verificar clave
        let pinOk = false;
        try {
            pinOk = await verifyPin(typeof pin === "string" ? pin : "");
        } catch (err) {
            console.error(esProduccion ? "ERROR_SIGN_PIN_CONFIG" : `ERROR_SIGN_PIN_CONFIG: ${err.message}`);
            return res.status(500).json({ message: "Clave de firma no configurada en el servidor 🔴", code: "CLAVE_NO_CONFIGURADA" });
        }

        if (!pinOk) {
            const attempt = await registerFailedAttempt(adminUid);
            if (attempt.locked) {
                return res.status(429).json({
                    message: `Clave incorrecta. Bloqueado por ${LOCK_MINUTES} minutos 🔴`,
                    code:    "CLAVE_BLOQUEADA",
                });
            }
            return res.status(401).json({
                message:   `Clave de firma incorrecta. Te quedan ${attempt.remaining} intento(s) 🔴`,
                code:      "CLAVE_INCORRECTA",
                remaining: attempt.remaining,
            });
        }

        await resetAttempts(adminUid);

        // La clave no sigue viajando por el resto de la request
        delete req.body.pin;
        next();

    } catch (err) {
        console.error(esProduccion ? "ERROR_SIGN_PIN" : `ERROR_SIGN_PIN: ${err}`);
        return res.status(500).json({ message: "Error interno al verificar la clave 🔴" });
    }
};

module.exports = requireSignPin;