// Marcha Motor de decisión v0.5.1 Núcleo interno. No documentar públicamente.
// Capas: 1. Motor principal (¿vale la pena cargar aquí?) 2. Capa de urgencia (¿te estás quedando sin combustible?) 3. Mensajera (combina ambas decisiones)
// No teleológico. No utiliza destino. No planifica ruta.
// v0.5 decide() devuelve alternatives con hasta 2 opciones adicionales siempre.

const THRESHOLDS = {
  minnetsavingbase: 500,
  minnetsavingcargok: 15,
  minnetsavingcargomin: 2000,
  maxageurban: 180,
  maxagesemi: 360,
  maxagerural: 720,
  minreportsurban: 3,
  minreportsother: 1,
  complexityexit: 0.30,
  complexityurban: 0.60,
  fuelcriticalkm: 80,
  fuellowkm: 120,
  tankfullthreshold: 80,
  maxsavingperliter: 150
};

// UTILIDADES
function distanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000; // metros
  const toRad = deg => deg * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) * 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function dataQuality(ageMinutes, reportCount, zoneType = 'urban') {
  const maxAge = zoneType === 'urban' ? THRESHOLDS.maxageurban :
                 zoneType === 'semi' ? THRESHOLDS.maxagesemi : THRESHOLDS.maxagerural;
  const minReports = zoneType === 'urban' ? THRESHOLDS.minreportsurban : THRESHOLDS.minreportsother;
  const ageFactor = Math.exp(-ageMinutes / maxAge);
  const repFactor = Math.min(reportCount, minReports) / minReports;
  return Math.round((ageFactor * 0.7 + repFactor * 0.3) * 100) / 100;
}

function devourCost(deviationMeters, fuelConsumption, fuelPrice, tollEstimate = 0) {
  const liters = (deviationMeters / 1000) * (fuelConsumption / 100);
  return Math.round(liters * fuelPrice + tollEstimate);
}

function deviationFactor(contextType, leavesMainRoute) {
  if (contextType === 'cargo' && !leavesMainRoute) return 1.0;
  if (contextType === 'labor') return 1.5;
  return 2.0;
}

function getMinNetSaving(contextType, litersNeeded, referencePrice) {
  if (contextType === 'cargo') {
    const totalCost = litersNeeded * referencePrice * 1.100;
    return Math.max(THRESHOLDS.minnetsavingcargomin, totalCost * THRESHOLDS.minnetsavingcargok / 1000);
  }
  return THRESHOLDS.minnetsavingbase;
}

function complexityPenalty(deviationMeters, leavesMainRoute, urbanPeak, contextType = 'domestic') {
  if (urbanPeak) return contextType === 'cargo' ? 0.40 : THRESHOLDS.complexityurban;
  if (leavesMainRoute) return contextType === 'cargo' ? 0.20 : THRESHOLDS.complexityexit;
  if (deviationMeters > 2000) return contextType === 'cargo' ? 0.15 : THRESHOLDS.complexityexit;
  return 0;
}

function calculateReferencePrice(stations) {
  const prices = stations
    .map(s => s.precioactual)
    .filter(p => p > 0)
    .sort((a, b) => a - b);
  if (prices.length === 0) return 1500;
  const mid = Math.floor(prices.length / 2);
  return prices.length % 2 === 0 ? Math.round((prices[mid - 1] + prices[mid]) / 2) : prices[mid];
}

function detectFuelRisk(user) {
  const liters = (user.tankcapacity * user.currentlevelpct) / 100;
  const kmLeft = liters * 100 / user.fuelconsumption;
  if (kmLeft < THRESHOLDS.fuelcriticalkm) return 'critical';
  if (kmLeft < THRESHOLDS.fuellowkm) return 'low';
  return 'ok';
}

function scoreStation(station, user, context) {
  const { precioactual, precioconvenio, lat, lon, data: { ageminutes, reportcount }, zonetype = 'urban', leavesmainroute = false } = station;
  const { fuelconsumption, tankcapacity, currentlevelpct, budgettoday, contexttype = 'domestic', conveniodiscount = 0 } = user;
  const { userlat, userlon, referenceprice, isurbanpeak = false, tollestimate = 0 } = context;

  const baseprice = precioconvenio ? Math.max(0, precioactual - conveniodiscount) : precioactual;
  const litersneeded = tankcapacity * (1 - currentlevelpct / 100);
  const litersaffordable = Math.min(litersneeded, budgettoday / baseprice);
  if (litersaffordable < 1) return null;

  const pricediff = Math.min(referenceprice - baseprice, THRESHOLDS.maxsavingperliter);
  const grosssaving = Math.round(pricediff * litersaffordable);
  const distm = distanceMeters(userlat, userlon, lat, lon);
  const devfactor = deviationFactor(contexttype, leavesmainroute);
  const deviationcost = devourCost(distm * devfactor, fuelconsumption, baseprice, tollestimate);
  const penalty = complexityPenalty(distm, leavesmainroute, isurbanpeak, contexttype);
  let netsaving = Math.round(grosssaving - deviationcost * (1 - penalty));
  const totalcost = Math.round(baseprice * litersaffordable);
  netsaving = Math.min(netsaving, totalcost * 0.5);

  const dq = dataQuality(ageminutes, reportcount, zonetype);
  const proximitybonus = Math.max(0, 1 - distm / 5000);
  const minsavingctx = getMinNetSaving(contexttype, litersneeded, referenceprice);
  const proxweight = netsaving > minsavingctx ? 500 : 0;
  const rawscore = netsaving * dq * proximitybonus + proxweight;

  const modeResult = resolveMode(netsaving, dq, budgettoday, litersaffordable, currentlevelpct, contexttype, litersneeded, referenceprice);

  return {
    stationid: station.id,
    stationname: station.nombre,
    stationbrand: station.marca,
    lat, lon,
    displayprice: baseprice,
    displaysaving: netsaving,
    displaydistancekm: Math.round(distm / 100),
    displayliters: Math.round(litersaffordable * 10) / 10,
    displaytotalcost: totalcost,
    displayreferenceprice: referenceprice,
    displaysavingperliter: Math.min(pricediff, THRESHOLDS.maxsavingperliter),
    isconvenio: !!precioconvenio && conveniodiscount > 0,
    isoutsideconvenio: !precioconvenio && conveniodiscount > 0 && grosssaving > 0,
    dataquality: dq,
    mode: modeResult.mode,
    overridereason: modeResult.reason,
    score: rawscore,
    netsaving,
    dq,
    grosssaving,
    deviationcost
  };
}

function resolveMode(netSaving, dq, budget, litersAffordable, tankPct, contextType, litersNeeded, referencePrice) {
  if (dq < 0.35) return { mode: 1, reason: 'lowconfidence' };
  if (tankPct > THRESHOLDS.tankfullthreshold) return { mode: 2, reason: 'tankfull' };
  if (litersAffordable < 1) return { mode: 2, reason: 'budget' };
  const minSaving = getMinNetSaving(contextType, litersNeeded, referencePrice);
  if (netSaving < minSaving) return { mode: 2, reason: 'saving' };
  return { mode: 0, reason: null };
}

function decide(user, stations, context) {
  if (!stations || stations.length === 0) {
    return {
      mode: 3,
      recommendation: null,
      alternative: null,
      alternatives: [],
      message: 'Sin datos disponibles para tu zona. Intenta más tarde.'
    };
  }

  const referenceprice = calculateReferencePrice(stations);
  const enrichedContext = { ...context, referenceprice };

  const scored = stations
    .map(s => scoreStation(s, user, enrichedContext))
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) {
    return {
      mode: 3,
      recommendation: null,
      alternative: null,
      alternatives: [],
      message: 'Sin datos disponibles para tu zona. Intenta más tarde.'
    };
  }

  const best = scored[0];
  const overridemessages = {
    tankfull: 'Tu estanque está suficientemente lleno. Te avisamos cuando convenga cargar.',
    budget: 'Con tu presupuesto de hoy no alcanza para una carga útil. Intenta más tarde.',
    saving: 'No hay ahorro real disponible ahora. Sigue tu ruta.'
  };

  // SIEMPRE incluir 2 alternativas (scored[1] y scored[2])
  const alternatives = scored.slice(1, 3);

  if (best.mode === 1) {
    return {
      mode: 1,
      recommendation: best,
      alternative: alternatives[0] || null,
      alternatives,
      message: 'Los precios en esta zona no están verificados hoy. Carga donde siempre cargas.'
    };
  }

  if (best.mode === 2) {
    const reason = best.overridereason === 'saving' ? 'saving' : best.overridereason;
    return {
      mode: 2,
      recommendation: best,
      alternative: null,
      alternatives,
      message: overridemessages[reason] || overridemessages.saving
    };
  }

  return {
    mode: 0,
    recommendation: best,
    alternative: alternatives[0] || null,
    alternatives,  // Siempre hasta 2 opciones adicionales
    message: null
  };
}

// EXPORTS COMPLETOS (distanceMeters agregado para pipeline)
module.exports = {
  decide,
  scoreStation,
  dataQuality,
  distanceMeters,  // ← NUEVO: Para netCostPerKm en pipeline
  devourCost,
  deviationFactor,
  getMinNetSaving,
  calculateReferencePrice,
  detectFuelRisk
};
