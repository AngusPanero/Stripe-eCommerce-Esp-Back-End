const mongoose = require("mongoose")

const RaffleSchema = new mongoose.Schema({
    fullName: {
        type: String,
        required: true,
        minlength: 3,      
        maxlength: 30,
        set: value => value.toUpperCase()
    },
    email: {
        type: String,
        minlength: 10,
        maxlength: 60,
        trim: true,
        lowercase: true,
        default: null,
        required: true,
        match: /^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,6}$/,
    },
    phone: {
        type: Number,
        required: true
    },
    description: {
        type: String,
        required: true,
        minlength: 3,      
        maxlength: 500,
    },
    terminosCondiciones:{
        type: String,
        default: "Aceptados al inscribirse en el sorteo"
    }
}, { timestamps: true })

const Raffle = mongoose.model("raffle", RaffleSchema)

module.exports = Raffle