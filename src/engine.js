/**
 * Marcha — Motor de decisión v0.5
 * Núcleo interno. No documentar públicamente.
 *
 * Capas:
 *   1. Motor principal → ¿vale la pena cargar aquí?
 *   2. Capa de urgencia → ¿te estás quedando sin combustible?
 *   3. Mensajería → combina ambas decisiones
 *
 * No teleológico. No utiliza destino. No planifica ruta.
 * v0.5: decide() devuelve alternatives[] con hasta 2 opciones adicionales siempre.
 */

// ===============================
// CONSTANTES DE CALIBRACIÓN
// ===============================

const THRESHOLDS = {
  min_net_saving_base:     500,
  min_net_saving_cargo_k:  15,
  min_net_saving_cargo_min: 2000,
  max_age_urban:           180,
  max_age_semi:            360,
  max_age_rural:           720,
  min_reports_urban:       3,
  min_reports_other:       1,
  complexity_exit:         0.30,
  complexity_urban:        0.60,
  fuel_critical_km:        80,
  fuel_low_km:             120,
  tank_full_threshold:     80,
  max_saving_per_liter:    150,
};

// ===============================
// UTILIDADES
// ===============================

function distanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = deg => deg * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) *
            Math.cos(toRad(lat2)) *
            Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ===============================
// DATA QUALITY (INR proxy)
// ===============================

function dataQuality(ageMinutes, reportCount, zoneType = 'urban') {
  const maxAge = zoneType === 'urban' ? THRESHOLDS.max_age_urban :
                 zoneType === 'semi'  ? THRESHOLDS.max_age_semi  :
                                        THRESHOLDS.max_age_rural;
  const minReports = zoneType === 'urban'
    ? THRESHOLDS.min_reports_urban
    : THRESHOLDS.min_reports_other;
  const ageFactor = Math.exp(-ageMinutes / maxAge);
  const repFactor = Math.min(reportCount, minReports) / minReports;
  return Math.round((ageFactor * 0.7 + repFactor * 0.3) * 100) / 100;
}

// ===============================
// COSTO DEL DESVÍO
// ===============================

function devourCost(deviationMeters, fuelConsumption, fuelPrice, tollEstimate = 0) {
  const liters = (deviationMeters / 1000) * (fuelConsumption / 100);
  return Math.round(liters * fuelPrice + tollEstimate);
}

// ===============================
// FACTOR DE DESVÍO SEGÚN CONTEXTO
// ===============================

function deviationFactor(contextType, leavesMainRoute) {
  if (contextType === 'cargo' && !leavesMainRoute) return 1.0;
  if (contextType === 'labor') return 1.5;
  return 2.0;
}

// ===============================
// UMBRAL MÍNIMO DE AHORRO
// ===============================

function getMinNetSaving(contextType, litersNeeded, referencePrice) {
  if (contextType === 'cargo') {
    const totalCost = litersNeeded * (referencePrice || 1100);
    return Math.max(
      THRESHOLDS.min_net_saving_cargo_min,
      totalCost * (THRESHOLDS.min_net_saving_cargo_k / 1000)
    );
  }
  return THRESHOLDS.min_net_saving_base;
}

// ===============================
// PENALIZACIÓN POR COMPLEJIDAD
// ===============================

function complexityPenalty(deviationMeters, leavesMainRoute, urbanPeak, contextType = 'domestic') {
  if (urbanPeak)              return contextType === 'cargo' ? 0.40 : THRESHOLDS.complexity_urban;
  if (leavesMainRoute)        return contextType === 'cargo' ? 0.20 : THRESHOLDS.complexity_exit;
  if (deviationMeters > 2000) return contextType === 'cargo' ? 0.15 : THRESHOLDS.complexity_exit;
  return 0;
}

// ===============================
// PRECIO DE REFERENCIA (mediana)
// ===============================

function calculateReferencePrice(stations) {
  const prices = stations
    .map(s => s.precio_actual)
    .filter(p => p && p > 0)
    .sort((a, b) => a - b);
  if (prices.length === 0) return 1500;
  const mid = Math.floor(prices.length / 2);
  return prices.length % 2 === 0
    ? Math.round((prices[mid - 1] + prices[mid]) / 2)
    : prices[mid];
}

// ===============================
// DETECCIÓN DE RIESGO DE COMBUSTIBLE
// ===============================

function detectFuelRisk(user) {
  const liters = user.tank_capacity * (user.current_level_pct / 100);
  const kmLeft = liters * (100 / user.fuel_consumption);
  if (kmLeft < THRESHOLDS.fuel_critical_km) return 'critical';
  if (kmLeft < THRESHOLDS.fuel_low_km)      return 'low';
  return 'ok';
}

// ===============================
// SCORE PRINCIPAL
// ===============================

function scoreStation(station, user, context) {
  const {
    precio_actual, precio_convenio,
    lat, lon,
    data_age_minutes, report_count,
    zone_type = 'urban',
    leaves_main_route = false,
  } = station;

  const {
    fuel_consumption, tank_capacity,
    current_level_pct, budget_today,
    context_type = 'domestic',
    convenio_discount = 0,
  } = user;

  const {
    user_lat, user_lon,
    reference_price,
    is_urban_peak = false,
    toll_estimate = 0,
  } = context;

  const base_price = precio_convenio
    ? precio_convenio
    : Math.max(0, precio_actual - convenio_discount);

  const liters_needed     = tank_capacity * (1 - current_level_pct / 100);
  const liters_affordable = Math.min(liters_needed, budget_today / base_price);
  if (liters_affordable < 1) return null;

  const price_diff  = Math.min(reference_price - base_price, THRESHOLDS.max_saving_per_liter);
  const gross_saving = Math.round(price_diff * liters_affordable);

  const dist_m        = distanceMeters(user_lat, user_lon, lat, lon);
  const dev_factor    = deviationFactor(context_type, leaves_main_route);
  const deviation_cost = devourCost(dist_m * dev_factor, fuel_consumption, base_price, toll_estimate);
  const penalty       = complexityPenalty(dist_m, leaves_main_route, is_urban_peak, context_type);

  let net_saving    = Math.round((gross_saving - deviation_cost) * (1 - penalty));
  const total_cost  = Math.round(base_price * liters_affordable);
  net_saving        = Math.min(net_saving, total_cost * 0.5);

  const dq             = dataQuality(data_age_minutes, report_count, zone_type);
  const proximity_bonus = Math.max(0, 1 - dist_m / 5000);
  const min_saving_ctx  = getMinNetSaving(context_type, liters_needed, reference_price);
  const prox_weight     = net_saving > min_saving_ctx ? 500 : 0;
  const raw_score       = (net_saving * dq) + (proximity_bonus * prox_weight);

  const modeResult = resolveMode(net_saving, dq, budget_today, liters_affordable,
                                 current_level_pct, context_type, liters_needed, reference_price);

  return {
    station_id:              station.id,
    station_name:            station.nombre,
    station_brand:           station.marca,
    lat, lon,
    display_price:           base_price,
    display_saving:          net_saving,
    display_distance_km:     Math.round(dist_m / 100) / 10,
    display_liters:          Math.round(liters_affordable * 10) / 10,
    display_total_cost:      total_cost,
    display_reference_price: reference_price,
    display_saving_per_liter: Math.min(price_diff, THRESHOLDS.max_saving_per_liter),
    is_convenio:             !!precio_convenio || convenio_discount > 0,
    is_outside_convenio:     !precio_convenio && convenio_discount === 0 && gross_saving > 0,
    data_quality:            dq,
    mode:                    modeResult.mode,
    _override_reason:        modeResult.reason,
    _score:                  raw_score,
    _net_saving:             net_saving,
    _dq:                     dq,
    _gross_saving:           gross_saving,
    _deviation_cost:         deviation_cost,
  };
}

// ===============================
// RESOLVER MODO
// ===============================

function resolveMode(netSaving, dq, budget, litersAffordable, tankPct, contextType, litersNeeded, referencePrice) {
  if (dq < 0.35)                                          return { mode: 1, reason: 'low_confidence' };
  if (tankPct >= THRESHOLDS.tank_full_threshold)          return { mode: 2, reason: 'tank_full' };
  if (litersAffordable < 1)                               return { mode: 2, reason: 'budget' };
  const minSaving = getMinNetSaving(contextType, litersNeeded, referencePrice);
  if (netSaving < minSaving)                              return { mode: 2, reason: 'saving' };
  return { mode: 0, reason: null };
}

// ===============================
// DECISIÓN PRINCIPAL
// ===============================

function decide(user, stations, context) {
  if (!stations || stations.length === 0) {
    return { mode: 3, recommendation: null, alternative: null, alternatives: [], message: 'Sin datos disponibles para tu zona. Intenta más tarde.' };
  }

  const reference_price = calculateReferencePrice(stations);
  const enrichedContext = { ...context, reference_price };

  const scored = stations
    .map(s => scoreStation(s, user, enrichedContext))
    .filter(Boolean)
    .sort((a, b) => b._score - a._score);

  if (scored.length === 0) {
    return { mode: 3, recommendation: null, alternative: null, alternatives: [], message: 'Sin datos disponibles para tu zona. Intenta más tarde.' };
  }

  const best = scored[0];

  const override_messages = {
    tank_full: 'Tu estanque está suficientemente lleno. Te avisamos cuando convenga cargar.',
    budget:    'Con tu presupuesto de hoy no alcanza para una carga útil. Intenta más tarde.',
    saving:    'No hay ahorro real disponible ahora. Sigue tu ruta.',
  };

  // Alternativas: siempre incluir scored[1] y scored[2] si existen,
  // independientemente del ahorro. El usuario siempre ve hasta 2 opciones adicionales.
  const alternatives = scored.slice(1, 3);

  if (best.mode === 1) {
    return {
      mode: 1,
      recommendation: best,
      alternative:  alternatives[0] || null,
      alternatives,
      message: 'Los precios en esta zona no están verificados hoy. Carga donde siempre cargas.',
    };
  }

  if (best.mode === 2) {
    const reason = best._override_reason || 'saving';
    return {
      mode: 2,
      recommendation: best,
      alternative:  null,
      alternatives: [],
      message: override_messages[reason] || override_messages.saving,
    };
  }

  return {
    mode: 0,
    recommendation: best,
    alternative:  alternatives[0] || null,  // compatibilidad con código legacy
    alternatives,                            // nueva clave — hasta 2 opciones
    message: null,
  };
}

// ===============================
// EXPORTS
// ===============================

module.exports = {
  decide,
  scoreStation,
  dataQuality,
  distanceMeters,
  devourCost,
  deviationFactor,
  getMinNetSaving,
  calculateReferencePrice,
  detectFuelRisk,
};
