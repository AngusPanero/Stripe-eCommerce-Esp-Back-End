const sseClients = new Set();

const notifyNewSale = (payment) => {
    if (sseClients.size === 0) return;
    const data = JSON.stringify({
        _id:       payment._id,
        email:     payment.email,
        amount:    payment.amount,
        status:    payment.status,
        checked:   payment.checked ?? false,
        createdAt: payment.createdAt,
    });
    console.log(`📢 SSE notify — clientes: ${sseClients.size} — ${payment.email}`);
    sseClients.forEach(client => {
        try { client.write(`data: ${data}\n\n`); }
        catch (_) { sseClients.delete(client); }
    });
};

const sseHandler = (req, res) => {
    console.log(`🔌 SSE conectado — total: ${sseClients.size + 1}`);
    res.setHeader("Content-Type",      "text/event-stream");
    res.setHeader("Cache-Control",     "no-cache");
    res.setHeader("Connection",        "keep-alive");
    res.setHeader("X-Accel-Buffering", "no"); // nginx no bufferea
    res.flushHeaders();

    // ping cada 25s para mantener viva la conexión
    const ping = setInterval(() => {
        try { res.write(": ping\n\n"); }
        catch (_) { clearInterval(ping); sseClients.delete(res); }
    }, 25_000);

    sseClients.add(res);

    req.on("close", () => {
        clearInterval(ping);
        sseClients.delete(res);
        console.log(`🔌 SSE desconectado — total: ${sseClients.size}`);
    });
};

module.exports = { notifyNewSale, sseHandler };