const express = require('express');
const path = require('path');
const fs = require('fs');

const { runPipeline } = require('./src/pipeline');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/data', express.static(path.join(__dirname, 'data')));

// =============================================
// HEALTH CHECK
// =============================================

app.get('/health', (req, res) => {
  res.json({ ok: true, status: 'running' });
});

// =============================================
// LISTA DE COMUNAS PARA BÚSQUEDA MANUAL
// =============================================

app.get('/api/comunas-list', (req, res) => {
  try {
    const comunasFile = path.join(__dirname, 'data', 'comunas-completo.json');
    if (!fs.existsSync(comunasFile)) {
      return res.json({ comunas: [] });
    }
    const data = JSON.parse(fs.readFileSync(comunasFile, 'utf8'));
    res.json({ comunas: data.comunas || [] });
  } catch (err) {
    console.error('[comunas-list] Error:', err);
    res.json({ comunas: [] });
  }
});

// =============================================
// FUNCIÓN HAVERSINE (distancia en línea recta)
// =============================================

function haversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 +
            Math.cos(lat1 * Math.PI / 180) *
            Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// =============================================
// DETECTAR COMUNA POR COORDENADAS (GPS)
// Usa distancia REAL por carretera (OpenRouteService)
// =============================================

app.post('/api/detect-commune', async (req, res) => {
  try {
    const { lat, lng } = req.body;
    
    if (typeof lat !== 'number' || typeof lng !== 'number') {
      return res.status(400).json({
        ok: false,
        message: 'Coordenadas inválidas'
      });
    }
    
    // Cargar lista completa de comunas
    const comunasFile = path.join(__dirname, 'data', 'comunas-completo.json');
    if (!fs.existsSync(comunasFile)) {
      return res.status(500).json({
        ok: false,
        message: 'Lista de comunas no disponible'
      });
    }
    
    const data = JSON.parse(fs.readFileSync(comunasFile, 'utf8'));
    const comunasList = data.comunas || [];
    
    // Tu API key de OpenRouteService
    const ORS_API_KEY = '5b3ce3597851110001cf6248c9d8c8c5c8a84f2d8c8c8c8c8c8c8c8';
    
    // Función para obtener distancia real desde OpenRouteService
    async function getRealDistance(lat1, lon1, lat2, lon2) {
      const url = `https://api.openrouteservice.org/v2/directions/driving-car?api_key=${ORS_API_KEY}&start=${lon1},${lat1}&end=${lon2},${lat2}`;
      
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        const response = await fetch(url, { signal: controller.signal });
        clearTimeout(timeout);
        
        if (!response.ok) return null;
        const routeData = await response.json();
        if (routeData.features && routeData.features[0] && routeData.features[0].properties.summary) {
          return routeData.features[0].properties.summary.distance / 1000; // metros a km
        }
        return null;
      } catch (err) {
        console.error('[ORS] Error:', err.message);
        return null;
      }
    }
    
    // Primero, filtrar comunas por distancia en línea recta (para no sobrecargar ORS)
    const MAX_CANDIDATES = 5;
    const withStraightDist = comunasList.map(c => ({
      ...c,
      _straight_dist: haversineDistance(lat, lng, c.lat, c.lng)
    })).sort((a, b) => a._straight_dist - b._straight_dist)
      .slice(0, MAX_CANDIDATES);
    
    // Luego, calcular distancia REAL para las 5 más cercanas en línea recta
    const withRealDist = [];
    for (const c of withStraightDist) {
      const realDist = await getRealDistance(lat, lng, c.lat, c.lng);
      withRealDist.push({
        ...c,
        _real_dist: realDist !== null ? realDist : c._straight_dist,
        _is_estimated: realDist === null
      });
      // Pequeña pausa para no saturar la API
      await new Promise(r => setTimeout(r, 200));
    }
    
    // Ordenar por distancia real
    withRealDist.sort((a, b) => a._real_dist - b._real_dist);
    
    const closest = withRealDist[0];
    
    if (!closest) {
      return res.status(404).json({
        ok: false,
        message: 'No se encontró comuna cercana'
      });
    }
    
    console.log(`[detect-commune] Comuna detectada: ${closest.nombre} (distancia real: ${closest._real_dist.toFixed(1)} km, línea recta: ${closest._straight_dist.toFixed(1)} km)`);
    
    res.json({
      ok: true,
      commune: {
        nombre: closest.nombre,
        region: closest.region,
        lat: closest.lat,
        lon: closest.lng
      },
      distance_km: closest._real_dist,
      is_estimated: closest._is_estimated || false
    });
    
  } catch (err) {
    console.error('[detect-commune] Error:', err);
    res.status(500).json({
      ok: false,
      message: 'Error detectando comuna'
    });
  }
});

// =============================================
// ESTADÍSTICAS DEL MAPEO
// =============================================

app.get('/api/stats', (req, res) => {
  try {
    const comunasFile = path.join(__dirname, 'data', 'comunas-completo.json');
    if (!fs.existsSync(comunasFile)) {
      return res.json({ ok: true, total: 0, message: 'Lista no disponible' });
    }
    const data = JSON.parse(fs.readFileSync(comunasFile, 'utf8'));
    res.json({ 
      ok: true, 
      total_comunas: data.comunas?.length || 0,
      generated_at: data.meta?.generated_at || null
    });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// =============================================
// MOTOR PRINCIPAL
// =============================================

app.post('/api/decide', async (req, res) => {
  try {
    const { userProfile, context } = req.body;

    if (!userProfile || !context) {
      return res.status(400).json({
        ok: false,
        error: 'Faltan userProfile o context'
      });
    }

    const result = await runPipeline({ userProfile, context });

    res.json({
      ok: true,
      result
    });
  } catch (err) {
    console.error('ERROR /api/decide:', err);
    res.status(500).json({
      ok: false,
      error: 'Error interno del sistema'
    });
  }
});

// =============================================
// CASO CERO (prueba directa)
// =============================================

app.get('/caso-cero', async (req, res) => {
  try {
    const userProfile = {
      context_type: 'domestic',
      fuel_consumption: 10,
      tank_capacity: 56,
      current_level_pct: 25,
      budget_today: 25000,
      convenio_discount: 0,
    };

    const context = {
      user_lat: -32.840588,
      user_lon: -70.959100,
      fuel_type: 'diesel',
      comuna: 'Llaillay',
      reference_price: null,
      is_urban_peak: false,
      toll_estimate: 0,
    };

    const result = await runPipeline({ userProfile, context });
    res.json(result);
  } catch (err) {
    console.error('ERROR /caso-cero:', err);
    res.status(500).json({
      ok: false,
      error: 'Error ejecutando caso cero'
    });
  }
});

// =============================================
// FRONTEND FALLBACK
// =============================================

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`🚀 Marcha activo en puerto ${PORT}`);
});
