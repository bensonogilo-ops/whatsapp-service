import express from 'express'
import authRouter from './auth/router'
import { errorHandler } from './util/handler'
import { getGroupData, logout, printQR, status } from './whatsapp/controller'
import whatsappRouter from './whatsapp/router'

// Keep the service running if WhatsApp drops the connection mid-request
process.on('unhandledRejection', reason => {
    console.error('Unhandled rejection (ignored):', reason)
})
process.on('uncaughtException', error => {
    console.error('Uncaught exception (ignored):', error)
})

const app = express()

app.use(express.json())

app.use((req, res, next) => {
    const apiKey = process.env.API_KEY
    if (!apiKey || req.headers['x-api-key'] !== apiKey) {
        return res.status(401).json({ message: 'unauthorized' })
    }
    return next()
})

app.get('/status', status)
app.get('/qr-code', printQR)
app.delete('/logout', logout)

app.get('/group/:id', getGroupData)

app.use('/send', whatsappRouter)
app.use('/auth', authRouter)

app.use(errorHandler)

export default app
