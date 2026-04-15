/**
 * Marcha — Crawler de estaciones v2
 * Construye data/comunas-stations.json consultando la API BencinaEnLinea.
 *
 * Cambios respecto a v1:
 *   - MAX_ID ampliado a 6000 (cubre RM y todas las regiones)
 *   - Parada temprana aumentada a 400 IDs vacíos consecutivos
 *   - Modo --resume: retoma desde el último ID procesado sin perder lo ya crawleado
 *   - Modo --from N: empieza desde ID N (útil para completar la RM)
 *
 * Uso:
 *   node scripts/crawler.js              — crawl completo desde 0
 *   node scripts/crawler.js --resume     — retoma desde donde quedó
 *   node scripts/crawler.js --from 2200  — empieza desde ID 2200 (para completar RM)
 *   node scripts/crawler.js --test 10    — prueba rápida con 10 estaciones
 */

const fs   = require('fs');
const path = require('path');

const BASE_URL   = 'https://api.bencinaenlinea.cl/api/estacion_ciudadano';
const OUT_FILE   = path.join(__dirname, '..', 'data', 'comunas-stations.json');
const STATE_FILE = path.join(__dirname, '..', 'data', '.crawler-state.json');

const MAX_ID       = 6000;  // ampliado — RM tiene IDs altos
const BATCH_SIZE   = 10;    // requests concurrentes por lote
const DELAY_MS     = 300;   // pausa entre lotes
const RETRY_MAX    = 2;
const EMPTY_STOP   = 400;   // parar si hay 400 IDs vacíos consecutivos (antes era 200)
const CHECKPOINT_N = 200;   // guardar cada N IDs procesados

// ─── Fetch con reintentos ─────────────────────────────────────────────────────

async function fetchStation(id) {
  const url = `${BASE_URL}/${id}`;
  for (let attempt = 0; attempt <= RETRY_MAX; attempt++) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(8000),
        headers: {
          'Accept': 'application/json',
          'Origin': 'https://www.bencinaenlinea.cl',
          'Referer': 'https://www.bencinaenlinea.cl/',
        }
      });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (!json?.data?.latitud) return null;
      return json;
    } catch (e) {
      if (attempt === RETRY_MAX) return null;
      await sleep(600 * (attempt + 1));
    }
  }
  return null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getMarcaNombre(marcaId) {
  const marcas = {
    1: 'Copec', 2: 'Shell', 3: 'Petrobras', 4: 'ENEX', 5: 'Copec',
    10: 'Shell', 15: 'Petrobras', 23: 'Abastible', 24: 'Lipigas',
    151: 'Esmax', 177: 'Autogasco'
  };
  return marcas[marcaId] || `Marca-${marcaId}`;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function loadExisting() {
  try {
    if (fs.existsSync(OUT_FILE)) {
      const raw = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8'));
      return raw.comunas || {};
    }
  } catch (_) {}
  return {};
}

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE))
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (_) {}
  return { lastId: 0 };
}

function saveState(lastId) {
  fs.writeFileSync(STATE_FILE, JSON.stringify({ lastId, savedAt: new Date().toISOString() }));
}

function saveComunas(comunas) {
  const total = Object.values(comunas).reduce((acc, c) => acc + c.stations.length, 0);
  const dir = path.dirname(OUT_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify({
    meta: {
      generated_at:   new Date().toISOString(),
      total_comunas:  Object.keys(comunas).length,
      total_stations: total,
      id_range:       `1-${MAX_ID}`,
      ids_checked:    MAX_ID,
      source:         'API BencinaEnLinea - Real-time',
    },
    comunas,
  }, null, 2));
}

function progress(currentId, maxId, found, region) {
  const pct = Math.round((currentId / maxId) * 100);
  const bar = '█'.repeat(Math.floor(pct / 5)).padEnd(20, '░');
  const reg = region ? ` [${region.slice(0, 20)}]` : '';
  process.stdout.write(`\r  [${bar}] ${pct}%  ID ${currentId}/${maxId}  ${found} estaciones${reg}   `);
}

// ─── Crawler principal ────────────────────────────────────────────────────────

async function crawl(options = {}) {
  const { testLimit, fromId = 1, mergeExisting = false } = options;

  // En modo resume o --from, conservar lo ya crawleado
  const comunas = mergeExisting ? loadExisting() : {};
  const existingCount = Object.values(comunas).reduce((a, c) => a + c.stations.length, 0);

  const maxId = testLimit ? fromId + testLimit * 8 : MAX_ID;

  console.log(`\n  Marcha — Crawler v2`);
  console.log(`  Rango: ${fromId}..${maxId}  |  Lote: ${BATCH_SIZE}  |  Pausa: ${DELAY_MS}ms`);
  if (mergeExisting) console.log(`  Modo merge: conservando ${Object.keys(comunas).length} comunas existentes (${existingCount} estaciones)`);
  console.log('');

  let found       = existingCount;
  let newThisRun  = 0;
  let emptyStreak = 0;

  for (let batch = fromId; batch <= maxId; batch += BATCH_SIZE) {
    const ids = Array.from(
      { length: Math.min(BATCH_SIZE, maxId - batch + 1) },
      (_, i) => batch + i
    );

    const fetched = await Promise.all(ids.map(fetchStation));
    let lastRegion = '';

    fetched.forEach((raw, i) => {
      const id = ids[i];
      if (!raw || !raw.data) { emptyStreak++; return; }

      const d = raw.data;

      // Excluir inactivas
      if (d.estado_bandera !== 1) { emptyStreak++; return; }

      const comunaKey = (d.comuna || 'Sin comarca').trim();
      lastRegion = d.region || lastRegion;
      emptyStreak = 0;

      if (!comunas[comunaKey]) {
        comunas[comunaKey] = {
          region:   d.region || '',
          lat:      parseFloat(d.latitud),
          lon:      parseFloat(d.longitud),
          stations: [],
        };
      }

      if (!comunas[comunaKey].lat && d.latitud) {
        comunas[comunaKey].lat = parseFloat(d.latitud);
        comunas[comunaKey].lon = parseFloat(d.longitud);
      }

      if (!comunas[comunaKey].stations.find(s => s.id === id)) {
        comunas[comunaKey].stations.push({
          id,
          nombre: getMarcaNombre(d.marca),
          marca:  d.marca,
        });
        found++;
        newThisRun++;
      }
    });

    progress(Math.min(batch + BATCH_SIZE - 1, maxId), maxId, found, lastRegion);

    // Checkpoint
    const checked = batch - fromId + BATCH_SIZE;
    if (checked % CHECKPOINT_N === 0) {
      saveComunas(comunas);
      saveState(batch + BATCH_SIZE - 1);
    }

    await sleep(DELAY_MS);

    // Parada temprana (solo en crawl completo)
    if (!testLimit && emptyStreak >= EMPTY_STOP) {
      console.log(`\n\n  Parada temprana: ${EMPTY_STOP} IDs vacíos consecutivos en ID ${batch}.`);
      break;
    }

    if (testLimit && newThisRun >= testLimit) break;
  }

  saveComunas(comunas);
  saveState(maxId);

  // Resumen final
  const total = Object.values(comunas).reduce((a, c) => a + c.stations.length, 0);
  console.log(`\n\n  ✓ Completado — ${Object.keys(comunas).length} comunas, ${total} estaciones, ${newThisRun} nuevas`);
  console.log(`  Guardado en: data/comunas-stations.json\n`);

  // Resumen por región
  const byRegion = {};
  for (const [, data] of Object.entries(comunas)) {
    const reg = data.region || 'Sin región';
    if (!byRegion[reg]) byRegion[reg] = { comunas: 0, stations: 0 };
    byRegion[reg].comunas++;
    byRegion[reg].stations += data.stations.length;
  }
  const sorted = Object.entries(byRegion).sort((a, b) => b[1].stations - a[1].stations);
  sorted.forEach(([reg, d]) =>
    console.log(`  ${reg.padEnd(38)} ${String(d.comunas).padStart(3)} comunas  ${String(d.stations).padStart(4)} estaciones`)
  );

  const rmEntry = sorted.find(([r]) => r.toLowerCase().includes('metropolitana'));
  if (!rmEntry || rmEntry[1].stations === 0) {
    console.log('\n  ⚠️  La Región Metropolitana no tiene estaciones. Ejecuta:');
    console.log('     node scripts/crawler.js --from 2200\n');
  }
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

async function main() {
  const args    = process.argv.slice(2);
  const resume  = args.includes('--resume');
  const testIdx = args.indexOf('--test');
  const fromIdx = args.indexOf('--from');

  const testLimit = testIdx >= 0 ? parseInt(args[testIdx + 1]) || 10 : null;
  const fromId    = fromIdx >= 0 ? parseInt(args[fromIdx + 1]) || 1  : 1;

  if (testLimit) {
    await crawl({ testLimit, fromId, mergeExisting: true });
  } else if (resume) {
    const state = loadState();
    console.log(`  Retomando desde ID ${state.lastId + 1}`);
    await crawl({ fromId: state.lastId + 1, mergeExisting: true });
  } else if (fromIdx >= 0) {
    // --from siempre hace merge para no perder lo ya crawleado
    await crawl({ fromId, mergeExisting: true });
  } else {
    await crawl({ fromId: 1, mergeExisting: false });
  }
}

main().catch(e => { console.error('\nError fatal:', e.message); process.exit(1); });
