require('dotenv').config();
const express = require('express');
const { Queue } = require('bullmq');
const Redis = require('ioredis');
const crypto = require('crypto');

const app = express();

// Preservar el rawBody para la validación HMAC
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf; }
}));

// Conexión a AWS ElastiCache
const redisConnection = new Redis({
  host: process.env.REDIS_HOST,
  port: 6379,
  tls: undefined
});

const webhookQueue = new Queue('whatsapp-messages', { connection: redisConnection });

// 1. Verificación obligatoria de Meta (GET)
app.get('/api/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.META_VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// 2. Recepción de mensajes de ciudadanos (POST)
app.post('/api/webhook', async (req, res) => {
  // --- Validación de firma de Meta ---
  const signature = req.headers['x-hub-signature-256'];
  if (!signature) {
    return res.status(401).send('Firma ausente');
  }

  // Si falta el secreto, se rechaza todo: nunca se acepta una firma que no se pueda validar
  if (!process.env.META_APP_SECRET) {
    console.error("META_APP_SECRET no está configurado: se rechaza el mensaje");
    return res.status(500).send('Servidor mal configurado');
  }

  const digest = 'sha256=' + crypto
    .createHmac('sha256', process.env.META_APP_SECRET)
    .update(req.rawBody || '')
    .digest('hex');

  const firmaRecibida = Buffer.from(String(signature));
  const firmaEsperada = Buffer.from(digest);
  if (firmaRecibida.length !== firmaEsperada.length || !crypto.timingSafeEqual(firmaRecibida, firmaEsperada)) {
    console.error("Firma de Meta rechazada");
    return res.status(403).send('Firma inválida');
  }

  // --- Procesamiento del mensaje ---
  const body = req.body;

  if (body.object) {
    if (body.entry && body.entry[0].changes && body.entry[0].changes[0].value.messages) {
      const message = body.entry[0].changes[0].value.messages[0];
      const phoneId = body.entry[0].changes[0].value.metadata.phone_number_id;

      // jobId = id del mensaje: si Meta reintenta el webhook, no se encola dos veces.
      // Los trabajos terminados se limpian para que Redis no crezca sin límite.
      await webhookQueue.add('new-message', { message, phoneId }, {
        jobId: message.id,
        removeOnComplete: 1000,
        removeOnFail: 5000
      });
    }
    res.sendStatus(200);
  } else {
    res.sendStatus(404);
  }
});

// Estado del servicio (para Azure y para diagnóstico)
app.get('/health', (req, res) => {
  res.json({ ok: true, redis: redisConnection.status });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Ingesta Webhook escuchando en puerto ${PORT}`));