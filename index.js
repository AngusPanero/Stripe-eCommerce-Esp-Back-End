require("dotenv").config()
const express = require("express")
const cors = require("cors")
const helmet = require("helmet")
const { urlencoded } = require("body-parser")
const cookieParser = require("cookie-parser")
const dbConnection = require("./config/mongoose")
const authRouter = require("./routes/authRouter")
const contactRouter = require("./routes/contactRouter")
const mailRouter = require("./nodemailer/nodemailer")
const stripeRouter = require("./routes/stripeRouter")
const paymentsRouter = require("./routes/paymentRoutes")
const firebaseRouter = require("./routes/firebaseRouter")
const productRouter = require("./routes/productRouter")
const cartRouter = require("./routes/cartRouter")
const metricRouter = require("./routes/metricsRouter")
const adminMiddleware = require("./middleware/adminMiddleware")
const { sseHandler } = require("./sseManager/sseManajer")
const app = express()
const PORT = process.env.PORT

app.set('trust proxy', 1); // Para el Rate Limiter

// Headers de seguridad. También quita "X-Powered-By: Express".
// La API solo devuelve JSON: el CSP por defecto de helmet no molesta.
app.use(helmet({
    crossOriginResourcePolicy: { policy: "same-site" }, // front y API comparten sitio (tudominio.com / api.tudominio.com)
}))

app.use(urlencoded({ extended: true }))
app.post("/stripe-webhook", express.raw({ type: "application/json" }), stripeRouter.webhookHandler);
app.use(express.json())
app.use(cookieParser())

dbConnection()

app.use(cors({
    origin: [`${process.env.LOCAL_LINK}`, `${process.env.API_BACKEND_URL}`, `${process.env.FRONT_END}`, `${process.env.FRONT_END_WWW}`, `${process.env.LOCAL_HOST}`].filter(Boolean),
    methods: [ "GET", "POST", "PUT", "PATCH", "DELETE" ],
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
}))

app.get("/api/payments/stream", adminMiddleware, sseHandler);

app.use(metricRouter)
app.use(authRouter)
app.use(contactRouter)
app.use(mailRouter)
app.use(stripeRouter)
app.use(paymentsRouter)
app.use(firebaseRouter)
app.use(productRouter)
app.use(cartRouter)

app.use((req, res) => {
    res.status(404).json({ message: "Not found 🔴" })
})

app.use((err, req, res, next) => {
    if (err?.type === "entity.parse.failed") {
        return res.status(400).json({ message: "JSON inválido 🔴" })
    }
    if (err?.type === "entity.too.large") {
        return res.status(413).json({ message: "Body demasiado grande 🔴" })
    }
    console.error(`[${new Date().toISOString()}] UNHANDLED_ERROR ${req.method} ${req.originalUrl}:`, err)
    if (res.headersSent) return next(err)
    res.status(err?.status && err.status < 500 ? err.status : 500).json({ message: "Error interno 🔴" })
})

app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server listening🟢`)
})