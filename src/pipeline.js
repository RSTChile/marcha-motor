/**
 * Marcha — Pipeline CORREGIDO
 * - Orden de parámetros fijo: decide(user, stations, context)
 * - Ruta dinámica (funciona local y en Render)
 * - Validación de entrada
 */

const fs = require('fs');
const path = require('path');
const engine = require('./engine');

// Ruta dinámica (funciona en cualquier entorno)
const DATA_FILE = path.join(__dirname, '..', 'data', 'stations.json');

// Distancia (Haversine)
function distanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = deg => deg * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2)**2 +
            Math.cos(toRad(lat1)) *
            Math.cos(toRad(lat2)) *
            Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// Cargar estaciones desde el archivo
function loadStations() {
  try {
    console.log(`[pipeline] Buscando archivo en: ${DATA_FILE}`);
    if (!fs.existsSync(DATA_FILE)) {
      console.log('[pipeline] stations.json no existe');
      return [];
    }
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    const stations = raw.stations || [];
    console.log(`[pipeline] Cargadas ${stations.length} estaciones`);
    return stations;
  } catch (err) {
    console.error('[pipeline] Error cargando stations.json:', err.message);
    return [];
  }
}

// Función principal
async function runPipeline({ userProfile, context }) {
  try {
    console.log('[pipeline] Iniciando runPipeline');
    
    const { user_lat, user_lon, fuel_type = 'diesel', reference_price = 1500, is_urban_peak = false, toll_estimate = 0 } = context;
    
    // Validar coordenadas
    if (typeof user_lat !== 'number' || typeof user_lon !== 'number') {
      console.log('[pipeline] Coordenadas inválidas:', user_lat, user_lon);
      return { mode: 3, recommendation: null, alternative: null, message: 'Ubicación inválida' };
    }

    console.log(`[pipeline] Buscando cerca de (${user_lat}, ${user_lon})`);

    // Cargar estaciones
    const allStations = loadStations();
    if (!allStations.length) {
      return { mode: 3, recommendation: null, alternative: null, message: 'No hay datos de estaciones' };
    }

    // Radio de búsqueda (50 km)
    const radiusMeters = 50000;
    
    // Filtrar estaciones cercanas
    const nearby = allStations
      .filter(s => {
        if (typeof s.lat !== 'number' || typeof s.lon !== 'number') return false;
        const dist = distanceMeters(user_lat, user_lon, s.lat, s.lon);
        return dist <= radiusMeters;
      })
      .map(s => ({ ...s, _dist_m: distanceMeters(user_lat, user_lon, s.lat, s.lon) }))
      .sort((a, b) => a._dist_m - b._dist_m)
      .slice(0, 20);

    console.log(`[pipeline] Encontradas ${nearby.length} estaciones cerca`);

    if (!nearby.length) {
      return { mode: 3, recommendation: null, alternative: null, message: 'No hay estaciones en un radio de 50 km' };
    }

    // Preparar estaciones para el motor
    const stationsForEngine = [];
    
    for (const s of nearby) {
      const precio = s.precios?.[fuel_type];
      if (!precio) continue;
      
      const ageMinutes = s.updated_at ? (Date.now() - new Date(s.updated_at).getTime()) / 60000 : 999;
      
      stationsForEngine.push({
        id: s.id,
        nombre: s.nombre,
        marca: s.marca,
        lat: s.lat,
        lon: s.lon,
        precio_actual: precio,
        precio_convenio: null,
        data_age_minutes: Math.round(ageMinutes),
        report_count: s.report_count || 1,
        zone_type: s.zone_type || 'semi',
        leaves_main_route: false
      });
    }

    console.log(`[pipeline] Preparadas ${stationsForEngine.length} estaciones para el motor`);

    if (!stationsForEngine.length) {
      return { mode: 3, recommendation: null, alternative: null, message: `No hay estaciones con ${fuel_type} cerca` };
    }

    // Contexto para el motor
    const engineContext = {
      user_lat,
      user_lon,
      reference_price,
      is_urban_peak,
      toll_estimate
    };

    console.log('[pipeline] Llamando a engine.decide...');
    // 🔥 CORRECCIÓN CRÍTICA: orden correcto de parámetros
    const result = engine.decide(userProfile, stationsForEngine, engineContext);
    console.log('[pipeline] Motor respondió con mode:', result.mode);
    
    return result;

  } catch (err) {
    console.error('[pipeline] Error fatal:', err);
    return { mode: 3, recommendation: null, alternative: null, message: `Error: ${err.message}` };
  }
}

module.exports = { runPipeline };
