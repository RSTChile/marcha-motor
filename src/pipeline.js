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
// DISTANCIA A DESTINO
// Usa ORS si responde, si no usa aproximación
// =============================================

async function getTripDistanceKm(originCoords, destinationCoords) {
  if (!originCoords || !destinationCoords) return null;

  const real = await getRealDistance(
    originCoords.lat,
    originCoords.lon,
    destinationCoords.lat,
    destinationCoords.lon
  );

  if (real !== null) return real;

  return haversineDistance(
    originCoords.lat,
    originCoords.lon,
    destinationCoords.lat,
    destinationCoords.lon
  );
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
// DISTANCIA A DESTINO
// Usa ORS si responde, si no usa aproximación
// =============================================

async function getTripDistanceKm(originCoords, destinationCoords) {
  if (!originCoords || !destinationCoords) return null;

  const real = await getRealDistance(
    originCoords.lat,
    originCoords.lon,
    destinationCoords.lat,
    destinationCoords.lon
  );

  if (real !== null) return real;

  return haversineDistance(
    originCoords.lat,
    originCoords.lon,
    destinationCoords.lat,
    destinationCoords.lon
  );
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

function calculateSafeAutonomyKm(autonomyKm) {
  if (!Number.isFinite(autonomyKm) || autonomyKm <= 0) return 0;
  return autonomyKm * SAFE_AUTONOMY_FACTOR;
}

function calculateTripFuelEstimateLiters(distanceKm, userProfile) {
  const fuelConsumption = Number(userProfile?.fuel_consumption || 0);
  if (!Number.isFinite(distanceKm) || distanceKm <= 0) return 0;
  if (!Number.isFinite(fuelConsumption) || fuelConsumption <= 0) return 0;
  return distanceKm * (fuelConsumption / 100);
}

function calculateTripCostEstimate(distanceKm, referencePrice, userProfile) {
  const liters = calculateTripFuelEstimateLiters(distanceKm, userProfile);
  if (!Number.isFinite(referencePrice) || referencePrice <= 0) return 0;
  return Math.floor(liters * referencePrice);
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

function computeProgressKm(origin, point) {
  return haversineDistance(origin.lat, origin.lon, point.lat, point.lon);
}

// =============================================
// COMUNAS CANDIDATAS EN RUTA
// =============================================

function getRouteCandidateComunas(originComunaName, destinationName, originCoords, safeAutonomyKm) {
  const comunaMap = loadComunaStationsMap();
  const destinationCoords = getComunaCoords(destinationName);

  if (!destinationCoords) return [];

  const maxRange = safeAutonomyKm > 0 ? safeAutonomyKm * 1.05 : Infinity;
  const candidates = [];

  for (const comunaName of Object.keys(comunaMap)) {
    const coords = getComunaCoords(comunaName);
    if (!coords) continue;

    const point = { lat: coords.lat, lon: coords.lon };
    const forward = isStationForwardOnTrip(originCoords, destinationCoords, point);
    if (!forward) continue;

    const lateral = distancePointToLine(originCoords, destinationCoords, point);
    if (lateral > ROUTE_CORRIDOR_WIDTH) continue;

    const progressKm = computeProgressKm(originCoords, point);
    if (Number.isFinite(maxRange) && progressKm > maxRange) continue;

    candidates.push({
      comuna: comunaName,
      coords,
      progress_km: progressKm
    });
  }

  candidates.sort((a, b) => a.progress_km - b.progress_km);

  if (!candidates.some(c => normalizeText(c.comuna) === normalizeText(originComunaName))) {
    candidates.unshift({
      comuna: originComunaName,
      coords: getComunaCoords(originComunaName),
      progress_km: 0
    });
  }

  return candidates;
}

function pickNearestCandidateToTarget(candidates, targetKm) {
  if (!candidates.length) return null;

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

  selected.push(originComunaName);

  const firstForward = candidates.find(c => c.progress_km > 5);
  if (firstForward) selected.push(firstForward.comuna);

  const nearTarget = pickNearestCandidateToTarget(candidates, safeAutonomyKm * TRIP_TARGET_NEAR);
  const midTarget = pickNearestCandidateToTarget(candidates, safeAutonomyKm * TRIP_TARGET_MID);
  const limitTarget = pickNearestCandidateToTarget(candidates, safeAutonomyKm * TRIP_TARGET_LIMIT);

  if (nearTarget) selected.push(nearTarget.comuna);
  if (midTarget) selected.push(midTarget.comuna);
  if (limitTarget) selected.push(limitTarget.comuna);

  return [...new Set(selected)];
}

function getStationIdsFromComunas(comunaNames) {
  const comunaMap = loadComunaStationsMap();
  const ids = [];

  for (const comunaName of comunaNames) {
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
    console.log(
      `[pipeline] ⚠️ Excluyendo ${station.nombre}: ${fuelLabels[fuelType]} = $${price} (mínimo $${minPrice})`
    );
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
// MENSAJES DE MARGEN
// =============================================

function buildMarginMessage(marginKm) {
  if (!Number.isFinite(marginKm)) return '';

  if (marginKm < 0) {
    return 'Con tu conducción actual podrías no alcanzar a llegar a la próxima estación. Si reduces la velocidad y mantienes una conducción suave, es probable que llegues sin problemas.';
  }

  if (marginKm <= 20) {
    return 'Con tu conducción actual podrías quedar justo para llegar a la próxima estación. Reduciendo la velocidad y manteniendo una conducción suave, deberías llegar sin inconvenientes.';
  }

  if (marginKm <= 80) {
    return 'Estás dentro de un rango adecuado para decidir. Conviene planificar la carga en los próximos kilómetros.';
  }

  return 'Tienes margen suficiente para seguir avanzando y evaluar opciones antes de cargar.';
}

// =============================================
// PLAN DE VIAJE
// =============================================

function pickTripStop(stations, targetKm, fuelType) {
  const candidates = stations.filter(s => {
    const price = s.precios?.[fuelType];
    return Number.isFinite(price) && price > 0 && Number.isFinite(s._progress_km);
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

    if (delta === bestDelta && best && (station.precios[fuelType] < best.precios[fuelType])) {
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
  const startStop = pickTripStop(stations, safeAutonomyKm * TRIP_TARGET_NEAR, fuelType);
  const midStop = pickTripStop(stations, safeAutonomyKm * TRIP_TARGET_MID, fuelType);
  const limitStop = pickTripStop(stations, safeAutonomyKm * TRIP_TARGET_LIMIT, fuelType);

  const reachableAfterRefuel = Number.isFinite(tripDistanceKm) && safeAutonomyKm > 0
    ? (tripDistanceKm <= safeAutonomyKm)
    : false;

  return {
    start: buildTripStopPayload(startStop, fuelType),
    mid: buildTripStopPayload(midStop, fuelType),
    limit: buildTripStopPayload(limitStop, fuelType),
    reachable_after_refuel: reachableAfterRefuel
  };
}

function buildTripModeResult(stations, fuelType, userProfile, referencePrice, safeAutonomyKm, tripDistanceKm) {
  const tripPlan = buildTripPlan(stations, fuelType, safeAutonomyKm, tripDistanceKm);

  const primary = tripPlan.start?.station_id
    ? stations.find(s => s.id === tripPlan.start.station_id)
    : stations[0] || null;

  const secondaryIds = [tripPlan.mid?.station_id, tripPlan.limit?.station_id].filter(Boolean);

  const alternativesRaw = secondaryIds
    .map(id => stations.find(s => s.id === id))
    .filter(Boolean)
    .filter((station, index, arr) => arr.findIndex(s => s.id === station.id) === index)
    .filter(s => !primary || s.id !== primary.id);

  const litrosMissing = Math.max(
    0,
    Number(userProfile?.tank_capacity || 0) * (1 - (Number(userProfile?.current_level_pct || 0) / 100))
  );

  const recommendation = primary ? {
    station_id: primary.id,
    display_liters: Number(litrosMissing.toFixed(1)),
    display_total_cost: Math.floor((primary.precios[fuelType] || 0) * litrosMissing),
    display_distance_km: primary._real_distance_km,
    display_price: primary.precios[fuelType] || 0,
    display_reference_price: referencePrice,
    net_saving: Math.max(0, Math.floor((referencePrice - (primary.precios[fuelType] || 0)) * litrosMissing)),
    station: buildStationObj(primary)
  } : null;

  const alternatives = alternativesRaw.map(alt => ({
    station_id: alt.id,
    display_liters: Number(litrosMissing.toFixed(1)),
    display_total_cost: Math.floor((alt.precios[fuelType] || 0) * litrosMissing),
    display_distance_km: alt._real_distance_km,
    display_price: alt.precios[fuelType] || 0,
    display_reference_price: referencePrice,
    net_saving: Math.max(0, Math.floor((referencePrice - (alt.precios[fuelType] || 0)) * litrosMissing)),
    station: buildStationObj(alt)
  }));

  return {
    mode: 0,
    recommendation,
    alternatives,
    alternative: alternatives[0] || null,
    trip_plan: tripPlan
  };
}
// =============================================
// ENRIQUECER RESULTADO DEL MOTOR
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

  const original = stationsWithRealDist.find(
    s => s.id === scored.station_id
  );

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
// PRECIO DE REFERENCIA (MEDIANA)
// =============================================

function calculateReferencePrice(engineStations) {
  const prices = engineStations
    .map(s => s.precio_actual)
    .filter(p => p > 0)
    .sort((a, b) => a - b);

  if (prices.length === 0) return 1500;

  const mid = Math.floor(prices.length / 2);

  if (prices.length % 2 === 0) {
    return Math.round((prices[mid - 1] + prices[mid]) / 2);
  }

  return prices[mid];
}

// =============================================
// PREPARAR ESTACIÓN PARA EL MOTOR
// =============================================

function prepareStation(station, fuelType, realDistanceKm) {
  const MIN_REALISTIC_PRICES = {
    diesel: 1200,
    gas93: 1200,
    gas95: 1250,
    gas97: 1300
  };

  const price = station.precios[fuelType];
  const minPrice = MIN_REALISTIC_PRICES[fuelType] || 1200;

  if (!price || price <= 0) return null;

  if (price < minPrice) {
    return null;
  }

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
    } = context;

    // -----------------------------------------
    // VALIDACIÓN BÁSICA
    // -----------------------------------------

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

    // -----------------------------------------
    // AUTONOMÍA
    // -----------------------------------------

    const autonomiaKm = calculateAutonomyKm(userProfile);
    const autonomiaSeguraKm = autonomiaKm * 0.9;

    console.log(`[pipeline] ⛽ Autonomía: ${Math.round(autonomiaKm)} km`);

    // -----------------------------------------
    // DISTANCIA A DESTINO (SI EXISTE)
    // -----------------------------------------

    let tripDistanceKm = null;
    let tripFuelLiters = null;
    let tripCostEstimate = null;

    if (destino) {
      const destinoCoords = getComunaCoords(destino);

      if (destinoCoords) {
        const real = await getRealDistance(
          user_lat,
          user_lon,
          destinoCoords.lat,
          destinoCoords.lon
        );

        tripDistanceKm = real ?? haversineDistance(
          user_lat,
          user_lon,
          destinoCoords.lat,
          destinoCoords.lon
        );

        const rendimiento = Number(userProfile?.fuel_consumption || 0);
        const kmPerLiter = rendimiento > 0 ? 100 / rendimiento : 0;

        if (kmPerLiter > 0 && tripDistanceKm) {
          tripFuelLiters = tripDistanceKm / kmPerLiter;
        }
      }
    }

    // -----------------------------------------
    // DECISIÓN DE MODO
    // -----------------------------------------

    let isLongTrip = false;

    if (destino && tripDistanceKm && autonomiaSeguraKm > 0) {
      if (tripDistanceKm > autonomiaSeguraKm) {
        isLongTrip = true;
      }
    }

    // -----------------------------------------
    // CARGA DE MAPA
    // -----------------------------------------

    const comunaMap = loadComunaStationsMap();
    const resolvedComuna = resolveComunaData(comunaMap, comuna);

    if (!resolvedComuna) {
      return {
        mode: 3,
        recommendation: null,
        alternative: null,
        message: `No hay estaciones para ${comuna}`
      };
    }

    const comunaOriginal = resolvedComuna.key;

    // -----------------------------------------
    // OBTENER IDS SEGÚN MODO
    // -----------------------------------------

    let stationIds = [];

    if (!isLongTrip) {
      stationIds = resolvedComuna.value?.stations?.map(s => s.id) || [];
    } else {
      stationIds = getStationIdsForSearch(
        comunaOriginal,
        destino,
        { lat: user_lat, lon: user_lon },
        autonomiaKm
      );
    }

    if (stationIds.length === 0) {
      return {
        mode: 3,
        recommendation: null,
        alternative: null,
        message: 'No hay estaciones disponibles'
      };
    }

    console.log(`[pipeline] 📍 IDs: ${stationIds.length}`);

    // -----------------------------------------
    // FETCH ESTACIONES
    // -----------------------------------------

    const stations = await fetchStationsByIds(stationIds);

    if (stations.length === 0) {
      return {
        mode: 3,
        recommendation: null,
        alternative: null,
        message: 'No se encontraron estaciones'
      };
    }

    // -----------------------------------------
    // DISTANCIAS (OPTIMIZADO)
    // -----------------------------------------

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

    const top = prelim.slice(0, 5);
    const rest = prelim.slice(5);

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

      await new Promise(r => setTimeout(r, 100));
    }

    for (const s of rest) {
      stationsWithRealDist.push({
        ...s,
        _real_distance_km: s._approx_distance_km
      });
    }

    stationsWithRealDist.sort(
      (a, b) => a._real_distance_km - b._real_distance_km
    );

    // -----------------------------------------
    // FILTRO POR COMBUSTIBLE
    // -----------------------------------------

    let eligibleStations = stationsWithRealDist.filter(s => {
      const p = s.precios?.[fuel_type];
      return Number.isFinite(p) && p > 0;
    });

    if (eligibleStations.length === 0) {
      return {
        mode: 3,
        recommendation: null,
        alternative: null,
        message: `No hay estaciones con ${fuel_type}`
      };
    }

    // -----------------------------------------
    // FILTRO POR ALCANCE
    // -----------------------------------------

    const reachable = eligibleStations.filter(
      s => s._real_distance_km <= autonomiaSeguraKm
    );

    if (reachable.length > 0) {
      eligibleStations = reachable;
    }

    // -----------------------------------------
    // PREPARAR PARA MOTOR
    // -----------------------------------------

    const engineStations = eligibleStations
      .map(s => prepareStation(s, fuel_type, s._real_distance_km))
      .filter(Boolean);

    if (engineStations.length === 0) {
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
        is_urban_peak: context.is_urban_peak || false,
        toll_estimate: context.toll_estimate || 0
      }
    );

    // -----------------------------------------
    // ENRIQUECER RESULTADO
    // -----------------------------------------

    const enriched = enrichResult(
      result,
      eligibleStations,
      fuel_type
    );

    // -----------------------------------------
    // MARGEN DE DECISIÓN
    // -----------------------------------------

    const nearest = eligibleStations[0];
    let decisionMarginKm = null;

    if (nearest) {
      decisionMarginKm = autonomiaKm - nearest._real_distance_km;
    }

    let marginMessage = '';

    if (decisionMarginKm !== null) {
      if (decisionMarginKm > 50) {
        marginMessage =
          'Tienes margen suficiente para seguir avanzando y evaluar opciones.';
      } else if (decisionMarginKm > 0) {
        marginMessage =
          'Estás dentro de un rango adecuado para decidir la carga.';
      } else {
        marginMessage =
          'Con tu conducción actual podrías no alcanzar a llegar a la próxima estación. ' +
          'Si reduces la velocidad y mantienes una conducción suave, es probable que llegues sin problemas.';
      }
    }

    // -----------------------------------------
    // MENSAJE FINAL
    // -----------------------------------------

    enriched.message =
      `Autonomía estimada: ${Math.floor(autonomiaKm)} km.` +
      (tripDistanceKm
        ? ` Distancia al destino: ${Math.floor(tripDistanceKm)} km.`
        : '') +
      (marginMessage ? ` ${marginMessage}` : '');

    // -----------------------------------------
    // CAMPOS NUEVOS
    // -----------------------------------------

    enriched.autonomy_km = autonomiaKm;
    enriched.safe_autonomy_km = autonomiaSeguraKm;
    enriched.trip_distance_km = tripDistanceKm;
    enriched.trip_fuel_estimate_l = tripFuelLiters;
    enriched.trip_cost_estimate = tripFuelLiters
      ? Math.round(tripFuelLiters * refPrice)
      : null;
    enriched.decision_margin_km = decisionMarginKm;

    // -----------------------------------------
    // LOG FINAL
    // -----------------------------------------

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
