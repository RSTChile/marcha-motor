/**
 * Marcha — Conector API real
 * Fuente: api.bencinaenlinea.cl
 */

const fetch = require('node-fetch');

const BASE_URL = 'https://api.bencinaenlinea.cl/api/estacion_ciudadano';
const TIMEOUT_MS = 10000;
const RETRY_MAX = 2;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchJson(url, timeoutMs = TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json, text/plain, */*',
        'Content-Type': 'application/json',
        Origin: 'https://www.bencinaenlinea.cl',
        Referer: 'https://www.bencinaenlinea.cl/',
      },
      signal: controller.signal,
    });

    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    return await res.json();
  } catch (err) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchStationRaw(id) {
  const url = `${BASE_URL}/${id}`;

  for (let attempt = 0; attempt <= RETRY_MAX; attempt++) {
    try {
      const json = await fetchJson(url);
      if (!json?.data?.latitud || !json?.data?.longitud) return null;
      return json;
    } catch (err) {
      if (attempt === RETRY_MAX) return null;
      await sleep(500 * (attempt + 1));
    }
  }

  return null;
}

function mapFuel(code) {
  const map = {
    '93': 'gas93',
    '95': 'gas95',
    '97': 'gas97',
    'DI': 'diesel',
    'KE': 'kerosene',
    'GNC': 'gnc',
    'GLP': 'glp',
  };
  return map[code] || null;
}

function inferZone(region = '') {
  if (region.includes('Metropolitana')) return 'urban';
  if (['Valparaíso', 'Coquimbo', 'Biobío', 'Maule', "O'Higgins", 'Araucanía', 'Ñuble', 'Los Lagos'].some(r => region.includes(r))) {
    return 'semi';
  }
  return 'rural';
}

function normalizeStation(raw) {
  const d = raw?.data;
  if (!d) return null;

  const prices = {};
  let latestUpdate = null;

  for (const c of d.combustibles || []) {
    const key = mapFuel(c.nombre_corto);
    if (!key || !c.precio) continue;

    prices[key] = parseFloat(c.precio);

    if (c.precio_fecha) {
      const ts = new Date(c.precio_fecha);
      if (!Number.isNaN(ts.getTime()) && (!latestUpdate || ts > latestUpdate)) {
        latestUpdate = ts;
      }
    }
  }

  if (!prices.gas93 && !prices.gas95 && !prices.gas97 && !prices.diesel) {
    return null;
  }

  return {
    id: d.id,
    nombre: d.razon_social?.razon_social || d.razon_social || 'Sin nombre',
    marca: d.marca || 'Desconocida',
    region: d.region || '',
    comuna: d.comuna || '',
    direccion: d.direccion || '',
    lat: parseFloat(d.latitud),
    lon: parseFloat(d.longitud),
    estado: d.estado || '',
    precios: prices,
    updated_at: latestUpdate ? latestUpdate.toISOString() : null,
    zone_type: inferZone(d.region || ''),
    report_count: 1,
  };
}

module.exports = {
  BASE_URL,
  fetchStationRaw,
  normalizeStation,
  mapFuel,
  inferZone,
};