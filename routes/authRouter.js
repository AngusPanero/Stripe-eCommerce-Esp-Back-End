// Express y Router
const express = require("express")
const authRouter = express.Router()
// Firebase
const auth = require("../config/firebase")
// Models
const Audit = require("../models/AuditSchema")
const { LegalConsent, LEGAL_DOCUMENTS } = require("../models/LegalConsent")
// Middlewares
const loginLimiter = require("../middleware/rateLimitMiddleware")
const checkBanned = require("../middleware/checkBanned")
const verifyToken = require("../middleware/authMiddleware")
const adminMiddleware = require("../middleware/adminMiddleware")

// Axios
const axios = require("axios")

const esProduccion = (process.env.NODE_ENV === 'production');

// ── Validaciones, verificación de email (Firebase) y helpers ──

// Mismas regex que el front (SessionContext.tsx)
const PASSWORD_REGEX = /^(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()_+=[\]{};':"\\|,.<>/?`~-]).{10,}$/;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const FIREBASE_REST = "https://identitytoolkit.googleapis.com/v1/accounts";
// En dev usa LOCAL_HOST (http://localhost:5173) y en producción FRONT_END
const FRONT_URL = ((esProduccion ? process.env.FRONT_END : process.env.LOCAL_HOST) || "").replace(/\/+$/, "");

// IP real detrás de Cloudflare / Render
const getClientIp = (req) =>
    req.headers["cf-connecting-ip"] ||
    (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    req.ip ||
    null;

// Inicia sesión en la API REST de Firebase solo para obtener el idToken del usuario
// (es lo que pide Firebase para mandar el email de verificación).
async function idTokenDe(email, password) {
    const { data } = await axios.post(
        `${FIREBASE_REST}:signInWithPassword?key=${process.env.FIREBASE_API_KEY}`,
        { email, password, returnSecureToken: true }
    );
    return data.idToken;
}

// El email de verificación lo envía FIREBASE (su plantilla y su remitente:
// Firebase Console → Authentication → Templates → Verificación de dirección de correo).
// No usa Brevo ni nodemailer.
async function sendVerificationEmail(idToken) {
    const url = `${FIREBASE_REST}:sendOobCode?key=${process.env.FIREBASE_API_KEY}`;
    try {
        await axios.post(url, {
            requestType: "VERIFY_EMAIL",
            idToken,
            // Después de verificar, el botón "Continuar" vuelve a la web (dominio autorizado en Firebase)
            ...(FRONT_URL ? { continueUrl: `${FRONT_URL}/` } : {}),
        });
    } catch (error) {
        const code = (error.response?.data?.error?.message || "").split(" ")[0];
        // Dominio no autorizado en Firebase: se manda igual, sin el botón "Continuar"
        if (FRONT_URL && (code === "UNAUTHORIZED_DOMAIN" || code === "INVALID_CONTINUE_URI")) {
            console.warn(`⚠️ ${FRONT_URL} no está en Authorized domains de Firebase: se envía sin continueUrl`);
            await axios.post(url, { requestType: "VERIFY_EMAIL", idToken });
            return;
        }
        throw error;
    }
}

// Un reenvío por email cada 60 s (evita usar la ruta para spamear o probar contraseñas)
const ultimoReenvio = new Map();
const REENVIO_MS = 60 * 1000;

authRouter.post("/register", async (req, res) => {
    const { email: rawEmail, password, acceptedLegal } = req.body ?? {};
    const email = typeof rawEmail === "string" ? rawEmail.trim().toLowerCase() : "";

    try {
        if (!email || typeof password !== "string") {
            return res.status(400).json({ code: "auth/missing-fields", message: "All fields are required to create an user! 🔴" });
        }

        if (!EMAIL_REGEX.test(email)) {
            return res.status(400).json({ code: "auth/invalid-email", message: "Invalid email format! 🔴" });
        }

        if (!PASSWORD_REGEX.test(password)) {
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
            console.error(esProduccion ? "Error saving legal consent! 🔴" : `Error saving legal consent! 🔴 ${consentErr}`);
            try {
                await auth.deleteUser(userRecord.uid);
            } catch (rollbackErr) {
                console.error(esProduccion ? "Rollback failed! 🔴" : `Rollback failed! 🔴 ${rollbackErr}`);
            }
            return res.status(500).json({ code: "auth/general-error", message: "Error creating user! 🔴" });
        }

        // Email de verificación (lo manda Firebase). Si falla, la cuenta queda
        // creada y puede pedir el reenvío desde el login.
        try {
            const idToken = await idTokenDe(email, password);
            await sendVerificationEmail(idToken);
            ultimoReenvio.set(email, Date.now());
        } catch (emailErr) {
            console.error("Error enviando email de verificación 🔴", emailErr.response?.data?.error?.message || emailErr.message);
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
        console.error(esProduccion ? "Error creating user! 🔴" : `Error creating user! 🔴 ${error}`);
        return res.status(500).json({ code: "auth/general-error", message: "Error creating user! 🔴" });
    }
});


// Reenvío del email de verificación
// Pide email y contraseña (los del formulario de login): Firebase necesita
// la sesión del usuario para mandarle el email de verificación.
authRouter.post("/resend-verification", async (req, res) => {
    const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
    const password = req.body?.password;

    if (!EMAIL_REGEX.test(email) || typeof password !== "string" || !password) {
        return res.status(400).json({ code: "auth/missing-fields", message: "Email and password are required." });
    }

    const ultimo = ultimoReenvio.get(email);
    if (ultimo && Date.now() - ultimo < REENVIO_MS) {
        return res.status(429).json({ code: "auth/too-many-requests", message: "Wait a minute before requesting another email." });
    }
    ultimoReenvio.set(email, Date.now());

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
        const firebaseCode = (error.response?.data?.error?.message || "").split(" ")[0];
        if (["INVALID_PASSWORD", "INVALID_LOGIN_CREDENTIALS", "EMAIL_NOT_FOUND"].includes(firebaseCode)) {
            return res.status(401).json({ code: "auth/invalid-credential", message: "Wrong password." });
        }
        if (firebaseCode === "TOO_MANY_ATTEMPTS_TRY_LATER") {
            return res.status(429).json({ code: "auth/too-many-requests", message: "Too many requests. Try later." });
        }
        console.error("Error reenviando verificación 🔴", firebaseCode || error.message);
        return res.status(500).json({ code: "auth/general-error", message: "Error sending email." });
    }
});

authRouter.post("/login", loginLimiter, async (req, res) => {
    const { email, password } = req.body; 

    try {
        // 0. ¿El email existe? Si no, aviso claro y sin sumar intentos ni banear   [NUEVO]
        if (typeof email !== "string" || !email.trim() || typeof password !== "string") {
            return res.status(400).json({ code: "auth/missing-fields", message: "Email and password are required" });
        }
        try {
            await auth.getUserByEmail(email.trim());
        } catch (lookupError) {
            if (lookupError.code === "auth/user-not-found") {
                return res.status(404).json({ code: "auth/user-not-found", message: "Email not registered" });
            }
            throw lookupError;
        }

        // 1. Validar credenciales contra la API de Firebase Auth
        const firebaseResponse = await axios.post(
            `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${process.env.FIREBASE_API_KEY}`,
            { email, password, returnSecureToken: true }
        );

        const { idToken, localId: uid } = firebaseResponse.data;

        // 2. Verificar el token obtenido y obtener claims
        const decoded = await auth.verifyIdToken(idToken);

        // 3. Control de Baneo (Lógica de negocio)
        if (decoded.banned) {
            return res.status(403).json({ code: "auth/user-banned", message: "User is banned" });
        }

        // 3.5 Email verificado (los admin entran igual)   [NUEVO]
        if (!decoded.email_verified && decoded.admin !== true) {
            return res.status(403).json({ code: "auth/email-not-verified", message: "Email not verified" });
        }

        // 4. Limpiar intentos fallidos y Auditar
        await Audit.findOneAndUpdate(
            { email: decoded.email, event: "login-failed" },
            { $set: { attempts: 0, lastAttemptAt: null } }
        );

        await Audit.create({
            uid: uid,
            email: decoded.email,
            event: "login",
            ip: req.ip,
            userAgent: req.headers["user-agent"]
        });

        // 5. Configurar Cookie
        if (esProduccion) {
            res.cookie("idToken", idToken, {
                httpOnly: true,
                sameSite: "lax",
                secure: true,
                domain: ".quintadeargos.com",
                maxAge: 60 * 60 * 1000,
                path: "/"
            });
        } else {
            res.cookie("idToken", idToken, {
                httpOnly: true,
                sameSite: "none",
                secure: true,
                path: "/" 
            });
        }

        // Enviamos los datos necesarios para el setUser del front
        return res.status(200).json({ 
            user: decoded, 
            idToken,
            isAdmin: decoded.admin === true,
            isEnterprise: !!decoded.isEnterprise
        });

    } catch (error) {
        const errorData = error.response?.data?.error?.message;
        
        // Limpiamos el error por si viene con texto extra (ej: "INVALID_PASSWORD : ...")
        const errorCode = errorData ? errorData.split(' ')[0] : null;
        const now = Date.now();

        console.log("DEBUG // Error detectado:", errorCode);

        // 2. Definimos los errores que disparan la auditoría
        const loginErrors = ["INVALID_PASSWORD", "EMAIL_NOT_FOUND", "INVALID_LOGIN_CREDENTIALS"];

        if (loginErrors.includes(errorCode)) {
            try {
                // USAMOS REQ.BODY.EMAIL directamente para asegurar que existe en este scope
                const userEmail = req.body.email;

                console.log(`INFO // Colección destino: ${Audit.collection.name}`); // <--- AGREGA ESTO
                console.log(`INFO // Base de datos destino: ${Audit.db.name}`);

                const attempt = await Audit.findOneAndUpdate(
                    { email: userEmail, event: "login-failed" },
                    { 
                        $inc: { attempts: 1 }, 
                        $set: { lastAttemptAt: now } 
                    },
                    { upsert: true, returnDocument: 'after' }
                );

                console.log(`AUDIT // Fallo registrado para ${userEmail}. Intento: ${attempt.attempts}`);

                if (attempt.attempts >= 5) {
                    try {
                        const userRecord = await auth.getUserByEmail(userEmail);
                        await auth.setCustomUserClaims(userRecord.uid, {
                            banned: true,
                            bannedAt: now,
                            bannedReason: "Too many failed login attempts"
                        });
                        await auth.revokeRefreshTokens(userRecord.uid);
                        
                        return res.status(401).json({ 
                            code: "auth/too-many-attempts", 
                            banned: true 
                        });
                    } catch (getUserError) {
                        // El email no existe en Firebase, pero ya auditamos el intento
                        return res.status(401).json({ 
                            code: "auth/invalid-credential", 
                            attempts: attempt.attempts 
                        });
                    }
                }

                return res.status(401).json({ 
                    code: "auth/invalid-credential", 
                    attempts: attempt.attempts 
                });

            } catch (dbError) {
                console.error("DB_AUDIT_CRITICAL_ERROR 🔴", dbError);
                return res.status(401).json({ code: "auth/invalid-credential" });
            }
        }
        
        // 3. Si el error NO es de credenciales (ej: error de red, API key inválida)
        console.error("SYSTEM_LOGIN_ERROR 🔴", errorCode || error.message);
        return res.status(500).json({ message: "Internal Server Error" });
    }
})

authRouter.post("/logout", async (req, res) => {
    const idToken = req.cookies.idToken;
    try {
        if(idToken){
            const decoded = await auth.verifyIdToken(idToken)
            // Audito el logout
            await Audit.create({
                uid: decoded.uid,
                email: decoded.email,
                event: "logout",
                ip: req.ip || req.headers['x-forwarded-for'],
                userAgent: req.headers["user-agent"]
            });
        }
        // Limpio Cookie
        if (esProduccion) {
            res.clearCookie("idToken", {
                httpOnly: true,
                sameSite: "lax",
                secure: true,
                domain: ".quintadeargos.com",
                path: "/" 
            });
        } else {
            res.clearCookie("idToken", {
                httpOnly: true,
                sameSite: "none",
                secure: true,
                path: "/" 
            });
        }

        return res.status(200).json({ message: "Logout audited! 🟢" })
    } catch (error) {
        console.error(esProduccion ? `Logout fallback! 🔴` : `Logout fallback! 🔴 ${error}`);
        return res.status(200).json({ message: "Logout fallback! 🟡" });
        // Devuelvo 200 opr UX para no confundir al front y borrar token cuando no se deslogueo bien
    }
})

authRouter.post("/login-failed", async (req, res) => {
    const { email } = req.body
    console.log("Auditing failed login for email:", email);
    if(!email){
            return res.status(400).json({ message: "Email is required to audit failed login! 🔴" })
        }
    try {
        const now = Date.now()
        const attempt = await Audit.findOneAndUpdate(
            { email, event: "login-failed" },
            {
                $inc: { attempts: 1 },
                $set: { lastAttemptAt: now }
            },
            { upsert: true, new: true } // Esto si no existe lo creó aca
        )
        if(attempt.attempts >= 5){
            const user = await auth.getUserByEmail(email)

            await auth.setCustomUserClaims(user.uid, {
                banned: true,
                bannedAt: now,
                bannedReason: "Too many failed login attempts"
            })
            await auth.revokeRefreshTokens(user.uid) // Borro todos sus tokens existentes
            return res.status(200).json({ message: "User banned due to too many failed attempts! 🔴", banned: true })
        }
        return res.status(200).json({ message: "Failed login attempt recorded! 🟡", attempts: attempt.attempts })
    } catch (error) {
        console.error(esProduccion ? `Error auditing failed login 🔴` : `Error auditing failed login 🔴 ${error}`);
        return res.status(500).json({ message: "Error auditing failed login! 🔴" });  
    }
})

authRouter.post("/admin/ban-user", adminMiddleware, async (req, res) => {
    const { email } = req.body
    if(!email){
            return res.status(400).json({ message: "Email is required to audit failed login! 🔴" })
        }
    try {
        const now = Date.now()
        
      
        const user = await auth.getUserByEmail(email)

        await auth.setCustomUserClaims(user.uid, {
            banned: true,
            bannedAt: now,
            bannedReason: "Banned directly by admin."
        })
        await auth.revokeRefreshTokens(user.uid) // Borro todos sus tokens existentes

        return res.status(200).json({ message: "User banned successfully! 🟢",})
    } catch (error) {
        console.error(esProduccion ? `Error auditing failed login 🔴` : `Error auditing failed login 🔴 ${error}`);
        return res.status(500).json({ message: "Error auditing failed login! 🔴" });  
    }
})

authRouter.post("/unban-user", adminMiddleware, async (req, res) => {
    const { uid } = req.body
    if(!uid){
            return res.status(400).json({ message: "User UID is required! 🔴" })
        }
    try {
        const user = await auth.getUser(uid)
        await auth.setCustomUserClaims(uid, { banned: false })

        await auth.revokeRefreshTokens(uid)

        // Reseteo attempts
        await Audit.findOneAndUpdate(
            { uid, event: "login-failed" },
            { $set: { attempts: 0, lastAttemptAt: null } }
        )
        // Audito el unban
        await Audit.create({
            uid,
            email: user.email,
            event: "forced_logout",
            metadata: {
                action: "unban",
                by: "admin"
            }
            });
        return res.status(200).json({ message: "User unbanned successfully! 🟢"});

    } catch (error) {
        console.error(esProduccion ? `Error unbanning user! 🔴` : `Error unbanning user! 🔴 ${error}`);
        return res.status(500).json({ message: "Error unbanning user! 🔴" });
    }
})

authRouter.get("/check-auth", verifyToken, async (req, res) => {
    const idToken = req.cookies.idToken;

    if (!idToken) {
        return res.status(401).json({ authenticated: false });
    }

    try {
        const decoded = await auth.verifyIdToken(idToken);
        return res.status(200).json({ 
            authenticated: true, 
            user: decoded,
            isAdmin: decoded.admin === true 
        });
    } catch (error) {
        return res.status(401).json({ authenticated: false });
    }
});

authRouter.get("/me", verifyToken, checkBanned, async (req, res) => {
    const idToken = req.cookies.idToken; 

    if (!idToken) return res.status(401).json({ message: "No token" });
    try {
        const decoded = await auth.verifyIdToken(idToken);
        
        if (decoded.banned) {
            return res.status(403).json({ message: "Banned" });
        }
        return res.status(200).json({ user: decoded });
    } catch (error) {
        return res.status(401).json({ message: "Invalid token" });
    }
});

// ═══════════════════════════════════════════════════════════════
//  MI CUENTA: perfil (nombre, apellido, fecha de alta) y cambio de contraseña
//    GET  /account/profile          -> datos del usuario logueado
//    PUT  /account/profile          -> guarda nombre y apellido
//    POST /account/change-password  -> pide la actual y 2 veces la nueva
//  La sesión sale de la cookie idToken, igual que /check-auth y /me.
// ═══════════════════════════════════════════════════════════════

// Letras (con tildes y ñ), espacios, apóstrofo, punto y guion. De 2 a 40 caracteres.
const NAME_REGEX = /^\p{L}[\p{L}' .-]{1,39}$/u;

const limpiarNombre = (v) => (typeof v === "string" ? v.trim().replace(/\s+/g, " ") : "");

// Lee y valida la cookie de sesión
async function usuarioDeLaCookie(req) {
    const idToken = req.cookies?.idToken;
    if (!idToken) return null;
    try {
        return await auth.verifyIdToken(idToken);
    } catch {
        return null;
    }
}

function perfilDe(userRecord) {
    const claims = userRecord.customClaims || {};
    return {
        uid: userRecord.uid,
        email: userRecord.email,
        nombre: claims.nombre || null,
        apellido: claims.apellido || null,
        // Fechas de Firebase Auth (ISO)
        createdAt: userRecord.metadata?.creationTime ? new Date(userRecord.metadata.creationTime).toISOString() : null,
        lastLogin: userRecord.metadata?.lastSignInTime ? new Date(userRecord.metadata.lastSignInTime).toISOString() : null,
        emailVerified: !!userRecord.emailVerified,
    };
}

authRouter.get("/account/profile", verifyToken, checkBanned, async (req, res) => {
    const decoded = await usuarioDeLaCookie(req);
    if (!decoded) return res.status(401).json({ code: "auth/no-session", message: "No session" });
    try {
        const userRecord = await auth.getUser(decoded.uid);
        return res.status(200).json({ profile: perfilDe(userRecord) });
    } catch (error) {
        console.error(esProduccion ? "Error reading profile 🔴" : `Error reading profile 🔴 ${error}`);
        return res.status(500).json({ code: "auth/general-error", message: "Error reading profile" });
    }
});

authRouter.put("/account/profile", verifyToken, checkBanned, async (req, res) => {
    const decoded = await usuarioDeLaCookie(req);
    if (!decoded) return res.status(401).json({ code: "auth/no-session", message: "No session" });

    const nombre = limpiarNombre(req.body?.nombre);
    const apellido = limpiarNombre(req.body?.apellido);
    const errors = {};
    if (!NAME_REGEX.test(nombre)) errors.nombre = "Nombre no válido (de 2 a 40 letras).";
    if (!NAME_REGEX.test(apellido)) errors.apellido = "Apellido no válido (de 2 a 40 letras).";
    if (Object.keys(errors).length) {
        return res.status(400).json({ code: "profile/invalid", message: "Invalid name", errors });
    }

    try {
        // Se SUMAN a los claims existentes (admin, banned, etc. no se pierden)
        const userRecord = await auth.getUser(decoded.uid);
        const claims = userRecord.customClaims || {};
        await auth.setCustomUserClaims(decoded.uid, { ...claims, nombre, apellido });
        await auth.updateUser(decoded.uid, { displayName: `${nombre} ${apellido}` });

        const actualizado = await auth.getUser(decoded.uid);
        return res.status(200).json({ profile: perfilDe(actualizado) });
    } catch (error) {
        console.error(esProduccion ? "Error updating profile 🔴" : `Error updating profile 🔴 ${error}`);
        return res.status(500).json({ code: "auth/general-error", message: "Error updating profile" });
    }
});

// loginLimiter: mismo freno que el login contra intentos repetidos de la contraseña actual
authRouter.post("/account/change-password", loginLimiter, verifyToken, checkBanned, async (req, res) => {
    const decoded = await usuarioDeLaCookie(req);
    if (!decoded) return res.status(401).json({ code: "auth/no-session", message: "No session" });

    const { currentPassword, newPassword, confirmPassword } = req.body ?? {};

    if (typeof currentPassword !== "string" || !currentPassword || typeof newPassword !== "string" || typeof confirmPassword !== "string") {
        return res.status(400).json({ code: "auth/missing-fields", message: "All fields are required" });
    }
    if (!PASSWORD_REGEX.test(newPassword)) {
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
        await axios.post(
            `${FIREBASE_REST}:signInWithPassword?key=${process.env.FIREBASE_API_KEY}`,
            { email: decoded.email, password: currentPassword, returnSecureToken: true }
        );
    } catch (error) {
        const code = (error.response?.data?.error?.message || "").split(" ")[0];
        if (["INVALID_PASSWORD", "INVALID_LOGIN_CREDENTIALS"].includes(code)) {
            return res.status(401).json({ code: "auth/wrong-password", message: "Current password is wrong" });
        }
        if (code === "TOO_MANY_ATTEMPTS_TRY_LATER") {
            return res.status(429).json({ code: "auth/too-many-requests", message: "Too many attempts. Try later." });
        }
        console.error("Error checking current password 🔴", code || error.message);
        return res.status(500).json({ code: "auth/general-error", message: "Error changing password" });
    }

    // 2. Guardar la nueva
    try {
        await auth.updateUser(decoded.uid, { password: newPassword });
    } catch (error) {
        if (error.code === "auth/invalid-password") {
            return res.status(400).json({ code: "auth/weak-password", message: "Password does not meet security requirements! 🔴" });
        }
        console.error(esProduccion ? "Error changing password 🔴" : `Error changing password 🔴 ${error}`);
        return res.status(500).json({ code: "auth/general-error", message: "Error changing password" });
    }

    // 3. Auditar (si el modelo no admite el evento, no rompe el cambio)
    try {
        await Audit.create({
            uid: decoded.uid,
            email: decoded.email,
            event: "password-changed",
            ip: getClientIp(req),
            userAgent: req.headers["user-agent"],
        });
    } catch (auditErr) {
        console.error("Audit password-changed failed 🟡", auditErr.message);
    }

    return res.status(200).json({ message: "Password changed! 🟢" });
});

module.exports = authRouter