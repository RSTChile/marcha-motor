function loadComunaStationsMap() {
  if (comunasMapCache) return comunasMapCache;
  try {
    const raw = JSON.parse(fs.readFileSync(COMUNA_STATIONS_FILE, 'utf8'));
    comunasMapCache = raw.comunas || {};
    return comunasMapCache;
  } catch (err) {
    return {};
  }
}

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
function loadComunaStationsMap() {
  if (comunasMapCache) return comunasMapCache;
  try {
    const raw = JSON.parse(fs.readFileSync(COMUNA_STATIONS_FILE, 'utf8'));
    comunasMapCache = raw.comunas || {};
    return comunasMapCache;
  } catch (err) {
    return {};
  }
}

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
// ===============================
// 🔴 NUEVO: AUTONOMÍA
// ===============================

function calcularAutonomia(userProfile) {
  const kmPorLitro = 100 / userProfile.fuel_consumption;
  const litros = userProfile.tank_capacity * (userProfile.current_level_pct / 100);
  return kmPorLitro * litros;
}

// ===============================
// 🔴 NUEVO: VECTOR DIRECCIÓN
// ===============================

function getVector(a, b) {
  return {
    x: b.lon - a.lon,
    y: b.lat - a.lat
  };
}

function dot(a, b) {
  return a.x * b.x + a.y * b.y;
}

function enRuta(origen, destino, punto) {
  const v1 = getVector(origen, destino);
  const v2 = getVector(origen, punto);
  return dot(v1, v2) > 0;
}

function buscarCentroComuna(nombre, comunaMap) {
  for (const [key, value] of Object.entries(comunaMap)) {
    if (key.toLowerCase() === nombre.toLowerCase()) {
      return {
        lat: value.lat || 0,
        lon: value.lon || 0
      };
    }
  }
  return null;
}
async function runPipeline({ userProfile, context }) {

  const { user_lat, user_lon, fuel_type = 'diesel', comuna, destino } = context;

  const comunaMap = loadComunaStationsMap();

  if (!comunaMap[comuna]) {
    return { mode: 3, message: `No hay estaciones para ${comuna}` };
  }

  const stationIds = comunaMap[comuna].stations.map(s => s.id);

  const stations = await fetchStationsByIds(stationIds);

  const stationsWithRealDist = [];

  for (const station of stations) {
    const realDist = await getRealDistance(user_lat, user_lon, station.lat, station.lon);
    const finalDist = realDist || haversineDistance(user_lat, user_lon, station.lat, station.lon);

    stationsWithRealDist.push({
      ...station,
      _real_distance_km: finalDist
    });
  }

  // ===============================
  // 🔴 NUEVO: AUTONOMÍA
  // ===============================

  const autonomia = calcularAutonomia(userProfile);

  let filtradas = stationsWithRealDist.filter(s => s._real_distance_km <= autonomia);

  // ===============================
  // 🔴 NUEVO: TRAYECTORIA
  // ===============================

  if (destino) {
    const destinoCentro = buscarCentroComuna(destino, comunaMap);

    if (destinoCentro) {
      const origen = { lat: user_lat, lon: user_lon };

      const enTrayecto = filtradas.filter(s =>
        enRuta(origen, destinoCentro, { lat: s.lat, lon: s.lon })
      );

      if (enTrayecto.length > 0) {
        filtradas = enTrayecto;
      }
    }
  }
      filtradas.sort((a, b) => a._real_distance_km - b._real_distance_km);

  const engineStations = filtradas
    .map(s => prepareStation(s, fuel_type, s._real_distance_km))
    .filter(Boolean);

  if (engineStations.length === 0) {
    return { mode: 3, message: 'No hay estaciones disponibles' };
  }

  const refPrice = calculateReferencePrice(engineStations);

  const result = engine.decide(userProfile, engineStations, {
    user_lat,
    user_lon,
    reference_price: refPrice
  });

  result.message =
    `Autonomía estimada: ${Math.floor(autonomia)} km.` +
    (destino
      ? ` Evaluando estaciones en ruta hacia ${destino}.`
      : '');

  return result;
}

module.exports = { runPipeline };
