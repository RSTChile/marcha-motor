/**
 * Script para construir el mapeo COMPLETO comuna → IDs de estaciones
 * Ejecutar: node scripts/build-comuna-map.js
 * 
 * Este script consulta la API y genera data/comunas-stations.json
 * Rango: 1-2260 (todas las estaciones reales)
 */

const fs = require('fs');
const path = require('path');

const API_BASE = 'https://api.bencinaenlinea.cl/api/estacion_ciudadano';
const ID_START = 1;
const ID_END = 2260;  // ✅ RANGO EXACTO CONFIRMADO
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
    
    // ✅ Guardar información completa
    const result = {
      id: data.id,
      nombre: data.razon_social?.razon_social || 'Estación',
      marca: data.marca || 'Desconocida',
      comuna: data.comuna,
      region: data.region || '',
      lat: parseFloat(data.latitud),
      lon: parseFloat(data.longitud)
    };
    
    cache.set(id, result);
    return result;
    
  } catch (err) {
    return null;
  }
}

async function buildComunaMap() {
  console.log('🔍 Construyendo mapeo COMPLETO comuna → IDs...\n');
  console.log(`📌 Rango: ${ID_START}-${ID_END}`);
  console.log(`⏱️  Estimado: ${Math.ceil((ID_END - ID_START) / BATCH_SIZE) * (DELAY_MS / 1000) / 60} minutos\n`);
  
  const comunaMap = {};
  let totalValid = 0;
  let processed = 0;
  let nullCount = 0;
  let startTime = Date.now();
  
  for (let start = ID_START; start <= ID_END; start += BATCH_SIZE) {
    const end = Math.min(start + BATCH_SIZE - 1, ID_END);
    const ids = Array.from({ length: end - start + 1 }, (_, i) => start + i);
    
    const results = await Promise.all(ids.map(id => fetchStation(id)));
    
    for (const station of results) {
      if (!station) {
        nullCount++;
        continue;
      }
      
      const comuna = station.comuna;
      if (!comunaMap[comuna]) {
        comunaMap[comuna] = {
          region: station.region,
          lat: station.lat,
          lon: station.lon,
          stations: []
        };
      }
      
      // ✅ Guardar información completa de la estación
      if (!comunaMap[comuna].stations.find(s => s.id === station.id)) {
        comunaMap[comuna].stations.push({
          id: station.id,
          nombre: station.nombre,
          marca: station.marca
        });
        totalValid++;
      }
    }
    
    processed += ids.length;
    const progress = Math.round(processed / ID_END * 100);
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    
    console.log(`📊 ${progress}% | ${processed}/${ID_END} | ✅ ${totalValid} estaciones | ❌ ${nullCount} vacíos | ⏱️ ${elapsed}s`);
    
    await sleep(DELAY_MS);
  }
  
  // ✅ Ordenar estaciones dentro de cada comuna
  for (const comuna in comunaMap) {
    comunaMap[comuna].stations.sort((a, b) => a.id - b.id);
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
      id_range: `${ID_START}-${ID_END}`,
      source: 'API BencinaEnLinea - Real-time',
      ids_checked: processed,
      ids_empty: nullCount
    },
    comunas: comunaMap
  };
  
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
  
  const totalTime = Math.round((Date.now() - startTime) / 1000);
  
  console.log(`\n✅ Archivo guardado en: ${outputPath}`);
  console.log(`\n📊 ESTADÍSTICAS FINALES:`);
  console.log(`  Total comunas: ${Object.keys(comunaMap).length}`);
  console.log(`  Total estaciones: ${totalValid}`);
  console.log(`  IDs procesados: ${processed}`);
  console.log(`  IDs vacíos: ${nullCount}`);
  console.log(`  Tiempo total: ${totalTime}s`);
  console.log(`  Rango: ${ID_START}-${ID_END}`);
  
  // ✅ Mostrar top 10 comunas por estaciones
  const top10 = Object.entries(comunaMap)
    .sort((a, b) => b[1].stations.length - a[1].stations.length)
    .slice(0, 10);
  
  console.log(`\n🏆 TOP 10 COMUNAS MÁS ESTACIONES:`);
  top10.forEach(([nombre, info], idx) => {
    console.log(`  ${idx + 1}. ${nombre} (${info.region}): ${info.stations.length} estaciones`);
  });
}

buildComunaMap().catch(console.error);