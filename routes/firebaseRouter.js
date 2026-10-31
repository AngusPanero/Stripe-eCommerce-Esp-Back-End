// backend/routes/firebaseRouter.js
const express = require("express");
const firebaseRouter = express.Router();
const auth = require("../config/firebase"); // firebase-admin
const adminMiddleware = require("../middleware/adminMiddleware");

const esProduccion = (process.env.NODE_ENV === 'production');

// Paginación: Firebase devuelve como máximo 1000 usuarios por página
const PAGE_MAX     = 1000;
const PAGE_DEFAULT = 500;
const PAGE_TOKEN_MAX_LEN = 2048;

// Solo URLs https: una photoURL rara (javascript:, data:, http:) no llega al panel
const safeUrl = (u) => (typeof u === "string" && /^https:\/\//i.test(u) && u.length <= 2048 ? u : null);

// ═══════════════════════════════════════════════════════════════
//  GET /admin/users?limit=500&pageToken=...
//  Respuesta: { users: [...], nextPageToken: string | null }
//  Solo admin (adminMiddleware: token verificado con checkRevoked + claim admin).
// ═══════════════════════════════════════════════════════════════
firebaseRouter.get("/admin/users", adminMiddleware, async (req, res) => {
    // Lista de emails de clientes: que ningún navegador ni proxy la guarde en caché
    res.set("Cache-Control", "no-store");

    // limit: entero entre 1 y 1000 (si no llega, 500)
    let limit = PAGE_DEFAULT;
    if (req.query.limit !== undefined) {
        const n = Number(req.query.limit);
        if (typeof req.query.limit !== "string" || !Number.isInteger(n) || n < 1 || n > PAGE_MAX) {
            return res.status(400).json({ message: `limit debe ser un entero entre 1 y ${PAGE_MAX} 🔴` });
        }
        limit = n;
    }

    // pageToken: string (un ?pageToken=a&pageToken=b llega como array y se rechaza)
    let pageToken;
    if (req.query.pageToken !== undefined) {
        if (typeof req.query.pageToken !== "string" || !req.query.pageToken || req.query.pageToken.length > PAGE_TOKEN_MAX_LEN) {
            return res.status(400).json({ message: "pageToken inválido 🔴" });
        }
        pageToken = req.query.pageToken;
    }

    try {
        const result = await auth.listUsers(limit, pageToken);

        // Lista blanca de campos: nada de passwordHash, tokens, providerData ni el resto de las claims
        const users = result.users.map(userRecord => ({
            uid:           userRecord.uid,
            email:         userRecord.email || null,
            displayName:   userRecord.displayName || "ANONYMOUS_USER",
            photoURL:      safeUrl(userRecord.photoURL),
            emailVerified: userRecord.emailVerified === true,
            disabled:      userRecord.disabled === true,
            metadata: {
                creationTime:   userRecord.metadata.creationTime,
                lastSignInTime: userRecord.metadata.lastSignInTime,
            },
            // Siempre booleanos: un claim con otro valor no se interpreta como true
            isBanned: userRecord.customClaims?.banned === true,
            isAdmin:  userRecord.customClaims?.admin === true,
        }));

        return res.status(200).json({ users, nextPageToken: result.pageToken || null });
    } catch (error) {
        if (error?.code === "auth/invalid-page-token") {
            return res.status(400).json({ message: "pageToken inválido 🔴" });
        }
        console.error("Error listing users 🔴", esProduccion ? error.message : error);
        return res.status(500).json({ message: "INTERNAL_SERVER_ERROR_FETCHING_USERS 🔴" });
    }
});

module.exports = firebaseRouter;