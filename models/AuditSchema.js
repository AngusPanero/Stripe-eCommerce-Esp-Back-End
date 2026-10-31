const mongoose = require("mongoose")

// Eventos que usan authRouter y adminMiddleware.
// Antes faltaban varios y los Audit.create de "admin-ban" y "security-threat" fallaban en silencio.
const AUDIT_EVENTS = [
  // sesión
  "login", "logout", "token_refresh", "session_expired", "forced_logout", "invalid_token", "password-changed",
  // contadores de bloqueo (un documento por email / IP / uid)
  "login-failed",      // fallos de contraseña por email → bloqueo de 15 min
  "intrusion-ip",      // strikes por IP en zona admin → bloqueo de 24 h
  "intrusion-user",    // strikes de un usuario no admin en la API admin → ban
  // acciones y amenazas
  "admin-ban",
  "security-threat",
  // legado (nombre viejo, se deja para no romper documentos existentes)
  "login_failed",
]

const AuditSchema = new mongoose.Schema({
  uid: {
    type: String,
    index: true
  },
  // Los strikes por IP no tienen email: es un visitante sin sesión
  email: {
    type: String,
    required: function () { return this.event !== "intrusion-ip" },
    index: true
  },
  event: {
    type: String,
    enum: AUDIT_EVENTS,
    required: true,
    index: true
  },
  ip: {
    type: String,
    index: true
  },
  userAgent: String,
  country: String,

  createdAt: {
    type: Date,
    default: Date.now,
    immutable: true,
    index: true
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  attempts: {
    type: Number,
    default: 0
  },
  lastAttemptAt: Date
}, { timestamps: true })

// Un solo contador por email / IP / uid. Sin esto, dos fallos simultáneos con upsert
// pueden crear dos documentos y el bloqueo cuenta mal. Con el índice único, Mongo
// reintenta el upsert sobre el documento que ya existe.
AuditSchema.index(
  { email: 1, event: 1 },
  { unique: true, partialFilterExpression: { event: "login-failed" }, name: "uniq_login_failed" }
)
AuditSchema.index(
  { ip: 1, event: 1 },
  { unique: true, partialFilterExpression: { event: "intrusion-ip" }, name: "uniq_intrusion_ip" }
)
AuditSchema.index(
  { uid: 1, event: 1 },
  { unique: true, partialFilterExpression: { event: "intrusion-user" }, name: "uniq_intrusion_user" }
)

const Audit = mongoose.model("audit", AuditSchema)

module.exports = Audit
module.exports.AUDIT_EVENTS = AUDIT_EVENTS