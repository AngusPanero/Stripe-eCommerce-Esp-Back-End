const auth = require("../config/firebase")

const esProduccion = (process.env.NODE_ENV === 'production');

const verifyToken = async (req, res, next) => {
    // Cookie httpOnly (navegador). El header Bearer solo se acepta fuera de producción (Postman en dev).
    const cookieToken = req.cookies?.idToken;
    const header = req.headers.authorization;
    const headerToken = !esProduccion && typeof header === "string" && header.startsWith("Bearer ")
        ? header.slice(7)
        : null;
    const token = (typeof cookieToken === "string" && cookieToken) ? cookieToken : headerToken;

    if (!token) {
        return res.status(401).json({ code: "auth/no-session", message: "No credentials! 🔴" })
    }

    let decoded;
    try {
        // checkRevoked = true: si lo banearon o cambió la contraseña, el token deja de valer AL INSTANTE
        decoded = await auth.verifyIdToken(token, true)
    } catch (error) {
        console.error(esProduccion ? `Unauthorized! 🔴` : `Unauthorized! 🔴 ${error}`);
        return res.status(401).json({ code: "auth/invalid-session", message: "Unauthorized" });
    }

    // Baneado: se corta en cada pedido, no solo en el login
    if (decoded.banned === true) {
        return res.status(403).json({ code: "auth/user-banned", message: "User is banned" });
    }

    // Email sin verificar (los admin pasan igual, como en el login)
    if (!decoded.email_verified && decoded.admin !== true) {
        return res.status(403).json({ code: "auth/email-not-verified", message: "Email not verified" });
    }

    req.user = decoded // Claims verificadas y firmadas por Firebase: la única fuente de verdad
    next()
}

module.exports = verifyToken