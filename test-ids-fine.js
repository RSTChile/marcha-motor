async function findExactLimit() {
  console.log('🔍 Buscando límite exacto...\n');
  
  const testIds = [2100, 2200, 2300, 2400, 2500, 2600, 2700, 2800, 2900];
  
  for (const id of testIds) {
    try {
      const res = await fetch(`https://api.bencinaenlinea.cl/api/estacion_ciudadano/${id}`, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(5000)
      });
      
      const json = await res.json();
      const hasData = json?.data?.latitud && json?.data?.longitud;
      const nombre = json?.data?.razon_social?.razon_social || 'N/A';
      
      console.log(`ID ${id}: ${hasData ? '✅ EXISTE' : '❌ VACÍO'} - ${nombre.substring(0, 30)}`);
    } catch (e) {
      console.log(`ID ${id}: 🔥 ERROR - ${e.message}`);
    }
    
    await new Promise(r => setTimeout(r, 200));
  }
}

findExactLimit();