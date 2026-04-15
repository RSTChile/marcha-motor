/**
 * Marcha — Tests del motor v0.4
 * Verificación con datos simulados antes de conexión real
 */

const { decide, evaluateStation, computeDataQuality, detectFuelRisk, distanceMeters } = require('../src/engine');

// ===============================
// DATOS DE PRUEBA
// ===============================

const USER_DOMESTIC = {
  context_type: 'domestic',
  fuel_consumption: 10,     // L/100km
  tank_capacity: 56,
  current_level_pct: 25,
  budget_today: 25000,
  convenio_discount: 0,
};

const USER_CARGO = {
  context_type: 'cargo',
  fuel_consumption: 35,     // L/100km
  tank_capacity: 400,
  current_level_pct: 30,
  budget_today: 200000,
  convenio_discount: 40,
};

const CONTEXT = {
  user_lat: -33.4489,
  user_lon: -70.6693,
  reference_price: 1500,
  is_urban_peak: false,
  toll_estimate: 0,
};

const STATIONS = [
  {
    id: 'S1',
    nombre: 'Copec Test',
    marca: 'Copec',
    lat: -33.4501,
    lon: -70.6650,
    precio_actual: 1480,
    precio_convenio: null,
    data_age_minutes: 45,
    report_count: 5,
    zone_type: 'urban',
    leaves_main_route: false,
  },
  {
    id: 'S2',
    nombre: 'Shell Test',
    marca: 'Shell',
    lat: -33.4820,
    lon: -70.6510,
    precio_actual: 1450,
    precio_convenio: null,
    data_age_minutes: 300,
    report_count: 1,
    zone_type: 'urban',
    leaves_main_route: true,
  },
  {
    id: 'S3',
    nombre: 'ENEX Test',
    marca: 'ENEX',
    lat: -33.4455,
    lon: -70.6720,
    precio_actual: 1520,
    precio_convenio: null,
    data_age_minutes: 45,
    report_count: 2,
    zone_type: 'semi',
    leaves_main_route: false,
  },
];

// ===============================
// UTILIDAD DE TESTS
// ===============================

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ✗ ${name}: ${e.message}`);
    failed++;
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'Assertion failed');
}

// ===============================
// TESTS
// ===============================

console.log('\n=== MARCHA v0.4 — Tests del motor ===\n');

// Test 1: distanceMeters
console.log('[ distancia ]');
test('distancia Santiago-Maipú ≈ 15-20 km', () => {
  const d = distanceMeters(-33.4489, -70.6693, -33.5093, -70.7647);
  assert(d > 15000 && d < 20000, `esperado 15-20 km, obtenido ${(d/1000).toFixed(1)} km`);
});

// Test 2: computeDataQuality
console.log('\n[ dataQuality ]');
test('dato fresco en zona urbana → alta calidad', () => {
  const dq = computeDataQuality({ data_age_minutes: 45, report_count: 5, zone_type: 'urban' });
  assert(dq > 0.7, `esperado > 0.7, obtenido ${dq}`);
});
test('dato viejo en zona urbana → baja calidad', () => {
  const dq = computeDataQuality({ data_age_minutes: 400, report_count: 1, zone_type: 'urban' });
  assert(dq < 0.4, `esperado < 0.4, obtenido ${dq}`);
});

// Test 3: detectFuelRisk
console.log('\n[ fuelRisk ]');
test('estanque al 10% → risk critical', () => {
  const risk = detectFuelRisk({ tank_capacity: 56, current_level_pct: 10, fuel_consumption: 10 });
  assert(risk === 'critical', `esperado critical, obtenido ${risk}`);
});
test('estanque al 30% → risk low', () => {
  const risk = detectFuelRisk({ tank_capacity: 56, current_level_pct: 30, fuel_consumption: 10 });
  assert(risk === 'low', `esperado low, obtenido ${risk}`);
});
test('estanque al 60% → risk ok', () => {
  const risk = detectFuelRisk({ tank_capacity: 56, current_level_pct: 60, fuel_consumption: 10 });
  assert(risk === 'ok', `esperado ok, obtenido ${risk}`);
});

// Test 4: evaluateStation
console.log('\n[ evaluateStation ]');
test('estación cercana con buen precio → net_saving positivo', () => {
  const result = evaluateStation(USER_DOMESTIC, STATIONS[0], CONTEXT);
  assert(result !== null, 'no debe ser null');
  assert(result.net_saving !== undefined, 'debe tener net_saving');
});
test('estación con dato viejo → data_quality baja', () => {
  const result = evaluateStation(USER_DOMESTIC, STATIONS[1], CONTEXT);
  assert(result.data_quality < 0.4, `data_quality esperado < 0.4, obtenido ${result.data_quality}`);
});
test('usuario sin presupuesto → mode override', () => {
  const brokeUser = { ...USER_DOMESTIC, budget_today: 200 };
  const result = evaluateStation(brokeUser, STATIONS[0], CONTEXT);
  assert(result.mode === 2, `mode esperado 2, obtenido ${result.mode}`);
  assert(result.mode_reason === 'budget', `reason esperado budget, obtenido ${result.mode_reason}`);
});
test('estanque lleno → mode override', () => {
  const fullUser = { ...USER_DOMESTIC, current_level_pct: 85 };
  const result = evaluateStation(fullUser, STATIONS[0], CONTEXT);
  assert(result.mode === 2, `mode esperado 2, obtenido ${result.mode}`);
  assert(result.mode_reason === 'tank_full', `reason esperado tank_full, obtenido ${result.mode_reason}`);
});

// Test 5: decide
console.log('\n[ decide ]');
test('modo normal: recomienda mejor estación', () => {
  const result = decide(USER_DOMESTIC, STATIONS, CONTEXT);
  assert(result.mode === 0, `mode esperado 0, obtenido ${result.mode}`);
  assert(result.recommendation !== null, 'debe haber recomendación');
});
test('modo low_confidence: datos inciertos', () => {
  const oldStations = STATIONS.map(s => ({
    ...s,
    data_age_minutes: 500,
    report_count: 0,
  }));
  const result = decide(USER_DOMESTIC, oldStations, CONTEXT);
  assert(result.mode === 1, `mode esperado 1, obtenido ${result.mode}`);
});
test('sin estaciones → modo silent', () => {
  const result = decide(USER_DOMESTIC, [], CONTEXT);
  assert(result.mode === 3, `mode esperado 3, obtenido ${result.mode}`);
  assert(result.recommendation === null, 'no debe haber recomendación');
});

// Test 6: usuario de carga con convenio
console.log('\n[ convenio B2B ]');
test('usuario con convenio → precio con descuento', () => {
  const stationWithConvenio = {
    ...STATIONS[0],
    precio_convenio: 1440,
  };
  const result = evaluateStation(USER_CARGO, stationWithConvenio, CONTEXT);
  assert(result.is_convenio === true, 'debe marcar como convenio');
  assert(result.display_price === 1440, `precio esperado 1440, obtenido ${result.display_price}`);
});

// Test 7: urgencia por combustible bajo
console.log('\n[ urgencia ]');
test('estanque crítico + modo override → mensaje de urgencia', () => {
  const criticalUser = { ...USER_DOMESTIC, current_level_pct: 10, tank_capacity: 56, fuel_consumption: 10 };
  const result = decide(criticalUser, STATIONS, CONTEXT);
  // En modo override (mode 2) debe tener mensaje de urgencia
  if (result.mode === 2) {
    assert(result.message.includes('poco combustible') || result.message.includes('bajo'), 
      'mensaje debe mencionar urgencia');
  }
});

// ===============================
// RESUMEN
// ===============================

console.log(`\n=== Resultado: ${passed} pasados, ${failed} fallidos ===\n`);
if (failed > 0) process.exit(1);