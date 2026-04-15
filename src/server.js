const express = require('express');
const bodyParser = require('body-parser');
const { getDecision } = require('./pipeline');

const app = express();
app.use(bodyParser.json());

app.get('/', (req, res) => {
  res.send('Marcha API OK');
});

app.post('/decision', (req, res) => {
  try {
    const { userProfile, context } = req.body;

    if (!userProfile || !context) {
      return res.status(400).json({
        error: 'Faltan userProfile o context'
      });
    }

    const result = getDecision(userProfile, context);

    res.json({
      ok: true,
      result
    });

  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

// 🔥 Caso Cero directo
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

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`🚀 Marcha corriendo en http://localhost:${PORT}`);
});