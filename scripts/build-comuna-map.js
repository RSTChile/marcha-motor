/**
 * Script para construir el mapeo comuna → IDs de estaciones
 * Ejecutar: node scripts/build-comuna-map.js
 * 
 * Este script consulta la API y genera data/comunas-stations.json
 */

const fs = require('fs');
const path = require('path');

const API_BASE = 'https://api.bencinaenlinea.cl/api/estacion_ciudadano';
const ID_START = 1;
const ID_END = 3000;
const BATCH_SIZE = 20;
const DELAY_MS = 100;

// Cache temporal para no repetir consultas
const cache = new Map();

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchStation(id) {
  if (cache.has(id)) return cache.get(id);
  
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    
    const res = await fetch(`${API_BASE}/${id}`, {
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
    const data = json?.data;
    
    if (!data?.latitud || !data?.longitud) return null;
    if (!data?.comuna) return null;
    
    const result = { id: data.id, comuna: data.comuna, region: data.region };
    cache.set(id, result);
    return result;
    
  } catch (err) {
    return null;
  }
}

async function buildComunaMap() {
  console.log('🔍 Construyendo mapeo comuna → IDs...\n');
  
  const comunaMap = {};
  let totalValid = 0;
  let processed = 0;
  
  for (let start = ID_START; start <= ID_END; start += BATCH_SIZE) {
    const end = Math.min(start + BATCH_SIZE - 1, ID_END);
    const ids = Array.from({ length: end - start + 1 }, (_, i) => start + i);
    
    const results = await Promise.all(ids.map(id => fetchStation(id)));
    
    for (const station of results) {
      if (!station) continue;
      
      const comuna = station.comuna;
      if (!comunaMap[comuna]) {
        comunaMap[comuna] = {
          region: station.region,
          station_ids: []
        };
      }
      
      if (!comunaMap[comuna].station_ids.includes(station.id)) {
        comunaMap[comuna].station_ids.push(station.id);
        totalValid++;
      }
    }
    
    processed += ids.length;
    console.log(`📊 Progreso: ${processed}/${ID_END} (${Math.round(processed/ID_END*100)}%) - ${totalValid} IDs válidos en ${Object.keys(comunaMap).length} comunas`);
    
    await sleep(DELAY_MS);
  }
  
  // Ordenar IDs dentro de cada comuna
  for (const comuna in comunaMap) {
    comunaMap[comuna].station_ids.sort((a, b) => a - b);
  }
  
  // Guardar archivo
  const outputPath = path.join(__dirname, '..', 'data', 'comunas-stations.json');
  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  
  const output = {
    meta: {
      generated_at: new Date().toISOString(),
      total_comunas: Object.keys(comunaMap).length,
      total_stations: totalValid,
      source: 'API BencinaEnLinea'
    },
    comunas: comunaMap
  };
  
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log(`\n✅ Archivo guardado en: ${outputPath}`);
  console.log(`📊 Total comunas: ${Object.keys(comunaMap).length}`);
  console.log(`📍 Total estaciones: ${totalValid}`);
}

buildComunaMap().catch(console.error);