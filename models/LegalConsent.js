const mongoose = require("mongoose");

/* ══════════════════════════════════════════════════════════════
   LegalConsent — registro de aceptación de documentos legales
   Append-only: cada aceptación es un documento nuevo. Nunca se
   edita ni se borra, así queda trazabilidad completa (qué versión
   aceptó cada usuario, cuándo y desde dónde).
══════════════════════════════════════════════════════════════ */

// Dominio público del front (el mismo FRONT_END que ya usás en CORS)
const FRONT = (process.env.FRONT_END || "").replace(/\/+$/, "");

// Versiones vigentes de cada documento.
// Cuando se modifique una política, subir la versión acá:
// los registros viejos quedan con la versión que el usuario aceptó.
// Las rutas tienen que coincidir con LEGAL_LINKS de RegisterMinimal.tsx.
const LEGAL_DOCUMENTS = {
    cookies: { version: "1.0", url: `${FRONT}/policy-cookie` },
    privacy: { version: "1.0", url: `${FRONT}/policy-privacity` },
    terms:   { version: "1.0", url: `${FRONT}/terms-and-conditions` },
};

const acceptedDocumentSchema = new mongoose.Schema(
    {
        type: {
            type: String,
            enum: ["cookies", "privacy", "terms"],
            required: true,
        },
        version: { type: String, required: true },
        url: { type: String, required: true },
    },
    { _id: false }
);

const legalConsentSchema = new mongoose.Schema(
    {
        uid: {
            type: String,
            required: true,
            index: true,
            immutable: true,
        },
        email: {
            type: String,
            required: true,
            lowercase: true,
            trim: true,
            immutable: true,
        },
        documents: {
            type: [acceptedDocumentSchema],
            required: true,
            immutable: true,
            validate: {
                validator: (docs) => Array.isArray(docs) && docs.length > 0,
                message: "At least one legal document is required",
            },
        },
        accepted: {
            type: Boolean,
            required: true,
            immutable: true,
        },
        // Dónde se dio el consentimiento (registro hoy; a futuro re-aceptación por cambio de versión)
        source: {
            type: String,
            enum: ["register", "reaccept"],
            default: "register",
            immutable: true,
        },
        ip: { type: String, default: null, immutable: true },
        userAgent: { type: String, default: null, immutable: true },
        acceptedAt: {
            type: Date,
            default: Date.now,
            immutable: true,
        },
    },
    {
        timestamps: true,
        versionKey: false,
    }
);

// Último consentimiento de un usuario, rápido
legalConsentSchema.index({ uid: 1, acceptedAt: -1 });

const LegalConsent = mongoose.model("LegalConsent", legalConsentSchema);

module.exports = { LegalConsent, LEGAL_DOCUMENTS };