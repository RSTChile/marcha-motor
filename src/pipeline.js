/**
 * Marcha — Pipeline de datos
 * Consulta API BencinaEnLinea en tiempo real.
 * Busca estaciones en un rango de IDs hasta encontrar suficientes.
 */

const engine = require('./engine');

const API_BASE = 'https://api.bencinaenlinea.cl/api/estacion_ciudadano';
const CACHE_TTL = 300000; // 5 minutos

const cache = new Map();

// ─── Consulta a la API ───────────────────────────────────────────────────────

async function fetchStationById(id) {
  const url = `${API_BASE}/${id}`;
  
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'Origin': 'https://www.bencinaenlinea.cl',
        'Referer': 'https://www.bencinaenlinea.cl/'
      },
      signal: controller.signal
    });
    clearTimeout(timeout);
    
    if (!res.ok) return null;
    const json = await res.json();
    if (!json?.data?.latitud) return null;
    return json;
  } catch (err) {
    return null;
  }
}

// ─── Normalización ───────────────────────────────────────────────────────────

function normalizeStation(raw) {
  const d = raw.data;
  if (!d) return null;
  
  const prices = {};
  let latestUpdate = null;
  
  for (const c of (d.combustibles || [])) {
    const key = mapFuel(c.nombre_corto);
    if (key && c.precio) {
      prices[key] = parseFloat(c.precio);
      if (c.precio_fecha) {
        const ts = new Date(c.precio_fecha);
        if (!latestUpdate || ts > latestUpdate) latestUpdate = ts;
      }
    }
  }
  
  if (!prices.gas93 && !prices.gas95 && !prices.diesel) return null;
  
  return {
    id: d.id,
    nombre: d.razon_social?.razon_social || d.razon_social || 'Sin nombre',
    marca: d.marca || 'Desconocida',
    lat: parseFloat(d.latitud),
    lon: parseFloat(d.longitud),
    region: d.region || '',
    comuna: d.comuna || '',
    direccion: d.direccion || '',
    precios: prices,
    updated_at: latestUpdate ? latestUpdate.toISOString() : null,
    zone_type: inferZone(d.region || ''),
    report_count: 1,
    leaves_main_route: false
  };
}

function mapFuel(code) {
  const map = { '93':'gas93', '95':'gas95', '97':'gas97', 'DI':'diesel', 'KE':'kerosene' };
  return map[code] || null;
}

function inferZone(region) {
  if (region.includes('Metropolitana')) return 'urban';
  if (['Valparaíso', 'Biobío', 'Maule', "O'Higgins", 'Araucanía', 'Coquimbo'].some(r => region.includes(r))) return 'semi';
  return 'rural';
}

// ─── Búsqueda por radio (busca en rango de IDs) ─────────────────────────────

async function findStationsByRadius(lat, lon, radiusMeters = 5000) {
  const found = [];
  
  // Rango de IDs a explorar (1 a 3000 es el rango completo de Chile)
  // Para no hacer 3000 peticiones, exploramos en pasos hasta encontrar suficientes
  const ID_START = 1;
  const ID_END = 3000;
  const MAX_STATIONS = 20;
  const BATCH_SIZE = 50;
  
  for (let start = ID_START; start <= ID_END && found.length < MAX_STATIONS; start += BATCH_SIZE) {
    const end = Math.min(start + BATCH_SIZE - 1, ID_END);
    const ids = Array.from({ length: end - start + 1 }, (_, i) => start + i);
    
    // Consultar en paralelo (pero limitado para no sobrecargar)
    const batch = ids.map(id => (async () => {
      const cached = cache.get(id);
      if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
        return cached.data;
      }
      const raw = await fetchStationById(id);
      if (raw) cache.set(id, { data: raw, timestamp: Date.now() });
      return raw;
    })());
    
    const results = await Promise.all(batch);
    
    for (const raw of results) {
      if (!raw) continue;
      const station = normalizeStation(raw);
      if (!station) continue;
      
      const dist = engine.distanceMeters(lat, lon, station.lat, station.lon);
      if (dist <= radiusMeters) {
        station._dist = dist;
        found.push(station);
      }
    }
    
    // Pequeña pausa para no saturar la API
    await new Promise(r => setTimeout(r, 100));
  }
  
  return found.sort((a, b) => a._dist - b._dist);
}

// ─── Función principal ───────────────────────────────────────────────────────

async function getDecision(userProfile, context) {
  const { lat, lon, fuel_type = 'diesel', reference_price, is_urban_peak = false, toll_estimate = 0 } = context;
  
  const radius = userProfile.context_type === 'cargo' ? 15000 : 5000;
  
  console.log(`[pipeline] Buscando estaciones en radio ${radius}m desde (${lat}, ${lon})`);
  
  const stations = await findStationsByRadius(lat, lon, radius);
  
  if (stations.length === 0) {
    return {
      mode: 3,
      recommendation: null,
      alternative: null,
      message: 'No encontramos estaciones de servicio en tu zona. El sistema está en construcción.'
    };
  }
  
  console.log(`[pipeline] Encontradas ${stations.length} estaciones`);
  
  // Precio de referencia (mediana)
  const prices = stations.map(s => s.precios[fuel_type]).filter(p => p && p > 0);
  const refPrice = reference_price || (prices.length ? prices.sort((a,b) => a-b)[Math.floor(prices.length/2)] : 1500);
  
  // Preparar para el motor
  const engineStations = stations.map(s => {
    const ageMinutes = s.updated_at ? (Date.now() - new Date(s.updated_at).getTime()) / 60000 : 99999;
    return {
      id: s.id,
      nombre: s.nombre,
      marca: s.marca,
      lat: s.lat,
      lon: s.lon,
      precio_actual: s.precios[fuel_type] || 1500,
      precio_convenio: null,
      data_age_minutes: Math.round(ageMinutes),
      report_count: s.report_count || 1,
      zone_type: s.zone_type || 'semi',
      leaves_main_route: false,
      _dist_km: (s._dist / 1000).toFixed(1)
    };
  }).filter(s => s.precio_actual > 0);
  
  const engineContext = {
    user_lat: lat,
    user_lon: lon,
    reference_price: refPrice,
    is_urban_peak,
    toll_estimate
  };
  
  return engine.decide(engineStations, userProfile, engineContext);
}

module.exports = { getDecision };