const express = require('express');
const path = require('path');

const { runPipeline, getDatasetStats } = require('./src/pipeline');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Health
app.get('/health', (req, res) => {
  res.json({ ok: true, status: 'running' });
});

// Stats dataset
app.get('/api/stats', (req, res) => {
  res.json(getDatasetStats());
});

// Motor real
app.post('/api/decide', async (req, res) => {
  try {
    const { userProfile, context } = req.body;

    if (!userProfile || !context) {
      return res.status(400).json({
        ok: false,
        error: 'Faltan userProfile o context',
      });
    }

    const result = await runPipeline({ userProfile, context });

    res.json({
      ok: true,
      result,
    });
  } catch (err) {
    console.error('ERROR /api/decide:', err);
    res.status(500).json({
      ok: false,
      error: 'Error interno del sistema',
    });
  }
});

// Caso Cero
app.get('/caso-cero', async (req, res) => {
  try {
    const userProfile = {
      context_type: 'domestic',
      fuel_consumption: 10,  // L/100km = 10 km/L real
      tank_capacity: 56,
      current_level_pct: 25,
      budget_today: 25000,
      convenio_discount: 0,
    };

    const context = {
      user_lat: -32.8396,
      user_lon: -70.9530,
      fuel_type: 'diesel',
      reference_price: 1500,
      is_urban_peak: false,
      toll_estimate: 0,
    };

    const result = await runPipeline({ userProfile, context });
    res.json(result);
  } catch (err) {
    console.error('ERROR /caso-cero:', err);
    res.status(500).json({
      ok: false,
      error: 'Error ejecutando caso cero',
    });
  }
});

// Frontend fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`🚀 Marcha activo en puerto ${PORT}`);
});