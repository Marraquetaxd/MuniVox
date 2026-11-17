const crypto = require('crypto');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// El SDK de S3 viene incluido en el entorno de Lambda (Node.js 18 o superior).
// Se carga solo cuando se necesita, para que la función funcione aunque no esté.
let s3 = null;
function clienteS3() {
  if (s3) return s3;
  const { S3Client } = require('@aws-sdk/client-s3');
  s3 = new S3Client({ region: process.env.AWS_REGION || 'us-east-2' });
  return s3;
}

// ============================================================================
// CONFIGURACIÓN GENERAL
// ============================================================================
const ORIGENES_PERMITIDOS = [
  'https://main.df78b5k9bogvf.amplifyapp.com',
  'http://localhost:3000'
];
const PANEL_URL = (process.env.PANEL_URL || ORIGENES_PERMITIDOS[0]).replace(/\/$/, '');
const BUCKET = process.env.AWS_S3_BUCKET_NAME || 'munivox-evidencias-mvp';

const ESTADOS_VALIDOS = ['PENDIENTE', 'EN_REVISION', 'DESPACHADO', 'RESUELTO', 'DESCARTADO'];
const PRIORIDADES_VALIDAS = ['BAJA', 'MEDIA', 'ALTA', 'CRITICA'];
const ROLES_VALIDOS = ['ADMINISTRADOR', 'OPERADOR', 'TERRENO'];
const DEPARTAMENTOS_VALIDOS = [1, 2, 3, 4];
const CATEGORIAS_VALIDAS = [
  'Bache / Vialidad', 'Basura / Microbasural', 'Alumbrado público', 'Vehículo abandonado',
  'Ruidos molestos', 'Señalética / Tránsito', 'Áreas verdes', 'Animales', 'Otro'
];
const TIPOS_SOLICITUD = ['ACCESO', 'RECTIFICACION', 'SUPRESION', 'OPOSICION'];

const INCLUDE_REPORTE = {
  ciudadano: true,
  evidencias: true,
  categoria: true,
  departamento: true,
  operadorAsignado: true,
  historial: {
    include: { operador: { select: { id: true, nombre: true, rol: true, email: true } } },
    orderBy: { createdAt: 'desc' }
  }
};

// ============================================================================
// AYUDAS
// ============================================================================
function idDepartamentoDesdeNombre(nombre) {
  const n = String(nombre || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
  if (n.includes('ASEO') || n.includes('DIMAO')) return 1;
  if (n.includes('TRANSITO')) return 2;
  if (n.includes('SEGURIDAD')) return 3;
  if (n.includes('OBRAS') || n === 'DOM') return 4;
  return undefined;
}

function nombreDesdeCorreo(email) {
  const partes = String(email || '').split('@')[0].split(/[._-]+/).filter(Boolean);
  const capital = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  if (partes.length >= 2) return `${capital(partes[0])} (${capital(partes.slice(1).join(' '))})`;
  return capital(partes[0] || 'Usuario');
}

function distanciaMetros(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function nuevoToken() {
  const alfabeto = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from(crypto.randomBytes(12), b => alfabeto[b % alfabeto.length]).join('');
}

async function asegurarToken(reporte) {
  if (reporte.tokenSeguimiento) return reporte.tokenSeguimiento;
  const token = nuevoToken();
  await prisma.reporte.update({ where: { id: reporte.id }, data: { tokenSeguimiento: token } });
  return token;
}

const enlaceSeguimiento = (token) => `${PANEL_URL}/seguimiento?t=${token}`;

function normalizarTelefono(telefono) {
  let tel = telefono ? String(telefono).replace(/\D/g, '') : '';
  if (tel.length === 8) tel = `569${tel}`;
  if (tel.length === 9) tel = `56${tel}`;
  return tel;
}

// Minimización: el teléfono completo solo lo ve la central C4 en el expediente
function enmascararTelefono(tel) {
  if (String(tel || '').startsWith('anonimo-')) return 'Anónimo';
  const d = String(tel || '').replace(/\D/g, '');
  return d.length >= 4 ? `+56 9 **** ${d.slice(-4)}` : '****';
}

function protegerReporte(r, telefonoCompleto = false) {
  if (!r?.ciudadano) return r;
  return { ...r, ciudadano: { ...r.ciudadano, telefono: telefonoCompleto ? r.ciudadano.telefono : enmascararTelefono(r.ciudadano.telefono) } };
}

// ============================================================================
// NOTIFICACIONES PUSH A FUNCIONARIOS (Web Push con claves VAPID)
// Si faltan VAPID_PUBLICA o VAPID_PRIVADA, simplemente no se envían.
// ============================================================================
let webpush = null;
function clientePush() {
  if (webpush !== null) return webpush || null;
  if (!process.env.VAPID_PUBLICA || !process.env.VAPID_PRIVADA) { webpush = false; return null; }
  webpush = require('web-push');
  webpush.setVapidDetails(process.env.VAPID_CONTACTO || 'mailto:munivox@buin.cl', process.env.VAPID_PUBLICA, process.env.VAPID_PRIVADA);
  return webpush;
}

/** aviso = { titulo, cuerpo, url, tag, urgente } */
async function notificarFuncionario(operadorId, aviso) {
  const wp = clientePush();
  if (!wp || !operadorId) return 0;
  const suscripciones = await prisma.suscripcionPush.findMany({ where: { operadorId } });
  let enviadas = 0;
  await Promise.all(suscripciones.map(async sus => {
    try {
      await wp.sendNotification(
        { endpoint: sus.endpoint, keys: { p256dh: sus.p256dh, auth: sus.auth } },
        JSON.stringify(aviso),
        { TTL: 86400, urgency: aviso.urgente ? 'high' : 'normal', timeout: 5000 }
      );
      enviadas++;
    } catch (e) {
      // 404/410: el celular revocó el permiso o desinstaló; se borra la suscripción
      if (e.statusCode === 404 || e.statusCode === 410) await prisma.suscripcionPush.delete({ where: { id: sus.id } }).catch(() => {});
      else console.error('Notificación push falló:', e.statusCode, e.body || e.message);
    }
  }));
  return enviadas;
}

async function auditar(operadorId, accion, entidad, entidadId, detalle) {
  try {
    await prisma.auditoria.create({ data: { operadorId: operadorId || null, accion, entidad, entidadId: entidadId || null, detalle: detalle ? String(detalle).slice(0, 1000) : null } });
  } catch (e) {
    console.error('No se pudo registrar la auditoría:', e.message);
  }
}

async function subirImagen(base64, clave) {
  const limpio = String(base64).replace(/^data:image\/\w+;base64,/, '');
  const cuerpo = Buffer.from(limpio, 'base64');
  if (cuerpo.length > 4 * 1024 * 1024) throw new Error('La imagen supera 4 MB');
  const { PutObjectCommand } = require('@aws-sdk/client-s3');
  await clienteS3().send(new PutObjectCommand({ Bucket: BUCKET, Key: clave, Body: cuerpo, ContentType: 'image/jpeg' }));
  return `https://${BUCKET}.s3.${process.env.AWS_REGION || 'us-east-2'}.amazonaws.com/${clave}`;
}

async function borrarImagen(url) {
  const clave = String(url).split('.amazonaws.com/')[1];
  if (!clave) return;
  try {
    const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
    await clienteS3().send(new DeleteObjectCommand({ Bucket: BUCKET, Key: decodeURIComponent(clave) }));
  } catch (e) {
    console.error('No se pudo borrar la imagen de S3:', clave, e.message);
  }
}

// Supresión de datos de un vecino (derecho de supresión / plazo de conservación)
async function anonimizarCiudadano(ciudadanoId) {
  const reportes = await prisma.reporte.findMany({ where: { ciudadanoId }, include: { evidencias: true } });
  let fotos = 0;
  for (const r of reportes) {
    for (const e of r.evidencias) { await borrarImagen(e.url); fotos++; }
  }
  await prisma.evidencia.deleteMany({ where: { reporte: { ciudadanoId } } });
  await prisma.reporte.updateMany({ where: { ciudadanoId }, data: { descripcionUsuario: '[Relato eliminado a solicitud del titular]' } });
  await prisma.ciudadano.update({ where: { id: ciudadanoId }, data: { telefono: `anonimo-${ciudadanoId}`, nombre: null } });
  return { reportes: reportes.length, fotos };
}

// ============================================================================
// AVISOS AL CIUDADANO (META GRAPH API v18.0)
// Primero un mensaje libre (válido 24 h desde el último mensaje del vecino);
// si Meta lo rechaza, la plantilla aprobada `ticket_actualizado` (código y resumen).
// ============================================================================
async function enviarMeta(tel, payload) {
  const res = await fetch(`https://graph.facebook.com/v18.0/${process.env.META_PHONE_ID}/messages`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.META_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to: tel, ...payload }),
    signal: AbortSignal.timeout(5000)
  });
  let data = {};
  try { data = await res.json(); } catch (e) { /* sin cuerpo */ }
  return { ok: res.ok, status: res.status, data };
}

/** aviso = { texto, resumen (una línea), botones?: [{id, titulo}], imagen?: url } */
async function notificarCiudadano(telefono, codigoTicket, aviso) {
  if (!process.env.META_ACCESS_TOKEN || !process.env.META_PHONE_ID) {
    console.error('Faltan META_ACCESS_TOKEN o META_PHONE_ID en la Lambda.');
    return false;
  }
  if (String(telefono || '').startsWith('anonimo-')) return false;
  const tel = normalizarTelefono(telefono);
  if (!tel) return false;

  try {
    if (aviso.imagen) {
      const foto = await enviarMeta(tel, { type: 'image', image: { link: aviso.imagen, caption: `Foto del cierre del reporte ${codigoTicket}` } });
      if (!foto.ok) console.warn('No se pudo enviar la foto de cierre:', JSON.stringify(foto.data));
    }
    const payloadLibre = aviso.botones && aviso.botones.length
      ? {
          type: 'interactive',
          interactive: {
            type: 'button',
            body: { text: aviso.texto.slice(0, 1024) },
            action: { buttons: aviso.botones.slice(0, 3).map(b => ({ type: 'reply', reply: { id: b.id, title: b.titulo.slice(0, 20) } })) }
          }
        }
      : { type: 'text', text: { body: aviso.texto, preview_url: true } };

    const libre = await enviarMeta(tel, payloadLibre);
    if (libre.ok) {
      console.log(`Aviso enviado (${codigoTicket}).`);
      return true;
    }
    console.warn('Mensaje libre rechazado, se usa la plantilla:', JSON.stringify(libre.data));

    const resumen = String(aviso.resumen || '').replace(/[\r\n\t]+/g, ' ').replace(/ {4,}/g, ' ').trim().slice(0, 900);
    const plantilla = await enviarMeta(tel, {
      type: 'template',
      template: {
        name: process.env.META_TEMPLATE_NAME || 'ticket_actualizado',
        language: { code: process.env.META_TEMPLATE_LANG || 'es' },
        components: [{ type: 'body', parameters: [{ type: 'text', text: codigoTicket }, { type: 'text', text: resumen || 'Tu reporte tiene una actualización.' }] }]
      }
    });
    if (plantilla.ok) console.log(`Plantilla enviada (${codigoTicket}).`);
    else console.error(`La plantilla falló (${plantilla.status}):`, JSON.stringify(plantilla.data));
    return plantilla.ok;
  } catch (err) {
    console.error('Error HTTP hacia Meta:', err);
    return false;
  }
}

function construirAviso(evento, reporte, extra = {}) {
  const codigo = reporte.codigoTicket;
  const depto = reporte.departamento?.nombre || 'la Municipalidad';
  const categoria = reporte.categoria?.nombre || 'tu reporte';
  const pie = extra.token
    ? `\n\nVer el avance: ${enlaceSeguimiento(extra.token)}\nO escribe *estado* en este chat.`
    : '\n\nPara ver el avance, escribe *estado* en este chat.';

  switch (evento) {
    case 'DERIVADO':
      return {
        texto: `*MuniVox Buin* | Reporte *${codigo}*\n\nTu reporte (${categoria}) fue revisado por la central C4 y enviado a *${depto}*, que se encargará de atenderlo.${pie}`,
        resumen: `Enviado a ${depto}. El área responsable revisará tu caso.`
      };
    case 'ASIGNADO':
      return {
        texto: `*MuniVox Buin* | Reporte *${codigo}*\n\n*${depto}* asignó tu caso a un funcionario en terreno. Te avisaremos cuando vaya en camino.${pie}`,
        resumen: `${depto} asignó tu caso a un funcionario en terreno.`
      };
    case 'TOMADO':
      return {
        texto: `*MuniVox Buin* | Reporte *${codigo}*\n\nUn funcionario de *${depto}* tomó tu caso y lo atenderá en los próximos días. Te avisaremos cuando vaya al lugar.${pie}`,
        resumen: `Un funcionario de ${depto} tomó tu caso y lo atenderá en los próximos días.`
      };
    case 'EN_CAMINO':
      return {
        texto: `*MuniVox Buin* | Reporte *${codigo}*\n\nUn funcionario de *${depto}* va en camino al lugar que indicaste.${pie}`,
        resumen: `Un funcionario de ${depto} va en camino al lugar del reporte.`
      };
    case 'RESUELTO':
      return {
        texto: `*MuniVox Buin* | Reporte *${codigo}*\n\nTu caso fue *resuelto* por ${depto}.${extra.comentario ? `\n\n*Qué se hizo:* ${extra.comentario}` : ''}\n\n¿Cómo evalúas la solución? Toca una opción:`,
        resumen: `Caso resuelto por ${depto}.${extra.comentario ? ' ' + extra.comentario.slice(0, 200) : ''}`,
        imagen: extra.imagen,
        botones: [
          { id: `calif:${reporte.id}:5`, titulo: 'Bien resuelto' },
          { id: `calif:${reporte.id}:3`, titulo: 'Regular' },
          { id: `calif:${reporte.id}:1`, titulo: 'No se resolvió' }
        ]
      };
    case 'DESCARTADO':
      return {
        texto: `*MuniVox Buin* | Reporte *${codigo}*\n\nTu reporte fue cerrado sin intervención.${extra.comentario ? `\n\n*Motivo:* ${extra.comentario}` : ''}\n\nSi crees que es un error, envíanos un nuevo reporte con más detalles o una foto.`,
        resumen: `Reporte cerrado sin intervención.${extra.comentario ? ' Motivo: ' + extra.comentario.slice(0, 200) : ''}`
      };
    case 'DUPLICADO':
      return {
        texto: `*MuniVox Buin* | Reporte *${codigo}*\n\nOtro vecino ya había avisado el mismo problema, así que unimos tu reporte al caso *${extra.original}*, que ya está siendo atendido. Gracias por avisar.${extra.tokenOriginal ? `\n\nPuedes seguir ese caso aquí: ${enlaceSeguimiento(extra.tokenOriginal)}` : ''}`,
        resumen: `Tu reporte se unió al caso ${extra.original}, que ya está siendo atendido.`
      };
    case 'REABIERTO':
      return {
        texto: `*MuniVox Buin* | Reporte *${codigo}*\n\nTu caso fue reabierto y volverá a ser atendido por ${depto}.${pie}`,
        resumen: `Tu caso fue reabierto y volverá a ser atendido por ${depto}.`
      };
    case 'MENSAJE':
      return {
        texto: `*Mensaje de la Municipalidad de Buin*\nSobre tu reporte *${codigo}*:\n\n${extra.mensaje}\n\nPuedes responder directamente en este chat.`,
        resumen: extra.mensaje
      };
    default:
      return null;
  }
}

// ============================================================================
// SEGUIMIENTO PÚBLICO (sin datos personales)
// ============================================================================
const TEXTO_PUBLICO = {
  PENDIENTE: 'Reporte recibido',
  EN_REVISION: 'En revisión por el área responsable',
  DESPACHADO: 'Un funcionario tomó tu caso',
  RESUELTO: 'Caso resuelto',
  DESCARTADO: 'Reporte cerrado'
};

function vistaPublica(r) {
  const visibles = [...r.historial]
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
    .filter(h => !/^(\[Nota interna\]|\[Mensaje al vecino\]|Calificación|Rechazado por funcionario)/.test(String(h.comentario || '')));
  const primera = (estado) => visibles.find(h => h.estadoNuevo === estado)?.createdAt || null;
  const cierre = [...visibles].reverse().find(h => h.estadoNuevo === r.estado);
  return {
    codigo: r.codigoTicket,
    estado: r.estado,
    categoria: r.categoria?.nombre || null,
    departamento: r.departamento?.nombre || null,
    creado: r.createdAt,
    actualizado: r.updatedAt,
    etapas: {
      recibido: r.createdAt,
      enRevision: primera('EN_REVISION'),
      asignado: visibles.find(h => String(h.comentario || '').startsWith('Asignado'))?.createdAt || primera('DESPACHADO'),
      tomado: primera('DESPACHADO'),
      enCamino: visibles.find(h => String(h.comentario || '').startsWith('En camino'))?.createdAt || null,
      cerrado: ['RESUELTO', 'DESCARTADO'].includes(r.estado) ? cierre?.createdAt || r.updatedAt : null
    },
    pasos: visibles.map(h => ({ fecha: h.createdAt, texto: String(h.comentario || '').startsWith('En camino') ? 'Un funcionario va en camino' : TEXTO_PUBLICO[h.estadoNuevo] || h.estadoNuevo })),
    informe: r.estado === 'RESUELTO' ? cierre?.comentario || null : null,
    motivo: r.estado === 'DESCARTADO' ? cierre?.comentario || null : null,
    fotosCierre: (r.evidencias || []).filter(e => e.url.includes('/cierre/')).map(e => e.url),
    calificado: r.historial.some(h => String(h.comentario || '').startsWith('Calificación del ciudadano'))
  };
}

const INCLUDE_PUBLICO = { categoria: true, departamento: true, evidencias: true, historial: true };

// ============================================================================
// HANDLER PRINCIPAL
// ============================================================================
exports.handler = async (event) => {
  const origen = event.headers?.origin || event.headers?.Origin || '';
  const headers = {
    'Access-Control-Allow-Origin': ORIGENES_PERMITIDOS.includes(origen) ? origen : ORIGENES_PERMITIDOS[0],
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
    'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
    'Vary': 'Origin',
    'Content-Type': 'application/json'
  };
  const responder = (statusCode, data) => ({ statusCode, headers, body: JSON.stringify(data) });

  const method = event.requestContext?.http?.method || event.httpMethod;
  const path = event.requestContext?.http?.path || event.path || '';
  const partes = path.split('/').filter(Boolean);
  if (method === 'OPTIONS') return responder(200, { message: 'OK' });

  let body = {};
  if (event.body) {
    try {
      const crudo = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
      body = JSON.parse(crudo);
    } catch (e) {
      return responder(400, { error: 'El cuerpo de la petición no es JSON válido' });
    }
  }
  const query = event.queryStringParameters || {};

  try {
    // ------------------------------------------------------------------------
    // RUTAS PÚBLICAS (sin sesión): seguimiento de un reporte por el vecino
    //   GET  /publico/seguimiento?t=<token>
    //   POST /publico/seguimiento  { codigo, digitos }  (últimos 4 dígitos del teléfono)
    // ------------------------------------------------------------------------
    if (partes[0] === 'publico' && partes[1] === 'seguimiento') {
      if (method === 'GET') {
        const token = String(query.t || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
        if (token.length < 8) return responder(400, { error: 'Enlace incompleto' });
        const r = await prisma.reporte.findUnique({ where: { tokenSeguimiento: token }, include: INCLUDE_PUBLICO });
        if (!r || r.estado === 'BOCETO') return responder(404, { error: 'No encontramos ese reporte. Revisa que el enlace esté completo.' });
        return responder(200, { ...vistaPublica(r), token });
      }
      if (method === 'POST') {
        const numero = String(body.codigo || '').replace(/\D/g, '').slice(-6);
        const digitos = String(body.digitos || '').replace(/\D/g, '');
        const falla = async () => {
          await new Promise(res => setTimeout(res, 600)); // frena intentos repetidos
          return responder(404, { error: 'No encontramos un reporte con esos datos. Revisa el código y los últimos 4 dígitos de tu teléfono.' });
        };
        if (numero.length !== 6 || digitos.length !== 4) return falla();
        const r = await prisma.reporte.findUnique({ where: { codigoTicket: `MUN-${numero}` }, include: { ...INCLUDE_PUBLICO, ciudadano: true } });
        if (!r || r.estado === 'BOCETO' || !String(r.ciudadano?.telefono || '').endsWith(digitos)) return falla();
        const token = await asegurarToken(r);
        return responder(200, { ...vistaPublica(r), token });
      }
      return responder(405, { error: 'Método no permitido' });
    }

    // ------------------------------------------------------------------------
    // AUTENTICACIÓN Y ROL: la identidad sale SIEMPRE del token, nunca del cuerpo
    // ------------------------------------------------------------------------
    const emailToken = event.requestContext?.authorizer?.jwt?.claims?.email;
    if (!emailToken) return responder(401, { error: 'Token sin correo' });

    const esSincronizar = method === 'POST' && partes[0] === 'operadores' && partes[1] === 'sincronizar';
    const operador = await prisma.operador.findFirst({ where: { email: { equals: emailToken, mode: 'insensitive' } } });
    if (!operador && !esSincronizar) return responder(403, { error: 'Operador no registrado' });
    const miRol = operador?.rol;
    const miDepto = operador?.departamentoId ?? null;
    const esAdmin = miRol === 'ADMINISTRADOR';

    // ------------------------------------------------------------------------
    // POST /operadores/sincronizar
    // ------------------------------------------------------------------------
    if (esSincronizar) {
      const prefijo = emailToken.toLowerCase().split('@')[0];
      if (operador) {
        const data = {};
        if (!operador.nombre || operador.nombre === 'Operador Autorizado') data.nombre = nombreDesdeCorreo(emailToken);
        const actualizado = Object.keys(data).length
          ? await prisma.operador.update({ where: { id: operador.id }, data, include: { departamento: true } })
          : await prisma.operador.findUnique({ where: { id: operador.id }, include: { departamento: true } });
        return responder(200, actualizado);
      }
      let departamentoId = null;
      if (prefijo.includes('aseo')) departamentoId = 1;
      else if (prefijo.includes('transito')) departamentoId = 2;
      else if (prefijo.includes('seguridad')) departamentoId = 3;
      else if (prefijo.includes('obras')) departamentoId = 4;
      let rol = 'OPERADOR';
      if (prefijo.includes('terreno') || prefijo.includes('.')) rol = 'TERRENO';
      else if (prefijo.startsWith('operador')) rol = 'ADMINISTRADOR';
      const creado = await prisma.operador.create({
        data: { email: emailToken, nombre: nombreDesdeCorreo(emailToken), rol, departamentoId },
        include: { departamento: true }
      });
      await auditar(creado.id, 'REGISTRO_PERSONAL', 'Operador', creado.id, `Primer ingreso de ${emailToken} como ${rol}`);
      return responder(200, creado);
    }

    // ------------------------------------------------------------------------
    // GET /operadores
    // ------------------------------------------------------------------------
    if (method === 'GET' && partes[0] === 'operadores' && partes.length === 1) {
      if (miRol === 'TERRENO') return responder(403, { error: 'Acceso denegado: nivel de privilegio insuficiente' });
      const where = {};
      if (miRol === 'OPERADOR') where.departamentoId = miDepto ?? -1;
      else if (query.departamentoId) where.departamentoId = Number(query.departamentoId);
      if (query.rol && ROLES_VALIDOS.includes(query.rol)) where.rol = query.rol;
      if (query.gpsActivo !== undefined) where.gpsActivo = query.gpsActivo === 'true';
      const operadores = await prisma.operador.findMany({
        where,
        include: { departamento: true, _count: { select: { ticketsAsignados: { where: { estado: { in: ['EN_REVISION', 'DESPACHADO'] } } } } } },
        orderBy: { nombre: 'asc' }
      });
      // Privacidad: sin GPS activo no se entrega la última posición
      return responder(200, operadores.map(o => (o.gpsActivo ? o : { ...o, latitud: null, longitud: null, ultimaUbicacion: null })));
    }

    // ------------------------------------------------------------------------
    // PUT /operadores/ubicacion
    // ------------------------------------------------------------------------
    if (method === 'PUT' && partes[0] === 'operadores' && partes[1] === 'ubicacion') {
      const lat = Number(body.latitud);
      const lng = Number(body.longitud);
      const validas = Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
      const terminaTurno = body.enTurno === false;
      const apagaGps = body.gpsActivo === false || terminaTurno;
      const enTurnoFinal = body.enTurno !== undefined ? Boolean(body.enTurno) : operador.enTurno;
      // La ubicación solo se comparte durante el turno
      const gpsFinal = apagaGps ? false : body.gpsActivo !== undefined ? Boolean(body.gpsActivo) && enTurnoFinal : operador.gpsActivo;
      const actualizado = await prisma.operador.update({
        where: { id: operador.id },
        data: {
          ...(body.enTurno !== undefined && { enTurno: enTurnoFinal }),
          gpsActivo: gpsFinal,
          // Al dejar de compartir, se borra la última posición conocida
          ...(apagaGps ? { latitud: null, longitud: null, ultimaUbicacion: null } : {}),
          ...(validas && gpsFinal && { latitud: lat, longitud: lng, ultimaUbicacion: new Date() })
        },
        include: { departamento: true }
      });
      if (body.enTurno !== undefined && body.enTurno !== operador.enTurno) {
        await auditar(operador.id, enTurnoFinal ? 'INICIO_TURNO' : 'FIN_TURNO', 'Operador', operador.id, null);
      }
      return responder(200, actualizado);
    }

    // ------------------------------------------------------------------------
    // POST /operadores/notificaciones — activar o desactivar avisos en este celular
    //   { activar: true, suscripcion: { endpoint, keys: { p256dh, auth } }, dispositivo }
    //   { activar: false, suscripcion: { endpoint } }
    // ------------------------------------------------------------------------
    if (method === 'POST' && partes[0] === 'operadores' && partes[1] === 'notificaciones') {
      const sus = body.suscripcion || {};
      const endpoint = typeof sus.endpoint === 'string' ? sus.endpoint : '';
      if (!endpoint.startsWith('https://')) return responder(400, { error: 'Suscripción no válida' });

      if (body.activar === false) {
        await prisma.suscripcionPush.deleteMany({ where: { endpoint, operadorId: operador.id } });
        return responder(200, { ok: true, activas: false });
      }
      if (!sus.keys?.p256dh || !sus.keys?.auth) return responder(400, { error: 'Suscripción incompleta' });
      if (!clientePush()) return responder(503, { error: 'Las notificaciones aún no están configuradas en el servidor (faltan las claves VAPID).' });

      await prisma.suscripcionPush.upsert({
        where: { endpoint },
        update: { operadorId: operador.id, p256dh: sus.keys.p256dh, auth: sus.keys.auth, dispositivo: String(body.dispositivo || '').slice(0, 120) || null },
        create: { endpoint, operadorId: operador.id, p256dh: sus.keys.p256dh, auth: sus.keys.auth, dispositivo: String(body.dispositivo || '').slice(0, 120) || null }
      });
      // Aviso de prueba: confirma al funcionario que quedaron funcionando
      const enviadas = await notificarFuncionario(operador.id, {
        titulo: 'Notificaciones activadas',
        cuerpo: 'Te avisaremos aquí cuando te asignen una tarea o cambie una de tus tareas.',
        url: '/terreno',
        tag: 'activacion'
      });
      return responder(200, { ok: true, activas: true, prueba: enviadas > 0 });
    }

    // ------------------------------------------------------------------------
    // PUT /operadores/{id} — solo ADMINISTRADOR
    // ------------------------------------------------------------------------
    if (method === 'PUT' && partes[0] === 'operadores' && partes.length === 2) {
      if (!esAdmin) return responder(403, { error: 'Solo el administrador puede editar personal' });
      const data = {};
      if (typeof body.nombre === 'string' && body.nombre.trim()) data.nombre = body.nombre.trim().slice(0, 80);
      if (body.rol !== undefined) {
        if (!ROLES_VALIDOS.includes(body.rol)) return responder(400, { error: 'Rol no válido' });
        data.rol = body.rol;
      }
      if (body.departamentoId !== undefined) {
        const dep = body.departamentoId === null ? null : Number(body.departamentoId);
        if (dep !== null && !DEPARTAMENTOS_VALIDOS.includes(dep)) return responder(400, { error: 'Departamento no válido' });
        data.departamentoId = dep;
      }
      if (partes[1] === operador.id && data.rol && data.rol !== 'ADMINISTRADOR') {
        return responder(400, { error: 'No puedes quitarte a ti mismo el rol de administrador' });
      }
      const editado = await prisma.operador.update({ where: { id: partes[1] }, data, include: { departamento: true } });
      await auditar(operador.id, 'EDITAR_PERSONAL', 'Operador', editado.id, `${editado.email}: ${JSON.stringify(data)}`);
      return responder(200, editado);
    }

    // ------------------------------------------------------------------------
    // GET /ciudadanos y PUT /ciudadanos/{id} — solo ADMINISTRADOR
    // ------------------------------------------------------------------------
    if (method === 'GET' && partes[0] === 'ciudadanos' && partes.length === 1) {
      if (!esAdmin) return responder(403, { error: 'Acceso denegado' });
      const ciudadanos = await prisma.ciudadano.findMany({
        include: {
          _count: { select: { reportes: { where: { estado: { not: 'BOCETO' } } } } },
          reportes: { where: { estado: { not: 'BOCETO' } }, select: { createdAt: true, estado: true }, orderBy: { createdAt: 'desc' }, take: 1 }
        },
        orderBy: { createdAt: 'desc' },
        take: 500
      });
      await auditar(operador.id, 'CONSULTA_VECINOS', 'Ciudadano', null, `Listado de ${ciudadanos.length} vecinos`);
      return responder(200, ciudadanos);
    }

    if (method === 'PUT' && partes[0] === 'ciudadanos' && partes.length === 2) {
      if (!esAdmin) return responder(403, { error: 'Acceso denegado' });
      if (body.anonimizar === true) {
        const resultado = await anonimizarCiudadano(partes[1]);
        await auditar(operador.id, 'ANONIMIZAR_VECINO', 'Ciudadano', partes[1], `${resultado.reportes} reportes y ${resultado.fotos} fotos depurados. ${body.motivo || ''}`);
        return responder(200, { ok: true, ...resultado });
      }
      const data = {};
      if (body.baneado !== undefined) data.baneado = Boolean(body.baneado);
      if (typeof body.nombre === 'string') data.nombre = body.nombre.trim().slice(0, 80) || null;
      const ciudadano = await prisma.ciudadano.update({ where: { id: partes[1] }, data });
      if (body.baneado !== undefined) await auditar(operador.id, data.baneado ? 'BLOQUEAR_VECINO' : 'DESBLOQUEAR_VECINO', 'Ciudadano', ciudadano.id, enmascararTelefono(ciudadano.telefono));
      return responder(200, ciudadano);
    }

    // ------------------------------------------------------------------------
    // SOLICITUDES SOBRE DATOS PERSONALES — solo ADMINISTRADOR
    //   GET /solicitudes, POST /solicitudes, PUT /solicitudes/{id}
    // ------------------------------------------------------------------------
    if (partes[0] === 'solicitudes') {
      if (!esAdmin) return responder(403, { error: 'Acceso denegado' });

      if (method === 'GET' && partes.length === 1) {
        const solicitudes = await prisma.solicitudDatos.findMany({
          include: {
            ciudadano: { select: { id: true, telefono: true, createdAt: true, _count: { select: { reportes: true } } } },
            operador: { select: { nombre: true } }
          },
          orderBy: { createdAt: 'desc' },
          take: 300
        });
        return responder(200, solicitudes);
      }

      if (method === 'POST' && partes.length === 1) {
        if (!TIPOS_SOLICITUD.includes(body.tipo)) return responder(400, { error: 'Tipo de solicitud no válido' });
        const telefono = normalizarTelefono(body.telefono);
        const ciudadano = telefono ? await prisma.ciudadano.findUnique({ where: { telefono } }) : null;
        if (!ciudadano) return responder(404, { error: 'No hay registros asociados a ese número' });
        const solicitud = await prisma.solicitudDatos.create({
          data: { ciudadanoId: ciudadano.id, tipo: body.tipo, canal: String(body.canal || 'PRESENCIAL').slice(0, 30), detalle: String(body.detalle || '').slice(0, 2000) || null }
        });
        await auditar(operador.id, 'REGISTRAR_SOLICITUD', 'SolicitudDatos', solicitud.id, `${body.tipo} por ${solicitud.canal}`);
        return responder(200, solicitud);
      }

      if (method === 'PUT' && partes.length === 2) {
        const solicitud = await prisma.solicitudDatos.findUnique({ where: { id: partes[1] }, include: { ciudadano: true } });
        if (!solicitud) return responder(404, { error: 'Solicitud no encontrada' });
        if (!['RESUELTA', 'RECHAZADA'].includes(body.estado)) return responder(400, { error: 'Estado no válido' });
        const respuesta = String(body.respuesta || '').trim().slice(0, 1500);
        if (respuesta.length < 5) return responder(400, { error: 'Escribe la respuesta para el vecino' });

        // Primero se avisa (después de anonimizar ya no habría número)
        let avisado = false;
        if (body.notificar !== false) {
          avisado = await notificarCiudadano(solicitud.ciudadano.telefono, `SOL-${solicitud.id.slice(0, 8).toUpperCase()}`, {
            texto: `*Municipalidad de Buin* | Solicitud sobre tus datos personales\n\n${respuesta}`,
            resumen: `Respuesta a tu solicitud sobre datos personales: ${respuesta}`
          });
        }
        let resultado = null;
        if (body.anonimizar === true && body.estado === 'RESUELTA') resultado = await anonimizarCiudadano(solicitud.ciudadanoId);

        const actualizada = await prisma.solicitudDatos.update({
          where: { id: solicitud.id },
          data: { estado: body.estado, respuesta, operadorId: operador.id, resueltaEn: new Date() }
        });
        await auditar(operador.id, 'RESOLVER_SOLICITUD', 'SolicitudDatos', solicitud.id,
          `${solicitud.tipo} ${body.estado}${resultado ? `; anonimizado (${resultado.reportes} reportes, ${resultado.fotos} fotos)` : ''}`);
        return responder(200, { ...actualizada, avisado, anonimizado: !!resultado });
      }
      return responder(404, { error: 'Ruta no soportada' });
    }

    // ------------------------------------------------------------------------
    // GET /auditoria — solo ADMINISTRADOR
    // ------------------------------------------------------------------------
    if (method === 'GET' && partes[0] === 'auditoria') {
      if (!esAdmin) return responder(403, { error: 'Acceso denegado' });
      const registros = await prisma.auditoria.findMany({
        include: { operador: { select: { nombre: true, email: true } } },
        orderBy: { createdAt: 'desc' },
        take: 500
      });
      return responder(200, registros);
    }

    // ------------------------------------------------------------------------
    // GET /tickets, /tickets/cercanos, /tickets/{id}
    // ------------------------------------------------------------------------
    if (method === 'GET' && partes[0] === 'tickets') {
      const visibilidad = { estado: { not: 'BOCETO' } };
      if (miRol === 'TERRENO') {
        visibilidad.operadorAsignadoId = operador.id;
        if (partes.length === 1) {
          visibilidad.OR = [
            { estado: { in: ['EN_REVISION', 'DESPACHADO'] } },
            { updatedAt: { gte: new Date(Date.now() - 48 * 3600000) } }
          ];
        }
      }
      else if (miRol === 'OPERADOR') visibilidad.departamentoId = miDepto ?? -1;

      if (partes[1] === 'cercanos') {
        const lat = Number(query.lat);
        const lng = Number(query.lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return responder(400, { error: 'Faltan lat y lng' });
        const radio = Math.min(Math.max(Number(query.radio) || 300, 50), 3000);
        const dLat = radio / 111320;
        const dLng = radio / (111320 * Math.cos(lat * Math.PI / 180));
        const dias = Math.min(Math.max(Number(query.dias) || 30, 1), 365);
        const candidatos = await prisma.reporte.findMany({
          where: {
            ...visibilidad,
            ...(query.excluir ? { id: { not: String(query.excluir) } } : {}),
            latitud: { gte: lat - dLat, lte: lat + dLat },
            longitud: { gte: lng - dLng, lte: lng + dLng },
            createdAt: { gte: new Date(Date.now() - dias * 86400000) }
          },
          include: { categoria: true, departamento: true },
          take: 50
        });
        const cercanos = candidatos
          .map(r => ({ ...r, distancia: Math.round(distanciaMetros(lat, lng, r.latitud, r.longitud)) }))
          .filter(r => r.distancia <= radio)
          .sort((a, b) => a.distancia - b.distancia);
        return responder(200, cercanos);
      }

      if (partes.length > 1) {
        const reporte = await prisma.reporte.findUnique({ where: { id: partes[1] }, include: INCLUDE_REPORTE });
        if (!reporte || reporte.estado === 'BOCETO') return responder(404, { error: 'Reporte no encontrado' });
        if (miRol === 'TERRENO' && reporte.operadorAsignadoId !== operador.id) return responder(403, { error: 'Este ticket no está asignado a ti' });
        if (miRol === 'OPERADOR' && reporte.departamentoId !== miDepto) return responder(403, { error: 'Este ticket pertenece a otro departamento' });
        const reportesCiudadano = await prisma.reporte.count({ where: { ciudadanoId: reporte.ciudadanoId, estado: { not: 'BOCETO' } } });
        return responder(200, { ...protegerReporte(reporte, esAdmin), reportesCiudadano });
      }

      const where = { ...visibilidad };
      if (esAdmin) {
        if (query.operadorEmail) {
          const operadorQ = await prisma.operador.findUnique({ where: { email: query.operadorEmail } });
          where.operadorAsignadoId = operadorQ ? operadorQ.id : 'inexistente';
        } else if (query.departamentoId) {
          where.departamentoId = Number(query.departamentoId);
        }
      }
      if (query.estado && ESTADOS_VALIDOS.includes(query.estado)) where.estado = query.estado;
      if (query.desde) {
        const desde = new Date(query.desde);
        if (!isNaN(desde.getTime())) where.createdAt = { gte: desde };
      }
      const reportes = await prisma.reporte.findMany({ where, include: INCLUDE_REPORTE, orderBy: { createdAt: 'desc' } });
      return responder(200, reportes.map(r => protegerReporte(r, false)));
    }

    // ------------------------------------------------------------------------
    // PUT /tickets/{id}
    // ------------------------------------------------------------------------
    if (method === 'PUT' && partes[0] === 'tickets' && partes.length === 2) {
      const ticketId = partes[1];
      const actual = await prisma.reporte.findUnique({
        where: { id: ticketId },
        select: { id: true, codigoTicket: true, estado: true, operadorAsignadoId: true, departamentoId: true, prioridadFinal: true, prioridadIA: true }
      });
      if (!actual || actual.estado === 'BOCETO') return responder(404, { error: 'Reporte no encontrado' });

      const comentario = typeof body.comentario === 'string' ? body.comentario.trim().slice(0, 1000) : '';
      const mensajeVecino = typeof body.mensajeVecino === 'string' ? body.mensajeVecino.trim().slice(0, 800) : '';

      // Permisos base por rol
      if (miRol === 'TERRENO' && actual.operadorAsignadoId !== operador.id) return responder(403, { error: 'Este ticket no está asignado a ti' });
      if (miRol === 'OPERADOR' && actual.departamentoId !== miDepto) return responder(403, { error: 'Este ticket pertenece a otro departamento' });

      // ---- "Voy en camino" (funcionario en terreno) ----
      if (body.enCamino === true) {
        if (miRol !== 'TERRENO') return responder(403, { error: 'Solo el funcionario asignado puede indicar que va en camino' });
        if (actual.estado !== 'DESPACHADO') return responder(400, { error: 'Primero acepta la tarea' });
        const r = await prisma.reporte.findUnique({ where: { id: ticketId }, include: { ciudadano: true, departamento: true, categoria: true, historial: true } });
        const hace12h = Date.now() - 12 * 3600000;
        const yaAvisado = r.historial.some(h => String(h.comentario || '').startsWith('En camino') && new Date(h.createdAt).getTime() > hace12h);
        await prisma.historialEstado.create({
          data: { reporteId: r.id, estadoNuevo: r.estado, operadorId: operador.id, comentario: 'En camino al lugar' }
        });
        // Si ya avisó en las últimas 12 h no se repite el WhatsApp al vecino
        if (!yaAvisado && r.ciudadano?.telefono) {
          const token = await asegurarToken(r);
          await notificarCiudadano(r.ciudadano.telefono, r.codigoTicket, construirAviso('EN_CAMINO', r, { token }));
        }
        const completo = await prisma.reporte.findUnique({ where: { id: ticketId }, include: INCLUDE_REPORTE });
        return responder(200, protegerReporte(completo, false));
      }

      // ---- Mensaje directo al vecino (C4 y jefatura) ----
      if (mensajeVecino) {
        if (miRol === 'TERRENO') return responder(403, { error: 'Acción no permitida para tu rol' });
        if (mensajeVecino.length < 3) return responder(400, { error: 'Escribe el mensaje' });
        const r = await prisma.reporte.findUnique({ where: { id: ticketId }, include: { ciudadano: true, departamento: true, categoria: true } });
        const enviado = await notificarCiudadano(r.ciudadano?.telefono, r.codigoTicket, construirAviso('MENSAJE', r, { mensaje: mensajeVecino }));
        await prisma.historialEstado.create({
          data: { reporteId: r.id, estadoNuevo: r.estado, operadorId: operador.id, comentario: `[Mensaje al vecino] ${mensajeVecino}${enviado ? '' : ' (no se pudo entregar)'}` }
        });
        const completo = await prisma.reporte.findUnique({ where: { id: ticketId }, include: INCLUDE_REPORTE });
        return responder(enviado ? 200 : 502, enviado ? protegerReporte(completo, esAdmin) : { error: 'WhatsApp no aceptó el mensaje. Revisa los registros de la Lambda.' });
      }

      // ---- Marcar como duplicado de otro reporte ----
      let original = null;
      if (body.duplicadoDe) {
        if (miRol === 'TERRENO') return responder(403, { error: 'Acción no permitida para tu rol' });
        original = await prisma.reporte.findUnique({ where: { codigoTicket: String(body.duplicadoDe).toUpperCase() } });
        if (!original || original.id === actual.id || original.estado === 'BOCETO') return responder(400, { error: 'El reporte original no existe' });
        body.nuevoEstado = 'DESCARTADO';
      }

      const nuevoEstado = body.nuevoEstado;
      if (nuevoEstado !== undefined && !ESTADOS_VALIDOS.includes(nuevoEstado)) return responder(400, { error: 'Estado no válido' });
      const esNotaInterna = body.notaInterna === true;

      let depDestino;
      if (body.departamentoAsignado !== undefined || body.departamentoId !== undefined) {
        depDestino = body.departamentoId !== undefined ? Number(body.departamentoId) : idDepartamentoDesdeNombre(body.departamentoAsignado);
        if (!DEPARTAMENTOS_VALIDOS.includes(depDestino)) return responder(400, { error: 'Departamento no válido' });
      }

      if (miRol === 'TERRENO') {
        if (body.operadorAsignadoId !== undefined && body.operadorAsignadoId !== null) return responder(403, { error: 'Un funcionario en terreno no puede reasignar tickets' });
        if (depDestino !== undefined || body.prioridadFinal !== undefined || body.categoriaNombre !== undefined) return responder(403, { error: 'Acción no permitida para tu rol' });
        if (nuevoEstado && !['EN_REVISION', 'DESPACHADO', 'RESUELTO'].includes(nuevoEstado)) return responder(403, { error: 'Estado no permitido para tu rol' });
        if (nuevoEstado === 'RESUELTO' && comentario.length < 5) return responder(400, { error: 'Describe brevemente cómo se resolvió el caso' });
      }
      if (miRol === 'OPERADOR' && depDestino !== undefined && depDestino !== miDepto) {
        return responder(403, { error: 'Solo el administrador puede derivar entre departamentos' });
      }
      if (nuevoEstado === 'DESCARTADO' && !original && comentario.length < 5) return responder(400, { error: 'Indica el motivo del descarte' });

      if (body.operadorAsignadoId) {
        const funcionario = await prisma.operador.findUnique({ where: { id: String(body.operadorAsignadoId) } });
        if (!funcionario || funcionario.rol !== 'TERRENO') return responder(400, { error: 'El funcionario no existe o no es de terreno' });
        const depTicket = depDestino ?? actual.departamentoId;
        if (depTicket && funcionario.departamentoId !== depTicket) return responder(400, { error: 'El funcionario pertenece a otro departamento' });
      }

      let prioridadFinal;
      if (body.prioridadFinal !== undefined) {
        if (body.prioridadFinal !== null && !PRIORIDADES_VALIDAS.includes(body.prioridadFinal)) return responder(400, { error: 'Prioridad no válida' });
        prioridadFinal = body.prioridadFinal;
      }

      let categoriaId;
      if (body.categoriaNombre !== undefined) {
        if (!CATEGORIAS_VALIDAS.includes(body.categoriaNombre)) return responder(400, { error: 'Categoría no válida' });
        const cat = await prisma.categoria.upsert({ where: { nombre: body.categoriaNombre }, update: {}, create: { nombre: body.categoriaNombre } });
        categoriaId = cat.id;
      }

      // ---- Foto de cierre (opcional, al resolver) ----
      let urlFotoCierre = null;
      let advertencia = null;
      if (body.fotoCierre && nuevoEstado === 'RESUELTO') {
        try {
          // Debe ir bajo evidencias/: es la carpeta que el bucket permite leer (panel y WhatsApp)
          urlFotoCierre = await subirImagen(body.fotoCierre, `evidencias/cierre/${actual.codigoTicket}_${Date.now()}.jpg`);
        } catch (e) {
          console.error('No se pudo subir la foto de cierre:', e.message);
          advertencia = 'El caso se cerró, pero la foto no se pudo guardar.';
        }
      }

      // ---- Reglas de flujo ----
      let estadoFinal = nuevoEstado;
      const derivaAOtroDepto = depDestino !== undefined && depDestino !== actual.departamentoId;
      if (depDestino !== undefined && !estadoFinal && actual.estado === 'PENDIENTE') estadoFinal = 'EN_REVISION';
      const liberarFuncionario = derivaAOtroDepto && body.operadorAsignadoId === undefined && actual.operadorAsignadoId;

      const comentarioHistorial = (original ? `Duplicado de ${original.codigoTicket}` : '') || comentario || (
        esNotaInterna ? 'Nota interna' :
        derivaAOtroDepto ? 'Derivado por la central C4' :
        body.operadorAsignadoId ? 'Asignado a funcionario en terreno' :
        prioridadFinal !== undefined ? `Prioridad ajustada a ${prioridadFinal || 'la sugerida por IA'}` :
        categoriaId !== undefined ? `Categoría corregida a ${body.categoriaNombre}` :
        'Actualización operativa'
      );

      const reporte = await prisma.reporte.update({
        where: { id: ticketId },
        data: {
          ...(estadoFinal && { estado: estadoFinal }),
          ...(depDestino !== undefined && { departamentoId: depDestino }),
          ...(body.operadorAsignadoId !== undefined ? { operadorAsignadoId: body.operadorAsignadoId || null } : {}),
          ...(liberarFuncionario ? { operadorAsignadoId: null } : {}),
          ...(prioridadFinal !== undefined && { prioridadFinal }),
          ...(categoriaId !== undefined && { categoriaId }),
          ...(urlFotoCierre && { evidencias: { create: { url: urlFotoCierre, tipo: 'IMAGEN' } } }),
          historial: {
            create: {
              estadoNuevo: estadoFinal || actual.estado,
              comentario: esNotaInterna ? `[Nota interna] ${comentarioHistorial}` : comentarioHistorial,
              operadorId: operador.id
            }
          }
        },
        include: INCLUDE_REPORTE
      });

      // ---- Notificaciones push a los funcionarios afectados ----
      try {
        const anterior = actual.operadorAsignadoId;
        const nuevo = reporte.operadorAsignadoId;
        const prio = reporte.prioridadFinal || reporte.prioridadIA || 'MEDIA';
        const urgente = prio === 'CRITICA' || prio === 'ALTA';
        const tarea = `${reporte.categoria?.nombre || 'Reporte'} | ${reporte.codigoTicket}`;
        const url = `/terreno?tarea=${reporte.id}`;
        const tag = `tarea-${reporte.id}`;
        const avisos = [];
        if (nuevo && nuevo !== anterior) {
          avisos.push(notificarFuncionario(nuevo, {
            titulo: urgente ? `Tarea urgente (prioridad ${prio === 'CRITICA' ? 'crítica' : 'alta'})` : 'Nueva tarea asignada',
            cuerpo: `${tarea}. ${urgente ? 'Requiere atención pronto. ' : ''}Toca para ver el detalle.`,
            url, tag, urgente
          }));
        }
        if (anterior && anterior !== nuevo && miRol !== 'TERRENO') {
          avisos.push(notificarFuncionario(anterior, {
            titulo: 'Tarea reasignada',
            cuerpo: `${tarea} ya no está a tu cargo. No necesitas ir.`,
            url: '/terreno', tag
          }));
        }
        if (anterior && anterior === nuevo && miRol !== 'TERRENO') {
          if (estadoFinal === 'DESCARTADO' && actual.estado !== 'DESCARTADO') {
            avisos.push(notificarFuncionario(anterior, { titulo: 'Caso cerrado', cuerpo: `${tarea} fue cerrado por la Municipalidad. Ya no necesitas ir.`, url: '/terreno', tag }));
          } else if (prioridadFinal === 'CRITICA' && (actual.prioridadFinal || actual.prioridadIA) !== 'CRITICA') {
            avisos.push(notificarFuncionario(anterior, { titulo: 'Prioridad cambiada a crítica', cuerpo: `${tarea}. Atiéndelo lo antes posible.`, url, tag, urgente: true }));
          }
        }
        await Promise.all(avisos);
      } catch (e) {
        console.error('No se pudieron enviar las notificaciones push:', e);
      }

      // ---- Aviso al ciudadano ----
      if (!esNotaInterna) {
        let evento = null;
        const esRechazo = miRol === 'TERRENO' && body.operadorAsignadoId === null;
        if (esRechazo) evento = null;
        else if (original) evento = 'DUPLICADO';
        else if (estadoFinal === 'RESUELTO' && actual.estado !== 'RESUELTO') evento = 'RESUELTO';
        else if (estadoFinal === 'DESCARTADO' && actual.estado !== 'DESCARTADO') evento = 'DESCARTADO';
        else if (estadoFinal === 'DESPACHADO' && actual.estado !== 'DESPACHADO') evento = 'TOMADO';
        else if (['RESUELTO', 'DESCARTADO'].includes(actual.estado) && estadoFinal && !['RESUELTO', 'DESCARTADO'].includes(estadoFinal)) evento = 'REABIERTO';
        else if (body.operadorAsignadoId && body.operadorAsignadoId !== actual.operadorAsignadoId) evento = 'ASIGNADO';
        else if (derivaAOtroDepto || (depDestino !== undefined && actual.estado === 'PENDIENTE')) evento = 'DERIVADO';

        if (evento && reporte.ciudadano?.telefono) {
          const token = await asegurarToken(reporte);
          const tokenOriginal = original ? await asegurarToken(original) : null;
          const aviso = construirAviso(evento, reporte, { comentario, token, imagen: urlFotoCierre, original: original?.codigoTicket, tokenOriginal });
          if (aviso) await notificarCiudadano(reporte.ciudadano.telefono, reporte.codigoTicket, aviso);
        }
      }

      return responder(200, { ...protegerReporte(reporte, esAdmin), ...(advertencia && { advertencia }) });
    }

    return responder(404, { error: 'Método o ruta no soportados' });
  } catch (error) {
    console.error('Error crítico en Lambda:', error);
    if (error.code === 'P2025') return responder(404, { error: 'Registro no encontrado' });
    return responder(500, { error: 'Error interno de la Lambda', detalle: error.message });
  }
};
