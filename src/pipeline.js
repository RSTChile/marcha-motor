const engine = require('./engine');

// =============================================
// CONFIG
// =============================================

const CACHE_TTL_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;

const MIN_REALISTIC_PRICES = {
  diesel: 1200,
  gas93: 1200,
  gas95: 1250,
  gas97: 1300
};

const SAFE_AUTONOMY_FACTOR = 0.92;
const TRIP_TARGET_NEAR = 0.20;
const TRIP_TARGET_MID = 0.55;
const TRIP_TARGET_LIMIT = 0.90;

const stationsCache = new Map();
const routeCache = new Map();

let comunaMapCache = null;
let comunaCoordsCache = null;

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
// MARCAS
// =============================================

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

  if (marcas[marcaId]) return marcas[marcaId];

  if (typeof marcaId === 'string' && marcaId.trim()) {
    return marcaId.trim();
  }

  return 'Estación';
}

// =============================================
// CARGA DE COMUNAS -> IDS
// =============================================

async function loadComunaStationsMap() {
  if (comunaMapCache) return comunaMapCache;

  try {
    const res = await fetch(
      'https://raw.githubusercontent.com/RSTChile/marcha-motor/refs/heads/main/data/comunas-stations.json'
    );

    if (!res.ok) {
      console.error('[pipeline] ❌ Error cargando comunas-stations.json');
      return {};
    }

    const json = await res.json();

    comunaMapCache = json?.comunas || {};

    console.log(
      `[pipeline] 📍 Mapeo cargado: ${Object.keys(comunaMapCache).length} comunas`
    );

    return comunaMapCache;
  } catch (err) {
    console.error('[pipeline] 🔥 Error cargando comunas-stations:', err.message);
    return {};
  }
}

// =============================================
// CARGA DE COMUNAS -> COORDS
// Soporta varios formatos para evitar:
// "TypeError: json is not iterable"
// =============================================

function extractCoordsFromItem(item) {
  if (!item || typeof item !== 'object') return null;

  const lat =
    item.lat ??
    item.latitude ??
    item.latitud ??
    item.Latitud ??
    item.LATITUD;

  const lon =
    item.lon ??
    item.lng ??
    item.longitude ??
    item.longitud ??
    item.Longitud ??
    item.LONGITUD;

  const nombre =
    item.nombre ??
    item.name ??
    item.comuna ??
    item.Comuna ??
    item.COMUNA;

  const latNum = Number(lat);
  const lonNum = Number(lon);

  if (!nombre || !Number.isFinite(latNum) || !Number.isFinite(lonNum)) {
    return null;
  }

  return {
    nombre: String(nombre).trim(),
    lat: latNum,
    lon: lonNum
  };
}

async function loadComunaCoords() {
  if (comunaCoordsCache) return comunaCoordsCache;

  try {
    const res = await fetch(
      'https://raw.githubusercontent.com/RSTChile/marcha-motor/refs/heads/main/data/comunas-completo.json'
    );

    if (!res.ok) {
      console.error('[pipeline] ❌ Error cargando comunas-completo.json');
      comunaCoordsCache = {};
      return comunaCoordsCache;
    }

    const json = await res.json();
    const map = {};

    if (Array.isArray(json)) {
      for (const item of json) {
        const parsed = extractCoordsFromItem(item);
        if (parsed) {
          map[normalizeText(parsed.nombre)] = {
            nombre: parsed.nombre,
            lat: parsed.lat,
            lon: parsed.lon
          };
        }
      }
    } else if (json && typeof json === 'object') {
      if (Array.isArray(json.comunas)) {
        for (const item of json.comunas) {
          const parsed = extractCoordsFromItem(item);
          if (parsed) {
            map[normalizeText(parsed.nombre)] = {
              nombre: parsed.nombre,
              lat: parsed.lat,
              lon: parsed.lon
            };
          }
        }
      } else {
        for (const [key, value] of Object.entries(json)) {
          const parsed = extractCoordsFromItem({
            nombre: value?.nombre || key,
            lat:
              value?.lat ??
              value?.latitude ??
              value?.latitud,
            lon:
              value?.lon ??
              value?.lng ??
              value?.longitude ??
              value?.longitud
          });

          if (parsed) {
            map[normalizeText(parsed.nombre)] = {
              nombre: parsed.nombre,
              lat: parsed.lat,
              lon: parsed.lon
            };
          }
        }
      }
    }

    comunaCoordsCache = map;

    console.log(
      `[pipeline] 🗺️ Coordenadas cargadas: ${Object.keys(comunaCoordsCache).length} comunas`
    );

    return comunaCoordsCache;
  } catch (err) {
    console.error('[pipeline] 🔥 Error cargando comunas-completo:', err.message);
    comunaCoordsCache = {};
    return comunaCoordsCache;
  }
}

function getComunaCoords(name) {
  if (!name || !comunaCoordsCache) return null;
  return comunaCoordsCache[normalizeText(name)] || null;
}

function resolveComunaData(comunaMap, comunaName) {
  const target = normalizeText(comunaName);

  for (const [key, value] of Object.entries(comunaMap || {})) {
    if (normalizeText(key) === target) {
      return { key, value };
    }
  }

  return null;
}
// =============================================
// DISTANCIA EN LÍNEA RECTA (Haversine)
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
// DISTANCIA REAL POR CARRETERA (ORS)
// =============================================

async function getRealDistance(lat1, lon1, lat2, lon2) {
  const cacheKey = `${lat1.toFixed(4)},${lon1.toFixed(4)}|${lat2.toFixed(4)},${lon2.toFixed(4)}`;

  const cached = routeCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.distance;
  }

  try {
    if (!process.env.ORS_API_KEY) return null;

    const url =
      `https://api.openrouteservice.org/v2/directions/driving-car` +
      `?api_key=${process.env.ORS_API_KEY}` +
      `&start=${lon1},${lat1}` +
      `&end=${lon2},${lat2}`;

    const response = await fetch(url);

    if (!response.ok) {
      return null;
    }

    const routeData = await response.json();
    const distanceMeters =
      routeData?.features?.[0]?.properties?.summary?.distance;

    if (!distanceMeters) return null;

    const distanceKm = distanceMeters / 1000;

    routeCache.set(cacheKey, {
      distance: distanceKm,
      timestamp: Date.now()
    });

    return distanceKm;
  } catch {
    return null;
  }
}

// =============================================
// CONSULTA A LA API POR ID
// =============================================

async function fetchStationById(id) {
  const cached = stationsCache.get(id);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
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
    if (d.estado_bandera !== 1) return null;

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
      if (!Number.isFinite(precioNum) || precioNum <= 0) continue;

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
      marca: getMarcaNombre(d.marca),
      marca_id: d.marca || null,
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

    stationsCache.set(id, {
      data: station,
      timestamp: Date.now()
    });

    return station;
  } catch (err) {
    console.error(`[pipeline] Error fetching station ${id}:`, err.message);
    return null;
  }
}

async function fetchStationsByIds(ids) {
  const uniqueIds = [...new Set(ids || [])];
  const results = [];

  for (const id of uniqueIds) {
    const station = await fetchStationById(id);
    if (station) results.push(station);
  }

  return results;
}

// =============================================
// AUTONOMÍA Y COSTOS
// userProfile.fuel_consumption = km por litro
// =============================================

function calculateAutonomyKm(userProfile) {
  const tankCapacity = Number(userProfile?.tank_capacity || 0);
  const currentLevelPct = Number(userProfile?.current_level_pct || 0);
  const kmPerLiter = Number(userProfile?.fuel_consumption || 0);

  if (!Number.isFinite(tankCapacity) || tankCapacity <= 0) return 0;
  if (!Number.isFinite(currentLevelPct) || currentLevelPct <= 0) return 0;
  if (!Number.isFinite(kmPerLiter) || kmPerLiter <= 0) return 0;

  const litersAvailable = tankCapacity * (currentLevelPct / 100);
  return litersAvailable * kmPerLiter;
}

function calculateSafeAutonomyKm(autonomyKm) {
  if (!Number.isFinite(autonomyKm) || autonomyKm <= 0) return 0;
  return autonomyKm * SAFE_AUTONOMY_FACTOR;
}

function calculateTripFuelEstimateLiters(distanceKm, userProfile) {
  const kmPerLiter = Number(userProfile?.fuel_consumption || 0);

  if (!Number.isFinite(distanceKm) || distanceKm <= 0) return 0;
  if (!Number.isFinite(kmPerLiter) || kmPerLiter <= 0) return 0;

  return distanceKm / kmPerLiter;
}

function calculateTripCostEstimate(distanceKm, referencePrice, userProfile) {
  const liters = calculateTripFuelEstimateLiters(distanceKm, userProfile);

  if (!Number.isFinite(referencePrice) || referencePrice <= 0) return 0;

  return Math.floor(liters * referencePrice);
}

function buildMarginMessage(marginKm) {
  if (!Number.isFinite(marginKm)) return '';

  if (marginKm < 0) {
    return 'Con tu conducción actual podrías no alcanzar a llegar a la estación más cercana. Pero, si reduces velocidad y mantienes conducción suave, es probable que llegues sin problemas.';
  }

  if (marginKm <= 20) {
    return 'Con tu conducción actual podrías quedar justo para llegar a la próxima estación. Si bajas velocidad y conduces de forma suave, deberías llegar sin inconvenientes.';
  }

  if (marginKm <= 80) {
    return 'Estás dentro de un rango adecuado para decidir la carga en los próximos kilómetros.';
  }

  return 'Tienes margen suficiente para seguir avanzando y evaluar opciones antes de cargar.';
}
// =============================================
// GEOMETRÍA DE TRAYECTORIA
// =============================================

function isForward(origin, destination, point) {
  const dx = destination.lon - origin.lon;
  const dy = destination.lat - origin.lat;

  const px = point.lon - origin.lon;
  const py = point.lat - origin.lat;

  return (dx * px + dy * py) > 0;
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

function computeProgressKm(origin, point) {
  return haversineDistance(origin.lat, origin.lon, point.lat, point.lon);
}

// =============================================
// COMUNAS CANDIDATAS PARA VIAJE
// =============================================

function getRouteCandidateComunas(originComunaName, destinationName, originCoords, safeAutonomyKm) {
  const destinationCoords = getComunaCoords(destinationName);
  if (!destinationCoords) return [];

  const comunaMap = comunaMapCache || {};
  const maxRange = safeAutonomyKm > 0 ? safeAutonomyKm * 1.10 : Infinity;

  const corridorWidthKm = 55;
  const candidates = [];

  for (const comunaName of Object.keys(comunaMap)) {
    const coords = getComunaCoords(comunaName);
    if (!coords) continue;

    const point = { lat: coords.lat, lon: coords.lon };

    if (!isForward(originCoords, destinationCoords, point)) continue;

    const lateral = distancePointToLine(originCoords, destinationCoords, point);
    if (lateral > corridorWidthKm) continue;

    const progressKm = computeProgressKm(originCoords, point);
    if (Number.isFinite(maxRange) && progressKm > maxRange) continue;

    candidates.push({
      comuna: comunaName,
      coords,
      progress_km: progressKm
    });
  }

  candidates.sort((a, b) => a.progress_km - b.progress_km);

  if (
    originComunaName &&
    !candidates.some(c => normalizeText(c.comuna) === normalizeText(originComunaName))
  ) {
    const originCoordsResolved = getComunaCoords(originComunaName);
    if (originCoordsResolved) {
      candidates.unshift({
        comuna: originComunaName,
        coords: originCoordsResolved,
        progress_km: 0
      });
    }
  }

  return candidates;
}

function pickNearestCandidateToTarget(candidates, targetKm) {
  if (!Array.isArray(candidates) || !candidates.length) return null;

  let best = null;
  let bestDelta = Infinity;

  for (const candidate of candidates) {
    const delta = Math.abs(candidate.progress_km - targetKm);
    if (delta < bestDelta) {
      best = candidate;
      bestDelta = delta;
    }
  }

  return best;
}

function selectTripSearchComunas(originComunaName, candidates, safeAutonomyKm) {
  const selected = [];

  if (originComunaName) selected.push(originComunaName);

  const firstForward = candidates.find(c => c.progress_km > 5);
  if (firstForward) selected.push(firstForward.comuna);

  const nearTarget = pickNearestCandidateToTarget(
    candidates,
    safeAutonomyKm * TRIP_TARGET_NEAR
  );

  const midTarget = pickNearestCandidateToTarget(
    candidates,
    safeAutonomyKm * TRIP_TARGET_MID
  );

  const limitTarget = pickNearestCandidateToTarget(
    candidates,
    safeAutonomyKm * TRIP_TARGET_LIMIT
  );

  if (nearTarget) selected.push(nearTarget.comuna);
  if (midTarget) selected.push(midTarget.comuna);
  if (limitTarget) selected.push(limitTarget.comuna);

  return [...new Set(selected)];
}

function getStationIdsFromComunas(comunaNames) {
  const comunaMap = comunaMapCache || {};
  const ids = [];

  for (const comunaName of comunaNames || []) {
    const resolved = resolveComunaData(comunaMap, comunaName);
    const stationIds = resolved?.value?.stations?.map(s => s.id) || [];
    ids.push(...stationIds);
  }

  return [...new Set(ids)];
}

// =============================================
// PREPARAR ESTACIÓN PARA MOTOR
// =============================================

function inferZoneType(region) {
  if (!region) return 'semi';

  const r = normalizeText(region);

  if (r.includes('metropolitana')) return 'urban';

  const semiUrban = [
    'valparaiso',
    'coquimbo',
    'biobio',
    'maule',
    "o'higgins",
    'ohiggins',
    'araucania',
    'los lagos'
  ];

  if (semiUrban.some(x => r.includes(x))) return 'semi';

  return 'rural';
}

function prepareStation(station, fuelType, realDistanceKm) {
  const price = station.precios?.[fuelType];
  const minPrice = MIN_REALISTIC_PRICES[fuelType] || 1200;

  if (!Number.isFinite(price) || price <= 0) return null;
  if (price < minPrice) return null;

  const ageMinutes = Math.min(
    Math.round((Date.now() - station.fetched_at) / 60000),
    60
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

function calculateReferencePrice(engineStations) {
  const prices = engineStations
    .map(s => s.precio_actual)
    .filter(p => Number.isFinite(p) && p > 0)
    .sort((a, b) => a - b);

  if (!prices.length) return 1500;

  const mid = Math.floor(prices.length / 2);

  return prices.length % 2 === 0
    ? Math.round((prices[mid - 1] + prices[mid]) / 2)
    : prices[mid];
}

// =============================================
// ENRIQUECER RESULTADO VISUAL
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
  if (!original) return scored;

  const correctPrice = original.precios?.[fuelType];

  if (Number.isFinite(correctPrice) && correctPrice > 0) {
    scored.display_price = correctPrice;

    const liters = Number(scored.display_liters || 0);
    scored.display_total_cost = Math.floor(correctPrice * liters);
  }

  scored.display_distance_km = original._real_distance_km;
  scored.station = buildStationObj(original);

  if (scored.net_saving) {
    scored.net_saving = Math.floor(scored.net_saving);
  }

  return scored;
}

function enrichResult(result, stationsWithRealDist, fuelType) {
  result.recommendation = enrichOne(
    result.recommendation,
    stationsWithRealDist,
    fuelType
  );

  if (Array.isArray(result.alternatives)) {
    result.alternatives = result.alternatives.map(a =>
      enrichOne(a, stationsWithRealDist, fuelType)
    );
  }

  result.alternative = result.alternatives?.[0] || null;

  return result;
}
// =============================================
// PLAN DE VIAJE (3 referencias)
// =============================================

function pickTripStop(stations, targetKm, fuelType) {
  const candidates = stations.filter(s => {
    const price = s.precios?.[fuelType];
    return (
      Number.isFinite(price) &&
      price > 0 &&
      Number.isFinite(s._progress_km)
    );
  });

  if (!candidates.length) return null;

  let best = null;
  let bestDelta = Infinity;

  for (const station of candidates) {
    const delta = Math.abs(station._progress_km - targetKm);

    if (delta < bestDelta) {
      best = station;
      bestDelta = delta;
      continue;
    }

    if (
      delta === bestDelta &&
      best &&
      station.precios[fuelType] < best.precios[fuelType]
    ) {
      best = station;
    }
  }

  return best;
}

function buildTripStopPayload(station, fuelType) {
  if (!station) return null;

  return {
    station_id: station.id,
    progress_km: Math.round(station._progress_km),
    distance_from_user_km: Number(station._real_distance_km.toFixed(1)),
    price: station.precios[fuelType] || 0,
    station: buildStationObj(station)
  };
}

function buildTripPlan(stations, fuelType, safeAutonomyKm, tripDistanceKm) {
  const startStop = pickTripStop(
    stations,
    safeAutonomyKm * TRIP_TARGET_NEAR,
    fuelType
  );

  const midStop = pickTripStop(
    stations,
    safeAutonomyKm * TRIP_TARGET_MID,
    fuelType
  );

  const limitStop = pickTripStop(
    stations,
    safeAutonomyKm * TRIP_TARGET_LIMIT,
    fuelType
  );

  const reachableAfterRefuel =
    Number.isFinite(tripDistanceKm) &&
    safeAutonomyKm > 0 &&
    tripDistanceKm <= safeAutonomyKm;

  return {
    start: buildTripStopPayload(startStop, fuelType),
    mid: buildTripStopPayload(midStop, fuelType),
    limit: buildTripStopPayload(limitStop, fuelType),
    reachable_after_refuel: Boolean(reachableAfterRefuel)
  };
}

// =============================================
// PIPELINE PRINCIPAL
// =============================================

async function runPipeline({ userProfile, context }) {
  const startTime = Date.now();

  try {
    console.log('[pipeline] 🚀 Iniciando...');

    const {
      user_lat,
      user_lon,
      fuel_type = 'diesel',
      comuna,
      destino
    } = context || {};

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

    await loadComunaStationsMap();
    await loadComunaCoords();

    const resolvedComuna = resolveComunaData(comunaMapCache, comuna);

    if (!resolvedComuna) {
      return {
        mode: 3,
        recommendation: null,
        alternative: null,
        message: `No hay estaciones para ${comuna}`
      };
    }

    const autonomiaKm = calculateAutonomyKm(userProfile);
    const safeAutonomyKm = calculateSafeAutonomyKm(autonomiaKm);

    console.log(`[pipeline] ⛽ Autonomía estimada: ${Math.round(autonomiaKm)} km`);

    let tripDistanceKm = null;
    let stationIds = [];

    // =========================================
    // MODO VIAJE
    // =========================================

    if (destino) {
      const destinoCoords = getComunaCoords(destino);

      if (destinoCoords) {
        tripDistanceKm = await getRealDistance(
          user_lat,
          user_lon,
          destinoCoords.lat,
          destinoCoords.lon
        );

        if (!tripDistanceKm) {
          tripDistanceKm = haversineDistance(
            user_lat,
            user_lon,
            destinoCoords.lat,
            destinoCoords.lon
          );
        }

        const candidates = getRouteCandidateComunas(
          resolvedComuna.key,
          destino,
          { lat: user_lat, lon: user_lon },
          safeAutonomyKm
        );

        const selectedComunas = selectTripSearchComunas(
          resolvedComuna.key,
          candidates,
          safeAutonomyKm
        );

        stationIds = getStationIdsFromComunas(selectedComunas);

        console.log(
          `[pipeline] 🚗 Viaje detectado: ${selectedComunas.join(', ')}`
        );
      }
    }

    // =========================================
    // MODO NORMAL (fallback)
    // =========================================

    if (!stationIds.length) {
      stationIds = resolvedComuna.value?.stations?.map(s => s.id) || [];
    }

    if (!stationIds.length) {
      return {
        mode: 3,
        recommendation: null,
        alternative: null,
        message: 'No hay estaciones disponibles'
      };
    }

    console.log(`[pipeline] 📍 Universo de búsqueda: ${stationIds.length} estaciones`);

    const stations = await fetchStationsByIds(stationIds);

    if (!stations.length) {
      return {
        mode: 3,
        recommendation: null,
        alternative: null,
        message: 'No se encontraron estaciones'
      };
    }

    // =========================================
    // DISTANCIAS: ORS SOLO PARA LAS MÁS RELEVANTES
    // =========================================

    const prelim = stations.map(s => ({
      ...s,
      _approx_distance_km: haversineDistance(
        user_lat,
        user_lon,
        s.lat,
        s.lon
      )
    }));

    prelim.sort((a, b) => a._approx_distance_km - b._approx_distance_km);

    const top = prelim.slice(0, 12);
    const rest = prelim.slice(12);

    const stationsWithRealDist = [];

    for (const s of top) {
      const real = await getRealDistance(
        user_lat,
        user_lon,
        s.lat,
        s.lon
      );

      stationsWithRealDist.push({
        ...s,
        _real_distance_km: real ?? s._approx_distance_km
      });
    }

    for (const s of rest) {
      stationsWithRealDist.push({
        ...s,
        _real_distance_km: s._approx_distance_km
      });
    }

    for (const s of stationsWithRealDist) {
      s._progress_km = haversineDistance(
        user_lat,
        user_lon,
        s.lat,
        s.lon
      );
    }

    stationsWithRealDist.sort(
      (a, b) => a._real_distance_km - b._real_distance_km
    );

    let eligibleStations = stationsWithRealDist.filter(s => {
      const p = s.precios?.[fuel_type];
      return Number.isFinite(p) && p > 0;
    });

    if (!eligibleStations.length) {
      return {
        mode: 3,
        recommendation: null,
        alternative: null,
        message: `No hay estaciones con ${fuel_type}`
      };
    }

    const reachable = eligibleStations.filter(
      s => s._real_distance_km <= safeAutonomyKm
    );

    if (reachable.length) {
      eligibleStations = reachable;
    }

    const engineStations = eligibleStations
      .map(s => prepareStation(s, fuel_type, s._real_distance_km))
      .filter(Boolean);

    if (!engineStations.length) {
      return {
        mode: 3,
        recommendation: null,
        alternative: null,
        message: 'No hay estaciones disponibles'
      };
    }

    const refPrice = calculateReferencePrice(engineStations);

    const result = engine.decide(
      userProfile,
      engineStations,
      {
        user_lat,
        user_lon,
        reference_price: refPrice,
        is_urban_peak: context?.is_urban_peak || false,
        toll_estimate: context?.toll_estimate || 0
      }
    );

    const enriched = enrichResult(
      result,
      eligibleStations,
      fuel_type
    );

    const nearest = eligibleStations[0];
    const decisionMarginKm = nearest
      ? autonomiaKm - nearest._real_distance_km
      : null;

    const tripFuelLiters = tripDistanceKm
      ? calculateTripFuelEstimateLiters(tripDistanceKm, userProfile)
      : null;

    const tripCostEstimate = tripDistanceKm
      ? calculateTripCostEstimate(tripDistanceKm, refPrice, userProfile)
      : null;

    enriched.autonomy_km = Math.round(autonomiaKm);
    enriched.safe_autonomy_km = Math.round(safeAutonomyKm);
    enriched.trip_distance_km = tripDistanceKm ? Math.round(tripDistanceKm) : null;
    enriched.trip_fuel_estimate_l = tripFuelLiters
      ? Number(tripFuelLiters.toFixed(1))
      : null;
    enriched.trip_cost_estimate = tripCostEstimate || null;
    enriched.decision_margin_km = Number.isFinite(decisionMarginKm)
      ? Math.round(decisionMarginKm)
      : null;

    if (destino && tripDistanceKm) {
      enriched.trip_plan = buildTripPlan(
        eligibleStations,
        fuel_type,
        safeAutonomyKm,
        tripDistanceKm
      );
    }

    const marginMessage = buildMarginMessage(decisionMarginKm);

    enriched.message =
      `Autonomía estimada: ${Math.round(autonomiaKm)} km.` +
      (tripDistanceKm
        ? ` Distancia al destino: ${Math.round(tripDistanceKm)} km.`
        : '') +
      (tripCostEstimate
        ? ` Costo estimado de combustible al destino: $${tripCostEstimate.toLocaleString('es-CL')}.`
        : '') +
      (marginMessage ? ` ${marginMessage}` : '');

    const elapsed = Date.now() - startTime;
    console.log(`[pipeline] ✅ OK (${elapsed}ms)`);

    return enriched;
  } catch (err) {
    console.error('[pipeline] 🔥 Error:', err);

    return {
      mode: 3,
      recommendation: null,
      alternative: null,
      message: `Error interno: ${err.message}`
    };
  }
}

module.exports = { runPipeline };
