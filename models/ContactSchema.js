const mongoose = require("mongoose")

const ContactSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        minlength: 3,      
        maxlength: 30,
        set: value => value.toUpperCase()
    },
    surname: {
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
    tel: {
        type: String,
        required: true
    },
    trabajo: {
        type: String,
        required: true,
        minlength: 3,      
        maxlength: 50,
    },
    text: {
        type: String,
        required: true,
        minlength: 3,      
        maxlength: 500,
    }
}, { timestamps: true })

const Contact = mongoose.model("contact", ContactSchema)

module.exports = Contact