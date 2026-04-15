async function findPreciseLimit() {
  console.log('🔍 Buscando límite PRECISO...\n');
  
  const testIds = [2210, 2220, 2230, 2240, 2250, 2260, 2270, 2280, 2290];
  
  for (const id of testIds) {
    try {
      const res = await fetch(`https://api.bencinaenlinea.cl/api/estacion_ciudadano/${id}`, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(5000)
      });
      
      const json = await res.json();
      const hasData = json?.data?.latitud && json?.data?.longitud;
      const nombre = json?.data?.razon_social?.razon_social || 'N/A';
      
      console.log(`ID ${id}: ${hasData ? '✅ EXISTE' : '❌ VACÍO'} - ${nombre.substring(0, 40)}`);
    } catch (e) {
      console.log(`ID ${id}: 🔥 ERROR`);
    }
    
    await new Promise(r => setTimeout(r, 200));
  }
}

findPreciseLimit();