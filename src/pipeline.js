// =============================================
// BASE + UTILIDADES
// =============================================

const fetch = require('node-fetch');

let comunaCoordsCache = null;

// Normalización segura
function normalizeText(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

// Número válido
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Primer número válido
function firstNumber(...vals) {
  for (const v of vals) {
    const n = num(v);
    if (n !== null && n > 0) return n;
  }
  return 0;
}
// =============================================
// LOAD COORDS (FIX DEFINITIVO)
// =============================================

async function loadComunaCoords() {
  if (comunaCoordsCache) return comunaCoordsCache;

  try {
    const url = 'https://raw.githubusercontent.com/RSTChile/marcha-motor/refs/heads/main/data/comunas-completo.json';

    const res = await fetch(url);

    if (!res.ok) {
      console.error('[pipeline] ❌ Error HTTP coords:', res.status);
      comunaCoordsCache = {};
      return {};
    }

    const json = await res.json();

    let items = [];

    if (Array.isArray(json)) {
      items = json;
    } else if (Array.isArray(json.comunas)) {
      items = json.comunas;
    } else {
      items = Object.values(json);
    }

    const map = {};

    for (const item of items) {
      const nombre = item.nombre || item.comuna || item.name;
      const lat = num(item.lat ?? item.latitud ?? item.latitude);
      const lon = num(item.lon ?? item.longitud ?? item.longitude);

      if (!nombre || lat === null || lon === null) continue;

      map[normalizeText(nombre)] = {
        nombre,
        lat,
        lon
      };
    }

    comunaCoordsCache = map;

    console.log(`[pipeline] 🗺️ Coordenadas cargadas: ${Object.keys(map).length}`);

    return map;

  } catch (err) {
    console.error('[pipeline] ❌ Error coords:', err.message);
    comunaCoordsCache = {};
    return {};
  }
}
// =============================================
// RESOLVE COMUNA
// =============================================

async function resolveComunaData(nombre) {
  const map = await loadComunaCoords();
  return map[normalizeText(nombre)] || null;
}

async function getComunaCoords(nombre) {
  const c = await resolveComunaData(nombre);
  return c ? { lat: c.lat, lon: c.lon } : null;
}
// =============================================
// NORMALIZACIÓN DE ESTACIONES (CLAVE)
// =============================================

function normalizeStation(raw) {

  const nombre =
    raw.nombre ||
    raw.brand ||
    raw.razon_social ||
    'Estación';

  const direccion =
    raw.direccion ||
    raw.address ||
    raw.calle ||
    '';

  const comuna =
    raw.comuna ||
    raw.location ||
    '';

  const precios_detalle =
    raw.precios ||
    raw.prices ||
    [];

  const servicios =
    raw.servicios ||
    [];

  const metodos_pago =
    raw.metodos_pago ||
    [];

  const distancia =
    firstNumber(
      raw.display_distance_km,
      raw.real_distance_km,
      raw.distance_km,
      raw.distancia
    );

  const precio =
    firstNumber(
      raw.display_price,
      raw.precio_actual,
      raw.price
    );

  return {
    station: {
      nombre,
      direccion,
      comuna,
      precios_detalle,
      servicios,
      metodos_pago
    },
    display_price: precio,
    display_distance_km: distancia
  };
}
// =============================================
// DISTANCIA (ORS YA LO TIENES)
// =============================================

async function enrichWithDistance(stations, user_lat, user_lon) {

  return stations.map(s => {

    const dist = firstNumber(
      s.display_distance_km,
      s.distance_km,
      s.distancia
    );

    return {
      ...s,
      display_distance_km: dist
    };
  });
}
// =============================================
// DECISIÓN
// =============================================

function chooseBest(stations) {

  if (!stations.length) return null;

  const sorted = stations
    .filter(s => s.display_price > 0)
    .sort((a, b) => a.display_price - b.display_price);

  return {
    best: sorted[0],
    alternatives: sorted.slice(1, 3)
  };
}
// =============================================
// PIPELINE PRINCIPAL
// =============================================

async function runPipeline(input) {

  const { context } = input;

  const { user_lat, user_lon } = context;

  // 🔹 1. Fetch estaciones (tu endpoint actual)
  const res = await fetch('https://api.bencinaenlinea.cl/stations'); // usa tu endpoint real
  const rawStations = await res.json();

  // 🔹 2. NORMALIZACIÓN (CLAVE)
  const normalized = rawStations.map(normalizeStation);

  // 🔹 3. DISTANCIA
  const withDistance = await enrichWithDistance(
    normalized,
    user_lat,
    user_lon
  );

  // 🔹 4. DECISIÓN
  const decision = chooseBest(withDistance);

  if (!decision) {
    return {
      mode: 3,
      message: 'No hay estaciones disponibles'
    };
  }

  return {
    mode: 0,
    recommendation: decision.best,
    alternatives: decision.alternatives,
    message: 'Evaluación completada'
  };
}
// =============================================
// EXPORT
// =============================================

module.exports = {
  runPipeline
};
