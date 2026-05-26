// Express y Router
const express = require("express")
const raffleRouter = express.Router()
// Modelo
const Raffle = require("../models/RaffleSchema")

const esProduccion = (process.env.NODE_ENV === 'production');

raffleRouter.post("/raffle", async (req, res) => {
    const { fullName, email, phone, description } = req.body
    try {
        if(!fullName || !email || !phone || !description) {
            return res.status(400).json({ message: "All Fields are required! 🔴" })
        } 
        const raffle = new Raffle({ fullName, email, phone, description })
        await raffle.save()
        res.status(201).json({ message: "Raffle created successfully! 🟢" })
    } catch (error) {
        console.error(esProduccion ? "Error creating raffle:" : "Error creating raffle:", error)
        res.status(500).json({ message: "Error creating raffle! 🔴"})
    }
})

module.exports = raffleRouter