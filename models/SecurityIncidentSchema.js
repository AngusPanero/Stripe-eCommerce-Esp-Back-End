const mongoose = require("mongoose");

// Registro de intentos de acceso no autorizado a zonas protegidas (panel admin, panel enterprise).
// Mismo modelo que Hidden Security. Nunca se guarda el token ni la contraseña:
// solo datos para identificar al autor.
const SecurityIncidentSchema = new mongoose.Schema(
    {
        type: {
            type: String,
            enum: ["unauthorized-admin-access", "unauthorized-enterprise-access"],
            default: "unauthorized-admin-access",
            index: true,
        },
        zone: { type: String, enum: ["admin", "enterprise"], default: "admin", index: true },

        // ── Quién ────────────────────────────────────────────────────────────
        uid:              { type: String, required: true, index: true },
        email:            { type: String, default: null, index: true },
        emailVerified:    { type: Boolean, default: null },
        accountCreatedAt: { type: Date, default: null },
        lastSignInAt:     { type: Date, default: null },

        // ── Desde dónde ──────────────────────────────────────────────────────
        ip:             { type: String, default: null, index: true },
        ipChain:        { type: String, default: null }, // x-forwarded-for completo
        country:        { type: String, default: null }, // cf-ipcountry (Cloudflare)
        userAgent:      { type: String, default: null },
        acceptLanguage: { type: String, default: null },
        referer:        { type: String, default: null },
        origin:         { type: String, default: null },

        // ── Qué intentó ──────────────────────────────────────────────────────
        method:         { type: String, default: null },
        endpoint:       { type: String, default: null }, // endpoint que lo detectó
        attemptedPath:  { type: String, default: null }, // ruta del front (/admin)
        attemptedTab:   { type: String, default: null },

        // ── Qué decía su token firmado (la verdad del servidor) ──────────────
        tokenClaims: {
            admin:        { type: Boolean, default: false },
            isEnterprise: { type: Boolean, default: false },
            partner:      { type: Boolean, default: false },
            banned:       { type: Boolean, default: false },
        },
        signInProvider: { type: String, default: null },
        tokenIssuedAt:  { type: Date, default: null },
        tokenAuthTime:  { type: Date, default: null },

        // ── Respuesta del sistema ────────────────────────────────────────────
        actionTaken: {
            type: String,
            enum: ["banned", "already-banned", "ban-failed"],
            default: "banned",
        },
        actionError: { type: String, default: null },
        detectedAt:  { type: Date, default: Date.now, index: true },
    },
    { timestamps: true }
);

module.exports = mongoose.model("SecurityIncident", SecurityIncidentSchema);