require("dotenv").config()
const express = require("express")
const nodemailer = require("nodemailer");
const adminMiddleware = require("../middleware/adminMiddleware");
const multer = require("multer");
const PaymentsMongo = require("../models/Payments")

const mailRouter = express.Router()

const esProduccion = (process.env.NODE_ENV === 'production');

// Contact
mailRouter.post("/send-email", async (req, res) => {
    const { name, surname, email, tel, text, trabajo } = req.body
    console.log(req.body);
    
    
    if(!name || !surname || !email || !tel || !text || !trabajo){
        return res.status(400).json({ message: "All required fields must be filled! 🔴" })
    }

    const transporter = nodemailer.createTransport({
        service: "gmail",
        auth: {
            user: process.env.EMAIL_FROM,
            pass: process.env.PASS_EMAIL
        }
    })

    const mailOptions = {
        from: process.env.EMAIL_FROM,
        to: process.env.EMAIL_TO, // A dónde querés que llegue el Mail
        subject: `Nueva Consulta De Proyecto.`,
        html: `<!DOCTYPE html>
            <html lang="es">
            <head>
            <meta charset="UTF-8" />
            <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
            <title>Nueva consulta — iService</title>
            <link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@400;500;600;700;800&display=swap" rel="stylesheet"/>
            </head>
            <body style="margin:0;padding:0;background:#000;font-family:'Montserrat',Arial,sans-serif;color:#f5f5f7;">
            
            <!-- wrapper -->
            <table width="100%" cellpadding="0" cellspacing="0" border="0"
                    style="background:#000;padding:48px 24px;">
                <tr>
                <td align="center">
            
                    <!-- card -->
                    <table width="560" cellpadding="0" cellspacing="0" border="0"
                        style="max-width:560px;width:100%;background:#111;border-radius:20px;
                                overflow:hidden;border:1px solid rgba(255,255,255,0.08);
                                box-shadow:0 32px 80px rgba(0,0,0,0.7);">
            
                    <!-- barra superior azul -->
                    <tr>
                        <td style="height:4px;background:linear-gradient(90deg,#0071e3,#34aadc);
                                font-size:0;line-height:0;">&nbsp;</td>
                    </tr>
            
                    <!-- header -->
                    <tr>
                        <td style="padding:36px 40px 28px;">
            
                        <!-- logo -->
                        <table cellpadding="0" cellspacing="0" border="0" style="margin-bottom:28px;">
                            <tr>
                            <td style="font-size:28px;font-weight:900;letter-spacing:-0.04em;
                                        line-height:1;color:#0071e3;">i</td>
                            <td style="font-size:26px;font-weight:700;letter-spacing:-0.03em;
                                        line-height:1;color:#f5f5f7;padding-left:1px;">Service</td>
                            <td style="font-size:28px;font-weight:900;color:#0071e3;
                                        line-height:1;padding-left:1px;">.</td>
                            </tr>
                        </table>
            
                        <!-- badge -->
                        <table cellpadding="0" cellspacing="0" border="0" style="margin-bottom:16px;">
                            <tr>
                            <td style="background:rgba(0,113,227,0.14);border:1px solid rgba(0,113,227,0.28);
                                        border-radius:99px;padding:5px 14px;
                                        font-size:10px;font-weight:700;letter-spacing:0.14em;
                                        text-transform:uppercase;color:#0071e3;">
                                Nueva consulta recibida
                            </td>
                            </tr>
                        </table>
            
                        <p style="margin:0;font-size:22px;font-weight:800;letter-spacing:-0.035em;
                                    color:#f5f5f7;line-height:1.15;">
                            Alguien quiere contactarte
                        </p>
                        <p style="margin:6px 0 0;font-size:13px;font-weight:400;
                                    color:rgba(245,245,247,0.45);line-height:1.5;">
                            Este mensaje fue enviado desde el formulario de contacto de iService.
                        </p>
                        </td>
                    </tr>
            
                    <!-- divisor -->
                    <tr>
                        <td style="height:1px;background:rgba(255,255,255,0.07);
                                font-size:0;line-height:0;">&nbsp;</td>
                    </tr>
            
                    <!-- datos del cliente -->
                    <tr>
                        <td style="padding:32px 40px 0;">
                        <p style="margin:0 0 20px;font-size:10px;font-weight:700;letter-spacing:0.18em;
                                    text-transform:uppercase;color:rgba(245,245,247,0.28);">
                            Datos del cliente
                        </p>
            
                        <!-- nombre -->
                        <table width="100%" cellpadding="0" cellspacing="0" border="0"
                                style="margin-bottom:2px;">
                            <tr>
                            <td style="padding:14px 16px;background:#161617;
                                        border-radius:12px 12px 0 0;
                                        border:1px solid rgba(255,255,255,0.07);
                                        border-bottom:none;">
                                <p style="margin:0 0 3px;font-size:9px;font-weight:700;letter-spacing:0.16em;
                                        text-transform:uppercase;color:rgba(245,245,247,0.28);">Nombre</p>
                                <p style="margin:0;font-size:16px;font-weight:600;
                                        letter-spacing:-0.015em;color:#f5f5f7;">
                                ${name} ${surname}
                                </p>
                            </td>
                            </tr>
                        </table>
            
                        <!-- email -->
                        <table width="100%" cellpadding="0" cellspacing="0" border="0"
                                style="margin-bottom:2px;">
                            <tr>
                            <td style="padding:14px 16px;background:#161617;
                                        border:1px solid rgba(255,255,255,0.07);
                                        border-top:none;border-bottom:none;">
                                <p style="margin:0 0 3px;font-size:9px;font-weight:700;letter-spacing:0.16em;
                                        text-transform:uppercase;color:rgba(245,245,247,0.28);">Email</p>
                                <a href="mailto:${email}$"
                                style="margin:0;font-size:16px;font-weight:600;letter-spacing:-0.01em;
                                        color:#0071e3;text-decoration:none;">
                                ${email}
                                </a>
                            </td>
                            </tr>
                        </table>
            
                        <!-- teléfono -->
                        <table width="100%" cellpadding="0" cellspacing="0" border="0"
                                style="margin-bottom:2px;">
                            <tr>
                            <td style="padding:14px 16px;background:#161617;
                                        border:1px solid rgba(255,255,255,0.07);
                                        border-top:none;border-bottom:none;">
                                <p style="margin:0 0 3px;font-size:9px;font-weight:700;letter-spacing:0.16em;
                                        text-transform:uppercase;color:rgba(245,245,247,0.28);">Teléfono</p>
                                <p style="margin:0;font-size:16px;font-weight:600;
                                        letter-spacing:-0.01em;color:#f5f5f7;">
                                ${tel}
                                </p>
                            </td>
                            </tr>
                        </table>
            
                        <!-- asunto -->
                        <table width="100%" cellpadding="0" cellspacing="0" border="0">
                            <tr>
                            <td style="padding:14px 16px;background:#161617;
                                        border-radius:0 0 12px 12px;
                                        border:1px solid rgba(255,255,255,0.07);
                                        border-top:none;">
                                <p style="margin:0 0 3px;font-size:9px;font-weight:700;letter-spacing:0.16em;
                                        text-transform:uppercase;color:rgba(245,245,247,0.28);">Asunto</p>
                                <p style="margin:0;font-size:16px;font-weight:600;
                                        letter-spacing:-0.01em;color:#f5f5f7;">
                                ${trabajo}
                                </p>
                            </td>
                            </tr>
                        </table>
                        </td>
                    </tr>
            
                    <!-- mensaje -->
                    <tr>
                        <td style="padding:24px 40px 0;">
                        <p style="margin:0 0 12px;font-size:10px;font-weight:700;letter-spacing:0.18em;
                                    text-transform:uppercase;color:rgba(245,245,247,0.28);">
                            Mensaje
                        </p>
                        <table width="100%" cellpadding="0" cellspacing="0" border="0">
                            <tr>
                            <td style="padding:20px;background:rgba(0,113,227,0.06);
                                        border:1px solid rgba(0,113,227,0.15);
                                        border-radius:14px;
                                        border-left:3px solid #0071e3;">
                                <p style="margin:0;font-size:15px;font-weight:400;line-height:1.75;
                                        color:rgba(245,245,247,0.75);">
                                ${text}
                                </p>
                            </td>
                            </tr>
                        </table>
                        </td>
                    </tr>
            
                    <!-- CTA responder -->
                    <tr>
                        <td style="padding:32px 40px;">
                        <table cellpadding="0" cellspacing="0" border="0">
                            <tr>
                            <td style="background:#0071e3;border-radius:12px;">
                                <a href="mailto:${email}"
                                style="display:inline-block;padding:14px 28px;
                                        font-size:14px;font-weight:700;letter-spacing:0.02em;
                                        color:#fff;text-decoration:none;">
                                Responder ahora →
                                </a>
                            </td>
                            </tr>
                        </table>
                        </td>
                    </tr>
            
                    <!-- divisor -->
                    <tr>
                        <td style="height:1px;background:rgba(255,255,255,0.07);
                                font-size:0;line-height:0;">&nbsp;</td>
                    </tr>
            
                    <!-- footer -->
                    <tr>
                        <td style="padding:24px 40px;">
                        <table width="100%" cellpadding="0" cellspacing="0" border="0">
                            <tr>
                            <!-- iService -->
                            <td style="vertical-align:middle;">
                                <p style="margin:0;font-size:12px;font-weight:600;
                                        letter-spacing:-0.01em;color:rgba(245,245,247,0.35);">
                                iService · Necochea 276, Ramos Mejía
                                </p>
                                <p style="margin:2px 0 0;font-size:11px;font-weight:400;
                                        color:rgba(245,245,247,0.2);">
                                Este email fue generado automáticamente.
                                </p>
                            </td>
                            <!-- powered by -->
                            <td align="right" style="vertical-align:middle;">
                                <a href="https://www.deepdev.com.ar" target="_blank"
                                style="text-decoration:none;">
                                <p style="margin:0;font-size:9px;font-weight:700;letter-spacing:0.1em;
                                            text-transform:uppercase;color:rgba(245,245,247,0.18);">
                                    Powered by
                                </p>
                                <p style="margin:2px 0 0;font-size:12px;font-weight:800;
                                            letter-spacing:-0.01em;color:rgba(245,245,247,0.35);">
                                    DeepDev Studio
                                </p>
                                </a>
                            </td>
                            </tr>
                        </table>
                        </td>
                    </tr>
            
                    </table>
                    <!-- / card -->
            
                </td>
                </tr>
            </table>
            
            </body>
            </html>`
    }
    try {
        await transporter.sendMail(mailOptions)
        res.status(200).json({ success: true, message: 'Correo enviado con éxito' })
    } catch (error) {
        console.error(esProduccion ? `Internal error setting up mail transporter! 🔴` : `Internal error setting up mail transporter! 🔴 ${error}`);
        res.status(500).send({ message: `Internal error setting up mail transporter! 🔴 ${error}` })
    }
})

// Confirmación Compra
mailRouter.post("/confirm-order", async (req, res) => {
    const { email } = req.body

    if(!email) {
        return res.status(400).json({ message: "Email is required! 🔴" })
    } 
    
    const transporter = nodemailer.createTransport({
            service: "gmail",
            auth: {
                user: process.env.EMAIL_FROM, // ORIGEN
                pass: process.env.PASS_EMAIL //PASS APP
            }
    })

    const ticketsMailOptions = {
        from: process.env.EMAIL_FROM,
        to: email, // A dónde querés que llegue el Mail
        subject: `Confirmacion de compra Dekin Hogar`,
        html: `
            <!DOCTYPE html>
                <html lang="es" xmlns="http://www.w3.org/1999/xhtml">
                <head>
                <meta charset="UTF-8" />
                <meta name="viewport" content="width=device-width, initial-scale=1.0" />
                <meta http-equiv="X-UA-Compatible" content="IE=edge" />
                <title>Confirmación de compra — Dekin Hogar</title>
                <style>
                    @import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@700;800&family=Barlow:wght@300;400;500&display=swap');
                    * { box-sizing: border-box; margin: 0; padding: 0; }
                    body { background-color: #F2EDE8; font-family: 'Barlow', Georgia, sans-serif; }
                </style>
                </head>
                <body style="margin:0; padding:0; background-color:#F2EDE8;">

                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#F2EDE8; padding: 40px 16px;">
                    <tr>
                    <td align="center">

                        <!-- CARD -->
                        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px; width:100%; background-color:#1A1614; font-family:'Barlow', Georgia, sans-serif;">

                        <!-- ══ CABECERA NARANJA ══ -->
                        <tr>
                            <td style="background-color:#E84B1A; padding:0;">
                            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                                <tr>
                                <td style="height:4px; background: repeating-linear-gradient(90deg, #fff 0px, #fff 6px, transparent 6px, transparent 14px); opacity:0.18;"></td>
                                </tr>
                            </table>
                            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                                <tr>
                                <td style="padding: 32px 40px 28px;">
                                    <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
                                    <tr>
                                        <td>
                                        <p style="font-family:'Barlow Condensed','Arial Narrow',Arial,sans-serif; font-size:36px; font-weight:800; letter-spacing:0.08em; text-transform:uppercase; color:#ffffff; line-height:1; margin:0;">DEKIN</p>
                                        <p style="font-family:'Barlow',Arial,sans-serif; font-size:10px; font-weight:300; letter-spacing:0.42em; text-transform:uppercase; color:rgba(255,255,255,0.75); margin:3px 0 0 2px; line-height:1;">HOGAR</p>
                                        </td>
                                        <td style="text-align:right; vertical-align:bottom; padding-bottom:2px;">
                                        <p style="font-family:'Barlow Condensed','Arial Narrow',Arial,sans-serif; font-size:11px; font-weight:700; letter-spacing:0.22em; text-transform:uppercase; color:rgba(255,255,255,0.55); margin:0;">CONFIRMACIÓN DE COMPRA</p>
                                        </td>
                                    </tr>
                                    </table>
                                </td>
                                </tr>
                            </table>
                            </td>
                        </tr>

                        <!-- ══ CUERPO ══ -->
                        <tr>
                            <td style="background-color:#1A1614; padding: 48px 40px 40px;">

                            <!-- ícono + badge -->
                            <table role="presentation" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
                                <tr>
                                <td>
                                    <div style="width:56px; height:56px; background:rgba(232,75,26,0.12); border:1px solid rgba(232,75,26,0.3); display:inline-block; text-align:center; line-height:56px; font-size:26px;">✅</div>
                                </td>
                                <td style="padding-left:14px; vertical-align:middle;">
                                    <p style="font-family:'Barlow Condensed','Arial Narrow',Arial,sans-serif; font-size:10px; font-weight:700; letter-spacing:0.28em; text-transform:uppercase; background:rgba(34,197,94,0.1); color:#22c55e; border:1px solid rgba(34,197,94,0.3); display:inline-block; padding:4px 12px; margin:0;">PAGO APROBADO</p>
                                </td>
                                </tr>
                            </table>

                            <!-- headline -->
                            <p style="font-family:'Barlow Condensed','Arial Narrow',Arial,sans-serif; font-size:32px; font-weight:800; letter-spacing:0.04em; text-transform:uppercase; color:#F0EBE5; line-height:1.1; margin:0 0 16px;">
                                ¡Gracias por tu<br/>
                                <span style="color:#E84B1A;">compra!</span>
                            </p>

                            <!-- bajada -->
                            <p style="font-family:'Barlow',Arial,sans-serif; font-size:16px; font-weight:300; color:rgba(240,235,229,0.7); line-height:1.65; margin:0 0 32px;">
                                Recibimos tu pedido con éxito. Nuestro equipo ya está trabajando en prepararlo para que llegue en perfectas condiciones. Pronto recibirás un correo con la factura de compra adjunta.
                            </p>

                            <!-- DIVISOR -->
                            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:28px;">
                                <tr><td style="border-top:1px solid rgba(255,255,255,0.07);"></td></tr>
                            </table>

                            <!-- PRÓXIMOS PASOS -->
                            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                                <tr>
                                <!-- paso 1 -->
                                <td width="33%" style="vertical-align:top; padding-right:12px;">
                                    <p style="font-size:20px; margin:0 0 8px;">📦</p>
                                    <p style="font-family:'Barlow Condensed','Arial Narrow',Arial,sans-serif; font-size:12px; font-weight:700; letter-spacing:0.12em; text-transform:uppercase; color:#E84B1A; margin:0 0 5px;">PREPARANDO</p>
                                    <p style="font-family:'Barlow',Arial,sans-serif; font-size:13px; font-weight:300; color:rgba(240,235,229,0.5); line-height:1.5; margin:0;">Tu pedido ya está en proceso de preparación.</p>
                                </td>
                                <!-- paso 2 -->
                                <td width="33%" style="vertical-align:top; padding-right:12px;">
                                    <p style="font-size:20px; margin:0 0 8px;">📄</p>
                                    <p style="font-family:'Barlow Condensed','Arial Narrow',Arial,sans-serif; font-size:12px; font-weight:700; letter-spacing:0.12em; text-transform:uppercase; color:#E84B1A; margin:0 0 5px;">FACTURA</p>
                                    <p style="font-family:'Barlow',Arial,sans-serif; font-size:13px; font-weight:300; color:rgba(240,235,229,0.5); line-height:1.5; margin:0;">Recibirás tu factura por correo en breve.</p>
                                </td>
                                <!-- paso 3 -->
                                <td width="33%" style="vertical-align:top;">
                                    <p style="font-size:20px; margin:0 0 8px;">🚚</p>
                                    <p style="font-family:'Barlow Condensed','Arial Narrow',Arial,sans-serif; font-size:12px; font-weight:700; letter-spacing:0.12em; text-transform:uppercase; color:#E84B1A; margin:0 0 5px;">ENVÍO</p>
                                    <p style="font-family:'Barlow',Arial,sans-serif; font-size:13px; font-weight:300; color:rgba(240,235,229,0.5); line-height:1.5; margin:0;">Te avisaremos cuando tu pedido esté en camino.</p>
                                </td>
                                </tr>
                            </table>

                            </td>
                        </tr>

                        <!-- ══ FRANJA HUESO ══ -->
                        <tr>
                            <td style="background-color:#F2EDE8; padding: 32px 40px;">
                            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                                <tr>
                                <td style="vertical-align:middle;">
                                    <p style="font-family:'Barlow Condensed','Arial Narrow',Arial,sans-serif; font-size:18px; font-weight:800; letter-spacing:0.08em; text-transform:uppercase; color:#1A1614; margin:0 0 2px;">DEKIN HOGAR</p>
                                    <p style="font-family:'Barlow',Arial,sans-serif; font-size:12px; font-weight:300; letter-spacing:0.2em; text-transform:uppercase; color:rgba(26,22,20,0.4); margin:0;">Diseño · Calidad · Confianza</p>
                                </td>
                                <td style="text-align:right; vertical-align:middle;">
                                    <p style="font-family:'Barlow',Arial,sans-serif; font-size:11px; color:rgba(26,22,20,0.35); margin:0; line-height:1.6;">
                                    Este es un mensaje automático.<br/>
                                    Por favor no respondas a esta dirección.
                                    </p>
                                </td>
                                </tr>
                            </table>
                            </td>
                        </tr>

                        <!-- ══ BARRA INFERIOR NARANJA ══ -->
                        <tr>
                            <td style="background-color:#E84B1A; padding: 14px 40px;">
                            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                                <tr>
                                <td>
                                    <p style="font-family:'Barlow Condensed','Arial Narrow',Arial,sans-serif; font-size:10px; font-weight:700; letter-spacing:0.22em; text-transform:uppercase; color:rgba(255,255,255,0.65); margin:0;">
                                    © ${new Date().getFullYear()} DEKIN HOGAR · TODOS LOS DERECHOS RESERVADOS
                                    </p>
                                </td>
                                <td style="text-align:right;">
                                    <p style="font-family:'Barlow Condensed','Arial Narrow',Arial,sans-serif; font-size:10px; font-weight:700; letter-spacing:0.16em; text-transform:uppercase; color:rgba(255,255,255,0.65); margin:0;">ARGENTINA</p>
                                </td>
                                </tr>
                                <tr>
                                <td colspan="2" style="padding-top:8px; border-top:1px solid rgba(255,255,255,0.2);">
                                    <p style="font-family:'Barlow',Arial,sans-serif; font-size:10px; font-weight:300; letter-spacing:0.08em; color:rgba(255,255,255,0.5); margin:0; padding-top:8px;">
                                    Desarrollado por
                                    <a href="https://www.deepdev.com.ar" target="_blank" style="color:rgba(255,255,255,0.85); text-decoration:none; font-weight:600; border-bottom:1px solid rgba(255,255,255,0.35);">DeepDev Studio</a>
                                    </p>
                                </td>
                                </tr>
                            </table>
                            </td>
                        </tr>

                        </table>
                        <!-- / CARD -->

                        <!-- nota al pie -->
                        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px; width:100%; margin-top:20px;">
                        <tr>
                            <td>
                            <p style="font-family:'Barlow',Arial,sans-serif; font-size:11px; font-weight:300; color:rgba(26,22,20,0.4); text-align:center; line-height:1.6; margin:0;">
                                Recibiste este correo porque realizaste una compra en Dekin Hogar.<br/>
                                Si creés que lo recibiste por error, por favor ignoralo.
                            </p>
                            </td>
                        </tr>
                        </table>

                    </td>
                    </tr>
                </table>

                </body>
                </html>
        `
    }

    try {
        await transporter.sendMail(ticketsMailOptions)
        res.status(200).json({ success: true, message: 'Correo enviado con éxito' })
    } catch (error) {
        res.status(500).json({ message: "Error creating ticket! 🔴", error: error.message })
        console.error(esProduccion ? "Error creating ticket! 🔴" : `Error creating ticket! 🔴 ${error}`);
    }
})

// Enviar factura 
const upload = multer({ storage: multer.memoryStorage() });

mailRouter.post('/:id/send-invoice', upload.single('invoice'), adminMiddleware, async (req, res) => {
  const { id }   = req.params;
  const { email } = req.body;
  const file     = req.file;           

  const transporter = nodemailer.createTransport({
        service: "gmail",
        auth: {
            user: process.env.EMAIL_FROM,
            pass: process.env.PASS_EMAIL
        }
    })

  await transporter.sendMail({
    from:        process.env.EMAIL_FROM,
    to:          email,
    subject:     'Factura de tu compra Dekin Hogar',
    html: `<!DOCTYPE html>
            <html lang="es" xmlns="http://www.w3.org/1999/xhtml">
            <head>
            <meta charset="UTF-8" />
            <meta name="viewport" content="width=device-width, initial-scale=1.0" />
            <meta http-equiv="X-UA-Compatible" content="IE=edge" />
            <title>Factura de tu compra — Dekin Hogar</title>
            <!--[if mso]>
            <noscript>
                <xml><o:OfficeDocumentSettings>
                <o:PixelsPerInch>96</o:PixelsPerInch>
                </o:OfficeDocumentSettings></xml>
            </noscript>
            <![endif]-->
            <style>
                @import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@700;800&family=Barlow:wght@300;400;500&display=swap');
                * { box-sizing: border-box; margin: 0; padding: 0; }
                body { background-color: #F2EDE8; font-family: 'Barlow', Georgia, sans-serif; }
            </style>
            </head>
            <body style="margin:0; padding:0; background-color:#F2EDE8;">

            <!-- WRAPPER -->
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#F2EDE8; padding: 40px 16px;">
                <tr>
                <td align="center">

                    <!-- CARD PRINCIPAL -->
                    <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px; width:100%; background-color:#1A1614; font-family:'Barlow', Georgia, sans-serif;">

                    <!-- ══ CABECERA NARANJA ══ -->
                    <tr>
                        <td style="background-color:#E84B1A; padding: 0;">
                        <!-- barra decorativa superior -->
                        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                            <tr>
                            <td style="height:4px; background: repeating-linear-gradient(90deg, #fff 0px, #fff 6px, transparent 6px, transparent 14px); opacity:0.18;"></td>
                            </tr>
                        </table>
                        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                            <tr>
                            <td style="padding: 32px 40px 28px;">
                                <!-- LOGO AREA -->
                                <table role="presentation" cellpadding="0" cellspacing="0">
                                <tr>
                                    <td>
                                    <!-- Bloque logo tipográfico -->
                                    <div style="display:inline-block;">
                                        <p style="font-family:'Barlow Condensed', 'Arial Narrow', Arial, sans-serif; font-size:36px; font-weight:800; letter-spacing:0.08em; text-transform:uppercase; color:#ffffff; line-height:1; margin:0;">DEKIN</p>
                                        <p style="font-family:'Barlow', Arial, sans-serif; font-size:10px; font-weight:300; letter-spacing:0.42em; text-transform:uppercase; color:rgba(255,255,255,0.75); margin: 3px 0 0 2px; line-height:1;">HOGAR</p>
                                    </div>
                                    </td>
                                    <td style="text-align:right; vertical-align:bottom; padding-bottom:2px;">
                                    <p style="font-family:'Barlow Condensed', 'Arial Narrow', Arial, sans-serif; font-size:11px; font-weight:700; letter-spacing:0.22em; text-transform:uppercase; color:rgba(255,255,255,0.55); margin:0;">COMPROBANTE DE COMPRA</p>
                                    </td>
                                </tr>
                                </table>
                            </td>
                            </tr>
                        </table>
                        </td>
                    </tr>

                    <!-- ══ FRANJA OSCURA — MENSAJE PRINCIPAL ══ -->
                    <tr>
                        <td style="background-color:#1A1614; padding: 48px 40px 40px;">

                        <!-- Icono visual — sobre / documento -->
                        <table role="presentation" cellpadding="0" cellspacing="0" style="margin-bottom:28px;">
                            <tr>
                            <td>
                                <div style="
                                width: 56px; height: 56px;
                                background: rgba(232,75,26,0.12);
                                border: 1px solid rgba(232,75,26,0.3);
                                display: inline-flex; align-items: center; justify-content: center;
                                font-size: 26px; line-height:56px; text-align:center;
                                ">📄</div>
                            </td>
                            </tr>
                        </table>

                        <!-- Headline -->
                        <p style="font-family:'Barlow Condensed', 'Arial Narrow', Arial, sans-serif; font-size:30px; font-weight:800; letter-spacing:0.04em; text-transform:uppercase; color:#F0EBE5; line-height:1.1; margin:0 0 16px;">
                            Tu factura está<br/>
                            <span style="color:#E84B1A;">lista.</span>
                        </p>

                        <!-- Cuerpo -->
                        <p style="font-family:'Barlow', Arial, sans-serif; font-size:16px; font-weight:300; color:rgba(240,235,229,0.7); line-height:1.65; margin:0 0 32px;">
                            Gracias por tu compra. Encontrás adjunto el comprobante correspondiente a tu pedido. Guardalo como respaldo — lo vas a necesitar en caso de cualquier consulta o cambio.
                        </p>

                        <!-- DIVISOR -->
                        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:32px;">
                            <tr>
                            <td style="border-top: 1px solid rgba(255,255,255,0.07);"></td>
                            </tr>
                        </table>

                        <!-- BLOQUE INFO — qué está adjunto -->
                        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:32px; background:rgba(255,255,255,0.03); border-left:3px solid #E84B1A; padding:18px 20px;">
                            <tr>
                            <td style="padding:18px 20px;">
                                <p style="font-family:'Barlow Condensed', 'Arial Narrow', Arial, sans-serif; font-size:10px; font-weight:700; letter-spacing:0.28em; text-transform:uppercase; color:rgba(240,235,229,0.35); margin:0 0 10px;">ARCHIVO ADJUNTO</p>
                                <p style="font-family:'Barlow', Arial, sans-serif; font-size:15px; font-weight:500; color:#F0EBE5; margin:0;">
                                Factura de compra · <span style="color:#E84B1A;">Dekin Hogar</span>
                                </p>
                                <p style="font-family:'Barlow', Arial, sans-serif; font-size:13px; font-weight:300; color:rgba(240,235,229,0.45); margin:6px 0 0;">PDF / PNG / JPEG según el formato enviado por el equipo</p>
                            </td>
                            </tr>
                        </table>

                        <!-- DIVISOR -->
                        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:32px;">
                            <tr>
                            <td style="border-top: 1px solid rgba(255,255,255,0.07);"></td>
                            </tr>
                        </table>

                        <!-- BLOQUE AYUDA -->
                        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                            <tr>
                            <!-- ítem 1 -->
                            <td width="33%" style="vertical-align:top; padding-right:12px;">
                                <p style="font-size:18px; margin:0 0 8px;">🔒</p>
                                <p style="font-family:'Barlow Condensed', 'Arial Narrow', Arial, sans-serif; font-size:12px; font-weight:700; letter-spacing:0.12em; text-transform:uppercase; color:#E84B1A; margin:0 0 4px;">RESPALDO SEGURO</p>
                                <p style="font-family:'Barlow', Arial, sans-serif; font-size:13px; font-weight:300; color:rgba(240,235,229,0.5); line-height:1.5; margin:0;">Guardá este comprobante en un lugar seguro.</p>
                            </td>
                            <!-- ítem 2 -->
                            <td width="33%" style="vertical-align:top; padding-right:12px;">
                                <p style="font-size:18px; margin:0 0 8px;">📦</p>
                                <p style="font-family:'Barlow Condensed', 'Arial Narrow', Arial, sans-serif; font-size:12px; font-weight:700; letter-spacing:0.12em; text-transform:uppercase; color:#E84B1A; margin:0 0 4px;">TU PEDIDO</p>
                                <p style="font-family:'Barlow', Arial, sans-serif; font-size:13px; font-weight:300; color:rgba(240,235,229,0.5); line-height:1.5; margin:0;">Nuestro equipo está preparando tu envío.</p>
                            </td>
                            <!-- ítem 3 -->
                            <td width="33%" style="vertical-align:top;">
                                <p style="font-size:18px; margin:0 0 8px;">💬</p>
                                <p style="font-family:'Barlow Condensed', 'Arial Narrow', Arial, sans-serif; font-size:12px; font-weight:700; letter-spacing:0.12em; text-transform:uppercase; color:#E84B1A; margin:0 0 4px;">¿DUDAS?</p>
                                <p style="font-family:'Barlow', Arial, sans-serif; font-size:13px; font-weight:300; color:rgba(240,235,229,0.5); line-height:1.5; margin:0;">Respondé este mail y te ayudamos.</p>
                            </td>
                            </tr>
                        </table>

                        </td>
                    </tr>

                    <!-- ══ FRANJA HUESO / FIRMA ══ -->
                    <tr>
                        <td style="background-color:#F2EDE8; padding: 32px 40px;">
                        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                            <tr>
                            <td style="vertical-align:middle;">
                                <p style="font-family:'Barlow Condensed', 'Arial Narrow', Arial, sans-serif; font-size:18px; font-weight:800; letter-spacing:0.08em; text-transform:uppercase; color:#1A1614; margin:0 0 2px;">DEKIN HOGAR</p>
                                <p style="font-family:'Barlow', Arial, sans-serif; font-size:12px; font-weight:300; letter-spacing:0.2em; text-transform:uppercase; color:rgba(26,22,20,0.4); margin:0;">Diseño · Calidad · Confianza</p>
                            </td>
                            <td style="text-align:right; vertical-align:middle;">
                                <p style="font-family:'Barlow', Arial, sans-serif; font-size:11px; color:rgba(26,22,20,0.35); margin:0; line-height:1.6;">
                                Este es un mensaje automático.<br/>
                                Por favor no respondas a esta dirección.
                                </p>
                            </td>
                            </tr>
                        </table>
                        </td>
                    </tr>

                    <!-- ══ BARRA INFERIOR NARANJA ══ -->
                    <tr>
                        <td style="background-color:#E84B1A; padding: 14px 40px;">
                        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                            <tr>
                            <td>
                                <p style="font-family:'Barlow Condensed', 'Arial Narrow', Arial, sans-serif; font-size:10px; font-weight:700; letter-spacing:0.22em; text-transform:uppercase; color:rgba(255,255,255,0.65); margin:0;">
                                © ${new Date().getFullYear()} DEKIN HOGAR · TODOS LOS DERECHOS RESERVADOS
                                </p>
                            </td>
                            <td style="text-align:right;">
                                <p style="font-family:'Barlow Condensed', 'Arial Narrow', Arial, sans-serif; font-size:10px; font-weight:700; letter-spacing:0.16em; text-transform:uppercase; color:rgba(255,255,255,0.65); margin:0;">
                                ARGENTINA
                                </p>
                            </td>
                            </tr>
                            <tr>
                            <td colspan="2" style="padding-top:8px; border-top:1px solid rgba(255,255,255,0.2);">
                                <p style="font-family:'Barlow', Arial, sans-serif; font-size:10px; font-weight:300; letter-spacing:0.08em; color:rgba(255,255,255,0.5); margin:0; padding-top:8px;">
                                Desarrollado por
                                <a href="https://www.deepdev.com.ar" target="_blank" style="color:rgba(255,255,255,0.85); text-decoration:none; font-weight:600; border-bottom:1px solid rgba(255,255,255,0.35);">DeepDev Studio</a>
                                </p>
                            </td>
                            </tr>
                        </table>
                        </td>
                    </tr>

                    </table>
                    <!-- / CARD PRINCIPAL -->

                    <!-- Nota al pie fuera de la card -->
                    <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px; width:100%; margin-top:20px; padding:0 4px;">
                    <tr>
                        <td>
                        <p style="font-family:'Barlow', Arial, sans-serif; font-size:11px; font-weight:300; color:rgba(26,22,20,0.4); text-align:center; line-height:1.6; margin:0;">
                            Recibiste este correo porque realizaste una compra en Dekin Hogar.<br/>
                            Si crees que recibiste este mensaje por error, por favor ignoralo.
                        </p>
                        </td>
                    </tr>
                    </table>

                </td>
                </tr>
            </table>
            <!-- / WRAPPER -->

            </body>
            </html>`,
    attachments: [{
      filename:    file.originalname,
      content:     file.buffer,
      contentType: file.mimetype,
    }],
  });

  // 2. Marcar la venta como factura enviada
  await PaymentsMongo.findByIdAndUpdate(id, {
    invoiceSent:     true,
    invoiceSentAt:   new Date(),
    invoiceFilename: file.originalname,
  });

  res.json({ ok: true });
});

module.exports = mailRouter