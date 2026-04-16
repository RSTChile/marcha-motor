async function fetchStationById(id) {
  const cached = stationsCache.get(id);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.data;
  }

  try {
    const res = await fetch(`https://api.bencinaenlinea.cl/api/estacion_ciudadano/${id}`);
    if (!res.ok) return null;

    const json = await res.json();
    const d = json?.data;

    if (!d || d.estado_bandera !== 1) return null;

    const precios = {};

    for (const c of d.combustibles || []) {
      const p = Math.floor(parseFloat(c.precio));
      if (!p) continue;

      if (c.nombre_corto === 'DI') precios.diesel = p;
      if (c.nombre_corto === '93') precios.gas93 = p;
      if (c.nombre_corto === '95') precios.gas95 = p;
      if (c.nombre_corto === '97') precios.gas97 = p;
    }

    const station = {
      id: d.id,
      nombre: d.marca || 'Estación',
      comuna: d.comuna,
      direccion: d.direccion,
      lat: parseFloat(d.latitud),
      lon: parseFloat(d.longitud),
      precios,
      fetched_at: Date.now()
    };

    stationsCache.set(id, { data: station, timestamp: Date.now() });

    return station;

  } catch {
    return null;
  }
}

async function fetchStations(ids) {
  const results = [];

  for (const id of ids) {
    const s = await fetchStationById(id);
    if (s) results.push(s);
  }

  return results;
}

async function runPipeline({ userProfile, context }) {

  const {
    user_lat,
    user_lon,
    comuna,
    destino,
    fuel_type = 'diesel'
  } = context;

  const autonomia = calculateAutonomyKm(userProfile);

  const comunaMap = loadComunaStationsMap();
  const resolved = resolveComunaData(comunaMap, comuna);

  if (!resolved) {
    return { mode: 3, message: 'Comuna no encontrada' };
  }

  let stationIds = resolved.value.stations.map(s => s.id);

  // 🔥 MODO VIAJE
  if (destino) {
    const comunasRuta = getRouteComunas(
      { lat: user_lat, lon: user_lon },
      destino,
      autonomia
    );

    stationIds = [];

    for (const c of comunasRuta) {
      const r = resolveComunaData(comunaMap, c);
      if (r) {
        stationIds.push(...r.value.stations.map(s => s.id));
      }
    }
  }

  const stations = await fetchStations(stationIds);

  // ⚠️ OPTIMIZACIÓN ORS (CLAVE)
  // Ordenamos primero por distancia aproximada (barata)
  stations.sort((a, b) =>
    haversineDistance(user_lat, user_lon, a.lat, a.lon) -
    haversineDistance(user_lat, user_lon, b.lat, b.lon)
  );

  // Tomamos sólo las más cercanas
  const topStations = stations.slice(0, 10);

  const enriched = [];

  for (const s of topStations) {

    let dist = null;

    try {
      dist = await getRealDistance(user_lat, user_lon, s.lat, s.lon);
    } catch {
      dist = null;
    }

    if (!dist) {
      dist = haversineDistance(user_lat, user_lon, s.lat, s.lon);
    }

    if (!s.precios[fuel_type]) continue;

    enriched.push({
      ...s,
      _real_distance_km: dist
    });
  }

  enriched.sort((a, b) => a._real_distance_km - b._real_distance_km);

  const engineStations = enriched.map(s => ({
    id: s.id,
    nombre: s.nombre,
    precio_actual: s.precios[fuel_type],
    _real_distance_km: s._real_distance_km
  }));

  if (engineStations.length === 0) {
    return { mode: 3, message: 'No hay estaciones disponibles' };
  }

  const result = engine.decide(userProfile, engineStations, {});

  result.autonomy_km = Math.round(autonomia);

  return result;
}
function calculateAutonomyKm(userProfile) {
  const {
    tank_capacity_liters = 45,   // capacidad típica
    consumption_km_per_liter = 12 // rendimiento típico
  } = userProfile || {};

  if (!tank_capacity_liters || !consumption_km_per_liter) {
    return 400; // fallback razonable
  }

  return tank_capacity_liters * consumption_km_per_liter;
}
module.exports = { runPipeline };
