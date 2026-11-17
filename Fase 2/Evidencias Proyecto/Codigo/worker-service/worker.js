require('dotenv').config();
const crypto = require('crypto');
const { Worker, Queue } = require('bullmq');
const Redis = require('ioredis');
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { PrismaClient } = require('@prisma/client');
const { verificarUbicacion } = require('./geo');
const { detectarIntencion } = require('./intencion');

const prisma = new PrismaClient();
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const s3Client = new S3Client({ region: process.env.AWS_REGION || 'us-east-2' });

const redisConnection = new Redis({
  host: process.env.REDIS_HOST,
  port: 6379,
  maxRetriesPerRequest: null
});

// ============================================================================
// CONFIGURACIÓN
// ============================================================================
// Espera breve antes de procesar, para que llegue el resto de un mensaje compuesto
const ESPERA_CONSOLIDACION_MS = Number(process.env.ESPERA_CONSOLIDACION_MS || 2500);
// Minutos que se espera la ubicación antes de borrar un borrador
const MINUTOS_ABANDONO = Number(process.env.MINUTOS_ABANDONO || 30);
// Dirección pública del panel (seguimiento y política de privacidad)
const PANEL_URL = (process.env.PANEL_URL || 'https://main.df78b5k9bogvf.amplifyapp.com').replace(/\/$/, '');
// Meses que se conservan relatos y fotos de casos cerrados (vacío = no se aplica)
const RETENCION_MESES = Number(process.env.RETENCION_MESES || 0);
const MODELO_GEMINI = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';

const cleanupQueue = new Queue('verificar-abandono', { connection: redisConnection });
const mantencionQueue = new Queue('mantencion', { connection: redisConnection });

// ============================================================================
// CLASIFICACIÓN: categorías y departamentos permitidos (la IA solo puede elegir de estas listas)
// ============================================================================
const CATEGORIAS = {
  'Bache / Vialidad':      'Obras Municipales',
  'Basura / Microbasural': 'Aseo y Ornato',
  'Alumbrado público':     'Obras Municipales',
  'Vehículo abandonado':   'Tránsito',
  'Ruidos molestos':       'Seguridad Pública',
  'Señalética / Tránsito': 'Tránsito',
  'Áreas verdes':          'Aseo y Ornato',
  'Animales':              'Seguridad Pública',
  'Otro':                  null
};
const DEPARTAMENTOS_ID = { 'Aseo y Ornato': 1, 'Tránsito': 2, 'Seguridad Pública': 3, 'Obras Municipales': 4 };

// Lista de WhatsApp: títulos de hasta 24 caracteres, máximo 10 filas
const MENU_CATEGORIAS = [
  { id: 'cat:Bache / Vialidad',      titulo: 'Bache / Vialidad',      descripcion: 'Hoyos, calzada o veredas dañadas' },
  { id: 'cat:Basura / Microbasural', titulo: 'Basura / Microbasural', descripcion: 'Escombros, basura acumulada o microbasurales' },
  { id: 'cat:Alumbrado público',     titulo: 'Alumbrado público',     descripcion: 'Luminarias apagadas o postes dañados' },
  { id: 'cat:Vehículo abandonado',   titulo: 'Vehículo abandonado',   descripcion: 'Autos abandonados en la vía pública' },
  { id: 'cat:Ruidos molestos',       titulo: 'Ruidos molestos',       descripcion: 'Fiestas, música o ruidos fuera de horario' },
  { id: 'cat:Señalética / Tránsito', titulo: 'Señalética / Tránsito', descripcion: 'Semáforos, señales o demarcación' },
  { id: 'cat:Áreas verdes',          titulo: 'Áreas verdes',          descripcion: 'Plazas, árboles, riego y mantención' },
  { id: 'cat:Animales',              titulo: 'Animales',              descripcion: 'Animales sueltos, heridos o abandonados' },
  { id: 'cat:Otro',                  titulo: 'Otro problema',         descripcion: 'Cualquier otro problema en la vía pública' }
];

// Estados en palabras simples para el vecino
const ESTADO_LEGIBLE = {
  PENDIENTE:   'Recibido, esperando revisión',
  EN_REVISION: 'En revisión por el área responsable',
  DESPACHADO:  'Un funcionario tomó tu caso',
  RESUELTO:    'Resuelto',
  DESCARTADO:  'Cerrado'
};

const normalizar = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

function buscarEnLista(valor, opciones) {
  const v = normalizar(valor);
  return opciones.find(o => normalizar(o) === v) || null;
}

const fechaCorta = (d) => new Date(d).toLocaleString('es-CL', {
  timeZone: 'America/Santiago', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
});

const enlaceSeguimiento = (token) => `${PANEL_URL}/seguimiento?t=${token}`;

// Clave aleatoria para el enlace de seguimiento (sin letras que se confunden: 0/O, 1/I)
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

// Respaldo sin IA: palabras clave del relato (en orden de prioridad)
const PALABRAS_CATEGORIA = [
  ['Bache / Vialidad',      ['bache', 'baches', 'hoyo', 'hoyos', 'socavon', 'calzada', 'pavimento', 'asfalto', 'vereda', 'veredas', 'vialidad']],
  ['Basura / Microbasural', ['basura', 'basural', 'microbasural', 'escombro', 'escombros', 'residuos', 'desechos', 'cachureos', 'basurero']],
  ['Alumbrado público',     ['alumbrado', 'luminaria', 'luminarias', 'foco', 'focos', 'poste', 'ampolleta', 'oscuro', 'oscura']],
  ['Vehículo abandonado',   ['vehiculo', 'auto', 'autos', 'camioneta', 'camion', 'chatarra', 'abandonado', 'abandonada']],
  ['Ruidos molestos',       ['ruido', 'ruidos', 'fiesta', 'musica', 'parlante', 'bulla', 'gritos']],
  ['Señalética / Tránsito', ['senal', 'senaletica', 'letrero', 'semaforo', 'pare', 'demarcacion', 'paso de cebra']],
  ['Áreas verdes',          ['plaza', 'arbol', 'arboles', 'rama', 'ramas', 'riego', 'pasto', 'jardin', 'poda', 'area verde', 'areas verdes']],
  ['Animales',              ['perro', 'perros', 'gato', 'gatos', 'animal', 'animales', 'caballo', 'vaca', 'jauria', 'mascota']]
];

function categoriaPorPalabras(texto) {
  const t = ` ${normalizar(texto).replace(/[^a-z0-9ñ ]+/g, ' ')} `;
  for (const [categoria, palabras] of PALABRAS_CATEGORIA) {
    if (palabras.some(p => t.includes(` ${p} `))) return categoria;
  }
  return null;
}

// Clasificación dedicada (solo si la respuesta principal no trajo una categoría válida)
async function clasificarConIA(texto) {
  try {
    const modelo = genAI.getGenerativeModel({ model: MODELO_GEMINI, generationConfig: { responseMimeType: 'application/json' } });
    const r = await modelo.generateContent(
      `Clasifica este reporte ciudadano de la Municipalidad de Buin. Responde SOLO un JSON {"categoria": "..."} ` +
      `donde categoria es EXACTAMENTE uno de: ${Object.keys(CATEGORIAS).join(' | ')}.\n\nReporte:\n${texto}`
    );
    return buscarEnLista(JSON.parse(r.response.text()).categoria, Object.keys(CATEGORIAS));
  } catch (e) {
    console.error('X Clasificación dedicada falló:', e.message);
    return null;
  }
}

/**
 * Devuelve { categoriaId, departamentoId } validados contra la BD.
 * final = true cuando el reporte se confirma: entonces nunca queda sin categoría ("Otro" en el peor caso).
 */
async function resolverClasificacion(respuestaIA, texto = '', final = false) {
  const deIA = buscarEnLista(respuestaIA.categoriaNombre, Object.keys(CATEGORIAS));
  let categoria = deIA === 'Otro' && !final ? null : deIA;
  if (!categoria) categoria = categoriaPorPalabras(`${texto} ${respuestaIA.analisisIA || ''}`);
  if (!categoria && final) categoria = (await clasificarConIA(texto)) || 'Otro';

  let departamento = categoria && categoria === deIA ? buscarEnLista(respuestaIA.departamentoNombre, Object.keys(DEPARTAMENTOS_ID)) : null;
  if (!departamento && categoria) departamento = CATEGORIAS[categoria];

  let categoriaId, departamentoId;
  if (categoria) {
    const cat = await prisma.categoria.upsert({ where: { nombre: categoria }, update: {}, create: { nombre: categoria } });
    categoriaId = cat.id;
  }
  if (departamento) {
    const dep = await prisma.departamento.findUnique({ where: { id: DEPARTAMENTOS_ID[departamento] } });
    if (dep) departamentoId = dep.id;
  }
  console.log(`> Clasificación: categoría=${categoria} | departamento=${departamento}`);
  return { categoriaId, departamentoId };
}

// ============================================================================
// WHATSAPP
// ============================================================================
async function llamarMeta(payload) {
  try {
    const res = await fetch(`https://graph.facebook.com/v18.0/${process.env.META_PHONE_ID}/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.META_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', ...payload }),
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) console.error('X Meta rechazó el mensaje:', res.status, await res.text());
    return res.ok;
  } catch (error) {
    console.error('X Error enviando a Meta:', error);
    return false;
  }
}

const enviarTexto = (to, texto) => llamarMeta({ to, type: 'text', text: { body: texto, preview_url: true } });

const pedirUbicacion = (to, texto) => llamarMeta({
  to, type: 'interactive',
  interactive: { type: 'location_request_message', body: { text: texto }, action: { name: 'send_location' } }
});

// Hasta 3 botones (títulos de máximo 20 caracteres)
async function enviarBotones(to, texto, botones, respaldo) {
  const ok = await llamarMeta({
    to, type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: texto },
      action: { buttons: botones.slice(0, 3).map(b => ({ type: 'reply', reply: { id: b.id, title: b.titulo.slice(0, 20) } })) }
    }
  });
  if (!ok && respaldo) await enviarTexto(to, respaldo);
}

async function enviarLista(to, { encabezado, texto, pie, boton, secciones }, respaldo) {
  const ok = await llamarMeta({
    to, type: 'interactive',
    interactive: {
      type: 'list',
      ...(encabezado && { header: { type: 'text', text: encabezado.slice(0, 60) } }),
      body: { text: texto },
      ...(pie && { footer: { text: pie.slice(0, 60) } }),
      action: { button: boton.slice(0, 20), sections: secciones }
    }
  });
  if (!ok && respaldo) await enviarTexto(to, respaldo);
}

const marcarComoLeido = (wamid) => (wamid ? llamarMeta({ status: 'read', message_id: wamid }) : Promise.resolve(false));

// ============================================================================
// MENSAJES DE AYUDA (pensados para personas de todas las edades)
// ============================================================================
const TEXTO_EMERGENCIAS = '*Emergencias:* 131 SAMU | 132 Bomberos | 133 Carabineros';

async function enviarMenuPrincipal(to) {
  await enviarBotones(
    to,
    'Hola. Este es el canal oficial de la *Municipalidad de Buin* para avisar problemas en la calle: baches, basura, luminarias, autos abandonados y más.\n\n¿Qué necesitas hacer? Toca una opción:',
    [
      { id: 'menu:reportar', titulo: 'Reportar problema' },
      { id: 'consultar', titulo: 'Ver mis reportes' },
      { id: 'menu:ayuda', titulo: 'Ayuda' }
    ],
    'Hola. Este es el canal oficial de la Municipalidad de Buin.\n\nPara *reportar un problema*, escríbelo con tus palabras.\nPara *ver tus reportes*, escribe: estado\nPara *ayuda*, escribe: ayuda'
  );
}

async function enviarCategorias(to) {
  await enviarLista(to, {
    texto: 'Elige el tipo de problema. Si no sabes cuál es, elige *Otro problema* o simplemente escríbelo con tus palabras.',
    pie: 'Puedes adjuntar una foto después',
    boton: 'Elegir tipo',
    secciones: [{ title: 'Tipo de problema', rows: MENU_CATEGORIAS.map(c => ({ id: c.id, title: c.titulo, description: c.descripcion })) }]
  }, 'Escribe con tus palabras qué problema quieres reportar y dónde está. Por ejemplo: "Hay un bache grande en calle Balmaceda frente al número 300".');
}

async function enviarAyuda(to) {
  await enviarTexto(to,
    '*Cómo usar este canal*\n\n' +
    '*1. Cuenta el problema*\nEscribe qué pasa, por ejemplo: "Hay basura acumulada en la esquina".\n\n' +
    '*2. Envía una foto (opcional)*\nToca el clip o la cámara y saca una foto del problema. Evita que salgan personas.\n\n' +
    '*3. Envía la ubicación (obligatoria)*\nToca el clip, elige *Ubicación* y luego *Enviar tu ubicación actual*. Si no estás en el lugar, mueve el mapa hasta el punto exacto. El lugar debe estar dentro de la comuna de Buin.\n\n' +
    '*4. Guarda tu código*\nTe enviaremos un código como MUN-123456 y un enlace para ver el avance.\n\n' +
    '*Palabras útiles*\n' +
    '- *estado*: ver tus reportes (no necesitas recordar el código)\n' +
    '- *cancelar*: anular un reporte que ya no es necesario\n' +
    '- *mis datos*: ver qué datos tenemos de ti\n' +
    '- *eliminar mis datos*: pedir que borremos tus datos\n' +
    '- *menú*: volver al inicio\n\n' +
    `${TEXTO_EMERGENCIAS}\n\nPolítica de privacidad: ${PANEL_URL}/privacidad`
  );
}

async function enviarAvisoPrivacidad(to) {
  await enviarTexto(to,
    '*Aviso de privacidad* | Municipalidad de Buin\n\n' +
    'Usaremos tu número de teléfono y lo que nos envíes (mensajes, fotos y ubicación) solo para atender tus reportes y avisarte su avance. ' +
    'Lo hacemos en cumplimiento de las funciones municipales. No usamos tus datos para otros fines ni los vendemos.\n\n' +
    'Puedes escribir *mis datos* para ver lo que tenemos, o *eliminar mis datos* para pedir su eliminación.\n\n' +
    `Más información: ${PANEL_URL}/privacidad`
  );
}

// ============================================================================
// AUXILIARES DE ARCHIVOS Y EVENTOS
// ============================================================================
async function obtenerMediaWhatsApp(mediaId) {
  try {
    const resUrl = await fetch(`https://graph.facebook.com/v18.0/${mediaId}`, { headers: { 'Authorization': `Bearer ${process.env.META_ACCESS_TOKEN}` } });
    const dataUrl = await resUrl.json();
    if (!dataUrl.url) return null;
    const resData = await fetch(dataUrl.url, { headers: { 'Authorization': `Bearer ${process.env.META_ACCESS_TOKEN}` } });
    return Buffer.from(await resData.arrayBuffer()).toString('base64');
  } catch (error) { return null; }
}

async function subirImagenS3(imagenBase64, ciudadanoId, codigoTicket) {
  try {
    const fileName = `evidencias/usuario_${ciudadanoId}/${codigoTicket}_${Date.now()}.jpg`;
    await s3Client.send(new PutObjectCommand({
      Bucket: process.env.AWS_S3_BUCKET_NAME, Key: fileName, Body: Buffer.from(imagenBase64, 'base64'), ContentType: 'image/jpeg'
    }));
    return `https://${process.env.AWS_S3_BUCKET_NAME}.s3.${process.env.AWS_REGION || 'us-east-2'}.amazonaws.com/${fileName}`;
  } catch (error) {
    console.error('X Error subiendo evidencia a S3:', error);
    return null;
  }
}

async function borrarDeS3(url) {
  const clave = String(url).split('.amazonaws.com/')[1];
  if (!clave) return;
  try { await s3Client.send(new DeleteObjectCommand({ Bucket: process.env.AWS_S3_BUCKET_NAME, Key: decodeURIComponent(clave) })); }
  catch (e) { console.error('X No se pudo borrar de S3:', clave, e.message); }
}

// Notificación push al funcionario (mismas claves VAPID que la Lambda)
let webpush = null;
async function notificarFuncionario(operadorId, aviso) {
  if (!operadorId || !process.env.VAPID_PUBLICA || !process.env.VAPID_PRIVADA) return;
  if (!webpush) {
    webpush = require('web-push');
    webpush.setVapidDetails(process.env.VAPID_CONTACTO || 'mailto:munivox@buin.cl', process.env.VAPID_PUBLICA, process.env.VAPID_PRIVADA);
  }
  const suscripciones = await prisma.suscripcionPush.findMany({ where: { operadorId } });
  await Promise.all(suscripciones.map(async sus => {
    try {
      await webpush.sendNotification({ endpoint: sus.endpoint, keys: { p256dh: sus.p256dh, auth: sus.auth } }, JSON.stringify(aviso), { TTL: 86400, timeout: 5000 });
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) await prisma.suscripcionPush.delete({ where: { id: sus.id } }).catch(() => {});
      else console.error('X Notificación push falló:', e.statusCode, e.body || e.message);
    }
  }));
}

async function publicarEvento(canal, datos) {
  const pub = redisConnection.duplicate();
  try { await pub.publish(canal, JSON.stringify(datos)); }
  catch (e) { console.error(`X No se pudo publicar en ${canal}:`, e); }
  finally { await pub.quit(); }
}

async function generarCodigoUnico() {
  for (let i = 0; i < 5; i++) {
    const codigo = `MUN-${Math.floor(100000 + Math.random() * 900000)}`;
    const existe = await prisma.reporte.findUnique({ where: { codigoTicket: codigo }, select: { id: true } });
    if (!existe) return codigo;
  }
  return `MUN-${String(Date.now()).slice(-6)}`;
}

const formatoTelefono = (t) => {
  const d = String(t || '').replace(/\D/g, '');
  return d.length === 11 && d.startsWith('569') ? `+56 9 ${d.slice(3, 7)} ${d.slice(7)}` : t;
};

// ============================================================================
// CONSULTA DE REPORTES (sin IA)
// ============================================================================
async function enviarListaReportes(to, ciudadano) {
  const reportes = await prisma.reporte.findMany({
    where: { ciudadanoId: ciudadano.id, estado: { not: 'BOCETO' } },
    include: { categoria: true },
    orderBy: { createdAt: 'desc' },
    take: 10
  });
  if (reportes.length === 0) {
    await enviarBotones(to, 'Todavía no tienes reportes registrados desde este número.\n\n¿Quieres reportar un problema ahora?',
      [{ id: 'menu:reportar', titulo: 'Reportar problema' }, { id: 'menu:ayuda', titulo: 'Ayuda' }],
      'Todavía no tienes reportes registrados desde este número. Escribe el problema que quieres reportar.');
    return;
  }
  const respaldo = '*Tus reportes*\n\n' + reportes.map(r => `*${r.codigoTicket}* | ${r.categoria?.nombre || 'Reporte'}\n${ESTADO_LEGIBLE[r.estado]} | ${fechaCorta(r.createdAt)}`).join('\n\n') +
    '\n\nEscribe el código de un reporte para ver su detalle.';
  await enviarLista(to, {
    texto: 'Estos son los reportes enviados desde este número. *No necesitas recordar el código*: toca uno para ver cómo va.',
    boton: 'Ver mis reportes',
    secciones: [{
      title: 'Tus reportes',
      rows: reportes.map(r => ({
        id: `ver:${r.codigoTicket}`,
        title: r.codigoTicket,
        description: `${(r.categoria?.nombre || 'Reporte').slice(0, 26)} | ${ESTADO_LEGIBLE[r.estado]}`.slice(0, 72)
      }))
    }]
  }, respaldo);
}

async function enviarDetalleReporte(to, ciudadano, codigo) {
  const r = await prisma.reporte.findFirst({
    where: { codigoTicket: codigo.toUpperCase(), ciudadanoId: ciudadano.id, estado: { not: 'BOCETO' } },
    include: { categoria: true, departamento: true, historial: { orderBy: { createdAt: 'asc' } } }
  });
  if (!r) {
    await enviarTexto(to, `No encontramos el reporte *${codigo.toUpperCase()}* en este número. Escribe *estado* para ver la lista de tus reportes.`);
    return;
  }
  const pasos = r.historial
    .filter(h => !/^(\[Nota interna\]|\[Mensaje al vecino\]|Calificación|Rechazado por funcionario)/.test(String(h.comentario || '')))
    .slice(-5)
    .map(h => `- ${fechaCorta(h.createdAt)}: ${String(h.comentario || '').startsWith('En camino') ? 'Un funcionario va en camino' : ESTADO_LEGIBLE[h.estadoNuevo] || h.estadoNuevo}`)
    .join('\n');
  const token = await asegurarToken(r);
  await enviarTexto(to,
    `*Reporte ${r.codigoTicket}*\n` +
    `Tipo: ${r.categoria?.nombre || 'En clasificación'}\n` +
    `Área responsable: ${r.departamento?.nombre || 'Por definir'}\n` +
    `Enviado: ${fechaCorta(r.createdAt)}\n\n` +
    `Estado: *${ESTADO_LEGIBLE[r.estado]}*` +
    (pasos ? `\n\n*Avance*\n${pasos}` : '') +
    `\n\nVer el avance en tu celular: ${enlaceSeguimiento(token)}`
  );
}

// ============================================================================
// CANCELACIÓN POR EL VECINO
// ============================================================================
async function iniciarCancelacion(to, ciudadano) {
  const activos = await prisma.reporte.findMany({
    where: { ciudadanoId: ciudadano.id, estado: { in: ['BOCETO', 'PENDIENTE', 'EN_REVISION'] } },
    include: { categoria: true }, orderBy: { createdAt: 'desc' }, take: 10
  });
  if (!activos.length) {
    await enviarTexto(to, 'No tienes reportes que se puedan cancelar. Si un funcionario ya tomó tu caso, ya no se puede cancelar por este medio.');
    return;
  }
  await enviarLista(to, {
    texto: '¿Qué reporte quieres cancelar? Cancela solo si el problema ya se solucionó o lo enviaste por error.',
    boton: 'Elegir reporte',
    secciones: [{ title: 'Reportes activos', rows: activos.map(r => ({
      id: `cancelar:${r.id}`,
      title: r.estado === 'BOCETO' ? 'Borrador' : r.codigoTicket,
      description: `${(r.categoria?.nombre || 'Reporte')} | ${fechaCorta(r.createdAt)}`.slice(0, 72)
    })) }]
  }, 'Escribe el código del reporte que quieres cancelar, por ejemplo: cancelar MUN-123456');
}

async function confirmarCancelacion(to, ciudadano, reporteId) {
  const r = await prisma.reporte.findFirst({ where: { id: reporteId, ciudadanoId: ciudadano.id } });
  if (!r) return;
  await enviarBotones(to, `¿Seguro que quieres cancelar el reporte *${r.estado === 'BOCETO' ? 'en borrador' : r.codigoTicket}*?`,
    [{ id: `cancelarsi:${r.id}`, titulo: 'Sí, cancelar' }, { id: 'cancelarno', titulo: 'No, mantener' }]);
}

async function ejecutarCancelacion(to, ciudadano, reporteId) {
  const r = await prisma.reporte.findFirst({ where: { id: reporteId, ciudadanoId: ciudadano.id } });
  if (!r) return;
  if (r.estado === 'BOCETO') {
    await prisma.reporte.delete({ where: { id: r.id } });
    await enviarTexto(to, 'Listo, eliminamos el borrador. Cuando quieras, puedes reportar otro problema.');
    return;
  }
  if (!['PENDIENTE', 'EN_REVISION'].includes(r.estado)) {
    await enviarTexto(to, `El reporte *${r.codigoTicket}* ya no se puede cancelar porque un funcionario ya lo tomó o fue cerrado (estado: ${ESTADO_LEGIBLE[r.estado]}).`);
    return;
  }
  await prisma.reporte.update({
    where: { id: r.id },
    data: { estado: 'DESCARTADO', operadorAsignadoId: null, historial: { create: { estadoNuevo: 'DESCARTADO', comentario: 'Cancelado por el vecino' } } }
  });
  await publicarEvento('ticket-cambio', { id: r.id, codigoTicket: r.codigoTicket, tipo: 'cancelado', departamentoId: r.departamentoId });
  if (r.operadorAsignadoId) {
    await notificarFuncionario(r.operadorAsignadoId, {
      titulo: 'Reporte cancelado por el vecino',
      cuerpo: `${r.codigoTicket} fue cancelado: el problema ya no requiere atención. No necesitas ir.`,
      url: '/terreno', tag: `tarea-${r.id}`
    }).catch(e => console.error('X Push de cancelación:', e));
  }
  await enviarTexto(to, `Listo, cancelamos el reporte *${r.codigoTicket}*. Gracias por avisarnos.`);
}

// ============================================================================
// DERECHOS SOBRE LOS DATOS PERSONALES
// ============================================================================
async function entregarMisDatos(to, ciudadano) {
  const reportes = await prisma.reporte.findMany({
    where: { ciudadanoId: ciudadano.id, estado: { not: 'BOCETO' } },
    include: { categoria: true, _count: { select: { evidencias: true } } },
    orderBy: { createdAt: 'desc' }
  });
  const fotos = reportes.reduce((a, r) => a + r._count.evidencias, 0);
  const lista = reportes.slice(0, 10).map(r => `- ${r.codigoTicket} (${r.categoria?.nombre || 'Reporte'}), ${fechaCorta(r.createdAt)}`).join('\n');
  await enviarTexto(to,
    '*Tus datos en MuniVox*\n\n' +
    `Teléfono: ${formatoTelefono(ciudadano.telefono)}\n` +
    `Primer contacto: ${fechaCorta(ciudadano.createdAt)}\n` +
    `Reportes: ${reportes.length}\n` +
    `Fotografías guardadas: ${fotos}\n` +
    (lista ? `\n${lista}${reportes.length > 10 ? '\n(y otros más antiguos)' : ''}\n` : '') +
    '\nDe cada reporte guardamos tus mensajes, las fotos y la ubicación que enviaste, y el historial de atención.\n\n' +
    'Si algún dato está incorrecto o quieres que lo eliminemos, escribe *eliminar mis datos* o comunícate con la Municipalidad.\n' +
    `Más información: ${PANEL_URL}/privacidad`
  );
  await prisma.solicitudDatos.create({
    data: { ciudadanoId: ciudadano.id, tipo: 'ACCESO', estado: 'RESUELTA', respuesta: 'Entregado automáticamente por WhatsApp', resueltaEn: new Date() }
  });
}

async function registrarSolicitudSupresion(to, ciudadano) {
  const pendiente = await prisma.solicitudDatos.findFirst({ where: { ciudadanoId: ciudadano.id, tipo: 'SUPRESION', estado: 'PENDIENTE' } });
  const solicitud = pendiente || await prisma.solicitudDatos.create({
    data: { ciudadanoId: ciudadano.id, tipo: 'SUPRESION', detalle: 'Solicitada por el vecino desde WhatsApp' }
  });
  await enviarTexto(to,
    `Recibimos tu solicitud de eliminación de datos (N° ${solicitud.id.slice(0, 8).toUpperCase()}).\n\n` +
    'La Municipalidad la revisará y te responderá por este medio en un plazo máximo de *30 días corridos*. ' +
    'Si tienes reportes en curso, te avisaremos antes de eliminarlos, porque sin tu número no podremos informarte su avance.'
  );
}

// ============================================================================
// CALIFICACIÓN DEL SERVICIO (botones de la Lambda al resolver): calif:<reporteId>:<nota>
// ============================================================================
async function registrarCalificacion(to, ciudadano, idBoton) {
  const [, reporteId, notaTxt] = idBoton.split(':');
  const nota = Number(notaTxt);
  const reporte = await prisma.reporte.findFirst({ where: { id: reporteId, ciudadanoId: ciudadano.id }, include: { historial: true } });
  if (!reporte || ![1, 3, 5].includes(nota)) return;

  if (reporte.historial.some(h => String(h.comentario || '').startsWith('Calificación del ciudadano'))) {
    await enviarTexto(to, `Ya registramos tu evaluación del reporte *${reporte.codigoTicket}*. Gracias.`);
    return;
  }
  const etiqueta = nota === 5 ? 'Bien resuelto' : nota === 3 ? 'Regular' : 'No se resolvió';
  await prisma.historialEstado.create({ data: { reporteId: reporte.id, estadoNuevo: reporte.estado, comentario: `Calificación del ciudadano: ${nota}/5 (${etiqueta})` } });
  await publicarEvento('ticket-cambio', { id: reporte.id, codigoTicket: reporte.codigoTicket, tipo: 'calificacion', nota, departamentoId: reporte.departamentoId });

  await enviarTexto(to, nota === 1
    ? `Lamentamos que el problema siga. La central C4 revisará el reporte *${reporte.codigoTicket}*. Si puedes, envíanos una foto actual del lugar.`
    : 'Gracias por tu evaluación. Tu opinión nos ayuda a mejorar la atención en Buin.');
}

// ============================================================================
// RESPUESTA A UN MENSAJE DE LA MUNICIPALIDAD
// Si un funcionario le escribió al vecino hace menos de 48 h por un caso en curso,
// lo que el vecino responda se agrega a ese caso (no se crea uno nuevo).
// ============================================================================
async function casoEnConversacion(ciudadanoId) {
  const desde = new Date(Date.now() - 48 * 3600000);
  return prisma.reporte.findFirst({
    where: {
      ciudadanoId,
      estado: { in: ['EN_REVISION', 'DESPACHADO'] },
      historial: { some: { comentario: { startsWith: '[Mensaje al vecino]' }, createdAt: { gte: desde } } }
    },
    orderBy: { updatedAt: 'desc' }
  });
}

// ============================================================================
// PASOS DEL BORRADOR: 1) describir  2) foto (opcional, con botones)  3) ubicación
// ============================================================================
const TEXTO_PEDIR_UBICACION =
  'Último paso: necesitamos el *lugar exacto* del problema.\n\n' +
  'Toca el botón *Enviar ubicación* de abajo. Si no estás en el lugar, mueve el mapa hasta el punto correcto antes de enviarlo.';

function tieneRelato(descripcion) {
  return String(descripcion || '')
    .split(/\n?\[Usuario\]:\s*/)
    .some(parte => {
      const t = parte.trim();
      if (!t || /^El usuario seleccion/i.test(t)) return false;
      if (t.startsWith('[Sistema: El usuario acaba de adjuntar una Fotografía]: "')) return true; // foto con texto
      return !t.startsWith('[Sistema:');
    });
}

async function siguientePasoBorrador(numero, reporteId, { respuestaIA, acabaDeEnviarFoto = false } = {}) {
  const r = await prisma.reporte.findUnique({ where: { id: reporteId }, include: { _count: { select: { evidencias: true } }, categoria: true } });
  if (!r || r.estado !== 'BOCETO') return;

  // 1) Falta describir el problema: se pregunta qué pasa y dónde.
  // El texto de la IA solo se usa si es una pregunta y no afirma haber recibido algo (ubicación, registro)
  // que todavía no existe; si el vecino acaba de enviar una foto, el mensaje es fijo.
  if (!tieneRelato(r.descripcionUsuario)) {
    const textoIA = String(respuestaIA?.respuesta_ia || '');
    const iaConfiable = textoIA.includes('?') && !/ubicaci|procesando|registrad|recibimos tu (foto|imagen)/i.test(textoIA);
    const pregunta = acabaDeEnviarFoto
      ? 'Recibimos tu foto, gracias.\n\nPara completar el reporte, cuéntanos brevemente *qué pasa* y *en qué calle o lugar* de Buin está.'
      : iaConfiable ? textoIA : 'Cuéntanos con tus palabras qué problema hay y en qué calle o lugar de Buin está.';
    await enviarTexto(numero, pregunta);
    return;
  }

  // 2) Foto opcional: se pregunta una sola vez, con botones
  const tieneFoto = acabaDeEnviarFoto || r._count.evidencias > 0;
  const yaPreguntada = await redisConnection.get(`foto-preguntada:${r.id}`);
  if (!tieneFoto && !yaPreguntada) {
    await redisConnection.set(`foto-preguntada:${r.id}`, '1', 'EX', 86400);
    await enviarBotones(numero,
      `Entendido${r.categoria?.nombre && r.categoria.nombre !== 'Otro' ? ` (*${r.categoria.nombre}*)` : ''}.\n\n` +
      '¿Puedes enviarnos una *foto* del problema? Es *opcional*, pero ayuda al equipo municipal a llegar preparado.',
      [{ id: `foto:si:${r.id}`, titulo: 'Sí, enviar foto' }, { id: `foto:no:${r.id}`, titulo: 'No, continuar' }],
      '¿Puedes enviarnos una foto del problema? Es opcional. Si no tienes, envía directamente la ubicación.');
    return;
  }

  // 3) Ubicación (obligatoria)
  await pedirUbicacion(numero, `${acabaDeEnviarFoto ? 'Recibimos tu foto, gracias.\n\n' : ''}${TEXTO_PEDIR_UBICACION}`);
}

// ============================================================================
// INTENCIONES QUE NO SON UN REPORTE NUEVO
// ============================================================================
const borradorActivo = (ciudadanoId) =>
  prisma.reporte.findFirst({ where: { ciudadanoId, estado: 'BOCETO' }, orderBy: { createdAt: 'desc' }, include: { _count: { select: { evidencias: true } } } });

// Un borrador "equivocado" es el que se creó con mensajes que no describen ningún problema
function borradorEquivocado(r) {
  const partes = String(r.descripcionUsuario || '').split(/\n?\[Usuario\]:\s*/).map(x => x.trim()).filter(x => x && !x.startsWith('[Sistema:') && !/^El usuario seleccion/i.test(x));
  if (!partes.length) return true;
  return partes.every(x => { const i = detectarIntencion(x); return i.consultar || i.cancelar || i.ayuda || i.negativa; });
}

async function borrarBorrador(r) {
  if (!r) return;
  await prisma.reporte.delete({ where: { id: r.id } }).catch(() => {});
  await redisConnection.del(`foto-preguntada:${r.id}`).catch(() => {});
}

async function manejarConsulta(numero, ciudadano, { cancelar = false } = {}) {
  const b = await borradorActivo(ciudadano.id);
  if (b && (cancelar || borradorEquivocado(b))) await borrarBorrador(b);
  await enviarListaReportes(numero, ciudadano);
}

async function manejarCancelacionBorrador(numero, ciudadano) {
  const b = await borradorActivo(ciudadano.id);
  await borrarBorrador(b);
  await enviarBotones(numero,
    b ? 'Listo, no registramos ese reporte. ¿Qué necesitas hacer?' : 'Entendido, no registramos nada. ¿Qué necesitas hacer?',
    [{ id: 'menu:reportar', titulo: 'Reportar problema' }, { id: 'consultar', titulo: 'Ver mis reportes' }, { id: 'menu:ayuda', titulo: 'Ayuda' }],
    'Entendido, no registramos nada. Escribe *estado* para ver tus reportes o *menú* para volver al inicio.');
}

// Un "no" suelto: depende del paso en que está el vecino
async function manejarNegativa(numero, ciudadano) {
  const b = await borradorActivo(ciudadano.id);
  if (!b) return enviarMenuPrincipal(numero);
  const preguntoFoto = await redisConnection.get(`foto-preguntada:${b.id}`);
  if (preguntoFoto && b._count.evidencias === 0) return pedirUbicacion(numero, TEXTO_PEDIR_UBICACION); // "no tengo foto"
  return enviarBotones(numero, '¿Quieres cancelar el reporte que estabas creando?',
    [{ id: `cancelarsi:${b.id}`, titulo: 'Sí, cancelar' }, { id: `seguir:${b.id}`, titulo: 'No, continuar' }]);
}

// ============================================================================
// WORKER PRINCIPAL
// ============================================================================
const worker = new Worker('whatsapp-messages', async job => {
  const { message, phoneId } = job.data;
  if (!message) return;
  const numero = message.from || phoneId;
  const wamid = message.id;

  if (wamid) {
    const yaProcesado = await redisConnection.get(`wamid:${wamid}`);
    if (yaProcesado) return;
    await redisConnection.set(`wamid:${wamid}`, '1', 'EX', 3600);
  }
  marcarComoLeido(wamid);

  const ciudadano = await prisma.ciudadano.upsert({ where: { telefono: numero }, update: {}, create: { telefono: numero } });

  if (ciudadano.baneado) {
    const avisado = await redisConnection.set(`baneado-aviso:${numero}`, '1', 'EX', 86400, 'NX');
    if (avisado) await enviarTexto(numero, 'Este número fue bloqueado por uso indebido del canal. Si crees que es un error, comunícate con la Municipalidad de Buin.');
    return;
  }

  // Deber de información: el aviso de privacidad se envía una vez, en el primer contacto
  if (!ciudadano.avisoPrivacidadEn) {
    await enviarAvisoPrivacidad(numero);
    await prisma.ciudadano.update({ where: { id: ciudadano.id }, data: { avisoPrivacidadEn: new Date() } });
  }

  const textoPlano = message.type === 'text' ? (message.text?.body || '').trim() : '';
  const t = normalizar(textoPlano).replace(/[¡!¿?.,;:]+/g, ' ').replace(/\s+/g, ' ').trim();
  const corto = textoPlano.length <= 60;
  const idInteractivo = message.interactive?.list_reply?.id || message.interactive?.button_reply?.id || '';

  // ---------------- 1. Botones y listas ----------------
  if (idInteractivo === 'menu:reportar') return enviarCategorias(numero);
  if (idInteractivo === 'menu:ayuda') return enviarAyuda(numero);
  if (idInteractivo === 'consultar') return enviarListaReportes(numero, ciudadano);
  if (idInteractivo.startsWith('ver:')) return enviarDetalleReporte(numero, ciudadano, idInteractivo.slice(4));
  if (idInteractivo.startsWith('cancelar:')) return confirmarCancelacion(numero, ciudadano, idInteractivo.slice(9));
  if (idInteractivo.startsWith('cancelarsi:')) return ejecutarCancelacion(numero, ciudadano, idInteractivo.slice(11));
  if (idInteractivo === 'cancelarno') return enviarTexto(numero, 'Perfecto, el reporte sigue activo.');
  if (idInteractivo.startsWith('calif:')) return registrarCalificacion(numero, ciudadano, idInteractivo);
  if (idInteractivo === 'datos:eliminar:si') return registrarSolicitudSupresion(numero, ciudadano);
  if (idInteractivo === 'datos:eliminar:no') return enviarTexto(numero, 'Perfecto, no haremos cambios en tus datos.');
  if (idInteractivo.startsWith('foto:si:')) {
    return enviarTexto(numero, 'Perfecto. Toca el ícono de la *cámara* o del *clip*, saca la foto del problema y envíala en este chat.\n\nTrata de que no aparezcan personas ni patentes de vehículos.');
  }
  if (idInteractivo.startsWith('foto:no:')) return pedirUbicacion(numero, TEXTO_PEDIR_UBICACION);
  if (idInteractivo.startsWith('seguir:')) return siguientePasoBorrador(numero, idInteractivo.slice(7));

  // ---------------- 2. Palabras clave (sin IA) ----------------
  if (message.type === 'text' && corto) {
    const SALUDO = '(hola+|holi+|ola|alo|hey|buenas|buen[oa]s? (dias|tardes|noches)|menu|inicio|empezar|start|volver)';
    if (new RegExp(`^${SALUDO}( ${SALUDO})?( (que tal|como esta|como estas))?$`).test(t)) {
      return enviarMenuPrincipal(numero);
    }
    if (/^(ayuda|como funciona|instrucciones|no entiendo|como (lo )?hago|que hago)$/.test(t)) return enviarAyuda(numero);
    if (/^(eliminar|borrar|suprimir) (mis )?datos/.test(t)) {
      return enviarBotones(numero,
        '¿Quieres que la Municipalidad elimine tus datos (número, mensajes, fotos y ubicaciones)?\n\nSi tienes reportes en curso, ya no podremos avisarte su avance.',
        [{ id: 'datos:eliminar:si', titulo: 'Sí, solicitar' }, { id: 'datos:eliminar:no', titulo: 'No' }]);
    }
    if (/^(mis datos|ver mis datos|que datos tienen|mis datos personales)$/.test(t)) return entregarMisDatos(numero, ciudadano);
    const codigoCancelar = t.match(/^cancelar mun ?(\d{6})$/);
    if (codigoCancelar) {
      const r = await prisma.reporte.findFirst({ where: { codigoTicket: `MUN-${codigoCancelar[1]}`, ciudadanoId: ciudadano.id } });
      return r ? confirmarCancelacion(numero, ciudadano, r.id) : enviarTexto(numero, 'No encontramos ese reporte en este número.');
    }
    if (/^(cancelar|anular)( (mi|el) (reporte|reclamo))?$/.test(t)) return iniciarCancelacion(numero, ciudadano);
  }

  // Consulta por código: el vecino no necesita recordar el código, pero si lo escribe se muestra
  const codigoEnTexto = textoPlano.match(/\bMUN\s?-?\s?(\d{6})\b/i);
  if (codigoEnTexto && textoPlano.length <= 60) return enviarDetalleReporte(numero, ciudadano, `MUN-${codigoEnTexto[1]}`);

  // Intención sin IA: consultas, arrepentimientos y "no" sueltos nunca crean ni alargan un reporte
  if (message.type === 'text' && textoPlano.length <= 300) {
    const intencion = detectarIntencion(textoPlano);
    if (intencion.consultar) return manejarConsulta(numero, ciudadano, { cancelar: intencion.cancelar });
    // Si el personal le escribió hace poco, un "no" o "no entiendo" es la respuesta a ese mensaje (sigue abajo)
    const respondeAlPersonal = (intencion.negativa || intencion.ayuda) && await casoEnConversacion(ciudadano.id);
    if (!respondeAlPersonal) {
      if (intencion.cancelar) return manejarCancelacionBorrador(numero, ciudadano);
      if (intencion.negativa) return manejarNegativa(numero, ciudadano);
      if (intencion.ayuda) return enviarAyuda(numero);
    }
  }

  // ---------------- 3. Respuesta a un mensaje de la Municipalidad ----------------
  const enConversacion = ['text', 'image', 'location'].includes(message.type) ? await casoEnConversacion(ciudadano.id) : null;
  if (enConversacion) {
    let agregado = textoPlano;
    if (message.type === 'image') {
      const img = await obtenerMediaWhatsApp(message.image.id);
      const url = img ? await subirImagenS3(img, ciudadano.id, enConversacion.codigoTicket) : null;
      if (url) await prisma.evidencia.create({ data: { url, tipo: 'IMAGEN', reporteId: enConversacion.id } });
      agregado = `[Sistema: El usuario acaba de adjuntar una Fotografía]${message.image?.caption ? `: "${message.image.caption}"` : ''}`;
    }
    if (message.type === 'location') {
      const { dentro } = verificarUbicacion(message.location.latitude, message.location.longitude);
      if (!dentro) return enviarTexto(numero, 'Esa ubicación está fuera de la comuna de Buin, así que no la agregamos al reporte. Envía la ubicación exacta del problema dentro de Buin.');
      await prisma.reporte.update({ where: { id: enConversacion.id }, data: { latitud: message.location.latitude, longitud: message.location.longitude } });
      agregado = '[Sistema: El usuario acaba de enviar su Ubicación GPS]';
    }
    await prisma.reporte.update({
      where: { id: enConversacion.id },
      data: {
        descripcionUsuario: `${enConversacion.descripcionUsuario || ''}\n[Usuario]: ${agregado}`,
        historial: { create: { estadoNuevo: enConversacion.estado, comentario: '[Nota interna] El vecino respondió por WhatsApp' } }
      }
    });
    await publicarEvento('ticket-cambio', { id: enConversacion.id, codigoTicket: enConversacion.codigoTicket, tipo: 'respuesta-vecino', departamentoId: enConversacion.departamentoId });
    return enviarTexto(numero, `Gracias. Agregamos tu respuesta al reporte *${enConversacion.codigoTicket}* y se la hicimos llegar al equipo municipal.`);
  }

  if (['audio', 'video', 'sticker', 'document', 'contacts', 'reaction'].includes(message.type)) {
    return enviarTexto(numero, 'Por ahora solo podemos recibir *texto*, *fotos* y *ubicación*. Por favor escribe el problema con tus palabras. Si necesitas ayuda, escribe *ayuda*.');
  }

  await new Promise(resolve => setTimeout(resolve, ESPERA_CONSOLIDACION_MS));

  try {
    let textoConsolidado = '';
    let imagenBase64 = null;
    let envioImagenActual = false;
    let envioUbicacionActual = false;

    // ---------------- 4. Tipo de mensaje ----------------
    if (message.type === 'location' || (message.type === 'interactive' && message.interactive?.type === 'location_update')) {
      const loc = message.location || message.interactive?.location_update;
      const { dentro, distanciaM } = verificarUbicacion(Number(loc?.latitude), Number(loc?.longitude));

      // Verificación del límite comunal: fuera de Buin no se acepta
      if (!dentro) {
        console.log(`> Ubicación fuera de Buin (${Math.round(distanciaM)} m del límite)`);
        await pedirUbicacion(numero,
          'La ubicación que enviaste está *fuera de la comuna de Buin*, así que lamentablemente no podemos registrar el reporte en ese lugar.\n\n' +
          'Si el problema sí está en Buin, envía de nuevo la ubicación *del lugar del problema* (no la de tu casa, si es distinta). ' +
          'Si está en otra comuna, comunícate con esa municipalidad.');
        return;
      }

      envioUbicacionActual = true;
      textoConsolidado = '[Sistema: El usuario acaba de enviar su Ubicación GPS]';
      // Solo el borrador en curso recibe la ubicación: nunca se mueve un reporte ya confirmado
      const ultimoReporte = await prisma.reporte.findFirst({
        where: { ciudadanoId: ciudadano.id, estado: 'BOCETO' },
        orderBy: { createdAt: 'desc' }
      });
      if (!ultimoReporte) {
        await enviarBotones(numero,
          'Recibimos tu ubicación, pero no tienes un reporte en curso.\n\nPara reportar un problema, primero cuéntanos *qué pasa*; después te pediremos la ubicación.',
          [{ id: 'menu:reportar', titulo: 'Reportar problema' }, { id: 'consultar', titulo: 'Ver mis reportes' }],
          'Recibimos tu ubicación, pero no tienes un reporte en curso. Para reportar un problema, primero escribe qué pasa.');
        return;
      }
      if (loc) {
        await prisma.reporte.update({ where: { id: ultimoReporte.id }, data: { latitud: loc.latitude, longitud: loc.longitude } });
      }
    }
    else if (message.type === 'image') {
      envioImagenActual = true;
      const caption = message.image?.caption ? `: "${message.image.caption}"` : '';
      textoConsolidado = `[Sistema: El usuario acaba de adjuntar una Fotografía]${caption}`;
      imagenBase64 = await obtenerMediaWhatsApp(message.image.id);
    }
    else if (message.type === 'interactive' && message.interactive?.type === 'list_reply') {
      const fila = MENU_CATEGORIAS.find(c => c.id === idInteractivo);
      textoConsolidado = fila
        ? `El usuario seleccionó la categoría: ${fila.titulo}. Aún no describe el problema.`
        : `El usuario seleccionó la opción: ${message.interactive.list_reply.title}`;
    }
    else if (message.type === 'text') {
      const n = Number(textoPlano);
      textoConsolidado = Number.isInteger(n) && n >= 1 && n <= MENU_CATEGORIAS.length && textoPlano.length <= 2
        ? `El usuario seleccionó la categoría: ${MENU_CATEGORIAS[n - 1].titulo}. Aún no describe el problema.`
        : textoPlano;
    }

    if (!textoConsolidado) return;

    const historialReportes = await prisma.reporte.findMany({ where: { ciudadanoId: ciudadano.id }, orderBy: { createdAt: 'desc' }, take: 2 });

    let contexto_previo = 'No hay historial previo.';
    if (historialReportes.length > 0) {
      contexto_previo = '--- HISTORIAL RECIENTE ---\n';
      historialReportes.forEach((r) => {
        const desc = r.descripcionUsuario || '';
        const tieneGPS = r.latitud ? 'SÍ' : 'NO';
        const tieneFoto = desc.includes('[Sistema: El usuario acaba de adjuntar una Fotografía]') ? 'SÍ' : 'NO';
        contexto_previo += `Ticket: ${r.codigoTicket} | Estado: ${r.estado} | TieneGPS: ${tieneGPS} | TieneFoto: ${tieneFoto} | Desc: ${desc}\n\n`;
      });
    }

    const prompt = `
    Eres MuniVox, el asistente oficial de la central C4 de la Municipalidad de Buin (Chile). Hablas como un funcionario municipal: cordial, claro y breve.

    ESTILO DE RESPUESTA:
    - Español de Chile, trato de "tú", tono respetuoso y cercano. Escribe para personas de todas las edades: palabras simples, sin tecnicismos.
    - Máximo 3 oraciones cortas. Sin emojis. Puedes usar *negritas* de WhatsApp para destacar una palabra.
    - Si falta información, pide UNA sola cosa a la vez y explica cómo hacerlo (por ejemplo: "toca el clip y elige Ubicación").

    ${contexto_previo}
    ¿Envió foto AHORA?: ${envioImagenActual ? 'SÍ' : 'NO'}
    ¿Envió mapa GPS AHORA?: ${envioUbicacionActual ? 'SÍ (el sistema ya verificó que está dentro de Buin)' : 'NO'}

    LO QUE PUEDE HACER ESTE CANAL (nunca digas que no se puede):
    - Reportar problemas de la vía pública en Buin (tu tarea principal).
    - Ver los reportes enviados y su estado: el vecino escribe *estado* (no necesita el código).
    - Cancelar un reporte: escribe *cancelar*. Ver sus datos: *mis datos*. Volver al inicio: *menú*. Ayuda: *ayuda*.

    PRIMERO CLASIFICA LA INTENCIÓN ("intencion"):
    - REPORTAR_PROBLEMA: describe un problema, responde preguntas sobre su reporte en curso o elige una categoría.
    - CONSULTAR_REPORTES: quiere ver, revisar o saber de reportes que ya envió.
    - CANCELAR: dice que no quería reportar, se equivocó o quiere anular lo que estaba creando.
    - AYUDA: no sabe cómo usar el canal o pregunta qué puede hacer.
    - CONVERSACION: saluda, agradece o escribe algo que no es un reporte ni una consulta.
    Si la intención NO es REPORTAR_PROBLEMA, no crees ni continúes un ticket: usa "accion_siguiente": "SIN_ACCION".
    Si dudas entre reportar y consultar, elige CONSULTAR_REPORTES: es mejor mostrarle sus reportes que crear uno por error.

    REGLAS:
    1. NUEVO TICKET: Si el usuario reporta un problema DIFERENTE al del historial, usa "CREAR_TICKET". Nunca agrupes problemas distintos.
    2. CONTINUACIÓN: Usa "CONTINUAR_TICKET" solo si el usuario completa o responde sobre el ticket BOCETO o PENDIENTE actual.
    3. EVIDENCIA: Si el usuario adjuntó una foto ahora, compárala con el reporte. Si no corresponde, usa "EVIDENCIA_INVALIDA".
    4. FOTO Y UBICACIÓN: NO las pidas en "respuesta_ia": el sistema las pide automáticamente con botones. Si falta saber QUÉ pasa o DÓNDE (calle o referencia), pregúntalo.
    5. UBICACIÓN: Si el ticket actual dice "TieneGPS: NO" y no la envió ahora, activa "requiere_ubicacion": true.
    6. RECIBIDO: Agradece SOLO lo que llegó en este mensaje: si es una foto, agradece la foto; si es la ubicación, la ubicación. NUNCA digas que recibiste la ubicación si el mensaje no dice "[Sistema: El usuario acaba de enviar su Ubicación GPS]". No digas que el reporte está registrado o "en proceso": eso lo confirma el sistema con el código. No pidas de nuevo lo que ya entregó.
    7. SOLO CATEGORÍA: Si el usuario solo eligió una categoría del menú y aún no describe el problema, pídele que lo describa brevemente (qué pasa y dónde). Usa "CREAR_TICKET".
    8. FUERA DE BUIN: Si el usuario menciona que el problema está en otra comuna, explícale con amabilidad que solo atendemos la comuna de Buin. Usa "RECHAZO_ADMINISTRATIVO".
    9. PROTOCOLO ABC (RIESGO VITAL): NO atiendas emergencias médicas, incendios ni robos en curso. Usa "DERIVACION_ABC".
    10. Si el mensaje no tiene relación con la municipalidad o es abusivo, usa "RECHAZO_ADMINISTRATIVO" y responde con cortesía.
    11. PRIORIDAD: CRITICA solo si hay riesgo inminente para personas (cables cortados, socavón en calzada transitada, semáforo apagado en cruce principal). ALTA si afecta la circulación o la salud. MEDIA para la mayoría. BAJA para molestias menores.
    12. CLASIFICACIÓN: Elige SIEMPRE la categoría y el departamento más adecuados, usando EXACTAMENTE los nombres de las listas del formato JSON. Guía: baches y calzadas -> Obras Municipales; basura, escombros y microbasurales -> Aseo y Ornato; luminarias -> Obras Municipales; autos abandonados y señales de tránsito -> Tránsito; ruidos, fiestas y animales sueltos -> Seguridad Pública; plazas y árboles -> Aseo y Ornato. No uses Seguridad Pública por defecto.
    13. DATOS PERSONALES: En "analisisIA" no copies nombres, RUT, teléfonos ni datos de salud de personas; describe solo el problema y el lugar.

    FORMATO JSON:
    {
      "intencion": "REPORTAR_PROBLEMA, CONSULTAR_REPORTES, CANCELAR, AYUDA o CONVERSACION",
      "respuesta_ia": "Mensaje para el usuario",
      "accion_siguiente": "CREAR_TICKET, CONTINUAR_TICKET, DERIVACION_ABC, RECHAZO_ADMINISTRATIVO, EVIDENCIA_INVALIDA o SIN_ACCION",
      "banear_usuario": false,
      "es_continuacion": boolean,
      "ticket_asociado": "Código de ticket o null",
      "requiere_ubicacion": boolean,
      "analisisIA": "Resumen técnico para el operador municipal (qué ocurre, dónde, riesgo)",
      "certezaIA": 0.9,
      "prioridadIA": "CRITICA, ALTA, MEDIA o BAJA",
      "categoriaNombre": "UNA de: ${Object.keys(CATEGORIAS).join(' | ')}",
      "departamentoNombre": "UNO de: ${Object.keys(DEPARTAMENTOS_ID).join(' | ')}"
    }

    Mensaje: "${textoConsolidado}"
    `;

    const model = genAI.getGenerativeModel({ model: MODELO_GEMINI, generationConfig: { responseMimeType: 'application/json' } });
    const parts = [{ text: prompt }];
    if (imagenBase64) {
      parts.push({ text: 'EVALÚA SI ESTA IMAGEN COINCIDE CON EL REPORTE.' });
      parts.push({ inlineData: { data: imagenBase64, mimeType: 'image/jpeg' } });
    }

    const aiResult = await model.generateContent({ contents: [{ role: 'user', parts }] });
    const respuestaIA = JSON.parse(aiResult.response.text());
    console.log(`> Respuesta IA: Intención=${respuestaIA.intencion} | Acción=${respuestaIA.accion_siguiente} | RequiereGPS=${respuestaIA.requiere_ubicacion}`);

    // Segunda barrera: la IA detectó que el mensaje no es un reporte (solo para texto; fotos y ubicación son parte del reporte)
    const esTexto = !envioImagenActual && !envioUbicacionActual && message.type === 'text';
    const intencionIA = String(respuestaIA.intencion || '').toUpperCase();
    if (esTexto && (['CONSULTAR_REPORTES', 'CANCELAR', 'AYUDA', 'CONVERSACION'].includes(intencionIA) || respuestaIA.accion_siguiente === 'SIN_ACCION')) {
      console.warn(`> Mensaje no tratado como reporte (${intencionIA || 'SIN_ACCION'}): "${textoConsolidado.slice(0, 80)}"`);
      if (intencionIA === 'CONSULTAR_REPORTES') return manejarConsulta(numero, ciudadano);
      if (intencionIA === 'CANCELAR') return manejarCancelacionBorrador(numero, ciudadano);
      if (intencionIA === 'AYUDA') return enviarAyuda(numero);
      // Conversación: respuesta breve y, si tiene un reporte a medias, se le recuerda el paso pendiente
      if (respuestaIA.respuesta_ia) await enviarTexto(numero, respuestaIA.respuesta_ia);
      const b = await borradorActivo(ciudadano.id);
      if (b && !borradorEquivocado(b)) await siguientePasoBorrador(numero, b.id);
      return;
    }

    const accionesSinTicket = ['DERIVACION_ABC', 'RECHAZO_ADMINISTRATIVO', 'EVIDENCIA_INVALIDA', 'BLOQUEO_DEFINITIVO'];
    if (accionesSinTicket.includes(respuestaIA.accion_siguiente)) {
      if (respuestaIA.banear_usuario) await prisma.ciudadano.update({ where: { id: ciudadano.id }, data: { baneado: true } });
      let texto = respuestaIA.respuesta_ia;
      if (respuestaIA.accion_siguiente === 'DERIVACION_ABC') {
        texto += '\n\n*Si hay riesgo para la vida, llama de inmediato:*\n131 SAMU (ambulancia)\n132 Bomberos\n133 Carabineros';
      }
      // Foto rechazada pero con texto: la descripción se conserva en el borrador para no volver a pedirla
      if (respuestaIA.accion_siguiente === 'EVIDENCIA_INVALIDA' && envioImagenActual && message.image?.caption?.trim()) {
        const borrador = await borradorActivo(ciudadano.id);
        if (borrador) {
          await prisma.reporte.update({
            where: { id: borrador.id },
            data: { descripcionUsuario: `${borrador.descripcionUsuario || ''}\n[Usuario]: ${message.image.caption.trim()}` }
          });
          texto += '\n\nGuardamos tu descripción. Puedes enviar otra foto del problema o tocar el clip y elegir *Ubicación* para continuar.';
        }
      }
      await enviarTexto(numero, texto);
      return;
    }

    // ---------------- 5. Continuación y confirmación del borrador ----------------
    if (respuestaIA.es_continuacion || envioUbicacionActual || envioImagenActual) {
      // 1) El borrador en curso. 2) Si no hay, un reporte ya confirmado solo si la IA dice que el mensaje
      // lo continúa y se confirmó hace menos de 30 minutos (por ejemplo, otra foto justo después).
      // Así una foto nueva nunca se pega a un reporte antiguo: si no calza, se crea un reporte nuevo.
      let ticketRelacionado = await prisma.reporte.findFirst({ where: { ciudadanoId: ciudadano.id, estado: 'BOCETO' }, orderBy: { createdAt: 'desc' } });
      if (!ticketRelacionado && respuestaIA.es_continuacion) {
        const asociado = historialReportes.find(r => r.codigoTicket === respuestaIA.ticket_asociado && r.estado === 'PENDIENTE');
        if (asociado && Date.now() - new Date(asociado.createdAt).getTime() < 30 * 60000) ticketRelacionado = asociado;
      }

      if (ticketRelacionado) {
        if (ticketRelacionado.latitud !== null || envioUbicacionActual) respuestaIA.requiere_ubicacion = false;

        if (imagenBase64) {
          const urlS3 = await subirImagenS3(imagenBase64, ciudadano.id, ticketRelacionado.codigoTicket);
          if (urlS3) await prisma.evidencia.create({ data: { url: urlS3, tipo: 'IMAGEN', reporteId: ticketRelacionado.id } });
        }

        const relatoCompleto = `${ticketRelacionado.descripcionUsuario || ''}\n[Usuario]: ${textoConsolidado}`;
        const esFinal = envioUbicacionActual || ticketRelacionado.estado === 'PENDIENTE';
        await prisma.reporte.update({
          where: { id: ticketRelacionado.id },
          data: {
            descripcionUsuario: relatoCompleto,
            ...(respuestaIA.analisisIA && !envioUbicacionActual ? { analisisIA: respuestaIA.analisisIA } : {}),
            ...(!ticketRelacionado.categoriaId || !ticketRelacionado.departamentoId
              ? await resolverClasificacion(respuestaIA, relatoCompleto, esFinal) : {})
          }
        });

        if (ticketRelacionado.estado === 'BOCETO' && envioUbicacionActual) {
          await prisma.reporte.update({ where: { id: ticketRelacionado.id }, data: { estado: 'PENDIENTE' } });
          const confirmado = await prisma.reporte.findUnique({
            where: { id: ticketRelacionado.id },
            include: { ciudadano: true, evidencias: true, categoria: true, departamento: true }
          });
          const token = await asegurarToken(confirmado);
          await publicarEvento('nuevo-ticket', { ...confirmado, ciudadano: undefined });
          await enviarTexto(numero, mensajeConfirmacion(confirmado, token));
          return;
        }

        if (ticketRelacionado.estado === 'BOCETO') {
          await siguientePasoBorrador(numero, ticketRelacionado.id, { respuestaIA, acabaDeEnviarFoto: envioImagenActual });
          return;
        }
        if (respuestaIA.requiere_ubicacion) await pedirUbicacion(numero, respuestaIA.respuesta_ia);
        else await enviarTexto(numero, respuestaIA.respuesta_ia);

        if (ticketRelacionado.estado === 'PENDIENTE') {
          await publicarEvento('ticket-cambio', { id: ticketRelacionado.id, codigoTicket: ticketRelacionado.codigoTicket, tipo: 'mensaje-ciudadano', departamentoId: ticketRelacionado.departamentoId });
        }
        return;
      }
    }

    // ---------------- 6. Nuevo reporte (borrador hasta recibir la ubicación) ----------------
    const codigoTicket = await generarCodigoUnico();
    const estadoInicial = envioUbicacionActual ? 'PENDIENTE' : 'BOCETO';
    const prioridad = String(respuestaIA.prioridadIA || '').toUpperCase();

    const reporte = await prisma.reporte.create({
      data: {
        codigoTicket,
        tokenSeguimiento: nuevoToken(),
        ciudadanoId: ciudadano.id,
        descripcionUsuario: textoConsolidado,
        analisisIA: respuestaIA.analisisIA || 'Sin análisis',
        certezaIA: typeof respuestaIA.certezaIA === 'number' ? respuestaIA.certezaIA : 0.8,
        prioridadIA: ['CRITICA', 'ALTA', 'MEDIA', 'BAJA'].includes(prioridad) ? prioridad : 'MEDIA',
        estado: estadoInicial,
        ...(await resolverClasificacion(respuestaIA, textoConsolidado, estadoInicial === 'PENDIENTE'))
      },
    });

    if (imagenBase64) {
      const urlS3 = await subirImagenS3(imagenBase64, ciudadano.id, codigoTicket);
      if (urlS3) await prisma.evidencia.create({ data: { url: urlS3, tipo: 'IMAGEN', reporteId: reporte.id } });
    }

    if (estadoInicial === 'BOCETO') {
      await cleanupQueue.add('verificar-abandono', { ticketId: reporte.id, telefono: numero }, {
        delay: MINUTOS_ABANDONO * 60000, removeOnComplete: true, removeOnFail: 100
      });
      await siguientePasoBorrador(numero, reporte.id, { respuestaIA, acabaDeEnviarFoto: envioImagenActual });
    } else {
      const completo = await prisma.reporte.findUnique({ where: { id: reporte.id }, include: { evidencias: true, categoria: true, departamento: true } });
      await publicarEvento('nuevo-ticket', completo);
      await enviarTexto(numero, mensajeConfirmacion(completo, completo.tokenSeguimiento));
    }
  } catch (error) {
    console.error('X Error crítico en el Worker:', error);
    await enviarTexto(numero, 'Tuvimos un problema técnico al procesar tu mensaje. Por favor intenta nuevamente en unos minutos.');
  }
}, { connection: redisConnection });

function mensajeConfirmacion(r, token) {
  return (
    `*Reporte registrado*\n\n` +
    `Tu código es: *${r.codigoTicket}*\n` +
    `Tipo: ${r.categoria?.nombre || 'En clasificación'}\n` +
    `Área responsable sugerida: ${r.departamento?.nombre || 'Por definir'}\n\n` +
    `Te avisaremos por este chat cada vez que haya un avance.\n\n` +
    `*Para ver cómo va tu reporte:*\n` +
    `- Toca este enlace: ${enlaceSeguimiento(token)}\n` +
    `- O escribe la palabra *estado* en este chat (no necesitas recordar el código).`
  );
}

// ============================================================================
// WORKER: BORRADORES ABANDONADOS
// ============================================================================
const cleanupWorker = new Worker('verificar-abandono', async (job) => {
  const ticket = await prisma.reporte.findUnique({ where: { id: job.data.ticketId } });
  if (ticket && ticket.estado === 'BOCETO') {
    await prisma.reporte.delete({ where: { id: ticket.id } });
    console.log(`Borrador ${ticket.codigoTicket} eliminado por inactividad (${MINUTOS_ABANDONO} min sin GPS).`);
    if (job.data.telefono) {
      await enviarTexto(job.data.telefono, 'Tu reporte en borrador se eliminó porque no recibimos la ubicación. Si el problema continúa, escríbenos de nuevo y lo registramos. Si necesitas ayuda para enviar la ubicación, escribe *ayuda*.');
    }
  }
}, { connection: redisConnection });

// ============================================================================
// WORKER: CONSERVACIÓN LIMITADA DE DATOS (se activa con RETENCION_MESES)
// Pasado el plazo, en casos cerrados se elimina el relato y las fotos; los vecinos
// sin actividad en ese plazo quedan anónimos. Se conserva el registro estadístico.
// ============================================================================
async function aplicarRetencion() {
  const limite = new Date(Date.now() - RETENCION_MESES * 30 * 86400000);
  const vencidos = await prisma.reporte.findMany({
    where: { estado: { in: ['RESUELTO', 'DESCARTADO'] }, updatedAt: { lt: limite }, NOT: { descripcionUsuario: { startsWith: '[Relato eliminado' } } },
    include: { evidencias: true },
    take: 500
  });
  for (const r of vencidos) {
    for (const e of r.evidencias) await borrarDeS3(e.url);
    await prisma.evidencia.deleteMany({ where: { reporteId: r.id } });
    await prisma.reporte.update({ where: { id: r.id }, data: { descripcionUsuario: '[Relato eliminado por plazo de conservación]' } });
  }
  const inactivos = await prisma.ciudadano.findMany({
    where: {
      NOT: { telefono: { startsWith: 'anonimo-' } },
      updatedAt: { lt: limite },
      reportes: { none: { OR: [{ updatedAt: { gte: limite } }, { estado: { in: ['BOCETO', 'PENDIENTE', 'EN_REVISION', 'DESPACHADO'] } }] } }
    },
    take: 500
  });
  for (const c of inactivos) {
    await prisma.ciudadano.update({ where: { id: c.id }, data: { telefono: `anonimo-${c.id}`, nombre: null } });
  }
  if (vencidos.length || inactivos.length) {
    await prisma.auditoria.create({ data: { accion: 'RETENCION_AUTOMATICA', entidad: 'Sistema', detalle: `${vencidos.length} reportes depurados, ${inactivos.length} vecinos anonimizados (plazo ${RETENCION_MESES} meses)` } });
  }
  console.log(`> Retención: ${vencidos.length} reportes depurados, ${inactivos.length} vecinos anonimizados.`);
}

const mantencionWorker = new Worker('mantencion', async (job) => {
  if (job.name === 'retencion' && RETENCION_MESES > 0) await aplicarRetencion();
}, { connection: redisConnection });

if (RETENCION_MESES > 0) {
  mantencionQueue.add('retencion', {}, { repeat: { pattern: '0 4 * * *', tz: 'America/Santiago' }, jobId: 'retencion-diaria', removeOnComplete: 10, removeOnFail: 10 })
    .then(() => console.log(`> Retención de datos activa: ${RETENCION_MESES} meses`))
    .catch(e => console.error('X No se pudo programar la retención:', e));
}

worker.on('ready', () => console.log('> Worker de IA activo'));
worker.on('failed', (job, err) => console.error(`X Job ${job?.id} falló:`, err));
cleanupWorker.on('ready', () => console.log('> Worker de limpieza activo'));
mantencionWorker.on('ready', () => console.log('> Worker de mantención activo'));
