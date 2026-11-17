require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Redis = require('ioredis');
const { CognitoJwtVerifier } = require('aws-jwt-verify');

const app = express();
const server = http.createServer(app);

// FRONTEND_URL puede traer varios orígenes separados por coma
const origenes = (process.env.FRONTEND_URL || '').split(',').map(s => s.trim()).filter(Boolean);
const io = new Server(server, {
  cors: { origin: origenes.length ? origenes : '*', methods: ['GET', 'POST'] },
  pingInterval: 20000,
  pingTimeout: 15000
});

if (!origenes.length) {
  console.warn('ADVERTENCIA: FRONTEND_URL no está definida; CORS queda abierto a cualquier origen.');
}

// Verificador del token de Cognito (si faltan las variables, el servicio no arranca)
const verifier = CognitoJwtVerifier.create({
  userPoolId: process.env.COGNITO_USER_POOL_ID,
  tokenUse: 'id',
  clientId: process.env.COGNITO_CLIENT_ID,
});

// Solo entra quien trae un token de Cognito válido y vigente
io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('Autenticación requerida'));
    const claims = await verifier.verify(token);
    socket.data.email = claims.email;
    next();
  } catch (err) {
    next(new Error('Token inválido o vencido'));
  }
});

// ============================================================================
// EVENTOS
// Los sockets solo transportan avisos de "algo cambió". Cada panel vuelve a pedir
// sus datos a la API, que es la que aplica los permisos según el rol.
//
//  Servidor -> paneles
//   ticket-actualizado   nuevo reporte confirmado por el ciudadano (desde el worker)
//   ticket-cambio        un reporte cambió (desde un panel o desde el worker)
//   operadores-cambio    un funcionario cambió su GPS o posición
//
//  Paneles -> servidor
//   ticket-cambio        { id, tipo, departamentoId?, operadorAsignadoId? }
//   ubicacion            { departamentoId? }
// ============================================================================

// Límite simple por conexión: máximo 40 avisos cada 10 segundos
function limitar(socket) {
  const ahora = Date.now();
  const v = socket.data.ventana || { inicio: ahora, n: 0 };
  if (ahora - v.inicio > 10000) { v.inicio = ahora; v.n = 0; }
  v.n++;
  socket.data.ventana = v;
  return v.n <= 40;
}

const limpiar = (d) => ({
  id: typeof d?.id === 'string' ? d.id.slice(0, 64) : undefined,
  tipo: typeof d?.tipo === 'string' ? d.tipo.slice(0, 32) : 'actualizacion',
  departamentoId: Number.isInteger(d?.departamentoId) ? d.departamentoId : undefined,
  operadorAsignadoId: typeof d?.operadorAsignadoId === 'string' ? d.operadorAsignadoId.slice(0, 64) : undefined,
  origen: undefined
});

io.on('connection', (socket) => {
  console.log(`Panel conectado: ${socket.id} (${socket.data.email})`);

  socket.on('ticket-cambio', (datos) => {
    if (!limitar(socket)) return;
    socket.broadcast.emit('ticket-cambio', { ...limpiar(datos), origen: socket.data.email, en: Date.now() });
  });

  socket.on('ubicacion', (datos) => {
    if (!limitar(socket)) return;
    socket.broadcast.emit('operadores-cambio', {
      departamentoId: Number.isInteger(datos?.departamentoId) ? datos.departamentoId : undefined,
      origen: socket.data.email,
      en: Date.now()
    });
  });

  socket.on('disconnect', () => console.log(`Panel desconectado: ${socket.id}`));
});

// ============================================================================
// REDIS: eventos publicados por el worker
// ============================================================================
const redisSubscriber = new Redis({ host: process.env.REDIS_HOST, port: 6379 });

// operadores-cambio: posiciones publicadas desde fuera de los paneles (por ejemplo, el simulador de demostración)
redisSubscriber.subscribe('nuevo-ticket', 'ticket-cambio', 'operadores-cambio', (err, count) => {
  if (err) console.error('Error suscribiéndose a Redis:', err);
  else console.log(`Suscrito a ${count} canal(es) de Redis.`);
});

redisSubscriber.on('message', (channel, message) => {
  let datos;
  try { datos = JSON.parse(message); } catch (e) { return; }

  if (channel === 'nuevo-ticket') {
    io.emit('ticket-actualizado', datos);
    io.emit('ticket-cambio', { id: datos.id, tipo: 'nuevo', departamentoId: datos.departamentoId, en: Date.now() });
    console.log(`Nuevo ticket ${datos.codigoTicket || datos.id} enviado a los paneles.`);
  } else if (channel === 'operadores-cambio') {
    io.emit('operadores-cambio', {
      departamentoId: Number.isInteger(datos?.departamentoId) ? datos.departamentoId : undefined,
      origen: 'simulador',
      en: Date.now()
    });
  } else if (channel === 'ticket-cambio') {
    io.emit('ticket-cambio', { ...datos, en: Date.now() });
  }
});

// Estado del servicio (para Azure y para diagnóstico)
app.get('/health', (req, res) => {
  res.json({ ok: true, conexiones: io.engine.clientsCount, redis: redisSubscriber.status });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Motor WebSockets escuchando en puerto ${PORT}`));
