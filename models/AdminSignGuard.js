// ═══════════════════════════════════════════════════════════════════════════════
//  models/AdminSignGuard.js — Contador de intentos fallidos de la clave de firma
//  Vive en Mongo para que el bloqueo no se pierda si Render reinicia el servicio.
// ═══════════════════════════════════════════════════════════════════════════════
const mongoose = require("mongoose");

const adminSignGuardSchema = new mongoose.Schema(
    {
        adminUid:     { type: String, required: true, unique: true, index: true },
        failedCount:  { type: Number, default: 0 },
        lockedUntil:  { type: Date,   default: null },
        lastFailedAt: { type: Date,   default: null },
    },
    { timestamps: true }
);

module.exports = mongoose.models.AdminSignGuard || mongoose.model("AdminSignGuard", adminSignGuardSchema);