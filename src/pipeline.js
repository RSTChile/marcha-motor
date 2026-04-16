/**
 * Marcha — Pipeline v4.2 (corregido)
 */

const engine = require('./engine');
const fs = require('fs');
const path = require('path');

const COMUNA_STATIONS_FILE = path.join(__dirname, '..', 'data', 'comunas-stations.json');
const COMUNAS_COMPLETE_FILE = path.join(__dirname, '..', 'data', 'comunas-completo.json');

const MIN_REALISTIC_PRICES = {
  diesel: 1200,
  gas93: 1200,
  gas95: 1250,
  gas97: 1300
};

const ORS_API_KEY = 'eyJvcmciOiI1YjNjZTM1OTc4NTExMTAwMDFjZjYyNDgiLCJpZCI6ImU0ODZkY2U1MzU0MTQ4YzFiMDgwMTg2YTYyYTBiOThiIiwiaCI6Im11cm11cjY0In0=';

const stationsCache = new Map();
const routeCache = new Map();

let comunasMapCache = null;
let comunasCompleteCache = null;

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}
function loadComunaStationsMap() {
  if (comunasMapCache) return comunasMapCache;

  try {
    const raw = JSON.parse(fs.readFileSync(COMUNA_STATIONS_FILE, 'utf8'));
    comunasMapCache = raw.comunas || {};
    return comunasMapCache;
  } catch {
    return {};
  }
}

function loadComunasCompleteMap() {
  if (comunasCompleteCache) return comunasCompleteCache;

  try {
    const raw = JSON.parse(fs.readFileSync(COMUNAS_COMPLETE_FILE, 'utf8'));
    const map = {};

    for (const c of raw.comunas || []) {
      map[normalizeText(c.nombre)] = c;
    }

    comunasCompleteCache = map;
    return map;
  } catch {
    return {};
  }
}

function getComunaCoords(nombre) {
  const map = loadComunasCompleteMap();
  const c = map[normalizeText(nombre)];
  if (!c) return null;

  return {
    lat: Number(c.lat),
    lon: Number(c.lng)
  };
}
async function getRealDistance(lat1, lon1, lat2, lon2) {
  const key = `${lat1},${lon1}|${lat2},${lon2}`;
  if (routeCache.has(key)) return routeCache.get(key);

  try {
    const res = await fetch(
      'https://api.openrouteservice.org/v2/directions/driving-car',
      {
        method: 'POST',
        headers: {
          'Authorization': ORS_API_KEY,
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

    if (!res.ok) return null;

    const json = await res.json();
    const km = json.features[0].properties.summary.distance / 1000;

    routeCache.set(key, km);
    return km;

  } catch {
    return null;
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
function calculateAutonomyKm(userProfile) {
  const cap = Number(userProfile.tank_capacity || 0);
  const lvl = Number(userProfile.current_level_pct || 0);
  const cons = Number(userProfile.fuel_consumption || 0);

  if (!cap || !lvl || !cons) return 0;

  const liters = cap * (lvl / 100);
  const kmPerL = 100 / cons;

  return liters * kmPerL;
}

function isForward(origin, dest, point) {
  const dx = dest.lon - origin.lon;
  const dy = dest.lat - origin.lat;

  const px = point.lon - origin.lon;
  const py = point.lat - origin.lat;

  return dx * px + dy * py > 0;
}

function distanceToLine(origin, dest, point) {
  const dx = dest.lon - origin.lon;
  const dy = dest.lat - origin.lat;

  const px = point.lon - origin.lon;
  const py = point.lat - origin.lat;

  return Math.abs(dx * py - dy * px) / Math.sqrt(dx * dx + dy * dy);
}
function getStationIds(comuna, destino, origin, autonomyKm) {
  const map = loadComunaStationsMap();

  if (!destino) {
    return map[comuna]?.stations?.map(s => s.id) || [];
  }

  const destCoords = getComunaCoords(destino);
  if (!destCoords) return [];

  const ids = [];

  for (const c of Object.keys(map)) {
    const coords = getComunaCoords(c);
    if (!coords) continue;

    if (!isForward(origin, destCoords, coords)) continue;

    if (distanceToLine(origin, destCoords, coords) > 1.2) continue;

    const dist = haversineDistance(origin.lat, origin.lon, coords.lat, coords.lon);

    if (dist > autonomyKm * 1.25) continue;

    ids.push(...(map[c]?.stations?.map(s => s.id) || []));
  }

  return [...new Set(ids)];
}
async function runPipeline({ userProfile, context }) {
  const { user_lat, user_lon, fuel_type, comuna, destino } = context;

  const autonomyKm = calculateAutonomyKm(userProfile);

  const origin = { lat: user_lat, lon: user_lon };

  const ids = getStationIds(comuna, destino, origin, autonomyKm);

  const stations = [];

  for (const id of ids) {
    const s = await fetch(`https://api.bencinaenlinea.cl/api/estacion_ciudadano/${id}`)
      .then(r => r.json())
      .then(j => j.data)
      .catch(() => null);

    if (!s) continue;

    const lat = parseFloat(s.latitud);
    const lon = parseFloat(s.longitud);

    let dist = await getRealDistance(user_lat, user_lon, lat, lon);
    if (!dist) dist = haversineDistance(user_lat, user_lon, lat, lon);

    stations.push({
      id,
      nombre: s.marca,
      lat,
      lon,
      precio_actual: parseInt(s.combustibles?.[0]?.precio || 0),
      _real_distance_km: dist
    });
  }

  stations.sort((a, b) => a._real_distance_km - b._real_distance_km);

  return {
    mode: 1,
    recommendation: stations[0] || null,
    alternatives: stations.slice(1, 3),
    message: `Autonomía: ${Math.floor(autonomyKm)} km`
  };
}

module.exports = { runPipeline };
