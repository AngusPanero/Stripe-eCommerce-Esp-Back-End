// Express y Router
const express = require("express")
const authRouter = express.Router()
// Firebase
const auth = require("../config/firebase")
// Models
const Audit = require("../models/AuditSchema")
const SecurityIncident = require("../models/SecurityIncidentSchema")
const { LegalConsent, LEGAL_DOCUMENTS } = require("../models/LegalConsent")
// Middlewares
const loginLimiter = require("../middleware/rateLimitMiddleware")
const verifyToken = require("../middleware/authMiddleware") // ya rechaza baneados y no verificados con checkRevoked
const adminMiddleware = require("../middleware/adminMiddleware")
const { ipGuard, isIpBlocked, strikeIp, getClientIp, BENIGN_TOKEN_ERRORS } = adminMiddleware

// Axios
const axios = require("axios")

const esProduccion = (process.env.NODE_ENV === 'production');

// ─── Cookie de sesión ─────────────────────────────────────────────────────────
// Producción: lax + domain (COOKIE_DOMAIN en Render, ej: ".tudominio.com")
// Desarrollo: none sin domain
const COOKIE_DOMAIN = process.env.COOKIE_DOMAIN;
const COOKIE_BASE = esProduccion
    ? { httpOnly: true, sameSite: "lax", secure: true, path: "/", ...(COOKIE_DOMAIN ? { domain: COOKIE_DOMAIN } : {}) }
    : { httpOnly: true, sameSite: "none", secure: true, path: "/" };
const SESSION_MS = 60 * 60 * 1000; // igual que la vida del idToken de Firebase

const setSessionCookie = (res, idToken) => res.cookie("idToken", idToken, { ...COOKIE_BASE, maxAge: SESSION_MS });
const clearSessionCookie = (res) => res.clearCookie("idToken", COOKIE_BASE);

// ── Validaciones, verificación de email (Firebase) y helpers ──

// Mismas regex que el front (SessionContext.tsx)
const PASSWORD_REGEX = /^(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()_+=[\]{};':"\\|,.<>/?`~-]).{10,}$/;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const FIREBASE_REST = "https://identitytoolkit.googleapis.com/v1/accounts";
// En dev usa LOCAL_HOST (http://localhost:5173) y en producción FRONT_END
const FRONT_URL = ((esProduccion ? process.env.FRONT_END : process.env.LOCAL_HOST) || "").replace(/\/+$/, "");

// Siempre string, recortado y en minúscula (evita inyección NoSQL con objetos {"$ne": null})
const normEmail = (v) => (typeof v === "string" ? v.trim().toLowerCase().slice(0, 254) : "");
const str = (v, max = 300) => (v == null ? null : String(v).slice(0, max));
const firebaseCodeDe = (error) => (error.response?.data?.error?.message || "").split(" ")[0];

// Al front se le mandan las claims del usuario, NUNCA el idToken ni los datos técnicos del token
const TOKEN_INTERNAL = ["iss", "aud", "auth_time", "user_id", "sub", "iat", "exp", "firebase"];
function sesionPublica(decoded) {
    const out = {};
    for (const [k, v] of Object.entries(decoded || {})) {
        if (!TOKEN_INTERNAL.includes(k)) out[k] = v;
    }
    return out;
}

// Inicia sesión en la API REST de Firebase solo para obtener el idToken del usuario
async function idTokenDe(email, password) {
    const { data } = await axios.post(
        `${FIREBASE_REST}:signInWithPassword?key=${process.env.FIREBASE_API_KEY}`,
        { email, password, returnSecureToken: true }
    );
    return data.idToken;
}

// Manda un email de Firebase (verificación o reset) con su plantilla y su remitente.
// Si el dominio no está autorizado en Firebase, se manda igual sin el botón "Continuar".
async function sendFirebaseEmail(payload) {
    const url = `${FIREBASE_REST}:sendOobCode?key=${process.env.FIREBASE_API_KEY}`;
    try {
        await axios.post(url, { ...payload, ...(FRONT_URL ? { continueUrl: `${FRONT_URL}/` } : {}) });
    } catch (error) {
        const code = firebaseCodeDe(error);
        if (FRONT_URL && (code === "UNAUTHORIZED_DOMAIN" || code === "INVALID_CONTINUE_URI")) {
            console.warn(`⚠️ ${FRONT_URL} no está en Authorized domains de Firebase: se envía sin continueUrl`);
            await axios.post(url, payload);
            return;
        }
        throw error;
    }
}
const sendVerificationEmail = (idToken) => sendFirebaseEmail({ requestType: "VERIFY_EMAIL", idToken });
const sendPasswordResetEmail = (email) => sendFirebaseEmail({ requestType: "PASSWORD_RESET", email });

// Un envío de email por dirección cada 60 s (evita spamear casillas o gastar cuota)
const REENVIO_MS = 60 * 1000;
const ultimoReenvio = new Map();
const ultimoReset = new Map();
const enEspera = (map, email) => {
    const t = map.get(email);
    return !!t && Date.now() - t < REENVIO_MS;
};
const marcarEnvio = (map, email) => {
    map.set(email, Date.now());
    // Limpieza para que el Map no crezca sin límite
    if (map.size > 5000) {
        const limite = Date.now() - REENVIO_MS;
        for (const [k, t] of map) if (t < limite) map.delete(k);
    }
};

// ── Bloqueo TEMPORAL por contraseña incorrecta (antes era ban permanente) ──
const MAX_LOGIN_FAILS = 5;
const LOGIN_LOCK_MS = 15 * 60 * 1000;

// Devuelve el timestamp hasta el que está bloqueado, o 0
async function loginBloqueadoHasta(email) {
    const doc = await Audit.findOne({ email, event: "login-failed" }).lean();
    if (!doc || (doc.attempts ?? 0) < MAX_LOGIN_FAILS) return 0;
    const hasta = new Date(doc.lastAttemptAt).getTime() + LOGIN_LOCK_MS;
    return hasta > Date.now() ? hasta : 0;
}

// Suma un fallo de forma atómica. Si el último fallo es viejo, el contador vuelve a 0.
async function sumarFalloLogin(email) {
    const now = Date.now();
    await Audit.updateOne(
        { email, event: "login-failed", lastAttemptAt: { $lt: now - LOGIN_LOCK_MS } },
        { $set: { attempts: 0 } }
    );
    const doc = await Audit.findOneAndUpdate(
        { email, event: "login-failed" },
        { $inc: { attempts: 1 }, $set: { lastAttemptAt: now } },
        { upsert: true, returnDocument: "after" }
    );
    return doc.attempts;
}

const minutosHasta = (ts) => Math.max(1, Math.ceil((ts - Date.now()) / 60000));

// ═══════════════════════════════════════════════════════════════
//  REGISTRO
// ═══════════════════════════════════════════════════════════════
authRouter.post("/register", ipGuard, loginLimiter, async (req, res) => {
    const { password, acceptedLegal } = req.body ?? {};
    const email = normEmail(req.body?.email);

    try {
        if (!email || typeof password !== "string") {
            return res.status(400).json({ code: "auth/missing-fields", message: "All fields are required to create an user! 🔴" });
        }

        if (!EMAIL_REGEX.test(email)) {
            return res.status(400).json({ code: "auth/invalid-email", message: "Invalid email format! 🔴" });
        }

        if (password.length > 128 || !PASSWORD_REGEX.test(password)) {
            return res.status(400).json({ code: "auth/weak-password", message: "Password does not meet security requirements! 🔴" });
        }

        // Estricto: tiene que llegar exactamente true (no "true", no 1)
        if (acceptedLegal !== true) {
            return res.status(400).json({ code: "LEGAL_NOT_ACCEPTED", message: "Legal documents must be accepted to register! 🔴" });
        }

        // ¿El email ya tiene cuenta?
        try {
            await auth.getUserByEmail(email);
            return res.status(409).json({ code: "auth/email-already-exists", message: "This email is already registered! 🔴" });
        } catch (lookupError) {
            if (lookupError.code !== "auth/user-not-found") throw lookupError;
        }

        // Nunca se aceptan claims desde el body: la cuenta nace sin admin, sin plan, sin nada
        const userRecord = await auth.createUser({ email, password, emailVerified: false });

        // Guardar el consentimiento. Si falla, se borra el usuario:
        // no puede existir una cuenta sin constancia de aceptación.
        try {
            await LegalConsent.create({
                uid: userRecord.uid,
                email,
                accepted: true,
                source: "register",
                documents: Object.entries(LEGAL_DOCUMENTS).map(([type, doc]) => ({
                    type,
                    version: doc.version,
                    url: doc.url,
                })),
                ip: getClientIp(req),
                userAgent: req.headers["user-agent"]?.slice(0, 500) || null,
            });
        } catch (consentErr) {
            console.error("Error saving legal consent! 🔴", esProduccion ? consentErr.message : consentErr);
            try {
                await auth.deleteUser(userRecord.uid);
            } catch (rollbackErr) {
                console.error("Rollback failed! 🔴", esProduccion ? rollbackErr.message : rollbackErr);
            }
            return res.status(500).json({ code: "auth/general-error", message: "Error creating user! 🔴" });
        }

        // Email de verificación (lo manda Firebase). Si falla, la cuenta queda
        // creada y puede pedir el reenvío desde el login.
        try {
            const idToken = await idTokenDe(email, password);
            await sendVerificationEmail(idToken);
            marcarEnvio(ultimoReenvio, email);
        } catch (emailErr) {
            console.error("Error enviando email de verificación 🔴", firebaseCodeDe(emailErr) || emailErr.message);
        }

        return res.status(201).json({ message: "User created successfully! 🟢" });
    } catch (error) {
        if (error.code === "auth/email-already-exists") {
            return res.status(409).json({ code: "auth/email-already-exists", message: "This email is already registered! 🔴" });
        }
        if (error.code === "auth/invalid-password") {
            return res.status(400).json({ code: "auth/weak-password", message: "Password does not meet security requirements! 🔴" });
        }
        if (error.code === "auth/invalid-email") {
            return res.status(400).json({ code: "auth/invalid-email", message: "Invalid email format! 🔴" });
        }
        console.error("Error creating user! 🔴", esProduccion ? error.message : error);
        return res.status(500).json({ code: "auth/general-error", message: "Error creating user! 🔴" });
    }
});

// ═══════════════════════════════════════════════════════════════
//  REENVÍO DEL EMAIL DE VERIFICACIÓN
//  Pide email y contraseña (los del login): Firebase necesita la sesión del usuario.
// ═══════════════════════════════════════════════════════════════
authRouter.post("/resend-verification", ipGuard, loginLimiter, async (req, res) => {
    const email = normEmail(req.body?.email);
    const password = req.body?.password;

    if (!EMAIL_REGEX.test(email) || typeof password !== "string" || !password || password.length > 128) {
        return res.status(400).json({ code: "auth/missing-fields", message: "Email and password are required." });
    }

    // Comparte el bloqueo del login: no sirve para probar contraseñas por otro lado
    if (await loginBloqueadoHasta(email)) {
        return res.status(429).json({ code: "auth/too-many-attempts", message: "Too many attempts. Try later." });
    }

    if (enEspera(ultimoReenvio, email)) {
        return res.status(429).json({ code: "auth/too-many-requests", message: "Wait a minute before requesting another email." });
    }
    marcarEnvio(ultimoReenvio, email);

    try {
        const userRecord = await auth.getUserByEmail(email);

        if (userRecord.emailVerified) {
            return res.status(400).json({ code: "auth/already-verified", message: "Email already verified." });
        }

        const idToken = await idTokenDe(email, password);
        await sendVerificationEmail(idToken);
        return res.status(200).json({ message: "Verification email sent! 🟢" });
    } catch (error) {
        if (error.code === "auth/user-not-found") {
            return res.status(404).json({ code: "auth/user-not-found", message: "Email not registered." });
        }
        const firebaseCode = firebaseCodeDe(error);
        if (["INVALID_PASSWORD", "INVALID_LOGIN_CREDENTIALS", "EMAIL_NOT_FOUND"].includes(firebaseCode)) {
            await sumarFalloLogin(email).catch(() => {});
            return res.status(401).json({ code: "auth/invalid-credential", message: "Wrong password." });
        }
        if (firebaseCode === "TOO_MANY_ATTEMPTS_TRY_LATER") {
            return res.status(429).json({ code: "auth/too-many-requests", message: "Too many requests. Try later." });
        }
        console.error("Error reenviando verificación 🔴", firebaseCode || error.message);
        return res.status(500).json({ code: "auth/general-error", message: "Error sending email." });
    }
});

// ═══════════════════════════════════════════════════════════════
//  RESET DE CONTRASEÑA (link generado y enviado por Firebase)
//  Siempre responde lo mismo: no revela si el email existe.
// ═══════════════════════════════════════════════════════════════
authRouter.post("/reset-password", ipGuard, loginLimiter, async (req, res) => {
    const email = normEmail(req.body?.email);
    if (!EMAIL_REGEX.test(email)) {
        return res.status(400).json({ code: "auth/invalid-email", message: "Invalid email format." });
    }

    const generico = { message: "If the email is registered, a reset link was sent. 🟢" };

    if (enEspera(ultimoReset, email)) return res.status(200).json(generico);
    marcarEnvio(ultimoReset, email);

    try {
        await sendPasswordResetEmail(email);
    } catch (error) {
        const code = firebaseCodeDe(error);
        if (code !== "EMAIL_NOT_FOUND") {
            console.error("Error enviando reset de contraseña 🔴", code || error.message);
        }
    }
    return res.status(200).json(generico);
});

// ═══════════════════════════════════════════════════════════════
//  LOGIN
// ═══════════════════════════════════════════════════════════════
authRouter.post("/login", ipGuard, loginLimiter, async (req, res) => {
    const email = normEmail(req.body?.email);
    const password = req.body?.password;

    if (!email || typeof password !== "string" || !password || password.length > 128) {
        return res.status(400).json({ code: "auth/missing-fields", message: "Email and password are required" });
    }

    try {
        // 0. Cuenta bloqueada temporalmente por contraseñas incorrectas
        const hasta = await loginBloqueadoHasta(email);
        if (hasta) {
            return res.status(429).json({ code: "auth/too-many-attempts", retryAfterMinutes: minutosHasta(hasta) });
        }

        // 0.5 ¿El email existe? Aviso claro sin sumar intentos
        try {
            await auth.getUserByEmail(email);
        } catch (lookupError) {
            if (lookupError.code === "auth/user-not-found") {
                return res.status(404).json({ code: "auth/user-not-found", message: "Email not registered" });
            }
            throw lookupError;
        }

        // 1. Validar credenciales contra la API de Firebase Auth
        const idToken = await idTokenDe(email, password);

        // 2. Verificar el token obtenido y obtener claims
        const decoded = await auth.verifyIdToken(idToken, true);

        // 3. Baneo
        if (decoded.banned === true) {
            return res.status(403).json({ code: "auth/user-banned", message: "User is banned" });
        }

        // 3.5 Email verificado (los admin entran igual)
        if (!decoded.email_verified && decoded.admin !== true) {
            return res.status(403).json({ code: "auth/email-not-verified", message: "Email not verified" });
        }

        // 4. Limpiar intentos fallidos y auditar
        await Audit.findOneAndUpdate(
            { email, event: "login-failed" },
            { $set: { attempts: 0, lastAttemptAt: null } }
        );

        await Audit.create({
            uid: decoded.uid,
            email: decoded.email,
            event: "login",
            ip: getClientIp(req),
            userAgent: str(req.headers["user-agent"], 500)
        });

        // 5. Cookie httpOnly. El idToken NO va en el JSON (si no, un XSS lo podría robar)
        setSessionCookie(res, idToken);

        return res.status(200).json({
            user: sesionPublica(decoded),
            isAdmin: decoded.admin === true,
            isEnterprise: !!decoded.isEnterprise
        });

    } catch (error) {
        const errorCode = firebaseCodeDe(error) || null;

        if (["INVALID_PASSWORD", "EMAIL_NOT_FOUND", "INVALID_LOGIN_CREDENTIALS"].includes(errorCode)) {
            try {
                const attempts = await sumarFalloLogin(email);
                if (attempts >= MAX_LOGIN_FAILS) {
                    console.warn(`AUDIT // ${email} bloqueado ${LOGIN_LOCK_MS / 60000} min por contraseñas incorrectas 🟡`);
                    return res.status(429).json({ code: "auth/too-many-attempts", retryAfterMinutes: LOGIN_LOCK_MS / 60000 });
                }
                return res.status(401).json({ code: "auth/invalid-credential", attempts });
            } catch (dbError) {
                console.error("DB_AUDIT_CRITICAL_ERROR 🔴", esProduccion ? dbError.message : dbError);
                return res.status(401).json({ code: "auth/invalid-credential" });
            }
        }

        if (errorCode === "USER_DISABLED") {
            return res.status(403).json({ code: "auth/user-banned", message: "User is banned" });
        }
        if (errorCode === "TOO_MANY_ATTEMPTS_TRY_LATER") {
            return res.status(429).json({ code: "auth/too-many-attempts" });
        }

        // Error que NO es de credenciales (red, API key inválida...)
        console.error("SYSTEM_LOGIN_ERROR 🔴", errorCode || error.message);
        return res.status(500).json({ code: "auth/general-error", message: "Internal Server Error" });
    }
})

// ═══════════════════════════════════════════════════════════════
//  LOGOUT
// ═══════════════════════════════════════════════════════════════
authRouter.post("/logout", async (req, res) => {
    const idToken = req.cookies?.idToken;
    try {
        if (typeof idToken === "string" && idToken) {
            const decoded = await auth.verifyIdToken(idToken)
            await Audit.create({
                uid: decoded.uid,
                email: decoded.email,
                event: "logout",
                ip: getClientIp(req),
                userAgent: str(req.headers["user-agent"], 500)
            });
        }
        clearSessionCookie(res);
        return res.status(200).json({ message: "Logout audited! 🟢" })
    } catch (error) {
        // Aunque el token esté vencido o revocado, la cookie se borra igual
        clearSessionCookie(res);
        console.error(esProduccion ? `Logout fallback! 🔴` : `Logout fallback! 🔴 ${error}`);
        return res.status(200).json({ message: "Logout fallback! 🟡" });
    }
})

// /login-failed ELIMINADO: era público y permitía banear a cualquiera (incluido el admin)
// mandando su email 5 veces. Los fallos ahora se cuentan dentro de /login.

// ═══════════════════════════════════════════════════════════════
//  ADMIN: BAN / UNBAN
// ═══════════════════════════════════════════════════════════════
authRouter.post("/admin/ban-user", adminMiddleware, async (req, res) => {
    const email = normEmail(req.body?.email);
    if (!EMAIL_REGEX.test(email)) {
        return res.status(400).json({ code: "auth/invalid-email", message: "Valid email is required! 🔴" })
    }
    try {
        const user = await auth.getUserByEmail(email)

        if (user.uid === req.user.uid) {
            return res.status(400).json({ code: "auth/cannot-ban-self", message: "You can't ban yourself! 🔴" })
        }
        if (user.customClaims?.admin === true) {
            return res.status(403).json({ code: "auth/cannot-ban-admin", message: "Admins can't be banned from the panel! 🔴" })
        }

        const now = Date.now()
        // Merge: se conservan nombre, apellido, planes y demás claims
        await auth.setCustomUserClaims(user.uid, {
            ...(user.customClaims || {}),
            banned: true,
            bannedAt: now,
            bannedReason: "Banned directly by admin."
        })
        await auth.revokeRefreshTokens(user.uid) // Corta todas sus sesiones

        await Audit.create({
            uid: user.uid,
            email: user.email,
            event: "admin-ban",
            ip: getClientIp(req),
            metadata: { by: req.user.email, byUid: req.user.uid }
        }).catch((e) => console.error("Audit admin-ban failed 🟡", e.message));

        return res.status(200).json({ message: "User banned successfully! 🟢" })
    } catch (error) {
        if (error.code === "auth/user-not-found") {
            return res.status(404).json({ code: "auth/user-not-found", message: "User not found! 🔴" })
        }
        console.error("Error banning user 🔴", esProduccion ? error.message : error);
        return res.status(500).json({ code: "auth/general-error", message: "Error banning user! 🔴" });
    }
})

authRouter.post("/unban-user", adminMiddleware, async (req, res) => {
    const uid = req.body?.uid
    if (typeof uid !== "string" || !uid || uid.length > 128) {
        return res.status(400).json({ message: "User UID is required! 🔴" })
    }
    try {
        const user = await auth.getUser(uid)

        // Merge: se quitan SOLO las claims del ban (antes se borraba todo, incluso admin)
        const { banned, bannedAt, bannedReason, ...resto } = user.customClaims || {};
        await auth.setCustomUserClaims(uid, resto)
        await auth.revokeRefreshTokens(uid)

        // Reseteo intentos de login (se guardan por email, no por uid)
        await Audit.findOneAndUpdate(
            { email: normEmail(user.email), event: "login-failed" },
            { $set: { attempts: 0, lastAttemptAt: null } }
        )
        // Reseteo strikes por zona admin (si no, al primer intento lo vuelve a banear)
        await Audit.findOneAndUpdate(
            { uid, event: "intrusion-user" },
            { $set: { attempts: 0, lastAttemptAt: null } }
        )
        await Audit.create({
            uid,
            email: user.email,
            event: "forced_logout",
            ip: getClientIp(req),
            metadata: { action: "unban", by: req.user.email, byUid: req.user.uid }
        });
        return res.status(200).json({ message: "User unbanned successfully! 🟢" });

    } catch (error) {
        if (error.code === "auth/user-not-found") {
            return res.status(404).json({ code: "auth/user-not-found", message: "User not found! 🔴" })
        }
        console.error("Error unbanning user! 🔴", esProduccion ? error.message : error);
        return res.status(500).json({ message: "Error unbanning user! 🔴" });
    }
})

// ═══════════════════════════════════════════════════════════════
//  SESIÓN
// ═══════════════════════════════════════════════════════════════
authRouter.get("/check-auth", verifyToken, (req, res) => {
    return res.status(200).json({
        authenticated: true,
        user: sesionPublica(req.user),
        isAdmin: req.user.admin === true
    });
});

authRouter.get("/me", verifyToken, (req, res) => {
    return res.status(200).json({ user: sesionPublica(req.user) });
});

// ═══════════════════════════════════════════════════════════════
//  ZONA ADMIN: verificación al entrar (PrivateRoute adminOnly y AdminDashboard)
//  - Sin sesión → strike a la IP (a los 10 en 1 h, bloqueo 24 h). Igual que Boggero.
//  - Usuario común que escribe /admin a mano → 403, sin ban.
//  - Sesión falseada que dice admin con un token NO admin (rompió el PrivateRoute)
//    → SecurityIncident + ban + revocar sesiones + borrar cookie. Igual que Hidden Security.
//  - Nunca banea a un admin (el token firmado dice admin → pasa).
// ═══════════════════════════════════════════════════════════════
authRouter.post("/admin/verify-access", async (req, res) => {
    try {
        if (await isIpBlocked(getClientIp(req))) {
            return res.status(403).json({ code: "auth/ip-blocked", message: "ACCESS_BLOCKED 🔴" });
        }
    } catch (error) {
        console.error("Error checking IP block 🔴", esProduccion ? error.message : error);
    }

    const token = req.cookies?.idToken;
    if (!token || typeof token !== "string") {
        await strikeIp(req, "no-token-admin-zone");
        return res.status(401).json({ code: "auth/no-session", message: "No credentials! 🔴" });
    }

    let decoded;
    try {
        decoded = await auth.verifyIdToken(token, true);
    } catch (error) {
        if (!BENIGN_TOKEN_ERRORS.includes(error.code)) await strikeIp(req, "invalid-token-admin-zone");
        clearSessionCookie(res);
        return res.status(401).json({ code: "auth/invalid-session", message: "Unauthorized" });
    }

    if (decoded.banned === true) {
        return res.status(403).json({ code: "auth/user-banned", message: "User is banned" });
    }

    // Admin real según el token firmado por Firebase
    if (decoded.admin === true) {
        return res.status(200).json({ ok: true });
    }

    // claimedAdmin: lo que decía la sesión del front. Un usuario común nunca lo manda en true,
    // porque su sesión dice admin: false. Si llega true con un token NO admin, alguien
    // falseó la sesión (Burp / DevTools) para romper el PrivateRoute → ban.
    const claimedAdmin = req.body?.claimedAdmin === true;

    // Usuario común que escribió /admin a mano: no rompió nada, solo se le niega el acceso
    if (!claimedAdmin) {
        return res.status(403).json({ code: "auth/forbidden", message: "ACCESS_DENIED: ADMIN_ONLY_ZONE 🔴" });
    }

    const now = Date.now();

    let userRecord = null;
    try {
        userRecord = await auth.getUser(decoded.uid);
    } catch (err) {
        console.error("verify-access getUser failed 🔴", esProduccion ? err.message : err);
    }

    // Caso legítimo: lo acaban de hacer admin y su token todavía es el viejo → no se banea
    if (userRecord?.customClaims?.admin === true && userRecord?.customClaims?.banned !== true) {
        return res.status(409).json({ code: "SESSION_REFRESH_REQUIRED", message: "Volvé a iniciar sesión." });
    }

    // ── Ban (merge: conserva compras, planes y demás claims) ─────────────────
    let actionTaken = "banned";
    let actionError = null;
    try {
        if (userRecord?.customClaims?.banned === true) {
            actionTaken = "already-banned";
        } else {
            await auth.setCustomUserClaims(decoded.uid, {
                ...(userRecord?.customClaims || {}),
                banned: true,
                bannedAt: now,
                bannedReason: "Unauthorized admin access attempt",
            });
        }
        await auth.revokeRefreshTokens(decoded.uid);
    } catch (err) {
        actionTaken = "ban-failed";
        actionError = str(err?.message, 500);
        console.error("verify-access ban failed 🔴", esProduccion ? err.message : err);
    }

    // ── Registro del incidente ───────────────────────────────────────────────
    let incidentId = null;
    try {
        const incident = await SecurityIncident.create({
            type:             "unauthorized-admin-access",
            zone:             "admin",
            uid:              decoded.uid,
            email:            decoded.email || userRecord?.email || null,
            emailVerified:    userRecord?.emailVerified ?? decoded.email_verified ?? null,
            accountCreatedAt: userRecord?.metadata?.creationTime ? new Date(userRecord.metadata.creationTime) : null,
            lastSignInAt:     userRecord?.metadata?.lastSignInTime ? new Date(userRecord.metadata.lastSignInTime) : null,

            ip:             getClientIp(req),
            ipChain:        str(req.headers["x-forwarded-for"]),
            country:        str(req.headers["cf-ipcountry"], 10),
            userAgent:      str(req.headers["user-agent"], 500),
            acceptLanguage: str(req.headers["accept-language"], 200),
            referer:        str(req.headers["referer"], 500),
            origin:         str(req.headers["origin"], 200),

            method:        req.method,
            endpoint:      str(req.originalUrl, 200),
            attemptedPath: str(req.body?.path, 200),
            attemptedTab:  str(req.body?.tab, 50),

            tokenClaims: {
                admin:        decoded.admin === true,
                isEnterprise: !!decoded.isEnterprise,
                partner:      !!decoded.partner,
                banned:       decoded.banned === true,
            },
            signInProvider: str(decoded.firebase?.sign_in_provider, 50),
            tokenIssuedAt:  decoded.iat ? new Date(decoded.iat * 1000) : null,
            tokenAuthTime:  decoded.auth_time ? new Date(decoded.auth_time * 1000) : null,

            actionTaken,
            actionError,
            detectedAt: new Date(now),
        });
        incidentId = String(incident._id);
    } catch (err) {
        console.error("SECURITY_INCIDENT save failed 🔴", esProduccion ? err.message : err);
    }

    // También en la auditoría general
    try {
        await Audit.create({
            uid:       decoded.uid,
            email:     decoded.email,
            event:     "security-threat",
            ip:        getClientIp(req),
            userAgent: str(req.headers["user-agent"], 500),
            metadata:  { reason: "unauthorized-admin-access", incidentId, actionTaken, claimedAdmin },
        });
    } catch (err) {
        console.error("Audit security-threat failed 🔴", esProduccion ? err.message : err);
    }

    console.warn(`🚨 SECURITY_THREAT // unauthorized admin access uid=${decoded.uid} email=${decoded.email} ip=${getClientIp(req)} action=${actionTaken} spoofedFront=${claimedAdmin}`);

    clearSessionCookie(res);

    return res.status(403).json({
        code:    "SECURITY_THREAT",
        message: "Unauthorized admin access attempt detected.",
        incidentId,
    });
});

// ═══════════════════════════════════════════════════════════════
//  MI CUENTA: perfil (nombre, apellido, fecha de alta) y cambio de contraseña
//    GET  /account/profile          -> datos del usuario logueado
//    PUT  /account/profile          -> guarda nombre y apellido
//    POST /account/change-password  -> pide la actual y 2 veces la nueva
//  El usuario sale SIEMPRE de req.user (token verificado), nunca del body.
// ═══════════════════════════════════════════════════════════════

// Letras (con tildes y ñ), espacios, apóstrofo, punto y guion. De 2 a 40 caracteres.
const NAME_REGEX = /^\p{L}[\p{L}' .-]{1,39}$/u;

const limpiarNombre = (v) => (typeof v === "string" ? v.trim().replace(/\s+/g, " ") : "");

function perfilDe(userRecord) {
    const claims = userRecord.customClaims || {};
    return {
        uid: userRecord.uid,
        email: userRecord.email,
        nombre: claims.nombre || null,
        apellido: claims.apellido || null,
        createdAt: userRecord.metadata?.creationTime ? new Date(userRecord.metadata.creationTime).toISOString() : null,
        lastLogin: userRecord.metadata?.lastSignInTime ? new Date(userRecord.metadata.lastSignInTime).toISOString() : null,
        emailVerified: !!userRecord.emailVerified,
    };
}

authRouter.get("/account/profile", verifyToken, async (req, res) => {
    try {
        const userRecord = await auth.getUser(req.user.uid);
        return res.status(200).json({ profile: perfilDe(userRecord) });
    } catch (error) {
        console.error("Error reading profile 🔴", esProduccion ? error.message : error);
        return res.status(500).json({ code: "auth/general-error", message: "Error reading profile" });
    }
});

authRouter.put("/account/profile", verifyToken, async (req, res) => {
    const nombre = limpiarNombre(req.body?.nombre);
    const apellido = limpiarNombre(req.body?.apellido);
    const errors = {};
    if (!NAME_REGEX.test(nombre)) errors.nombre = "Nombre no válido (de 2 a 40 letras).";
    if (!NAME_REGEX.test(apellido)) errors.apellido = "Apellido no válido (de 2 a 40 letras).";
    if (Object.keys(errors).length) {
        return res.status(400).json({ code: "profile/invalid", message: "Invalid name", errors });
    }

    try {
        const userRecord = await auth.getUser(req.user.uid);
        const claims = userRecord.customClaims || {};

        // Si lo banearon mientras este pedido estaba en curso, no se reescriben sus claims
        if (claims.banned === true) {
            return res.status(403).json({ code: "auth/user-banned", message: "User is banned" });
        }

        // Se SUMAN a los claims existentes (admin, banned, planes... no se pierden)
        await auth.setCustomUserClaims(req.user.uid, { ...claims, nombre, apellido });
        await auth.updateUser(req.user.uid, { displayName: `${nombre} ${apellido}` });

        const actualizado = await auth.getUser(req.user.uid);
        return res.status(200).json({ profile: perfilDe(actualizado) });
    } catch (error) {
        console.error("Error updating profile 🔴", esProduccion ? error.message : error);
        return res.status(500).json({ code: "auth/general-error", message: "Error updating profile" });
    }
});

// loginLimiter: mismo freno que el login contra intentos repetidos de la contraseña actual
authRouter.post("/account/change-password", loginLimiter, verifyToken, async (req, res) => {
    const { currentPassword, newPassword, confirmPassword } = req.body ?? {};
    const email = normEmail(req.user.email);

    if (typeof currentPassword !== "string" || !currentPassword || typeof newPassword !== "string" || typeof confirmPassword !== "string") {
        return res.status(400).json({ code: "auth/missing-fields", message: "All fields are required" });
    }
    if (currentPassword.length > 128 || newPassword.length > 128 || !PASSWORD_REGEX.test(newPassword)) {
        return res.status(400).json({ code: "auth/weak-password", message: "Password does not meet security requirements! 🔴" });
    }
    if (newPassword !== confirmPassword) {
        return res.status(400).json({ code: "auth/passwords-dont-match", message: "Passwords do not match" });
    }
    if (newPassword === currentPassword) {
        return res.status(400).json({ code: "auth/same-password", message: "New password must be different" });
    }

    // 1. Comprobar la contraseña actual contra Firebase
    try {
        await idTokenDe(email, currentPassword);
    } catch (error) {
        const code = firebaseCodeDe(error);
        if (["INVALID_PASSWORD", "INVALID_LOGIN_CREDENTIALS"].includes(code)) {
            return res.status(401).json({ code: "auth/wrong-password", message: "Current password is wrong" });
        }
        if (code === "TOO_MANY_ATTEMPTS_TRY_LATER") {
            return res.status(429).json({ code: "auth/too-many-requests", message: "Too many attempts. Try later." });
        }
        console.error("Error checking current password 🔴", code || error.message);
        return res.status(500).json({ code: "auth/general-error", message: "Error changing password" });
    }

    // 2. Guardar la nueva y cerrar TODAS las otras sesiones (por si alguien más tenía la vieja)
    try {
        await auth.updateUser(req.user.uid, { password: newPassword });
        await auth.revokeRefreshTokens(req.user.uid);
    } catch (error) {
        if (error.code === "auth/invalid-password") {
            return res.status(400).json({ code: "auth/weak-password", message: "Password does not meet security requirements! 🔴" });
        }
        console.error("Error changing password 🔴", esProduccion ? error.message : error);
        return res.status(500).json({ code: "auth/general-error", message: "Error changing password" });
    }

    // 3. Nueva cookie para ESTA sesión (la vieja quedó revocada)
    let reloginRequired = false;
    try {
        setSessionCookie(res, await idTokenDe(email, newPassword));
    } catch (error) {
        reloginRequired = true;
        clearSessionCookie(res);
        console.error("Error re-issuing session after password change 🟡", firebaseCodeDe(error) || error.message);
    }

    // 4. Auditar (si el modelo no admite el evento, no rompe el cambio)
    try {
        await Audit.create({
            uid: req.user.uid,
            email,
            event: "password-changed",
            ip: getClientIp(req),
            userAgent: str(req.headers["user-agent"], 500),
        });
    } catch (auditErr) {
        console.error("Audit password-changed failed 🟡", auditErr.message);
    }

    return res.status(200).json({ message: "Password changed! 🟢", reloginRequired });
});

module.exports = authRouter