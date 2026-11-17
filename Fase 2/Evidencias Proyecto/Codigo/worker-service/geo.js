// Verificación geográfica: ¿el punto está dentro de la comuna de Buin?
const limite = require('./datos/limite-buin.json');

// Tolerancia en metros para puntos justo en el borde (error normal del GPS)
const TOLERANCIA_M = Number(process.env.TOLERANCIA_LIMITE_M || 150);

const anillos = (() => {
  const g = limite.geometry || limite.features?.[0]?.geometry;
  if (g.type === 'Polygon') return [g.coordinates];
  if (g.type === 'MultiPolygon') return g.coordinates;
  return [];
})();

function dentroDeAnillo(lng, lat, anillo) {
  let dentro = false;
  for (let i = 0, j = anillo.length - 1; i < anillo.length; j = i++) {
    const [xi, yi] = anillo[i];
    const [xj, yj] = anillo[j];
    if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) dentro = !dentro;
  }
  return dentro;
}

// Distancia aproximada (m) de un punto al borde de la comuna
function distanciaAlBordeM(lng, lat) {
  const kx = 111320 * Math.cos(lat * Math.PI / 180);
  const ky = 110540;
  let min = Infinity;
  anillos.forEach(poligono => poligono.forEach(anillo => {
    for (let i = 0; i < anillo.length - 1; i++) {
      const ax = (anillo[i][0] - lng) * kx, ay = (anillo[i][1] - lat) * ky;
      const bx = (anillo[i + 1][0] - lng) * kx, by = (anillo[i + 1][1] - lat) * ky;
      const dx = bx - ax, dy = by - ay;
      const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy || 1)));
      min = Math.min(min, Math.hypot(ax + t * dx, ay + t * dy));
    }
  }));
  return min;
}

/** Devuelve { dentro, distanciaM } — dentro es true también si está a menos de la tolerancia del borde */
function verificarUbicacion(lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return { dentro: false, distanciaM: Infinity };
  const enPoligono = anillos.some(p => dentroDeAnillo(lng, lat, p[0]) && !p.slice(1).some(h => dentroDeAnillo(lng, lat, h)));
  if (enPoligono) return { dentro: true, distanciaM: 0 };
  const distanciaM = distanciaAlBordeM(lng, lat);
  return { dentro: distanciaM <= TOLERANCIA_M, distanciaM };
}

module.exports = { verificarUbicacion };
