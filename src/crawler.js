/**
 * Marcha — Crawler de estaciones reales
 * Construye dataset local desde api.bencinaenlinea.cl
 *
 * Uso:
 *   node src/crawler.js
 *   node src/crawler.js --update
 *   node src/crawler.js --test 50
 */

const fs = require('fs');
const path = require('path');
const { fetchStationRaw, normalizeStation } = require('./connector');

const DATA_FILE = path.join(__dirname, '..', 'data', 'stations.json');
const MAX_ID = 3000;
const BATCH_SIZE = 10;
const DELAY_MS = 300;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function loadExisting() {
  try {
    if (!fs.existsSync(DATA_FILE)) return { stations: [], meta: {} };
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return {
      stations: raw.stations || [],
      meta: raw.meta || {},
    };
  } catch {
    return { stations: [], meta: {} };
  }
}

function saveDataset(stations, meta = {}) {
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  fs.writeFileSync(
    DATA_FILE,
    JSON.stringify(
      {
        meta: {
          ...meta,
          updated_at: new Date().toISOString(),
          total: stations.length,
        },
        stations,
      },
      null,
      2
    )
  );
}

function progress(current, total, found) {
  const pct = Math.round((current / total) * 100);
  const filled = Math.floor(pct / 5);
  const bar = '█'.repeat(filled) + '░'.repeat(20 - filled);
  process.stdout.write(`\r[${bar}] ${pct}% — ID ${current}/${total} — ${found} estaciones`);
}

async function crawlAll({ onlyUpdate = false, testLimit = null } = {}) {
  const existingData = loadExisting();
  const existing = existingData.stations;
  const existingIds = new Set(existing.map(s => s.id));

  const results = [...existing];
  const maxId = testLimit ? Math.max(100, testLimit * 10) : MAX_ID;

  let found = existing.length;
  let checked = 0;
  let consecutiveEmpty = 0;

  console.log(`\nIniciando crawl — rango IDs: 1..${maxId}`);
  console.log(`Estaciones ya conocidas: ${existing.length}\n`);

  for (let batchStart = 1; batchStart <= maxId; batchStart += BATCH_SIZE) {
    const ids = Array.from(
      { length: Math.min(BATCH_SIZE, maxId - batchStart + 1) },
      (_, i) => batchStart + i
    );

    const idsToFetch = onlyUpdate
      ? ids.filter(id => existingIds.has(id))
      : ids;

    if (idsToFetch.length === 0) {
      checked += ids.length;
      continue;
    }

    const fetched = await Promise.all(idsToFetch.map(id => fetchStationRaw(id)));

    for (let i = 0; i < idsToFetch.length; i++) {
      const id = idsToFetch[i];
      const raw = fetched[i];

      if (!raw) {
        consecutiveEmpty++;
        continue;
      }

      const station = normalizeStation(raw);
      if (!station) {
        consecutiveEmpty++;
        continue;
      }

      consecutiveEmpty = 0;

      if (existingIds.has(id)) {
        const idx = results.findIndex(s => s.id === id);
        if (idx >= 0) results[idx] = station;
      } else {
        results.push(station);
        existingIds.add(id);
        found++;
      }
    }

    checked += ids.length;
    progress(Math.min(checked, maxId), maxId, found);

    if (checked % 100 === 0) {
      saveDataset(results);
    }

    if (!testLimit && consecutiveEmpty > 200) {
      console.log('\n\nSin estaciones en 200 IDs consecutivos. Deteniendo.');
      break;
    }

    if (testLimit && (found - existing.length) >= testLimit) {
      break;
    }

    await sleep(DELAY_MS);
  }

  saveDataset(results);
  console.log(`\n\n✓ Crawl completado — ${found} estaciones guardadas en ${DATA_FILE}\n`);
  return results;
}

async function main() {
  const args = process.argv.slice(2);
  const onlyUpdate = args.includes('--update');
  const testIdx = args.indexOf('--test');
  const testLimit = testIdx >= 0 ? parseInt(args[testIdx + 1], 10) || 20 : null;

  if (testLimit) {
    await crawlAll({ testLimit });
    return;
  }

  if (onlyUpdate) {
    await crawlAll({ onlyUpdate: true });
    return;
  }

  await crawlAll();
}

if (require.main === module) {
  main().catch(err => {
    console.error('\nError:', err.message);
    process.exit(1);
  });
}

module.exports = {
  crawlAll,
  loadExisting,
  saveDataset,
};