// Detección de intención sin IA: rápida, predecible y sin costo.
// Evita que una consulta ("¿qué reportes tengo?") o un arrepentimiento ("no quiero crear un caso")
// se registre como un reporte nuevo. Si no hay certeza, devuelve todo en false y decide la IA.

const normalizar = (s) => ` ${String(s || '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase()
  .replace(/[¡!¿?.,;:()"']+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()} `;

const tiene = (t, lista) => lista.some(p => t.includes(` ${p} `));

// Sustantivos con los que el vecino se refiere a lo que ya envió
const SUSTANTIVOS = ['reporte', 'reportes', 'reclamo', 'reclamos', 'denuncia', 'denuncias', 'caso', 'casos', 'ticket', 'tickets',
  'solicitud', 'solicitudes', 'aviso', 'avisos', 'codigo', 'codigos', 'numero de reporte', 'numero de reclamo'];

// Palabras que indican que quiere VER o SABER (no crear)
const CONSULTA = ['ver', 'veo', 'revisar', 'consultar', 'saber', 'tengo', 'tenia', 'tiene', 'hice', 'he hecho', 'hecho', 'hechos',
  'envie', 'mande', 'he enviado', 'enviados', 'mis', 'mi', 'cuantos', 'cuantas', 'cuales', 'como va', 'como van', 'estado', 'estados',
  'donde esta', 'donde estan', 'que paso con', 'que pasa con', 'seguimiento', 'lista', 'historial', 'anteriores', 'anterior',
  'pendientes', 'abiertos', 'activos', 'avance', 'novedades', 'respuesta', 'resolvieron', 'atendieron'];

// Frases de quien quiere REPORTAR algo nuevo (tienen prioridad sobre la consulta)
const REPORTAR = ['quiero reportar', 'quiero denunciar', 'quiero avisar', 'quiero hacer un reporte', 'quiero hacer un reclamo',
  'quiero hacer una denuncia', 'hacer un reporte', 'hacer un reclamo', 'nuevo reporte', 'nuevo reclamo', 'reportar un', 'reportar una',
  'necesito reportar', 'vengo a reportar', 'para reportar', 'otro reporte', 'otro reclamo'];

// Arrepentimiento: no quería crear un reporte
const CANCELAR = ['no quiero crear', 'no quiero hacer', 'no quiero reportar', 'no quiero enviar', 'no quiero registrar',
  'no quiero un reporte', 'no quiero un caso', 'no quiero reclamar', 'no es un reporte', 'no es un reclamo', 'no era eso',
  'me equivoque', 'me confundi', 'era una prueba', 'era prueba', 'olvidalo', 'olvidate', 'olvida eso', 'cancela esto',
  'cancela eso', 'cancelar esto', 'borra esto', 'no registres'];

const AYUDA = ['ayuda', 'como funciona', 'como funciona esto', 'que puedo hacer', 'para que sirve', 'que hace esto',
  'instrucciones', 'no entiendo', 'no se como', 'como lo hago', 'como hago', 'que hago'];

// Si el texto describe un problema concreto, no se decide aquí: lo clasifica la IA
const PROBLEMA = ['bache', 'baches', 'hoyo', 'hoyos', 'hundimiento', 'pavimento', 'basura', 'basural', 'microbasural', 'escombros',
  'desechos', 'luminaria', 'luminarias', 'luz', 'luces', 'poste', 'foco', 'oscuro', 'auto', 'autos', 'vehiculo', 'camioneta', 'camion',
  'ruido', 'ruidos', 'musica', 'fiesta', 'perro', 'perros', 'gato', 'gatos', 'animal', 'animales', 'arbol', 'arboles', 'rama', 'ramas',
  'pasto', 'plaza', 'semaforo', 'senal', 'senaletica', 'letrero', 'disco pare', 'calle', 'esquina', 'vereda', 'pasaje', 'avenida',
  'agua', 'fuga', 'inundacion', 'alcantarilla', 'quema', 'humo', 'incendio', 'choque', 'accidente', 'hay un', 'hay una', 'hay unos'];

const NEGATIVA_SOLA = /^ (no+|nop|nones|no gracias|no tengo|no tengo foto|sin foto|no puedo|nada) $/;

/**
 * Devuelve { consultar, cancelar, ayuda, negativa }.
 * - consultar: quiere ver sus reportes.
 * - cancelar: no quería crear el reporte en curso.
 * - ayuda: pide ayuda o no entiende.
 * - negativa: un "no" suelto (su significado depende del paso en que está el vecino).
 */
function detectarIntencion(texto) {
  const t = normalizar(texto);
  const quiereReportar = tiene(t, REPORTAR) && !tiene(t, ['ver', 'revisar', 'consultar']);
  const consultar = !quiereReportar && (
    /^ (estado|estados|seguimiento|mis reportes|mis reclamos|mis casos) $/.test(t) ||
    (tiene(t, SUSTANTIVOS) && tiene(t, CONSULTA) && !tiene(t, PROBLEMA))
  );
  const cancelar = tiene(t, CANCELAR);
  const ayuda = !consultar && !cancelar && (tiene(t, AYUDA) && t.trim().split(' ').length <= 8);
  const negativa = NEGATIVA_SOLA.test(t);
  return { consultar, cancelar, ayuda, negativa };
}

module.exports = { detectarIntencion };
