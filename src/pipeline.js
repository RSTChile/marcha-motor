/**
 * Marcha — Pipeline v4.3
 * Mantiene la estructura del pipeline real y agrega:
 *   - autonomía
 *   - destino
 *   - búsqueda de comunas en ruta
 *   - filtro de estaciones por trayectoria
 *   - uso moderado de ORS para evitar 429
 */

const engine = require('./engine');
const fs = require('fs');
const path = require('path');

const COMUNA_STATIONS_FILE = path.join(__dirname, '..', 'data', 'comunas-stations.json');
const COMUNAS_COMPLETE_FILE = path.join(__dirname, '..', 'data', 'comunas-completo.json');

const FETCH_TIMEOUT_MS = 8000;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutos
const ORS_TOP_CANDIDATES = 5; // solo las más cercanas usan ORS para evitar 429

const MIN_REALISTIC_PRICES = {
  diesel: 1200,
  gas93: 1200,
  gas95: 1250,
  gas97: 1300
};

// Basic Key de ORS
const ORS_API_KEY = 'eyJvcmciOiI1YjNjZTM1OTc4NTExMTAwMDFjZjYyNDgiLCJpZCI6ImU0ODZkY2U1MzU0MTQ4YzFiMDgwMTg2YTYyYTBiOThiIiwiaCI6Im11cm11cjY0In0=';

const stationsCache = new Map();
const routeCache = new Map();

let comunasMapCache = null;
let comunasCompleteCache = null;

// =============================================
// NORMALIZACIÓN
// =============================================

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

// =============================================
// CARGA DEL MAPEO COMUNA → IDs
// =============================================

function loadComunaStationsMap() {
  if (comunasMapCache) return comunasMapCache;

  try {
    if (!fs.existsSync(COMUNA_STATIONS_FILE)) {
      console.error('[pipeline] ❌ comunas-stations.json no encontrado');
      return {};
    }

    const raw = JSON.parse(fs.readFileSync(COMUNA_STATIONS_FILE, 'utf8'));
    comunasMapCache = raw.comunas || {};
    console.log(`[pipeline] 📍 Mapeo cargado: ${Object.keys(comunasMapCache).length} comunas`);
    return comunasMapCache;
  } catch (err) {
    console.error('[pipeline] Error cargando mapeo:', err.message);
    return {};
  }
}

// =============================================
// CARGA DE COORDENADAS DE COMUNAS
// =============================================

function loadComunasCompleteMap() {
  if (comunasCompleteCache) return comunasCompleteCache;

  try {
    if (!fs.existsSync(COMUNAS_COMPLETE_FILE)) {
      console.error('[pipeline] ❌ comunas-completo.json no encontrado');
      return {};
    }

    const raw = JSON.parse(fs.readFileSync(COMUNAS_COMPLETE_FILE, 'utf8'));
    const list = raw.comunas || [];

    const map = {};
    for (const item of list) {
      const key = normalizeText(item.nombre);
      map[key] = item;
    }

    comunasCompleteCache = map;
    console.log(`[pipeline] 🗺️ Coordenadas cargadas: ${Object.keys(comunasCompleteCache).length} comunas`);
    return comunasCompleteCache;
  } catch (err) {
    console.error('[pipeline] Error cargando comunas completas:', err.message);
    return {};
  }
}

// =============================================
// RESOLVER COMUNA DESDE MAPA
// =============================================

function resolveComunaData(comunaMap, comunaInput) {
  const comunaNorm = normalizeText(comunaInput);

  for (const [key, value] of Object.entries(comunaMap)) {
    if (normalizeText(key) === comunaNorm) {
      return { key, value };
    }
  }

  return null;
}

// =============================================
// OBTENER COORDENADAS DE UNA COMUNA
// =============================================

function getComunaCoords(comunaInput) {
  const comunasComplete = loadComunasCompleteMap();
  const item = comunasComplete[normalizeText(comunaInput)];

  if (!item) return null;

  const lat = typeof item.lat === 'number' ? item.lat : parseFloat(item.lat);
  const lon = typeof item.lng === 'number' ? item.lng : parseFloat(item.lng);

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  return {
    nombre: item.nombre,
    region: item.region,
    lat,
    lon
  };
}
// =============================================
// DISTANCIA REAL POR CARRETERA (OpenRouteService)
// POST + Authorization header
// =============================================

async function getRealDistance(lat1, lon1, lat2, lon2) {
  const cacheKey = `${lat1.toFixed(4)},${lon1.toFixed(4)}|${lat2.toFixed(4)},${lon2.toFixed(4)}`;

  const cached = routeCache.get(cacheKey);
  if (cached && (Date.now() - cached.timestamp) < CACHE_TTL_MS) {
    return cached.distance;
  }

  try {
    const response = await fetch(
      'https://api.openrouteservice.org/v2/directions/driving-car',
      {
        method: 'POST',
        headers: {
          Authorization: ORS_API_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          coordinates: [
            [lon1, lat1],
            [lon2, lat2]
          ]
        })
      }
    );

    if (!response.ok) {
      return null;
    }

    const routeData = await response.json();

    if (routeData.features?.[0]?.properties?.summary?.distance) {
      const distanceKm = routeData.features[0].properties.summary.distance / 1000;

      routeCache.set(cacheKey, {
        distance: distanceKm,
        timestamp: Date.now()
      });

      return distanceKm;
    }

    return null;
  } catch (err) {
    return null;
  }
}

// =============================================
// DISTANCIA EN LÍNEA RECTA (Haversine) — FALLBACK
// =============================================

function haversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) *
      Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLon / 2) ** 2;

  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// =============================================
// CONSULTA A LA API POR ID
// =============================================

async function fetchStationById(id) {
  const cached = stationsCache.get(id);
  if (cached && (Date.now() - cached.timestamp) < CACHE_TTL_MS) {
    return cached.data;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const res = await fetch(
      `https://api.bencinaenlinea.cl/api/estacion_ciudadano/${id}`,
      {
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          Origin: 'https://www.bencinaenlinea.cl',
          Referer: 'https://www.bencinaenlinea.cl/'
        }
      }
    );

    clearTimeout(timeout);

    if (!res.ok) return null;

    const json = await res.json();
    const d = json?.data;
    if (!d?.latitud || !d?.longitud) return null;

    if (d.estado_bandera !== 1) {
      console.log(`[pipeline] 🚫 Excluyendo estación ${d.id}: inactiva`);
      return null;
    }

    const precios = {
      diesel: null,
      gas93: null,
      gas95: null,
      gas97: null,
      kerosene: null
    };

    const preciosDetalle = [];

    for (const c of d.combustibles || []) {
      if (!c.precio) continue;

      const precioNum = Math.floor(parseFloat(c.precio));
      const tipo = c.nombre_corto;

      if (tipo === 'DI') precios.diesel = precioNum;
      if (tipo === '93') precios.gas93 = precioNum;
      if (tipo === '95') precios.gas95 = precioNum;
      if (tipo === '97') precios.gas97 = precioNum;
      if (tipo === 'KE') precios.kerosene = precioNum;

      preciosDetalle.push({
        tipo: c.nombre_largo || c.nombre_corto,
        precio: precioNum,
        unidad: c.unidad_cobro || '$/L',
        actualizado: c.actualizado || null
      });
    }

    const station = {
      id: d.id,
      nombre: getMarcaNombre(d.marca),
      nombre_legal: d.razon_social?.razon_social || d.razon_social || 'Estación',
      marca: d.marca || 'NA',
      region: d.region || '',
      comuna: d.comuna || '',
      direccion: d.direccion || '',
      lat: parseFloat(d.latitud),
      lon: parseFloat(d.longitud),
      precios,
      precios_detalle: preciosDetalle,
      servicios: d.servicios || [],
      metodos_pago: d.metodos_pago || [],
      fetched_at: Date.now()
    };

    stationsCache.set(id, { data: station, timestamp: Date.now() });
    return station;
  } catch (err) {
    console.error(`[pipeline] Error fetching station ${id}:`, err.message);
    return null;
  }
}

function getMarcaNombre(marcaId) {
  const marcas = {
    1: 'Copec',
    2: 'Shell',
    3: 'Petrobras',
    4: 'ENEX',
    5: 'Copec',
    10: 'Shell',
    15: 'Petrobras',
    23: 'Abastible',
    24: 'Lipigas',
    151: 'Esmax',
    177: 'Autogasco'
  };

  return marcas[marcaId] || 'Estación';
}

// =============================================
// CONSULTAR MÚLTIPLES ESTACIONES
// =============================================

async function fetchStationsByIds(ids) {
  console.log(`[pipeline] 🔄 Consultando ${ids.length} estaciones...`);

  const batchSize = 10;
  const results = [];

  for (let i = 0; i < ids.length; i += batchSize) {
    const batch = ids.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(id => fetchStationById(id)));
    results.push(...batchResults.filter(Boolean));

    if (i + batchSize < ids.length) {
      await new Promise(r => setTimeout(r, 100));
    }
  }

  console.log(`[pipeline] ✅ ${results.length} estaciones obtenidas`);
  return results;
}
// =============================================
// INFERIR TIPO DE ZONA
// =============================================

function inferZoneType(region) {
  if (!region) return 'semi';

  const r = region.toLowerCase();

  if (r.includes('metropolitana')) return 'urban';

  const semiUrban = ['valparaíso', 'coquimbo', 'biobío', 'maule', "o'higgins", 'araucanía', 'los lagos'];
  if (semiUrban.some(x => r.includes(x))) return 'semi';

  return 'rural';
}

// =============================================
// AUTONOMÍA
// fuel_consumption llega como litros por 100 km
// current_level_pct llega como porcentaje del estanque
// =============================================

function calculateAutonomyKm(userProfile) {
  const tankCapacity = Number(userProfile?.tank_capacity || 0);
  const currentLevelPct = Number(userProfile?.current_level_pct || 0);
  const fuelConsumption = Number(userProfile?.fuel_consumption || 0);

  if (!Number.isFinite(tankCapacity) || tankCapacity <= 0) return 0;
  if (!Number.isFinite(currentLevelPct) || currentLevelPct <= 0) return 0;
  if (!Number.isFinite(fuelConsumption) || fuelConsumption <= 0) return 0;

  const litersAvailable = tankCapacity * (currentLevelPct / 100);
  const kmPerLiter = 100 / fuelConsumption;

  if (!Number.isFinite(kmPerLiter) || kmPerLiter <= 0) return 0;

  return litersAvailable * kmPerLiter;
}

// =============================================
// GEOMETRÍA DE TRAYECTORIA
// =============================================

function isStationForwardOnTrip(origin, destination, point) {
  const dx = destination.lon - origin.lon;
  const dy = destination.lat - origin.lat;

  const px = point.lon - origin.lon;
  const py = point.lat - origin.lat;

  const dot = dx * px + dy * py;
  return dot > 0;
}

function distancePointToLine(origin, destination, point) {
  const dx = destination.lon - origin.lon;
  const dy = destination.lat - origin.lat;

  const px = point.lon - origin.lon;
  const py = point.lat - origin.lat;

  const len = Math.sqrt(dx * dx + dy * dy);
  if (len === 0) return Infinity;

  return Math.abs(dx * py - dy * px) / len;
}

// =============================================
// COMUNAS CANDIDATAS EN RUTA
// =============================================

function getRouteCandidateComunas(originComunaName, destinationName, originCoords, autonomyKm) {
  const comunaMap = loadComunaStationsMap();
  const destinationCoords = getComunaCoords(destinationName);

  if (!destinationCoords) return [];

  const safeRange = autonomyKm > 0 ? autonomyKm * 1.25 : Infinity;
  const candidates = [];

  for (const comunaName of Object.keys(comunaMap)) {
    const coords = getComunaCoords(comunaName);
    if (!coords) continue;

    const point = { lat: coords.lat, lon: coords.lon };
    const forward = isStationForwardOnTrip(originCoords, destinationCoords, point);
    if (!forward) continue;

    const lateral = distancePointToLine(originCoords, destinationCoords, point);
    if (lateral > 1.2) continue;

    const distFromOrigin = haversineDistance(originCoords.lat, originCoords.lon, coords.lat, coords.lon);
    if (Number.isFinite(safeRange) && distFromOrigin > safeRange) continue;

    candidates.push(comunaName);
  }

  if (!candidates.some(c => normalizeText(c) === normalizeText(originComunaName))) {
    candidates.push(originComunaName);
  }

  return [...new Set(candidates)];
}

// =============================================
// OBTENER IDs DE ESTACIONES PARA BÚSQUEDA
// =============================================

function getStationIdsForSearch(comunaOriginal, destino, originCoords, autonomyKm) {
  const comunaMap = loadComunaStationsMap();

  if (!destino) {
    const comunaData = comunaMap[comunaOriginal];
    return comunaData?.stations?.map(s => s.id) || [];
  }

  const candidateComunas = getRouteCandidateComunas(comunaOriginal, destino, originCoords, autonomyKm);

  if (!candidateComunas.length) {
    const comunaData = comunaMap[comunaOriginal];
    return comunaData?.stations?.map(s => s.id) || [];
  }

  const ids = [];
  for (const comunaName of candidateComunas) {
    const resolved = resolveComunaData(comunaMap, comunaName);
    const stationIds = resolved?.value?.stations?.map(s => s.id) || [];
    ids.push(...stationIds);
  }

  return [...new Set(ids)];
}
// =============================================
// PREPARAR ESTACIÓN PARA EL MOTOR
// =============================================

function prepareStation(station, fuelType, realDistanceKm) {
  const fuelLabels = {
    diesel: 'Diesel',
    gas93: 'Gasolina 93',
    gas95: 'Gasolina 95',
    gas97: 'Gasolina 97'
  };

  const price = station.precios[fuelType];
  const minPrice = MIN_REALISTIC_PRICES[fuelType] || 1200;

  if (!price || price <= 0) return null;

  if (price < minPrice) {
    console.log(`[pipeline] ⚠️ Excluyendo ${station.nombre}: ${fuelLabels[fuelType]} = $${price} (mínimo $${minPrice})`);
    return null;
  }

  const ageMinutes = Math.min(Math.round((Date.now() - station.fetched_at) / 60000), 60);

  console.log(
    `[pipeline] 📊 ${station.nombre} (${station.comuna}): ${fuelLabels[fuelType]}=$${price}, distancia_real=${realDistanceKm.toFixed(1)}km`
  );

  return {
    id: station.id,
    nombre: station.nombre,
    nombre_legal: station.nombre_legal,
    direccion: station.direccion,
    comuna: station.comuna,
    marca: station.marca,
    lat: station.lat,
    lon: station.lon,
    precio_actual: price,
    precios_detalle: station.precios_detalle,
    servicios: station.servicios,
    metodos_pago: station.metodos_pago,
    precio_convenio: null,
    data_age_minutes: ageMinutes,
    report_count: 1,
    zone_type: inferZoneType(station.region),
    leaves_main_route: false,
    _real_distance_km: realDistanceKm
  };
}

// =============================================
// PRECIO DE REFERENCIA (mediana)
// =============================================

function calculateReferencePrice(engineStations) {
  const prices = engineStations
    .map(s => s.precio_actual)
    .filter(p => p > 0)
    .sort((a, b) => a - b);

  if (prices.length === 0) return 1500;

  const mid = Math.floor(prices.length / 2);
  return prices.length % 2 === 0
    ? Math.round((prices[mid - 1] + prices[mid]) / 2)
    : prices[mid];
}

// =============================================
// ENRIQUECER RESULTADO DEL MOTOR
// Usa station_id (no station.id)
// =============================================

function buildStationObj(original) {
  return {
    id: original.id,
    nombre: original.nombre,
    nombre_legal: original.nombre_legal,
    direccion: original.direccion,
    comuna: original.comuna,
    marca: original.marca,
    precios_detalle: original.precios_detalle,
    servicios: original.servicios,
    metodos_pago: original.metodos_pago
  };
}

function enrichOne(scored, stationsWithRealDist, fuelType) {
  if (!scored) return scored;

  const original = stationsWithRealDist.find(s => s.id === scored.station_id);
  if (original) {
    const correctPrice = original.precios[fuelType];

    if (correctPrice && correctPrice > 0) {
      scored.display_price = correctPrice;
      const liters = scored.display_liters || 0;
      scored.display_total_cost = Math.floor(correctPrice * liters);
    }

    scored.display_distance_km = original._real_distance_km;
    scored.station = buildStationObj(original);
  }

  if (scored.net_saving) {
    scored.net_saving = Math.floor(scored.net_saving);
  }

  return scored;
}

function enrichResult(result, stationsWithRealDist, fuelType) {
  result.recommendation = enrichOne(result.recommendation, stationsWithRealDist, fuelType);

  if (Array.isArray(result.alternatives)) {
    result.alternatives = result.alternatives.map(a => enrichOne(a, stationsWithRealDist, fuelType));
  }

  result.alternative = result.alternatives?.[0] || null;

  return result;
}
// =============================================
// PIPELINE PRINCIPAL
// =============================================

async function runPipeline({ userProfile, context }) {
  const startTime = Date.now();

  try {
    console.log('[pipeline] 🚀 Iniciando...');

    const { user_lat, user_lon, fuel_type = 'diesel', comuna, destino } = context;

    if (typeof user_lat !== 'number' || typeof user_lon !== 'number') {
      return {
        mode: 3,
        recommendation: null,
        alternative: null,
        message: 'Ubicación inválida'
      };
    }

    if (!comuna) {
      return {
        mode: 3,
        recommendation: null,
        alternative: null,
        message: 'Selecciona una comuna válida'
      };
    }

    const autonomiaKm = calculateAutonomyKm(userProfile);
    console.log(`[pipeline] ⛽ Autonomía estimada: ${Math.round(autonomiaKm)} km`);

    const comunaMap = loadComunaStationsMap();
    const resolvedComuna = resolveComunaData(comunaMap, comuna);

    if (!resolvedComuna) {
      console.log(`[pipeline] ⚠️ Comuna "${comuna}" no encontrada`);
      return {
        mode: 3,
        recommendation: null,
        alternative: null,
        message: `No hay estaciones para ${comuna}`
      };
    }

    const comunaOriginal = resolvedComuna.key;
    const originCoords = { lat: user_lat, lon: user_lon };

    const stationIds = getStationIdsForSearch(comunaOriginal, destino, originCoords, autonomiaKm);

    if (stationIds.length === 0) {
      return {
        mode: 3,
        recommendation: null,
        alternative: null,
        message: `No hay estaciones para ${comunaOriginal}`
      };
    }

    console.log(`[pipeline] 📍 Universo de búsqueda: ${stationIds.length} estaciones`);

    const stations = await fetchStationsByIds(stationIds);

    if (stations.length === 0) {
      return {
        mode: 3,
        recommendation: null,
        alternative: null,
        message: 'No se encontraron estaciones'
      };
    }

    // 1) distancia simple para todas
    const prelim = stations.map(station => ({
      ...station,
      _approx_distance_km: haversineDistance(user_lat, user_lon, station.lat, station.lon)
    }));

    prelim.sort((a, b) => a._approx_distance_km - b._approx_distance_km);

    // 2) ORS solo para las más cercanas
    const top = prelim.slice(0, ORS_TOP_CANDIDATES);
    const rest = prelim.slice(ORS_TOP_CANDIDATES);

    const stationsWithRealDist = [];

    console.log('[pipeline] 🗺️ Calculando distancias reales por carretera...');

    for (const station of top) {
      const realDist = await getRealDistance(user_lat, user_lon, station.lat, station.lon);

      let finalDist = realDist;
      let isEstimated = false;

      if (realDist === null) {
        finalDist = station._approx_distance_km;
        isEstimated = true;
        console.log(`[pipeline] ⚠️ ORS falló para ${station.nombre}, usando línea recta: ${finalDist.toFixed(1)}km`);
      }

      stationsWithRealDist.push({
        ...station,
        _real_distance_km: finalDist,
        _is_estimated: isEstimated
      });

      await new Promise(r => setTimeout(r, 100));
    }

    for (const station of rest) {
      stationsWithRealDist.push({
        ...station,
        _real_distance_km: station._approx_distance_km,
        _is_estimated: true
      });
    }

    stationsWithRealDist.sort((a, b) => a._real_distance_km - b._real_distance_km);
    console.log(
      `[pipeline] 📌 ${stationsWithRealDist.length} estaciones (más cercana: ${stationsWithRealDist[0]?._real_distance_km.toFixed(1)}km)`
    );

    let eligibleStations = stationsWithRealDist.filter(s => {
      const p = s.precios?.[fuel_type];
      return Number.isFinite(p) && p > 0;
    });

    console.log(`[pipeline] 🔍 Estaciones con ${fuel_type}: ${eligibleStations.length}`);

    if (eligibleStations.length === 0) {
      return {
        mode: 3,
        recommendation: null,
        alternative: null,
        message: `No hay estaciones con ${fuel_type} en ${comunaOriginal}`
      };
    }

    if (destino) {
      const destinationCoords = getComunaCoords(destino);

      if (destinationCoords) {
        const forwardStations = eligibleStations.filter(station =>
          isStationForwardOnTrip(originCoords, destinationCoords, { lat: station.lat, lon: station.lon })
        );

        if (forwardStations.length > 0) {
          eligibleStations = forwardStations;
          console.log(`[pipeline] 🧭 Estaciones hacia ${destino}: ${eligibleStations.length}`);
        }
      }
    }

    const safeRange = autonomiaKm > 0 ? autonomiaKm * 0.9 : Infinity;
    const reachableStations = eligibleStations.filter(s => s._real_distance_km <= safeRange);

    if (reachableStations.length > 0) {
      eligibleStations = reachableStations;
      console.log(`[pipeline] ⛽ Estaciones alcanzables con seguridad: ${eligibleStations.length}`);
    }

    const engineStations = eligibleStations
      .map(s => prepareStation(s, fuel_type, s._real_distance_km))
      .filter(Boolean);

    console.log(`[pipeline] 🧠 Estaciones preparadas para motor: ${engineStations.length}`);

    if (engineStations.length === 0) {
      return {
        mode: 3,
        recommendation: null,
        alternative: null,
        message: 'No hay estaciones disponibles'
      };
    }

    const refPrice = calculateReferencePrice(engineStations);
    console.log(`[pipeline] 💹 Precio referencia: $${refPrice}`);

    const result = engine.decide(
      userProfile,
      engineStations,
      {
        user_lat,
        user_lon,
        reference_price: refPrice,
        is_urban_peak: context.is_urban_peak || false,
        toll_estimate: context.toll_estimate || 0
      }
    );

    const enriched = enrichResult(result, eligibleStations, fuel_type);

    enriched.message =
      `Con tu combustible actual tienes aproximadamente ${Math.floor(autonomiaKm)} km de autonomía.` +
      (destino
        ? ` Se evaluaron estaciones en trayectoria hacia ${destino}.`
        : ` Se evaluaron estaciones en tu zona.`) +
      (result.message ? ` ${result.message}` : '');

    const elapsed = Date.now() - startTime;
    console.log(`[pipeline] ✅ Motor respondió mode: ${enriched.mode} (${elapsed}ms)`);

    return enriched;
  } catch (err) {
    console.error('[pipeline] 🔥 Error fatal:', err);
    return {
      mode: 3,
      recommendation: null,
      alternative: null,
      message: `Error interno: ${err.message}`
    };
  }
}

module.exports = { runPipeline };
