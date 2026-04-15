async function findLimit() {
  const testIds = [1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000];
  
  console.log('🔍 Testeando rango de IDs...\n');
  
  for (const id of testIds) {
    try {
      const res = await fetch(`https://api.bencinaenlinea.cl/api/estacion_ciudadano/${id}`, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(5000)
      });
      
      if (!res.ok) {
        console.log(`ID ${id}: ❌ HTTP ${res.status}`);
        continue;
      }
      
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

findLimit();