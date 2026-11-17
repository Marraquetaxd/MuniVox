#!/usr/bin/env node
// ============================================================================
// Simulador de funcionarios en terreno (solo para demostraciones)
//
// Crea funcionarios de Aseo y Ornato de mentira (correo @munivox.demo) y los mueve
// por calles reales de Buin usando rutas de Mapbox. Algunos recorren la comuna y
// se detienen a "trabajar"; otros quedan quietos. Cada pocos segundos escribe sus
// posiciones en PostgreSQL y publica `operadores-cambio` en Redis para que los
// paneles se actualicen al instante (socket-service lo retransmite).
//
// También puede "estacionar" una cuenta real (el celular de la demo) en un punto
// de Buin y, cuando ese funcionario toca "Voy en camino", llevarla por la calle
// hasta el reporte.
//
//   node simulador.js alta                       crea o reactiva los funcionarios simulados
//   node simulador.js iniciar [opciones]         mueve a todos hasta presionar Ctrl+C
//   node simulador.js estado                     lista los funcionarios simulados
//   node simulador.js limpiar                    borra los funcionarios simulados
//   node simulador.js rutas                      prueba las rutas de Mapbox (no toca la base)
//
// Opciones de "iniciar":
//   --estacionar <correo>   cuenta real de terreno que se ubica en Buin y va al reporte en camino
//   --reporte <MUN-123456>  estaciona esa cuenta a unos 400 m del reporte (si no, en el centro)
//   --velocidad <km/h>      velocidad de los vehículos (por defecto 30)
//   --cada <segundos>       frecuencia de actualización (por defecto 3)
// ============================================================================
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// ---------------------------------------------------------------- configuración
// 1) simulador/.env  2) DATABASE_URL de munivox-lambda/.env  3) token de Mapbox del dashboard
const dotenv = require('dotenv');
dotenv.config({ path: path.join(__dirname, '.env') });
const leerEnv = (archivo) => { try { return dotenv.parse(fs.readFileSync(archivo)); } catch { return {}; } };
const envLambda = leerEnv(path.join(__dirname, '..', 'munivox-lambda', '.env'));
const envDashboard = leerEnv(path.join(__dirname, '..', 'munivox-dashboard', '.env.local'));

const DATABASE_URL = process.env.DATABASE_URL || envLambda.DATABASE_URL;
const MAPBOX_TOKEN = process.env.MAPBOX_TOKEN || envDashboard.NEXT_PUBLIC_MAPBOX_TOKEN;
const REDIS_HOST = process.env.REDIS_HOST;
const REDIS_PORT = Number(process.env.REDIS_PORT || 6379);

const DOMINIO = '@munivox.demo';
const DEPARTAMENTO_ASEO = 1;
const CENTRO = { lat: -33.7312, lng: -70.7415 };
const RADIO_KM = 2.6; // zona urbana de Buin donde se mueven

const { verificarUbicacion } = require(path.join(__dirname, '..', 'worker-service', 'geo'));

// Funcionarios simulados: "ruta" recorren la comuna, "quieto" se quedan en un punto
const NPC = [
  { n: 1, nombre: 'Juan Pérez Soto', modo: 'ruta' },
  { n: 2, nombre: 'María González Rojas', modo: 'ruta' },
  { n: 3, nombre: 'Pedro Muñoz Díaz', modo: 'ruta' },
  { n: 4, nombre: 'Carolina Vera Silva', modo: 'ruta' },
  { n: 5, nombre: 'Luis Contreras Mora', modo: 'quieto' },
  { n: 6, nombre: 'Camila Fuentes Araya', modo: 'quieto' },
];
const correoNpc = (n) => `sim${n}.aseo${DOMINIO}`;

// ---------------------------------------------------------------- argumentos
const [, , comando = 'ayuda', ...resto] = process.argv;
const opcion = (nombre, porDefecto) => {
  const i = resto.indexOf(`--${nombre}`);
  return i >= 0 && resto[i + 1] ? resto[i + 1] : porDefecto;
};

// ---------------------------------------------------------------- utilidades
const esperar = (ms) => new Promise(r => setTimeout(r, ms));
const azar = (a, b) => a + Math.random() * (b - a);
const log = (...a) => console.log(new Date().toLocaleTimeString('es-CL'), ...a);

function distanciaM(a, b) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function desplazar(p, metros, rumbo) {
  const dLat = (metros * Math.cos(rumbo)) / 110540;
  const dLng = (metros * Math.sin(rumbo)) / (111320 * Math.cos(p.lat * Math.PI / 180));
  return { lat: p.lat + dLat, lng: p.lng + dLng };
}

/** Punto al azar en la zona urbana, siempre dentro del límite comunal */
function puntoEnBuin(centro = CENTRO, radioKm = RADIO_KM) {
  for (let i = 0; i < 200; i++) {
    const p = desplazar(centro, Math.sqrt(Math.random()) * radioKm * 1000, Math.random() * 2 * Math.PI);
    if (verificarUbicacion(p.lat, p.lng).dentro) return p;
  }
  return { ...centro };
}

// ---------------------------------------------------------------- rutas (Mapbox Directions)
let avisoSinMapbox = false;
async function ruta(desde, hasta) {
  if (MAPBOX_TOKEN) {
    try {
      const url = `https://api.mapbox.com/directions/v5/mapbox/driving/${desde.lng},${desde.lat};${hasta.lng},${hasta.lat}` +
        `?geometries=geojson&overview=full&access_token=${MAPBOX_TOKEN}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (res.ok) {
        const data = await res.json();
        const coords = data.routes?.[0]?.geometry?.coordinates;
        if (coords?.length >= 2) return coords.map(([lng, lat]) => ({ lat, lng }));
      } else if (!avisoSinMapbox) {
        avisoSinMapbox = true; log(`Mapbox respondió ${res.status}; se usará línea recta.`);
      }
    } catch (e) {
      if (!avisoSinMapbox) { avisoSinMapbox = true; log('No se pudo pedir la ruta a Mapbox; se usará línea recta.'); }
    }
  } else if (!avisoSinMapbox) {
    avisoSinMapbox = true; log('Sin token de Mapbox: los recorridos serán en línea recta.');
  }
  return [desde, hasta];
}

/** Recorrido con distancias acumuladas para avanzar a velocidad constante */
function prepararRecorrido(puntos) {
  const acumulada = [0];
  for (let i = 1; i < puntos.length; i++) acumulada.push(acumulada[i - 1] + distanciaM(puntos[i - 1], puntos[i]));
  return { puntos, acumulada, total: acumulada[acumulada.length - 1], avance: 0 };
}

function posicionEn(rec) {
  const d = Math.min(rec.avance, rec.total);
  let i = 1;
  while (i < rec.acumulada.length - 1 && rec.acumulada[i] < d) i++;
  const a = rec.puntos[i - 1], b = rec.puntos[i];
  const tramo = rec.acumulada[i] - rec.acumulada[i - 1] || 1;
  const k = (d - rec.acumulada[i - 1]) / tramo;
  return { lat: a.lat + (b.lat - a.lat) * k, lng: a.lng + (b.lng - a.lng) * k };
}

/** Ajusta un punto a la calle más cercana (primer punto de una ruta corta) */
async function aCalle(p) {
  const r = await ruta(p, desplazar(p, 60, Math.random() * 2 * Math.PI));
  return r[0];
}

// ---------------------------------------------------------------- base de datos y Redis
// Modo en seco (SIMULADOR_SECO=1): no toca la base, muestra las posiciones en la consola
function baseEnSeco() {
  const filas = NPC.map(f => ({ id: `seco-${f.n}`, email: correoNpc(f.n), nombre: f.nombre }));
  return {
    query: async (sql, params = []) => {
      if (/SELECT id, email, nombre/.test(sql)) return { rows: filas, rowCount: filas.length };
      if (/UPDATE "Operador" o SET latitud/.test(sql)) {
        const pos = [];
        for (let i = 0; i < params.length; i += 3) pos.push(`${String(params[i]).slice(-1)}:${params[i + 1].toFixed(5)},${params[i + 2].toFixed(5)}`);
        log('[seco]', pos.join('  '));
      }
      return { rows: [], rowCount: 0 };
    },
    end: async () => {},
  };
}

function conectarBase() {
  if (process.env.SIMULADOR_SECO === '1') return baseEnSeco();
  if (!DATABASE_URL) {
    console.error('Falta DATABASE_URL. Ponla en simulador/.env o en munivox-lambda/.env.');
    process.exit(1);
  }
  const { Pool } = require('pg');
  const ssl = /sslmode=disable/.test(DATABASE_URL) ? false : { rejectUnauthorized: false };
  return new Pool({ connectionString: DATABASE_URL.replace(/[?&]schema=[^&]*/, ''), ssl, max: 3 });
}

function conectarRedis() {
  if (!REDIS_HOST) {
    log('Sin REDIS_HOST: los paneles verán el movimiento solo con su refresco automático (cada 20 a 60 s).');
    return null;
  }
  const Redis = require('ioredis');
  const r = new Redis({ host: REDIS_HOST, port: REDIS_PORT, connectTimeout: 5000, maxRetriesPerRequest: 1, lazyConnect: true });
  r.on('error', () => {});
  return r;
}

async function npcsEnBase(db) {
  const { rows } = await db.query(
    `SELECT id, email, nombre, "enTurno", "gpsActivo", latitud, longitud, "ultimaUbicacion" FROM "Operador" WHERE email LIKE $1 ORDER BY email`,
    [`%${DOMINIO}`]);
  return rows;
}

// ---------------------------------------------------------------- comandos
async function alta() {
  const db = conectarBase();
  for (const f of NPC) {
    await db.query(
      `INSERT INTO "Operador" (id, email, nombre, rol, "departamentoId", "enTurno", "gpsActivo", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, 'TERRENO'::"RolUsuario", $4, true, false, now(), now())
       ON CONFLICT (email) DO UPDATE SET nombre = EXCLUDED.nombre, rol = 'TERRENO'::"RolUsuario",
         "departamentoId" = EXCLUDED."departamentoId", "enTurno" = true, "updatedAt" = now()`,
      [crypto.randomUUID(), correoNpc(f.n), f.nombre, DEPARTAMENTO_ASEO]);
  }
  const filas = await npcsEnBase(db);
  console.log(`Funcionarios simulados de Aseo y Ornato: ${filas.length}`);
  filas.forEach(r => console.log(`  ${r.nombre.padEnd(24)} ${r.email}`));
  await db.end();
}

async function estado() {
  const db = conectarBase();
  const filas = await npcsEnBase(db);
  if (!filas.length) console.log('No hay funcionarios simulados. Ejecuta: node simulador.js alta');
  filas.forEach(r => console.log(`  ${r.nombre.padEnd(24)} turno=${r.enTurno ? 'sí' : 'no'} gps=${r.gpsActivo ? 'sí' : 'no'} ${r.latitud != null ? `${r.latitud.toFixed(5)}, ${r.longitud.toFixed(5)}` : 'sin posición'}`));
  await db.end();
}

async function limpiar() {
  const db = conectarBase();
  const filas = await npcsEnBase(db);
  if (!filas.length) { console.log('No hay funcionarios simulados.'); await db.end(); return; }
  const ids = filas.map(r => r.id);
  const cliente = await db.connect();
  try {
    await cliente.query('BEGIN');
    // Si a alguno le asignaron casos, vuelven a quedar sin asignar (la jefatura los reasigna)
    const liberados = await cliente.query(`UPDATE "Reporte" SET "operadorAsignadoId" = NULL, "updatedAt" = now() WHERE "operadorAsignadoId" = ANY($1)`, [ids]);
    await cliente.query(`UPDATE "HistorialEstado" SET "operadorId" = NULL WHERE "operadorId" = ANY($1)`, [ids]);
    await cliente.query(`UPDATE "SolicitudDatos" SET "operadorId" = NULL WHERE "operadorId" = ANY($1)`, [ids]);
    await cliente.query(`UPDATE "Auditoria" SET "operadorId" = NULL WHERE "operadorId" = ANY($1)`, [ids]);
    await cliente.query(`DELETE FROM "SuscripcionPush" WHERE "operadorId" = ANY($1)`, [ids]);
    await cliente.query(`DELETE FROM "Operador" WHERE id = ANY($1)`, [ids]);
    await cliente.query('COMMIT');
    console.log(`Se borraron ${ids.length} funcionarios simulados.${liberados.rowCount ? ` ${liberados.rowCount} caso(s) quedaron sin asignar.` : ''}`);
  } catch (e) {
    await cliente.query('ROLLBACK');
    throw e;
  } finally {
    cliente.release();
    await db.end();
  }
}

async function probarRutas() {
  const a = puntoEnBuin(), b = puntoEnBuin();
  const r = await ruta(a, b);
  const rec = prepararRecorrido(r);
  console.log(`Ruta de prueba: ${r.length} puntos, ${(rec.total / 1000).toFixed(2)} km`);
  console.log(`  desde ${a.lat.toFixed(5)}, ${a.lng.toFixed(5)}  hasta ${b.lat.toFixed(5)}, ${b.lng.toFixed(5)}`);
  console.log(r.length > 2 ? '  Rutas por calles: OK' : '  Sin rutas por calles (línea recta)');
}

async function iniciar() {
  const db = conectarBase();
  const redis = conectarRedis();
  if (redis) {
    try { await redis.connect(); log(`Redis conectado (${REDIS_HOST}).`); }
    catch { log('No se pudo conectar a Redis; los paneles se actualizarán con su refresco automático.'); }
  }
  const velocidad = Number(opcion('velocidad', 30)) / 3.6; // m/s
  const cadaMs = Math.max(1, Number(opcion('cada', 3))) * 1000;
  const correoEstacionado = opcion('estacionar', null);
  const codigoReporte = opcion('reporte', null);

  const filas = await npcsEnBase(db);
  if (!filas.length) { console.error('No hay funcionarios simulados. Ejecuta primero: node simulador.js alta'); process.exit(1); }

  // Estado inicial de cada funcionario simulado
  const agentes = [];
  for (const fila of filas) {
    const def = NPC.find(f => correoNpc(f.n) === fila.email) || { modo: 'ruta' };
    const inicio = await aCalle(puntoEnBuin());
    agentes.push({ id: fila.id, nombre: fila.nombre, modo: def.modo, pos: inicio, base: inicio, rec: null, pausaHasta: 0, pidiendo: false });
  }

  // Cuenta real estacionada (el celular de la demo)
  let estacionado = null;
  if (correoEstacionado) {
    const { rows } = await db.query(`SELECT id, nombre, rol FROM "Operador" WHERE lower(email) = lower($1)`, [correoEstacionado]);
    if (!rows.length) { console.error(`No existe un funcionario con el correo ${correoEstacionado}. Debe iniciar sesión una vez en MuniVox.`); process.exit(1); }
    if (rows[0].rol !== 'TERRENO') console.warn(`Aviso: ${correoEstacionado} no tiene rol TERRENO.`);
    let cerca = CENTRO;
    if (codigoReporte) {
      const r = await db.query(`SELECT latitud, longitud FROM "Reporte" WHERE "codigoTicket" = $1`, [codigoReporte.toUpperCase()]);
      if (r.rows[0]?.latitud != null) cerca = { lat: r.rows[0].latitud, lng: r.rows[0].longitud };
      else console.warn(`No se encontró la ubicación de ${codigoReporte}; se estaciona en el centro de Buin.`);
    }
    const punto = await aCalle(codigoReporte ? desplazar(cerca, azar(350, 500), Math.random() * 2 * Math.PI) : puntoEnBuin(CENTRO, 0.8));
    estacionado = { id: rows[0].id, nombre: rows[0].nombre, pos: punto, rec: null, destinoId: null, pidiendo: false };
    log(`${rows[0].nombre} queda estacionado en ${punto.lat.toFixed(5)}, ${punto.lng.toFixed(5)}.`);
    log('En su celular: "En turno" encendido y "Compartir ubicación" apagado.');
  }

  const inicioSimulacion = new Date();
  let detener = false;
  let vuelta = 0;

  async function nuevoDestino(a) {
    a.pidiendo = true;
    try {
      const destino = puntoEnBuin();
      a.rec = prepararRecorrido(await ruta(a.pos, destino));
    } finally { a.pidiendo = false; }
  }

  async function revisarEnCamino() {
    if (!estacionado || estacionado.pidiendo) return;
    const { rows } = await db.query(
      `SELECT r.id, r."codigoTicket", r.latitud, r.longitud FROM "Reporte" r
       WHERE r."operadorAsignadoId" = $1 AND r.estado = 'DESPACHADO' AND r.latitud IS NOT NULL
         AND EXISTS (SELECT 1 FROM "HistorialEstado" h WHERE h."reporteId" = r.id AND h.comentario LIKE 'En camino%' AND h."createdAt" >= $2)
       ORDER BY r."updatedAt" DESC LIMIT 1`, [estacionado.id, inicioSimulacion]);
    const t = rows[0];
    if (!t || t.id === estacionado.destinoId) return;
    estacionado.pidiendo = true;
    try {
      estacionado.rec = prepararRecorrido(await ruta(estacionado.pos, { lat: t.latitud, lng: t.longitud }));
      estacionado.destinoId = t.id;
      log(`${estacionado.nombre} va en camino a ${t.codigoTicket} (${(estacionado.rec.total / 1000).toFixed(1)} km).`);
    } finally { estacionado.pidiendo = false; }
  }

  async function publicar(lista) {
    if (!lista.length) return;
    const valores = [], params = [];
    lista.forEach((x, i) => { valores.push(`($${i * 3 + 1}, $${i * 3 + 2}::float8, $${i * 3 + 3}::float8)`); params.push(x.id, x.pos.lat, x.pos.lng); });
    await db.query(
      `UPDATE "Operador" o SET latitud = v.lat, longitud = v.lng, "ultimaUbicacion" = now(), "gpsActivo" = true, "enTurno" = true, "updatedAt" = now()
       FROM (VALUES ${valores.join(', ')}) AS v(id, lat, lng) WHERE o.id = v.id`, params);
    if (redis && redis.status === 'ready') await redis.publish('operadores-cambio', JSON.stringify({ departamentoId: DEPARTAMENTO_ASEO })).catch(() => {});
  }

  async function terminar() {
    if (detener) return;
    detener = true;
    log('Deteniendo: los funcionarios simulados terminan su turno y se borran sus posiciones.');
    try {
      await db.query(`UPDATE "Operador" SET "enTurno" = false, "gpsActivo" = false, latitud = NULL, longitud = NULL, "ultimaUbicacion" = NULL, "updatedAt" = now() WHERE email LIKE $1`, [`%${DOMINIO}`]);
      if (estacionado) await db.query(`UPDATE "Operador" SET "gpsActivo" = false, latitud = NULL, longitud = NULL, "ultimaUbicacion" = NULL, "updatedAt" = now() WHERE id = $1`, [estacionado.id]);
      if (redis && redis.status === 'ready') await redis.publish('operadores-cambio', JSON.stringify({ departamentoId: DEPARTAMENTO_ASEO }));
    } catch (e) { console.error(e.message); }
    await db.end().catch(() => {});
    if (redis) redis.disconnect();
    process.exit(0);
  }
  process.on('SIGINT', terminar);
  process.on('SIGTERM', terminar);

  log(`Simulando ${agentes.length} funcionarios de Aseo y Ornato a ${opcion('velocidad', 30)} km/h, cada ${cadaMs / 1000} s. Ctrl+C para detener.`);
  let ultimo = Date.now();
  while (!detener) {
    const ahora = Date.now();
    const dt = (ahora - ultimo) / 1000;
    ultimo = ahora;

    for (const a of agentes) {
      if (a.modo === 'quieto') {
        // Trabajando en un punto: pequeñas variaciones como las de un GPS real
        a.pos = desplazar(a.base, azar(0, 4), Math.random() * 2 * Math.PI);
        continue;
      }
      if (ahora < a.pausaHasta || a.pidiendo) continue;
      if (!a.rec) { nuevoDestino(a).catch(() => {}); continue; }
      a.rec.avance += velocidad * dt * azar(0.85, 1.1);
      a.pos = posicionEn(a.rec);
      if (a.rec.avance >= a.rec.total) {
        a.rec = null;
        a.pausaHasta = ahora + azar(25, 90) * 1000; // se detiene a "trabajar" un rato
      }
    }

    if (estacionado) {
      if (vuelta % 2 === 0) await revisarEnCamino().catch(e => log('Error revisando la tarea:', e.message));
      if (estacionado.rec) {
        estacionado.rec.avance += velocidad * dt;
        estacionado.pos = posicionEn(estacionado.rec);
        if (estacionado.rec.avance >= estacionado.rec.total) { estacionado.rec = null; log(`${estacionado.nombre} llegó al lugar.`); }
      }
    }

    try {
      await publicar([...agentes, ...(estacionado ? [estacionado] : [])]);
      if (vuelta % 20 === 0) log(`Posiciones actualizadas (${agentes.filter(a => a.rec).length} en movimiento).`);
    } catch (e) {
      log('No se pudieron guardar las posiciones:', e.message);
    }
    vuelta++;
    await esperar(cadaMs);
  }
}

// ---------------------------------------------------------------- entrada
const comandos = { alta, iniciar, estado, limpiar, rutas: probarRutas };
if (!comandos[comando]) {
  console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 27).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(comando === 'ayuda' ? 0 : 1);
}
comandos[comando]().catch(e => { console.error('Error:', e.message); process.exit(1); });
