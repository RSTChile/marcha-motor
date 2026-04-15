const engine = require('./engine');
const fs = require('fs');
const path = require('path');

const COMUNAS_STATIONS_FILE = path.join(__dirname, '..', 'data', 'comunas-stations.json');
const FETCH_TIMEOUT_MS = 8000;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutos
const MIN_REALISTIC_PRICES = {
  diesel: 1200, gas93: 1200, gas95: 1250, gas97: 1300
};

// Reemplaza con tu API key activa de openrouteservice.org
const ORS_API_KEY = '5b3ce3597851110001cf6248c9d8c8c5c8a84f2d8c8c8c8c8c8c8c8c';

const stationsCache = new Map();
const routeCache = new Map();
let comunasMapCache = null;

function loadComunaStationsMap() {
  if (comunasMapCache) return comunasMapCache;
  try {
    if (!fs.existsSync(COMUNAS_STATIONS_FILE)) {
      console.error('pipeline: comunas-stations.json no encontrado');
      return {};
    }
    const raw = JSON.parse(fs.readFileSync(COMUNAS_STATIONS_FILE, 'utf8'));
    comunasMapCache = raw.comunas;
    console.log('pipeline: Mapeo cargado', Object.keys(comunasMapCache).length, 'comunas');
    return comunasMapCache;
  } catch (err) {
    console.error('pipeline: Error cargando mapeo,', err.message);
    return {};
  }
}

async function getRealDistance(lat1, lon1, lat2, lon2) {
  const cacheKey = `${lat1.toFixed(4)},${lon1.toFixed(4)}-${lat2.toFixed(4)},${lon2.toFixed(4)}`;
  const cached = routeCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) return cached.distance;

  const url = `https://api.openrouteservice.org/v2/directions/driving-car?apikey=${ORS_API_KEY}&start=${lon1},${lat1}&end=${lon2},${lat2}`;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const response = await fetch(url, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal
    });
    clearTimeout(timeout);

    if (!response.ok) {
      console.error('ORS HTTP', response.status, response.statusText);
      return null;
    }
    const routeData = await response.json();
    if (routeData.features?.[0]?.properties?.summary) {
      const distanceKm = routeData.features[0].properties.summary.distance / 1000;
      routeCache.set(cacheKey, { distance: distanceKm, timestamp: Date.now() });
      return distanceKm;
    }
    return null;
  } catch (err) {
    console.error('ORS Error:', err.message);
    return null;
  }
}

function haversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) * 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function fetchStationById(id) {
  const cached = stationsCache.get(id);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) return cached.data;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(`https://api.bencinaenlinea.cl/api/estacion/ciudadano/${id}`, {
      signal: controller.signal,
      headers: {
        'Accept': 'application/json',
        'Origin': 'https://www.bencinaenlinea.cl',
        'Referer': 'https://www.bencinaenlinea.cl'
      }
    });
    clearTimeout(timeout);

    if (!res.ok) return null;
    const json = await res.json();
    const d = json?.data;
    if (!d?.latitud || !d?.longitud) return null;
    if (d.estadobandera != 1) {
      console.log('pipeline: Excluyendo estación', d.id, 'inactiva');
      return null;
    }

    const precios = { diesel: null, gas93: null, gas95: null, gas97: null, kerosene: null };
    const preciosDetalle = [];
    for (const c of d.combustibles) {
      if (!c.precio) continue;
      const precioNum = Math.floor(parseFloat(c.precio));
      const tipo = c.nombrecorto;
      if (tipo === 'DI') precios.diesel = precioNum;
      if (tipo === '93') precios.gas93 = precioNum;
      if (tipo === '95') precios.gas95 = precioNum;
      if (tipo === '97') precios.gas97 = precioNum;
      if (tipo === 'KE') precios.kerosene = precioNum;
      preciosDetalle.push({ tipo: c.nombrelargo, precio: precioNum, unidad: c.unidadcobro || 'L', actualizado: c.actualizado || null });
    }

    const station = {
      id: d.id,
      nombre: getMarcaNombre(d.marca) + (d.razonsocial?.razonsocial || ' Estación'),
      nombrelegal: d.razonsocial?.razonsocial || 'Estación',
      marca: d.marca || 'NA',
      region: d.region,
      comuna: d.comuna,
      direccion: d.direccion,
      lat: parseFloat(d.latitud),
      lon: parseFloat(d.longitud),
      precios,
      preciosdetalle: preciosDetalle,
      servicios: d.servicios,
      metodospago: d.metodospago,
      fetchedat: Date.now()
    };
    stationsCache.set(id, { data: station, timestamp: Date.now() });
    return station;
  } catch (err) {
    console.error('pipeline: Error fetching station', id, err.message);
    return null;
  }
}

function getMarcaNombre(marcaId) {
  const marcas = {
    1: 'Copec', 2: 'Shell', 3: 'Petrobras', 4: 'ENEX', 5: 'Copec',
    10: 'Shell', 15: 'Petrobras', 23: 'Abastible', 24: 'Lipigas',
    151: 'Esmax', 177: 'Autogasco'
  };
  return marcas[marcaId] || 'Estación';
}

async function fetchStationsByIds(ids) {
  console.log('pipeline: Consultando', ids.length, 'estaciones...');
  const batchSize = 10;
  const results = [];
  for (let i = 0; i < ids.length; i += batchSize) {
    const batch = ids.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(id => fetchStationById(id)));
    results.push(...batchResults.filter(Boolean));
    if (i + batchSize < ids.length) await new Promise(r => setTimeout(r, 100));
  }
  console.log('pipeline:', results.length, 'estaciones obtenidas');
  return results;
}

function inferZoneType(region) {
  if (!region) return 'semi';
  const r = region.toLowerCase();
  if (r.includes('metropolitana')) return 'urban';
  const semiUrban = ['valparaíso', 'coquimbo', 'biobío', 'maule', 'o\'higgins', 'araucanía', 'los lagos'];
  for (const x of semiUrban) if (r.includes(x)) return 'semi';
  return 'rural';
}

function prepareStation(station, fuelType, realDistanceKm) {
  const fuelMap = { diesel: 'diesel', gas93: 'gas93', gas95: 'gas95', gas97: 'gas97' };
  const fuelLabel = { diesel: 'Diesel', gas93: 'Gasolina 93', gas95: 'Gasolina 95', gas97: 'Gasolina 97' }[fuelType];
  const price = station.precios[fuelType];
  const minPrice = MIN_REALISTIC_PRICES[fuelType] || 1200;
  if (!price || price < minPrice) {
    console.log('pipeline: Excluyendo', station.nombre, station.comuna, fuelLabel, price, 'mínimo', minPrice);
    return null;
  }

  const ageMinutes = Math.min(Math.round((Date.now() - station.fetchedat) / 60000), 60);
  console.log('pipeline:', station.nombre, station.comuna, fuelLabel, price, 'distancia real', realDistanceKm.toFixed(1) + 'km');

  return {
    id: station.id,
    nombre: station.nombre,
    nombrelegal: station.nombrelegal,
    direccion: station.direccion,
    comuna: station.comuna,
    marca: station.marca,
    lat: station.lat,
    lon: station.lon,
    precioactual: price,
    preciosdetalle: station.preciosdetalle,
    servicios: station.servicios,
    metodospago: station.metodospago,
    precioconvenio: null,
    data: { ageminutes: ageMinutes, reportcount: 1 },
    zonetype: inferZoneType(station.region),
    leavesmainroute: false,
    realdistancekm: realDistanceKm
  };
}

function calculateReferencePrice(engineStations) {
  const prices = engineStations
    .map(s => s.precioactual)
    .filter(p => p > 0)
    .sort((a, b) => a - b);
  if (prices.length === 0) return 1500;
  const mid = Math.floor(prices.length / 2);
  return prices.length % 2 === 0 ? Math.round((prices[mid - 1] + prices[mid]) / 2) : prices[mid];
}

// NUEVA FUNCIÓN: Comunas aledañas + económica neta
function getNearbyStations(comunaData, maxStations = 20) {
  const allStations = [];
  const mainComunaStations = comunaData.stations?.map(s => s.id) || [];
  allStations.push(...mainComunaStations);

  // Comunas aledañas (las 5 más cercanas en el mapeo)
  const nearbyComunas = Object.entries(comunasMapCache)
    .filter(([name, data]) => name !== comunaData.nombre && data.stations)
    .sort(([,a], [,b]) => (a.stations?.length || 0) - (b.stations?.length || 0))
    .slice(0, 5)
    .flatMap(([,data]) => data.stations?.map(s => s.id) || [])
    .slice(0, maxStations - mainComunaStations.length);

  allStations.push(...nearbyComunas);
  return allStations.slice(0, maxStations);
}

function netCostPerKm(station, userLat, userLon, fuelType, fuelConsumption, referencePrice) {
  const distKm = engine.distanceMeters(userLat, userLon, station.lat, station.lon) / 1000;
  const fuelUsed = distKm / fuelConsumption;
  const fuelCost = fuelUsed * referencePrice;
  const stationPricePerKm = station.precioactual * 10; // Ajuste por litro/km
  return Math.round(stationPricePerKm - fuelCost * 10) / 10;
}

// NUEVA SELECCIÓN DE TOP 3
function selectTop3Stations(stationsWithRealDist, fuelType, userProfile, context) {
  // 1 y 2: Más cercanas por distancia
  const sortedByDist = stationsWithRealDist.sort((a, b) => a.realdistancekm - b.realdistancekm);
  const topClose = sortedByDist.slice(0, 2);

  // 3: Más económica neta (dist > media + 20km)
  const avgDist = sortedByDist.reduce((sum, s) => sum + s.realdistancekm, 0) / sortedByDist.length;
  const economicCandidates = sortedByDist.filter(s => s.realdistancekm > avgDist + 20);
  const bestEconomic = economicCandidates.length > 0 
    ? economicCandidates.reduce((best, s) => netCostPerKm(s, context.userlat, context.userlon, fuelType, userProfile.fuelconsumption, context.referenceprice) < netCostPerKm(best, context.userlat, context.userlon, fuelType, userProfile.fuelconsumption, context.referenceprice) ? s : best)
    : sortedByDist[2] || sortedByDist[1];

  return [topClose[0], topClose[1] || topClose[0], bestEconomic];
}

function buildStationObj(original) {
  return {
    id: original.id,
    nombre: original.nombre,
    nombrelegal: original.nombrelegal,
    direccion: original.direccion,
    comuna: original.comuna,
    marca: original.marca,
    preciosdetalle: original.preciosdetalle,
    servicios: original.servicios,
    metodospago: original.metodospago
  };
}

function enrichOne(scored, stationsWithRealDist, fuelType) {
  if (!scored) return scored;
  const original = stationsWithRealDist.find(s => s.id === scored.stationid);
  if (original) {
    const correctPrice = original.precios[fuelType];
    if (correctPrice && correctPrice > 0) {
      scored.displayprice = correctPrice;
      const liters = scored.displayliters || 0;
      scored.displaytotalcost = Math.floor(correctPrice * liters);
      scored.displaydistancekm = original.realdistancekm;
      scored.station = buildStationObj(original);
    }
    if (scored.netsaving) scored.netsaving = Math.floor(scored.netsaving);
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

async function runPipeline(userProfile, context) {
  const startTime = Date.now();
  try {
    console.log('pipeline: Iniciando...');
    const { userlat, userlon, fueltype = 'diesel', comuna } = context;
    if (typeof userlat !== 'number' || typeof userlon !== 'number') {
      return { mode: 3, recommendation: null, alternative: null, message: 'Ubicación inválida' };
    }
    if (!comuna) {
      return { mode: 3, recommendation: null, alternative: null, message: 'Selecciona una comuna válida' };
    }

    // Cargar mapa de comunas
    const comunaMap = loadComunaStationsMap();
    const comunaNorm = comuna.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    let comunaData = null, comunaOriginal = null;
    for (const [key, value] of Object.entries(comunaMap)) {
      const keyNorm = key.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      if (keyNorm.toLowerCase() === comunaNorm.toLowerCase()) {
        comunaData = value;
        comunaOriginal = key;
        break;
      }
    }
    if (!comunaData) {
      console.log('pipeline: Comuna', comuna, 'no encontrada');
      return { mode: 3, recommendation: null, alternative: null, message: 'No hay estaciones para comuna' };
    }

    // EXPANDIDO: Estaciones de comuna + aledañas
    const allStationIds = getNearbyStations(comunaData);
    if (allStationIds.length === 0) {
      return { mode: 3, recommendation: null, alternative: null, message: 'No hay estaciones para comuna' };
    }
    console.log('pipeline: Comuna', comunaOriginal, 'IDs', allStationIds.length, 'estaciones (incluyendo aledañas)');

    // Obtener datos de estaciones
    const stations = await fetchStationsByIds(allStationIds);
    if (stations.length === 0) {
      return { mode: 3, recommendation: null, alternative: null, message: 'No se encontraron estaciones' };
    }

    // Calcular distancias reales
    console.log('pipeline: Calculando distancias reales por carretera...');
    const stationsWithRealDist = [];
    for (const station of stations) {
      const realDist = await getRealDistance(userlat, userlon, station.lat, station.lon);
      let finalDist = realDist;
      let isEstimated = false;
      if (realDist === null) {
        finalDist = haversineDistance(userlat, userlon, station.lat, station.lon);
        isEstimated = true;
      }
      console.log('pipeline: ORS falló para', station.nombre, 'usando línea recta', finalDist.toFixed(1) + 'km');
      stationsWithRealDist.push({ ...station, realdistancekm: finalDist, isestimated: isEstimated });
      await new Promise(r => setTimeout(r, 200));
    }
    stationsWithRealDist.sort((a, b) => a.realdistancekm - b.realdistancekm);
    console.log('pipeline:', stationsWithRealDist.length, 'estaciones. Más cercana:', stationsWithRealDist[0]?.realdistancekm?.toFixed(1) + 'km');

    // NUEVO: Seleccionar TOP 3 fijo
    const top3Stations = selectTop3Stations(stationsWithRealDist, fueltype, userProfile, { ...context, userlat, userlon });
    const engineStations = top3Stations
      .map(s => prepareStation(s, fueltype, s.realdistancekm))
      .filter(Boolean);
    console.log('pipeline: Estaciones para motor (TOP 3):', engineStations.length);

    if (engineStations.length === 0) {
      return { mode: 3, recommendation: null, alternative: null, message: `No hay estaciones con ${fueltype} en ${comunaOriginal}` };
    }

    const refPrice = calculateReferencePrice(engineStations);
    console.log('pipeline: Precio referencia', refPrice);

    // Llamar motor SOLO con TOP 3
    const result = engine.decide(userProfile, engineStations, {
      ...context,
      userlat,
      userlon,
      referenceprice: refPrice,
      isurbanpeak: context.isurbanpeak || false,
      tollestimate: context.tollestimate || 0
    });

    const enriched = enrichResult(result, stationsWithRealDist, fueltype);
    const elapsed = Date.now() - startTime;
    console.log('pipeline: Motor respondió mode', enriched.mode, elapsed + 'ms');
    return enriched;
  } catch (err) {
    console.error('pipeline: Error fatal,', err);
    return { mode: 3, recommendation: null, alternative: null, message: 'Error interno: ' + err.message };
  }
}

module.exports = { runPipeline };
