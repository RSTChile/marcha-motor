/**
 * Marcha — Motor de decisión v0.4
 * Núcleo interno. No documentar públicamente.
 * 
 * Capas:
 *   1. Motor principal → ¿vale la pena cargar aquí?
 *   2. Capa de urgencia → ¿te estás quedando sin combustible?
 *   3. Mensajería → combina ambas decisiones
 * 
 * No teleológico. No utiliza destino. No planifica ruta.
 */

// ===============================
// CONSTANTES DE CALIBRACIÓN
// ===============================

const THRESHOLDS = {
  // Umbral base para usuario doméstico/laboral
  min_net_saving_base: 500,
  
  // Factor de escala para carga (0.015 = 1.5% del costo total)
  min_net_saving_cargo_k: 15,
  min_net_saving_cargo_min: 2000,
  
  // Umbrales de data quality por zona (minutos)
  max_age_urban: 180,      // 3 horas
  max_age_semi: 360,       // 6 horas
  max_age_rural: 720,      // 12 horas
  
  // Reportes mínimos para confianza alta
  min_reports_urban: 3,
  min_reports_other: 1,
  
  // Penalizaciones
  complexity_exit: 0.30,   // salir de ruta principal
  complexity_urban: 0.60,  // entrar a zona urbana en hora punta
  
  // Umbrales de urgencia (km de autonomía)
  fuel_critical_km: 80,
  fuel_low_km: 120,
  
  // Estanque lleno (no recomendar carga)
  tank_full_threshold: 80,  // porcentaje
};

// ===============================
// UTILIDADES
// ===============================

function toKm(meters) {
  return meters / 1000;
}

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

function computeDataQuality(station) {
  let maxAge = THRESHOLDS.max_age_semi;
  if (station.zone_type === 'urban') maxAge = THRESHOLDS.max_age_urban;
  if (station.zone_type === 'rural') maxAge = THRESHOLDS.max_age_rural;
  
  const minReports = station.zone_type === 'urban'
    ? THRESHOLDS.min_reports_urban
    : THRESHOLDS.min_reports_other;
  
  const ageFactor = Math.exp(-station.data_age_minutes / maxAge);
  const repFactor = Math.min(station.report_count, minReports) / minReports;
  
  let score = (ageFactor * 0.7) + (repFactor * 0.3);
  return Math.max(0, Math.min(1, Math.round(score * 100) / 100));
}

// ===============================
// UMBRAL DINÁMICO DE AHORRO
// ===============================

function getDynamicThreshold(user, litersToLoad, referencePrice) {
  if (user.context_type === 'cargo') {
    const totalCost = litersToLoad * (referencePrice || 1100);
    return Math.max(
      THRESHOLDS.min_net_saving_cargo_min,
      totalCost * (THRESHOLDS.min_net_saving_cargo_k / 1000)
    );
  }
  return THRESHOLDS.min_net_saving_base;
}

// ===============================
// DETECCIÓN DE RIESGO DE COMBUSTIBLE
// ===============================

function detectFuelRisk(user) {
  const liters = user.tank_capacity * (user.current_level_pct / 100);
  const kmLeft = liters * (100 / user.fuel_consumption);
  
  if (kmLeft < THRESHOLDS.fuel_critical_km) return 'critical';
  if (kmLeft < THRESHOLDS.fuel_low_km) return 'low';
  return 'ok';
}

// ===============================
// PENALIZACIONES POR CONTEXTO
// ===============================

function applyContextPenalties(score, station, user, context) {
  let adjusted = score;
  
  if (station.zone_type === 'urban' && context.is_urban_peak) {
    adjusted *= (1 - THRESHOLDS.complexity_urban);
  }
  
  if (station.leaves_main_route) {
    const penalty = user.context_type === 'cargo'
      ? THRESHOLDS.complexity_exit * 0.67
      : THRESHOLDS.complexity_exit;
    adjusted *= (1 - penalty);
  }
  
  return adjusted;
}

// ===============================
// EVALUACIÓN DE UNA ESTACIÓN
// ===============================

function evaluateStation(user, station, context) {
  const {
    fuel_consumption,
    tank_capacity,
    current_level_pct,
    budget_today,
    context_type,
  } = user;
  
  const {
    user_lat,
    user_lon,
    reference_price,
    is_urban_peak = false,
    toll_estimate = 0,
  } = context;
  
  const basePrice = station.precio_convenio || station.precio_actual;
  
  // Estanque lleno
  if (current_level_pct >= THRESHOLDS.tank_full_threshold) {
    return {
      station,
      net_saving: 0,
      score: 0,
      mode: 2,
      mode_reason: 'tank_full',
      data_quality: 1,
    };
  }
  
  const litersNeeded = tank_capacity * (1 - current_level_pct / 100);
  const litersAffordable = Math.min(litersNeeded, budget_today / basePrice);
  
  if (litersAffordable < 1) {
    return {
      station,
      net_saving: 0,
      score: 0,
      mode: 2,
      mode_reason: 'budget',
      data_quality: 1,
    };
  }
  
  const distMeters = distanceMeters(user_lat, user_lon, station.lat, station.lon);
  const distKm = toKm(distMeters);
  
  // AJUSTE 2: detourFactor simplificado
  let detourFactor = station.leaves_main_route ? 2 : 1;
  
  const litersPerKm = fuel_consumption / 100;
  const fuelCostPerKm = litersPerKm * reference_price;
  const detourCost = distKm * detourFactor * fuelCostPerKm + (toll_estimate || 0);
  
  const priceDiff = reference_price - basePrice;
  const grossSaving = priceDiff * litersAffordable;
  const netSaving = Math.round(grossSaving - detourCost);
  
  const dataQuality = computeDataQuality(station);
  const dynamicThreshold = getDynamicThreshold(user, litersAffordable, reference_price);
  
  let mode = 0;
  let modeReason = null;
  
  if (dataQuality < 0.35) {
    mode = 1;
    modeReason = 'low_confidence';
  } else if (netSaving < dynamicThreshold) {
    mode = 2;
    modeReason = 'saving';
  }
  
  let score = netSaving * dataQuality;
  
  const proximityBonus = Math.max(0, 1 - distKm / 5);
  if (netSaving > dynamicThreshold) {
    // AJUSTE 3: proximity bonus reducido de 500 a 200
    score += proximityBonus * 200;
  }
  
  score = applyContextPenalties(score, station, user, context);
  
  return {
    station,
    net_saving: netSaving,
    score: Math.max(0, score),
    mode,
    mode_reason: modeReason,
    data_quality: dataQuality,
    display_price: basePrice,
    display_liters: Math.round(litersAffordable * 10) / 10,
    display_distance_km: Math.round(distKm * 10) / 10,
    is_convenio: !!station.precio_convenio,
  };
}

// ===============================
// CONSTRUCCIÓN DE MENSAJES
// ===============================

function buildRecommendationMessage(best, fuelRisk) {
  const saving = Math.round(best.net_saving);
  const liters = best.display_liters;
  const stationName = best.station.nombre;
  
  let message = `Carga en ${stationName}. ${liters} L por $${Math.round(best.display_price * liters)}. Ahorro estimado: $${saving}.`;
  
  if (fuelRisk === 'critical') {
    return message + " Te queda muy poco combustible. Carga ahora.";
  }
  if (fuelRisk === 'low') {
    return message + " Nivel bajo de combustible. Buena decisión cargar ahora.";
  }
  return message;
}

function buildUncertainMessage(fuelRisk) {
  if (fuelRisk === 'critical') {
    return "Datos de precio no están verificados. Pero te queda muy poco combustible: carga en la próxima estación disponible.";
  }
  if (fuelRisk === 'low') {
    return "Datos de precio inciertos en esta zona. Si vas justo de combustible, carga en una estación confiable.";
  }
  return "Los precios en esta zona no están verificados hoy. Carga donde siempre cargas.";
}

function buildNoGoMessage(fuelRisk, modeReason) {
  if (fuelRisk === 'critical') {
    return "No hay ahorro relevante, pero te queda muy poco combustible. Carga en la próxima estación.";
  }
  if (fuelRisk === 'low') {
    return "No hay ahorro real disponible ahora. Si quieres mayor margen, puedes cargar en la próxima estación.";
  }
  if (modeReason === 'tank_full') {
    return "Tu estanque está suficientemente lleno. Te avisamos cuando convenga cargar.";
  }
  if (modeReason === 'budget') {
    return "Con tu presupuesto de hoy no alcanza para una carga útil. Intenta más tarde.";
  }
  return "No hay ahorro real disponible ahora. Sigue tu ruta.";
}

// ===============================
// DECISIÓN PRINCIPAL
// ===============================

function decide(user, stations, context) {
  const evaluations = stations.map(st => evaluateStation(user, st, context));
  const fuelRisk = detectFuelRisk(user);
  
  const bestNormal = evaluations
    .filter(e => e.mode === 0)
    .sort((a, b) => b.score - a.score)[0] || null;
  
  const alternative = bestNormal
    ? evaluations
        .filter(e => e.mode === 0 && e.station.id !== bestNormal.station.id)
        .sort((a, b) => b.score - a.score)[0] || null
    : null;
  
  const bestOverall = evaluations
    .sort((a, b) => b.score - a.score)[0] || null;
  
  if (bestNormal) {
    return {
      mode: 0,
      recommendation: bestNormal,
      alternative: alternative,
      message: buildRecommendationMessage(bestNormal, fuelRisk),
    };
  }
  
  if (bestOverall && bestOverall.mode === 1) {
    return {
      mode: 1,
      recommendation: null,
      alternative: null,
      message: buildUncertainMessage(fuelRisk),
    };
  }
  
  const modeReason = bestOverall?.mode_reason || 'saving';
  return {
    mode: 2,
    recommendation: null,
    alternative: null,
    message: buildNoGoMessage(fuelRisk, modeReason),
  };
}

// ===============================
// EXPORTS
// ===============================

module.exports = {
  decide,
  evaluateStation,
  computeDataQuality,
  detectFuelRisk,
  distanceMeters,
  getDynamicThreshold,
};