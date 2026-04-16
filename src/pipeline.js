const engine = require('./engine');
const estacionesData = require('../data/comunas-stations.json');

// ===============================
// UTILIDADES BASE (YA EXISTENTES)
// ===============================

function haversine(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const toRad = x => x * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
        Math.sin(dLon / 2) ** 2;
    return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

// ===============================
// 🔴 NUEVO: VECTOR DIRECCIONAL
// ===============================

function getVector(origen, destino) {
    return {
        x: destino.lng - origen.lng,
        y: destino.lat - origen.lat
    };
}

function dot(a, b) {
    return a.x * b.x + a.y * b.y;
}

// ===============================
// 🔴 NUEVO: FILTRO DE TRAYECTORIA
// ===============================

function estaEnTrayectoria(origen, destino, punto) {
    const vRuta = getVector(origen, destino);
    const vEst = getVector(origen, punto);

    const prod = dot(vRuta, vEst);

    // si es negativo → está hacia atrás
    return prod > 0;
}
// ===============================
// 🔴 NUEVO: AUTONOMÍA
// ===============================

function calcularAutonomia(userProfile) {
    const kmPorLitro = 100 / userProfile.fuel_consumption;
    const litrosDisponibles =
        userProfile.tank_capacity * (userProfile.current_level_pct / 100);

    return kmPorLitro * litrosDisponibles;
}

// ===============================
// 🔴 NUEVO: EXPANSIÓN DE BÚSQUEDA
// ===============================

function obtenerTodasLasEstaciones() {
    const all = [];

    for (const region of estacionesData.regiones) {
        for (const comuna of region.comunas) {
            for (const est of comuna.estaciones) {
                all.push(est);
            }
        }
    }

    return all;
}
// ===============================
// PIPELINE PRINCIPAL
// ===============================

async function runPipeline(userProfile, context) {

    console.log('[pipeline] 🚀 Iniciando...');

    const { user_lat, user_lon, comuna, destino } = context;

    const autonomia = calcularAutonomia(userProfile);

    console.log(`[pipeline] 🔋 Autonomía estimada: ${autonomia.toFixed(1)} km`);

    let estaciones = obtenerTodasLasEstaciones();

    console.log(`[pipeline] 📊 Total estaciones disponibles: ${estaciones.length}`);

    // ===============================
    // 🔴 FILTRO POR AUTONOMÍA
    // ===============================

    estaciones = estaciones.filter(est => {
        if (!est.lat || !est.lng) return false;

        const dist = haversine(user_lat, user_lon, est.lat, est.lng);
        est._dist = dist;

        return dist <= autonomia;
    });

    console.log(`[pipeline] ⛽ Estaciones dentro de autonomía: ${estaciones.length}`);

    // ===============================
    // 🔴 FILTRO POR TRAYECTORIA
    // ===============================

    let estacionesFiltradas = estaciones;

    if (destino) {
        console.log(`[pipeline] 🧭 Aplicando filtro de trayectoria hacia ${destino}`);

        const destinoObj = buscarComuna(destino);

        if (destinoObj) {
            estacionesFiltradas = estaciones.filter(est => {
                return estaEnTrayectoria(
                    { lat: user_lat, lng: user_lon },
                    { lat: destinoObj.lat, lng: destinoObj.lng },
                    { lat: est.lat, lng: est.lng }
                );
            });

            console.log(`[pipeline] ➡️ Estaciones en trayectoria: ${estacionesFiltradas.length}`);
        } else {
            console.log(`[pipeline] ⚠️ Destino no encontrado`);
        }
    }

    // fallback si queda vacío
    if (!estacionesFiltradas.length) {
        console.log('[pipeline] ⚠️ Sin estaciones en trayectoria, usando todas');
        estacionesFiltradas = estaciones;
    }

    // ===============================
    // 🔴 ORDENAR POR DISTANCIA
    // ===============================

    estacionesFiltradas.sort((a, b) => a._dist - b._dist);

    // ===============================
    // 🔴 PASAR AL MOTOR EXISTENTE
    // ===============================

    const result = await engine.decide(userProfile, context, estacionesFiltradas);

    // ===============================
    // 🔴 MENSAJE EXTENDIDO
    // ===============================

    result.message = `Con tu combustible actual tienes aproximadamente ${Math.floor(autonomia)} km de autonomía.` +
        (destino
            ? ` Se evaluaron estaciones en trayectoria hacia ${destino}.`
            : ` Se evaluaron estaciones en tu zona.`);

    return result;
}
// ===============================
// 🔴 BUSCAR COMUNA
// ===============================

function buscarComuna(nombre) {
    for (const region of estacionesData.regiones) {
        for (const comuna of region.comunas) {
            if (comuna.nombre.toLowerCase() === nombre.toLowerCase()) {
                return comuna;
            }
        }
    }
    return null;
}

// ===============================
// EXPORT
// ===============================

module.exports = {
    runPipeline
};
