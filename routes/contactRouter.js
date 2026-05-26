const express = require("express");
const contactRouter = express.Router();
const Contact = require("../models/ContactSchema");

const esProduccion = (process.env.NODE_ENV === 'production');

contactRouter.post("/contact", async (req, res) => {
    const { name, surname, email, tel, text, trabajo } = req.body;
    console.log(req.body);
    
    
    if(!name || !surname || !email || !tel || !text || !trabajo){
        return res.status(400).json({ message: "Faltan campos obligatorios. 🔴" });
    }

    try {
        const newContact = { name, surname, email, tel, text, trabajo };

        await Contact.create(newContact);

        return res.status(201).json({ message: "¡Formulario de contacto enviado con éxito! 🟢" });

    } catch (error) {
        console.error(esProduccion ? `Error al crear contacto! 🔴` : `Error al crear contacto! 🔴 ${error.message}`);
        
        res.status(500).json({ message: "Error interno del servidor al procesar el contacto. 🔴" });
    }
});

module.exports = contactRouter;