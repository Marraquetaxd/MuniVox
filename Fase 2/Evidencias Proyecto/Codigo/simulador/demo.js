#!/usr/bin/env node
// ============================================================================
// Datos de demostración: ~6 meses de uso de MuniVox
//
// Genera reportes ficticios repartidos en las 19 unidades vecinales de Buin, ubicados
// sobre calles reales (Mapbox), con fotos libres de Wikimedia Commons subidas a S3,
// estados e historial coherentes con los plazos de cada prioridad, evaluaciones de los
// vecinos, duplicados, rechazos y lugares con problemas repetidos (puntos críticos).
//
//   node demo.js fotos <carpeta>     sube las fotos elegidas (fotos.json de la carpeta) a S3
//   node demo.js generar [opciones]  crea los reportes de demostración
//   node demo.js borrar              borra todo lo creado por este script
//
// Opciones de "generar":
//   --cantidad <n>   reportes (por defecto 350)       --meses <n>  periodo (por defecto 6)
//   --seco           no escribe en la base: muestra un resumen
//   --sin-calles     no ajusta los puntos a las calles (más rápido, para probar)
//
// Todo lo que crea se reconoce y se borra con "borrar":
//   vecinos con teléfono 5690000xxxx, tokens de seguimiento "demo-..." y personal
//   con correo @personal.munivox.demo.
// ============================================================================
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const dotenv = require('dotenv');
dotenv.config({ path: path.join(__dirname, '.env') });
const leerEnv = (a) => { try { return dotenv.parse(fs.readFileSync(a)); } catch { return {}; } };
const DATABASE_URL = process.env.DATABASE_URL || leerEnv(path.join(__dirname, '..', 'munivox-lambda', '.env')).DATABASE_URL;
const MAPBOX_TOKEN = process.env.MAPBOX_TOKEN || leerEnv(path.join(__dirname, '..', 'munivox-dashboard', '.env.local')).NEXT_PUBLIC_MAPBOX_TOKEN;
const BUCKET = process.env.AWS_S3_BUCKET_NAME || 'munivox-evidencias-mvp';
const REGION_S3 = 'us-east-2';
const URL_S3 = `https://${BUCKET}.s3.${REGION_S3}.amazonaws.com`;
const ARCHIVO_FOTOS = path.join(__dirname, 'datos-demo', 'fotos.json');
const PREFIJO_TELEFONO = '5690000';
const DOMINIO_PERSONAL = '@personal.munivox.demo';

const [, , comando = 'ayuda', ...resto] = process.argv;
const opcion = (n, d) => { const i = resto.indexOf(`--${n}`); return i >= 0 && resto[i + 1] && !resto[i + 1].startsWith('--') ? resto[i + 1] : d; };
const bandera = (n) => resto.includes(`--${n}`);

// ---------------------------------------------------------------- azar reproducible
let semilla = Number(opcion('semilla', 20261123));
function azar() { semilla |= 0; semilla = (semilla + 0x6D2B79F5) | 0; let t = Math.imul(semilla ^ (semilla >>> 15), 1 | semilla); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }
const entre = (a, b) => a + azar() * (b - a);
const entero = (a, b) => Math.floor(entre(a, b + 1));
const uno = (lista) => lista[Math.floor(azar() * lista.length)];
const prob = (p) => azar() < p;
function ponderado(pares) { const total = pares.reduce((s, [, p]) => s + p, 0); let r = azar() * total; for (const [v, p] of pares) { if ((r -= p) <= 0) return v; } return pares[pares.length - 1][0]; }
const MIN = 60000, HORA = 3600000, DIA = 86400000;

// ---------------------------------------------------------------- catálogo
const DEPTO = { ASEO: 1, TRANSITO: 2, SEGURIDAD: 3, OBRAS: 4 };
const CATEGORIAS = [
  { nombre: 'Basura / Microbasural', clave: 'basura', depto: DEPTO.ASEO, peso: 25, foto: 0.85, prioridad: [['ALTA', 15], ['MEDIA', 55], ['BAJA', 28], ['CRITICA', 2]] },
  { nombre: 'Bache / Vialidad', clave: 'bache', depto: DEPTO.OBRAS, peso: 20, foto: 0.8, prioridad: [['ALTA', 30], ['MEDIA', 48], ['BAJA', 17], ['CRITICA', 5]] },
  { nombre: 'Alumbrado público', clave: 'alumbrado', depto: DEPTO.OBRAS, peso: 14, foto: 0.25, prioridad: [['ALTA', 28], ['MEDIA', 52], ['BAJA', 18], ['CRITICA', 2]] },
  { nombre: 'Áreas verdes', clave: 'areas_verdes', depto: DEPTO.ASEO, peso: 11, foto: 0.7, prioridad: [['ALTA', 8], ['MEDIA', 47], ['BAJA', 43], ['CRITICA', 2]] },
  { nombre: 'Animales', clave: 'animales', depto: DEPTO.SEGURIDAD, peso: 8, foto: 0.5, prioridad: [['ALTA', 25], ['MEDIA', 50], ['BAJA', 20], ['CRITICA', 5]] },
  { nombre: 'Ruidos molestos', clave: 'ruidos', depto: DEPTO.SEGURIDAD, peso: 8, foto: 0.1, prioridad: [['ALTA', 20], ['MEDIA', 60], ['BAJA', 20]] },
  { nombre: 'Vehículo abandonado', clave: 'vehiculo', depto: DEPTO.TRANSITO, peso: 7, foto: 0.85, prioridad: [['ALTA', 5], ['MEDIA', 45], ['BAJA', 50]] },
  { nombre: 'Señalética / Tránsito', clave: 'senaletica', depto: DEPTO.TRANSITO, peso: 5, foto: 0.7, prioridad: [['ALTA', 35], ['MEDIA', 45], ['BAJA', 10], ['CRITICA', 10]] },
  { nombre: 'Otro', clave: 'otro', depto: null, peso: 2, foto: 0.25, prioridad: [['MEDIA', 50], ['BAJA', 50]] },
];
const SLA_H = { CRITICA: 4, ALTA: 24, MEDIA: 72, BAJA: 168 };

// Unidades vecinales: id, nombre, archivo y peso (más reportes en el sector urbano)
const UVS = [
  [1, 'Buin Centro', 3, 7], [2, 'Buin Poniente', 1, 5], [3, 'Buin Norte', 16, 5], [4, 'Buin Oriente', 12, 4], [5, 'Buin Sur', 9, 5],
  [6, 'Nuevo Buin', 19, 4], [7, 'Maipo', 5, 3], [8, 'Alto Jahuel', 10, 3], [9, 'Linderos', 7, 2.5], [10, 'Viluco', 17, 1.5],
  [11, 'Valdivia de Paine', 18, 1.5], [12, 'Cervera', 15, 1], [13, 'La Estancilla', 14, 1], [14, 'Nuevo Linderos', 2, 1.5],
  [15, 'Flor de Maipo', 13, 1.5], [16, 'Los Guindos', 8, 1], [17, 'El Recurso', 11, 1], [18, 'Rural Norte', 6, 0.7], [19, 'El Cerrillo', 4, 0.7],
].map(([id, nombre, archivo, peso]) => {
  const f = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'munivox-dashboard', 'data', 'unidades-vecinales', `unidad-vecinal-${archivo}.json`), 'utf8'));
  const g = f.geometry || f.features[0].geometry;
  const anillos = g.type === 'Polygon' ? [g.coordinates[0]] : g.coordinates.map(p => p[0]);
  return { id, nombre, peso, anillos };
});

function dentro(lng, lat, anillo) {
  let d = false;
  for (let i = 0, j = anillo.length - 1; i < anillo.length; j = i++) {
    const [xi, yi] = anillo[i], [xj, yj] = anillo[j];
    if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) d = !d;
  }
  return d;
}
const enUV = (uv, p) => uv.anillos.some(a => dentro(p.lng, p.lat, a));
function puntoEnUV(uv) {
  const xs = uv.anillos.flat().map(c => c[0]), ys = uv.anillos.flat().map(c => c[1]);
  for (let i = 0; i < 500; i++) {
    const p = { lng: entre(Math.min(...xs), Math.max(...xs)), lat: entre(Math.min(...ys), Math.max(...ys)) };
    if (enUV(uv, p)) return p;
  }
  return { lng: xs[0], lat: ys[0] };
}
function desplazar(p, m, rumbo) { return { lat: p.lat + (m * Math.cos(rumbo)) / 110540, lng: p.lng + (m * Math.sin(rumbo)) / (111320 * Math.cos(p.lat * Math.PI / 180)) }; }
function distanciaM(a, b) { const kx = 111320 * Math.cos(a.lat * Math.PI / 180); return Math.hypot((b.lng - a.lng) * kx, (b.lat - a.lat) * 110540); }

// Ajusta un punto a la calle más cercana (primer punto de una ruta corta de Mapbox)
let sinCalles = bandera('sin-calles'), avisoMapbox = false;
async function aCalle(p) {
  if (sinCalles || !MAPBOX_TOKEN) return p;
  const q = desplazar(p, 40, azar() * 2 * Math.PI);
  try {
    const url = `https://api.mapbox.com/directions/v5/mapbox/driving/${p.lng},${p.lat};${q.lng},${q.lat}?geometries=geojson&overview=simplified&access_token=${MAPBOX_TOKEN}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const c = r.ok ? (await r.json()).routes?.[0]?.geometry?.coordinates?.[0] : null;
    if (c) return { lng: c[0], lat: c[1] };
  } catch {}
  if (!avisoMapbox) { avisoMapbox = true; console.log('Aviso: no se pudo ajustar algún punto a la calle; se usa el punto original.'); }
  return p;
}
async function ubicar(uv, cerca = null, radio = 0) {
  for (let i = 0; i < 6; i++) {
    const base = cerca ? desplazar(cerca, entre(10, radio), azar() * 2 * Math.PI) : puntoEnUV(uv);
    const c = await aCalle(base);
    const ok = enUV(uv, c) && (!cerca || distanciaM(cerca, c) <= radio + 20) && (!cerca || distanciaM(base, c) < 150);
    if (ok) return c;
  }
  return cerca ? desplazar(cerca, entre(10, radio), azar() * 2 * Math.PI) : puntoEnUV(uv);
}

// ---------------------------------------------------------------- textos
const REFERENCIAS = ['frente al almacén', 'al lado de la plaza', 'en la esquina de mi pasaje', 'cerca del paradero', 'frente al colegio', 'al lado de la cancha',
  'a media cuadra de la feria', 'frente a la sede vecinal', 'en la salida de la villa', 'cerca del consultorio', 'frente al jardín infantil', 'en la vereda del frente',
  'al llegar a la línea del tren', 'detrás de la iglesia', 'frente a la botillería', 'en la entrada del condominio'];
const RELATOS = {
  basura: ['hay un microbasural {ref}, bolsas y escombros tirados hace días', 'botaron un colchón y muebles viejos {ref}', 'se esta juntando basura {ref} y ya hay ratones',
    'están botando escombros de una construcción {ref}', 'llevan una semana dejando bolsas de basura {ref}, ya huele muy mal', 'hay un sillón y neumáticos botados {ref}'],
  bache: ['hay un hoyo enorme en la calle {ref}, casi rompo la rueda', 'bache grande {ref}, con la lluvia no se ve y es peligroso', 'se hundió el pavimento {ref}',
    'hay un forado en la calzada {ref}, los autos lo esquivan por la pista contraria', 'el asfalto está roto {ref} y cada día crece más', 'bache profundo {ref}, ya se cayó un ciclista'],
  alumbrado: ['la luminaria {ref} está apagada hace una semana', 'el poste de luz {ref} parpadea toda la noche', 'quedó todo oscuro {ref}, no funciona el foco',
    'hay dos postes sin luz {ref}, da miedo pasar de noche', 'el foco {ref} se queda prendido de día y apagado de noche'],
  areas_verdes: ['el pasto de la plaza {ref} está muy alto', 'se cayó una rama grande {ref} y tapa la vereda', 'el riego de la plaza {ref} está roto y sale agua todo el día',
    'los juegos de la plaza {ref} están rotos, es peligroso para los niños', 'hay un árbol seco {ref} que se puede caer'],
  animales: ['hay una jauría de perros sueltos {ref} que persigue a la gente', 'hay un perro atropellado {ref}', 'un perro agresivo anda suelto {ref}',
    'caballos sueltos {ref} en plena calle', 'hay perros sueltos {ref} rompiendo las bolsas de basura'],
  ruidos: ['fiesta con música muy fuerte {ref} todos los fines de semana', 'hay ruidos molestos {ref} hasta las 5 de la mañana', 'un taller hace ruido toda la noche {ref}',
    'música a todo volumen {ref}, no se puede dormir'],
  vehiculo: ['hay un auto abandonado {ref} hace meses, sin patente', 'una camioneta quemada {ref} lleva semanas ahí', 'auto desarmado y abandonado {ref}, ya lo usan para botar basura',
    'hay un vehículo sin ruedas {ref} hace tiempo'],
  senaletica: ['el disco pare {ref} está doblado y no se ve', 'se cayó la señal de tránsito {ref}', 'falta el letrero de ceda el paso {ref}', 'el semáforo {ref} está apagado',
    'chocaron el poste de la señal {ref} y quedó en el suelo'],
  otro: ['hay una tapa de alcantarilla suelta {ref}', 'se rompió una cañería y sale agua {ref}', 'hay un cable colgando {ref}', 'pintaron grafitis en el paradero {ref}'],
};
const SALUDOS = ['', '', 'hola, ', 'Hola buenas, ', 'Buenas tardes, ', 'Buenos días, quisiera informar que ', 'Hola, quería reportar que ', 'buenas noches, '];
const CIERRES_TEXTO = ['', '', '', ' gracias', ' por favor', ' porfa vengan pronto', '. Ojalá puedan venir.', ' Muchas gracias.', ' urgente', '!!'];
function relato(cat) {
  let t = uno(SALUDOS) + uno(RELATOS[cat.clave]).replace('{ref}', uno(REFERENCIAS)) + uno(CIERRES_TEXTO);
  if (prob(0.25)) t = t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  else t = t.charAt(0).toUpperCase() + t.slice(1);
  if (prob(0.1)) t = t.replace(/ /g, () => (prob(0.04) ? '' : ' '));
  return t;
}
const ANALISIS = {
  basura: 'Acumulación de residuos domiciliarios y escombros en la vía pública',
  bache: 'Daño en la calzada con riesgo para vehículos y ciclistas',
  alumbrado: 'Luminaria pública apagada o con falla intermitente',
  areas_verdes: 'Área verde con mantención pendiente',
  animales: 'Animales sueltos en la vía pública con posible riesgo para peatones',
  ruidos: 'Ruidos molestos reiterados en horario nocturno',
  vehiculo: 'Vehículo en aparente estado de abandono en la vía pública',
  senaletica: 'Señalética vial dañada o faltante',
  otro: 'Incidencia urbana que requiere revisión municipal',
};
const INFORMES = {
  basura: ['Se retiraron los residuos y escombros del lugar.', 'Cuadrilla retiró la basura y se limpió el sector.', 'Se limpió el microbasural y se dejó aviso a los vecinos.'],
  bache: ['Se tapó el bache con asfalto en frío.', 'Se reparó la calzada y se señalizó mientras fragua.', 'Bache reparado por la cuadrilla de Obras.'],
  alumbrado: ['Se cambió la ampolleta de la luminaria.', 'Se reparó la conexión del poste; la luminaria funciona.', 'Se reemplazó el foco por uno LED.'],
  areas_verdes: ['Se cortó el pasto y se limpió la plaza.', 'Se retiró la rama caída.', 'Se reparó el sistema de riego.'],
  animales: ['Se coordinó el retiro con la oficina de tenencia responsable.', 'Inspectores visitaron el lugar y se notificó al dueño.', 'Se retiró el animal del lugar.'],
  ruidos: ['Inspectores acudieron y se cursó una advertencia.', 'Se fiscalizó el lugar; el ruido cesó.', 'Se notificó al responsable y se dejó constancia.'],
  vehiculo: ['Se retiró el vehículo con grúa municipal.', 'Se notificó al propietario y retiró el vehículo.', 'Vehículo retirado y enviado a corrales.'],
  senaletica: ['Se reinstaló la señal de tránsito.', 'Se reemplazó el disco pare dañado.', 'Se reparó el semáforo y quedó operativo.'],
  otro: ['Se derivó a la empresa responsable y se reparó.', 'Se revisó el lugar y se solucionó el problema.'],
};
const MOTIVOS_RECHAZO = ['Falta material para la reparación', 'Corresponde a otra cuadrilla', 'No se encontró el lugar indicado', 'Requiere maquinaria especial'];
const MOTIVOS_DESCARTE = ['No corresponde a la Municipalidad: es un terreno privado', 'El problema ya estaba resuelto al revisar', 'Información insuficiente; el vecino no respondió', 'Corresponde a otra institución (Vialidad)'];
const NOTAS = ['[Nota interna] Coordinar con la cuadrilla de la tarde.', '[Nota interna] Vecino reporta lo mismo por segunda vez.', '[Nota interna] Revisar en la próxima ronda del sector.'];
const MENSAJES = ['[Mensaje al vecino] Hola, ¿nos podría indicar una referencia más exacta del lugar?', '[Mensaje al vecino] Gracias por su reporte, ¿el problema sigue presente?'];
const RESPUESTAS = ['es frente a la casa de rejas verdes', 'sí, sigue igual', 'en la esquina con el pasaje, al lado del poste', 'sigue ahí, gracias por preocuparse'];
const NOMBRES = ['María', 'José', 'Carmen', 'Juan', 'Rosa', 'Luis', 'Ana', 'Pedro', 'Patricia', 'Carlos', 'Marta', 'Jorge', 'Claudia', 'Manuel', 'Paola', 'Héctor',
  'Valentina', 'Diego', 'Camila', 'Felipe', 'Javiera', 'Matías', 'Francisca', 'Sebastián', 'Gloria', 'Ricardo', 'Daniela', 'Cristian', 'Verónica', 'Rodrigo'];
const PERSONAL = {
  [DEPTO.ASEO]: ['Hernán Soto', 'Marcela Díaz', 'Iván Rojas'],
  [DEPTO.TRANSITO]: ['Patricio Lagos', 'Nicole Fuentes', 'Óscar Muñoz'],
  [DEPTO.SEGURIDAD]: ['Andrés Contreras', 'Fernanda Silva', 'Raúl Pérez'],
  [DEPTO.OBRAS]: ['Mauricio Vera', 'Rubén Tapia', 'Lorena Castro'],
};

// ---------------------------------------------------------------- base de datos
function conectar() {
  if (!DATABASE_URL) { console.error('Falta DATABASE_URL (munivox-lambda/.env).'); process.exit(1); }
  const { Pool } = require('pg');
  return new Pool({ connectionString: DATABASE_URL.replace(/[?&]schema=[^&]*/, ''), ssl: /sslmode=disable/.test(DATABASE_URL) ? false : { rejectUnauthorized: false }, max: 3 });
}
async function insertar(cli, tabla, filas) {
  if (!filas.length) return;
  const cols = Object.keys(filas[0]);
  for (let i = 0; i < filas.length; i += 200) {
    const lote = filas.slice(i, i + 200), params = [];
    const valores = lote.map(f => `(${cols.map(c => { params.push(f[c]); return `$${params.length}`; }).join(', ')})`);
    await cli.query(`INSERT INTO "${tabla}" (${cols.map(c => `"${c}"`).join(', ')}) VALUES ${valores.join(', ')}`, params);
  }
}

// ---------------------------------------------------------------- fotos
async function subirFotos() {
  const carpeta = resto[0];
  if (!carpeta) { console.error('Uso: node demo.js fotos <carpeta con fotos.json y las imágenes>'); process.exit(1); }
  const seleccion = JSON.parse(fs.readFileSync(path.join(carpeta, 'fotos.json'), 'utf8'));
  const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
  const s3 = new S3Client({ region: REGION_S3 });
  const resultado = { antes: {}, cierre: {}, creditos: [] };
  for (const f of seleccion) {
    const cierre = f.categoria.startsWith('cierre_');
    const cat = cierre ? f.categoria.slice(7) : f.categoria;
    const clave = cierre ? `evidencias/cierre/demo/${cat}/${path.basename(f.archivo)}` : `evidencias/demo/${cat}/${path.basename(f.archivo)}`;
    await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: clave, Body: fs.readFileSync(path.join(carpeta, f.archivo)), ContentType: 'image/jpeg', CacheControl: 'public, max-age=31536000' }));
    (resultado[cierre ? 'cierre' : 'antes'][cat] ||= []).push(`${URL_S3}/${clave}`);
    resultado.creditos.push({ url: `${URL_S3}/${clave}`, titulo: f.titulo, autor: f.autor, licencia: f.licencia, fuente: f.fuente });
    process.stdout.write('.');
  }
  fs.mkdirSync(path.dirname(ARCHIVO_FOTOS), { recursive: true });
  fs.writeFileSync(ARCHIVO_FOTOS, JSON.stringify(resultado, null, 1));
  const md = ['# Créditos de las fotos de demostración', '', 'Fotos de Wikimedia Commons con licencia libre, usadas solo en los datos de demostración.', '',
    '| Archivo | Autor | Licencia | Fuente |', '|---|---|---|---|',
    ...resultado.creditos.map(c => `| ${c.url.split('/').slice(-2).join('/')} | ${(c.autor || 'Desconocido').replace(/\|/g, '/')} | ${c.licencia} | ${c.fuente} |`)];
  fs.writeFileSync(path.join(path.dirname(ARCHIVO_FOTOS), 'CREDITOS_FOTOS.md'), md.join('\n') + '\n');
  console.log(`\n${seleccion.length} fotos subidas. Lista en datos-demo/fotos.json y créditos en datos-demo/CREDITOS_FOTOS.md`);
}

// ---------------------------------------------------------------- generación
function fechaCreacion(ahora, meses) {
  // Uso creciente: el último mes tiene ~3 veces más reportes que el primero
  const m = ponderado([...Array(meses)].map((_, i) => [i, 1 + (2 * i) / Math.max(1, meses - 1)]));
  const hora = ponderado([[0, .3], [1, .2], [2, .1], [3, .1], [4, .1], [5, .2], [6, .5], [7, 1.2], [8, 2], [9, 2.4], [10, 2.5], [11, 2.4], [12, 2.2], [13, 2], [14, 2], [15, 2.1],
    [16, 2.1], [17, 2.2], [18, 2.3], [19, 2.2], [20, 1.8], [21, 1.4], [22, .9], [23, .5]]);
  for (let i = 0; i < 20; i++) {
    const dias = (meses - 1 - m) * 30.4 + entre(0, 30.4);
    const d = new Date(ahora - dias * DIA); d.setHours(hora, entero(0, 59), entero(0, 59), 0);
    const finde = d.getDay() === 0 || d.getDay() === 6;
    if (d.getTime() < ahora - 15 * MIN && (!finde || prob(0.6))) return d.getTime();
  }
  return ahora - entre(1, 30) * DIA;
}

const RETRASOS = { // minutos: derivar, asignar, tomar, en camino, resolver
  CRITICA: [[5, 40], [5, 30], [5, 30], [1, 20], [20, 120]],
  ALTA: [[15, 180], [15, 240], [30, 360], [30, 600], [30, 180]],
  MEDIA: [[30, 480], [60, 1440], [60, 1440], [60, 2880], [30, 240]],
  BAJA: [[60, 1440], [120, 2880], [120, 4320], [120, 5760], [30, 240]],
};

async function generar() {
  const cantidad = Number(opcion('cantidad', 350)), meses = Number(opcion('meses', 6)), seco = bandera('seco');
  const ahora = Date.now();
  const db = seco ? null : conectar();

  // Personal: C4, jefaturas reales y funcionarios de terreno de demostración
  let admin, jefaturas = {}, terreno = {};
  const filasPersonal = [];
  if (!seco) {
    const ops = (await db.query(`SELECT id, rol, "departamentoId" d, email FROM "Operador"`)).rows;
    admin = ops.find(o => o.rol === 'ADMINISTRADOR')?.id;
    if (!admin) { console.error('No hay un operador ADMINISTRADOR (C4).'); process.exit(1); }
    for (const d of Object.values(DEPTO)) jefaturas[d] = ops.filter(o => o.rol === 'OPERADOR' && o.d === d).map(o => o.id);
    for (const [d, nombres] of Object.entries(PERSONAL)) {
      for (const [i, nombre] of nombres.entries()) {
        const email = `terreno${i + 1}.d${d}${DOMINIO_PERSONAL}`;
        const existe = ops.find(o => o.email === email);
        const id = existe?.id || crypto.randomUUID();
        if (!existe) filasPersonal.push({ id, email, nombre, rol: 'TERRENO', departamentoId: Number(d), enTurno: false, gpsActivo: false, createdAt: new Date(ahora - meses * 31 * DIA), updatedAt: new Date() });
        (terreno[d] ||= []).push(id);
      }
    }
  } else {
    admin = 'C4'; for (const d of Object.values(DEPTO)) { jefaturas[d] = [`jefatura-${d}`]; terreno[d] = PERSONAL[d].map((_, i) => `terreno-${d}-${i}`); }
  }
  const jefaturaDe = (d) => jefaturas[d]?.length ? uno(jefaturas[d]) : admin;

  // Categorías (ids de los nombres actuales)
  const catId = {};
  if (!seco) for (const c of CATEGORIAS) catId[c.nombre] = (await db.query(`INSERT INTO "Categoria" (nombre) VALUES ($1) ON CONFLICT (nombre) DO UPDATE SET nombre = EXCLUDED.nombre RETURNING id`, [c.nombre])).rows[0].id;

  // Fotos
  let fotos = { antes: {}, cierre: {} };
  try { fotos = JSON.parse(fs.readFileSync(ARCHIVO_FOTOS, 'utf8')); } catch { console.log('Aviso: sin datos-demo/fotos.json; los reportes quedarán sin fotos.'); }

  // Planificación: reportes sueltos + puntos críticos (3 a 5 reportes del mismo tipo a menos de 120 m)
  const plan = [];
  const nCriticos = Math.round(cantidad / 55);
  for (let i = 0; i < nCriticos; i++) {
    const claveCat = uno(['basura', 'basura', 'basura', 'bache', 'bache', 'alumbrado', 'areas_verdes']), idUV = uno([1, 1, 2, 3, 5, 6]);
    const cat = CATEGORIAS.find(c => c.clave === claveCat);
    const uv = UVS.find(u => u.id === idUV);
    const centro = await ubicar(uv);
    for (let k = entero(3, 5); k > 0; k--) plan.push({ cat, uv, cerca: centro, reciente: k <= 3 });
  }
  while (plan.length < cantidad) {
    plan.push({ cat: ponderado(CATEGORIAS.map(c => [c, c.peso])), uv: ponderado(UVS.map(u => [u, u.peso])) });
  }

  // Vecinos: ~25 % reporta más de una vez
  const vecinos = [];
  const nuevoVecino = () => {
    let tel; do { tel = PREFIJO_TELEFONO + String(entero(0, 9999)).padStart(4, '0'); } while (vecinos.some(v => v.telefono === tel));
    const v = { id: crypto.randomUUID(), telefono: tel, nombre: prob(0.8) ? uno(NOMBRES) : null, primera: Infinity, ultima: 0 };
    vecinos.push(v); return v;
  };

  const reportes = [], evidencias = [], historial = [], codigos = new Set();
  const nuevoCodigo = () => { let c; do { c = `MUN-${String(entero(100000, 999999))}`; } while (codigos.has(c)); codigos.add(c); return c; };
  process.stdout.write(`Ubicando ${plan.length} reportes en calles de Buin `);

  for (const [i, p] of plan.entries()) {
    if (i % 25 === 0) process.stdout.write('.');
    const ubic = p.cerca ? await ubicar(p.uv, p.cerca, 90) : await ubicar(p.uv);
    let t0 = p.reciente ? ahora - entre(2, 55) * DIA : prob(0.07) ? ahora - entre(0.3, 72) * HORA : fechaCreacion(ahora, meses);
    const vecino = vecinos.length > 20 && prob(0.25) ? uno(vecinos) : nuevoVecino();
    vecino.primera = Math.min(vecino.primera, t0); vecino.ultima = Math.max(vecino.ultima, t0);

    const prioridadIA = ponderado(p.cat.prioridad);
    const r = {
      id: crypto.randomUUID(), codigoTicket: nuevoCodigo(), tokenSeguimiento: `demo-${crypto.randomBytes(14).toString('hex')}`,
      ciudadanoId: vecino.id, categoriaId: catId[p.cat.nombre] ?? null, departamentoId: p.cat.depto, operadorAsignadoId: null,
      latitud: ubic.lat, longitud: ubic.lng, descripcionUsuario: relato(p.cat),
      analisisIA: `${ANALISIS[p.cat.clave]}, ${uno(REFERENCIAS)} (UV ${p.uv.id} ${p.uv.nombre}).`,
      certezaIA: Math.round(entre(0.72, 0.98) * 100) / 100, prioridadIA, prioridadFinal: null,
      estado: 'PENDIENTE', createdAt: new Date(t0), updatedAt: new Date(t0),
    };
    const tieneFoto = prob(p.cat.foto) && fotos.antes[p.cat.clave]?.length;
    if (tieneFoto) {
      r.descripcionUsuario += '\n[Usuario]: [Sistema: El usuario acaba de adjuntar una Fotografía]';
      evidencias.push({ id: crypto.randomUUID(), url: uno(fotos.antes[p.cat.clave]), tipo: 'IMAGEN', reporteId: r.id, createdAt: new Date(t0 + entre(0.5, 3) * MIN) });
    }
    r.descripcionUsuario += '\n[Usuario]: [Sistema: El usuario acaba de enviar su Ubicación GPS]';

    // Línea de tiempo planificada; se corta en "ahora"
    const ev = [];
    let t = t0, prioridad = prioridadIA, asignado = null;
    const lento = prob(0.12) ? entre(2, 3.5) : 1; // algunos casos se atrasan y quedan fuera de plazo
    const ret = (k) => entre(...RETRASOS[prioridad][k]) * MIN * lento;
    const agregar = (dt, estado, comentario, operadorId, extra = {}) => { t += dt; ev.push({ t, estado, comentario, operadorId, ...extra }); };

    if (prob(0.06)) { // descartado por el C4 al revisar
      agregar(ret(0), 'DESCARTADO', uno(MOTIVOS_DESCARTE), admin);
    } else {
      if (prob(0.1)) { prioridad = prioridad === 'BAJA' ? 'MEDIA' : prioridad === 'MEDIA' ? 'ALTA' : prioridad; r.prioridadFinal = prioridad; agregar(ret(0) * 0.5, 'PENDIENTE', `Prioridad ajustada a ${prioridad}`, admin); }
      if (prob(0.07)) agregar(entre(2, 20) * MIN, 'PENDIENTE', MENSAJES[0], admin, { mensaje: true });
      const depto = p.cat.depto || uno([DEPTO.OBRAS, DEPTO.ASEO]);
      agregar(ret(0), 'EN_REVISION', 'Derivado por la central C4', admin, { depto });
      agregar(ret(1), 'EN_REVISION', 'Asignado a funcionario en terreno', jefaturaDe(depto), { asignar: (asignado = uno(terreno[depto])) });
      if (prob(0.08)) {
        agregar(ret(1) * 0.6, 'EN_REVISION', `Rechazado por funcionario: ${uno(MOTIVOS_RECHAZO)}`, asignado, { liberar: true });
        const otro = terreno[depto].filter(x => x !== asignado);
        agregar(ret(1) * 0.5, 'EN_REVISION', 'Asignado a funcionario en terreno', jefaturaDe(depto), { asignar: (asignado = uno(otro.length ? otro : terreno[depto])) });
      }
      if (prob(0.1)) agregar(entre(5, 120) * MIN, 'EN_REVISION', uno(NOTAS), jefaturaDe(depto), { nota: true });
      if (!prob(0.03)) { // 3 %: quedan detenidos sin tomar (fuera de plazo)
        agregar(ret(2), 'DESPACHADO', 'El funcionario tomó el caso.', asignado);
        if (prob(0.7)) agregar(ret(3), 'DESPACHADO', 'En camino al lugar', asignado);
        agregar(ret(4) + (ev[ev.length - 1].comentario === 'En camino al lugar' ? 0 : ret(3)), 'RESUELTO', uno(INFORMES[p.cat.clave]), asignado, { cierre: true });
        if (prob(0.55)) {
          const nota = ponderado([[5, 72], [3, 20], [1, 8]]);
          agregar(entre(10, 600) * MIN, 'RESUELTO', `Calificación del ciudadano: ${nota}/5 (${nota === 5 ? 'Bien resuelto' : nota === 3 ? 'Regular' : 'No se resolvió'})`, null);
        }
      }
    }
    // Aplicar los eventos que ya ocurrieron
    for (const e of ev) {
      if (e.t > ahora - 2 * MIN) break;
      if (e.depto) r.departamentoId = e.depto;
      if (e.asignar) r.operadorAsignadoId = e.asignar;
      if (e.liberar) r.operadorAsignadoId = null;
      if (e.estado !== 'PENDIENTE' || r.estado === 'PENDIENTE') r.estado = e.estado;
      if (e.mensaje && prob(0.7)) r.descripcionUsuario += `\n[Usuario]: ${uno(RESPUESTAS)}`;
      historial.push({ id: crypto.randomUUID(), estadoNuevo: r.estado, comentario: e.comentario, reporteId: r.id, operadorId: e.operadorId, createdAt: new Date(e.t) });
      if (e.mensaje && prob(0.7)) historial.push({ id: crypto.randomUUID(), estadoNuevo: r.estado, comentario: '[Nota interna] El vecino respondió por WhatsApp', reporteId: r.id, operadorId: null, createdAt: new Date(e.t + entre(10, 240) * MIN) });
      if (e.cierre && fotos.cierre[p.cat.clave]?.length && prob(0.65)) evidencias.push({ id: crypto.randomUUID(), url: uno(fotos.cierre[p.cat.clave]), tipo: 'IMAGEN', reporteId: r.id, createdAt: new Date(e.t) });
      r.updatedAt = new Date(e.t);
    }
    reportes.push({ r, cat: p.cat, uv: p.uv });
  }

  // Duplicados: un segundo vecino reporta lo mismo cerca y el C4 lo une al original
  const nDup = Math.round(cantidad * 0.04);
  for (let k = 0; k < nDup; k++) {
    const o = uno(reportes.filter(x => !x.dup && x.r.estado !== 'DESCARTADO' && ahora - x.r.createdAt.getTime() > 2 * DIA));
    if (!o) break;
    const t0 = o.r.createdAt.getTime() + entre(2, 36) * HORA; if (t0 > ahora - HORA) continue;
    const ubic = await ubicar(o.uv, { lat: o.r.latitud, lng: o.r.longitud }, 60);
    const vecino = nuevoVecino(); vecino.primera = vecino.ultima = t0;
    const r = { ...o.r, id: crypto.randomUUID(), codigoTicket: nuevoCodigo(), tokenSeguimiento: `demo-${crypto.randomBytes(14).toString('hex')}`, ciudadanoId: vecino.id,
      latitud: ubic.lat, longitud: ubic.lng, descripcionUsuario: relato(o.cat) + '\n[Usuario]: [Sistema: El usuario acaba de enviar su Ubicación GPS]',
      operadorAsignadoId: null, prioridadFinal: null, estado: 'DESCARTADO', createdAt: new Date(t0), updatedAt: new Date(t0 + entre(20, 240) * MIN) };
    historial.push({ id: crypto.randomUUID(), estadoNuevo: 'DESCARTADO', comentario: `Duplicado de ${o.r.codigoTicket}`, reporteId: r.id, operadorId: admin, createdAt: r.updatedAt });
    reportes.push({ r, cat: o.cat, uv: o.uv, dup: true });
  }
  console.log(' listo');

  // Resumen
  const cuenta = (f) => reportes.reduce((m, x) => (m[f(x)] = (m[f(x)] || 0) + 1, m), {});
  console.log(`Reportes: ${reportes.length} | vecinos: ${vecinos.length} | fotos: ${evidencias.length} | historial: ${historial.length}`);
  console.log('Por estado:', cuenta(x => x.r.estado));
  console.log('Por categoría:', cuenta(x => x.cat.clave));
  console.log('Por UV (top 8):', Object.entries(cuenta(x => `UV${x.uv.id}`)).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k}=${v}`).join(' '));
  const fuera = reportes.filter(x => ['PENDIENTE', 'EN_REVISION', 'DESPACHADO'].includes(x.r.estado) && ahora - x.r.createdAt.getTime() > SLA_H[x.r.prioridadFinal || x.r.prioridadIA] * HORA).length;
  console.log(`Activos fuera de plazo: ${fuera}`);
  if (seco) { console.log('\nEjemplos de relatos:'); reportes.slice(0, 6).forEach(x => console.log('  -', x.r.descripcionUsuario.split('\n')[0])); return; }

  // Escritura en una sola transacción
  const cli = await db.connect();
  try {
    await cli.query('BEGIN');
    await insertar(cli, 'Operador', filasPersonal);
    await insertar(cli, 'Ciudadano', vecinos.map(v => ({ id: v.id, telefono: v.telefono, nombre: v.nombre, baneado: false, avisoPrivacidadEn: new Date(v.primera), createdAt: new Date(v.primera), updatedAt: new Date(v.ultima) })));
    await insertar(cli, 'Reporte', reportes.map(x => x.r));
    await insertar(cli, 'Evidencia', evidencias);
    await insertar(cli, 'HistorialEstado', historial);
    await cli.query('COMMIT');
    console.log('Datos de demostración guardados.');
  } catch (e) {
    await cli.query('ROLLBACK'); throw e;
  } finally { cli.release(); await db.end(); }
}

// ---------------------------------------------------------------- borrar
async function borrar() {
  const db = conectar(); const cli = await db.connect();
  try {
    await cli.query('BEGIN');
    const rep = await cli.query(`DELETE FROM "Reporte" WHERE "tokenSeguimiento" LIKE 'demo-%' OR "ciudadanoId" IN (SELECT id FROM "Ciudadano" WHERE telefono LIKE $1)`, [`${PREFIJO_TELEFONO}%`]);
    const ciu = await cli.query(`DELETE FROM "Ciudadano" WHERE telefono LIKE $1`, [`${PREFIJO_TELEFONO}%`]);
    const ids = (await cli.query(`SELECT id FROM "Operador" WHERE email LIKE $1`, [`%${DOMINIO_PERSONAL}`])).rows.map(r => r.id);
    if (ids.length) {
      await cli.query(`UPDATE "Reporte" SET "operadorAsignadoId" = NULL WHERE "operadorAsignadoId" = ANY($1)`, [ids]);
      for (const t of ['HistorialEstado', 'SolicitudDatos', 'Auditoria']) await cli.query(`UPDATE "${t}" SET "operadorId" = NULL WHERE "operadorId" = ANY($1)`, [ids]);
      await cli.query(`DELETE FROM "SuscripcionPush" WHERE "operadorId" = ANY($1)`, [ids]);
      await cli.query(`DELETE FROM "Operador" WHERE id = ANY($1)`, [ids]);
    }
    await cli.query('COMMIT');
    console.log(`Borrados: ${rep.rowCount} reportes, ${ciu.rowCount} vecinos y ${ids.length} funcionarios de demostración.`);
  } catch (e) { await cli.query('ROLLBACK'); throw e; } finally { cli.release(); await db.end(); }
}

const comandos = { fotos: subirFotos, generar, borrar };
if (!comandos[comando]) { console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 24).map(l => l.replace(/^\/\/ ?/, '')).join('\n')); process.exit(comando === 'ayuda' ? 0 : 1); }
comandos[comando]().catch(e => { console.error('Error:', e.message); process.exit(1); });
