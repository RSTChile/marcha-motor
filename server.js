const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');

const { getDecision } = require('./pipeline');
const { crawlAll } = require('./crawler');

const app = express();

// ==============================
// CONFIG
// ==============================
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data', 'stations.json');

// ==============================
// MIDDLEWARE
// ==============================
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// ==============================
// INIT DATASET (AUTO)
// ==============================
async function ensureDataset() {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      console.log('📡 No hay dataset. Ejecutando crawl inicial...');
      await crawlAll({ testLimit: 50 }); // rápido para iniciar
      console.log('✅ Dataset inicial creado');
    } else {
      console.log('📦 Dataset existente encontrado');
    }
  } catch (err) {
    console.error('❌ Error inicializando dataset:', err.message);
  }
}

// ==============================
// ROUTES
// ==============================

// Health check
app.get('/health', (req, res) => {
  res.json({ ok: true, status: 'running' });
});

// Motor de decisión
app.post('/decision', (req, res) => {
  try {
    const { userProfile, context } = req.body;

    if (!userProfile || !context) {
      return res.status(400).json({
        ok: false,
        error: 'Faltan userProfile o context'
      });
    }

    const result = getDecision(userProfile, context);

    res.json({
      ok: true,
      result
    });

  } catch (err) {
    console.error('Error en /decision:', err);
    res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

// Caso Cero (tu escenario real)
app.get('/caso-cero', (req, res) => {

  const userProfile = {
    context_type: 'domestic',
    fuel_consumption: 10,
    tank_capacity: 56,
    current_level_pct: 20,
    budget_today: 25000
  };

  const context = {
    lat: -32.8396,
    lon: -70.9530,
    fuel_type: 'diesel',
    reference_price: 1500,
    is_urban_peak: false
  };

  const result = getDecision(userProfile, context);

  res.json(result);
});

// ==============================
// START SERVER
// ==============================
app.listen(PORT, async () => {
  console.log(`🚀 Marcha corriendo en puerto ${PORT}`);
  console.log(`🌐 http://localhost:${PORT}`);

  await ensureDataset();
});