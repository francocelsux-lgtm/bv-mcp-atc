/**
 * Script de prueba independiente del MCP server.
 * Usalo para verificar que el scraper funciona antes de conectarlo a Claude.
 *
 * Uso:
 *   npm run test:scraper
 *   ATC_DEBUG=true npm run test:scraper
 *   ATC_MOCK=true npm run test:scraper     ← sin conexión a ATC
 */
import 'dotenv/config';
import { fetchReservasHoy, todayArgentina } from './scraper.js';
import { syncReservasToSheets } from './sheets.js';

console.log('═══════════════════════════════════════════');
console.log('  BV Paddle Club – Test scraper ATC');
console.log(`  Fecha: ${todayArgentina()}`);
console.log(`  Modo mock: ${process.env.ATC_MOCK === 'true' ? 'SÍ' : 'NO'}`);
console.log('═══════════════════════════════════════════\n');

try {
  console.log('► Obteniendo reservas...');
  const reservas = await fetchReservasHoy();

  console.log(`\n✓ ${reservas.length} reservas encontradas:\n`);
  if (reservas.length === 0) {
    console.log('  (ninguna — verificá ATC_CLUB_SCHEDULE_URL y tus credenciales)');
  } else {
    for (const r of reservas) {
      console.log(`  ${r.horaInicio}-${r.horaFin} | ${r.cancha.padEnd(12)} | ${r.estado.padEnd(12)} | ${r.nombreCliente ?? '—'}`);
    }
  }

  if (process.env.TEST_SYNC_SHEETS === 'true') {
    console.log('\n► Sincronizando con Google Sheets...');
    const result = await syncReservasToSheets(reservas);
    console.log(`✓ ${result.message}`);
    console.log(`  URL: ${result.sheetUrl}`);
  }
} catch (err) {
  console.error('\n✗ Error:', err instanceof Error ? err.message : err);
  process.exit(1);
}
