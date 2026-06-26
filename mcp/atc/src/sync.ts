// Script de sincronización automática — pensado para correr vía cron.
// No requiere interacción. Loguea en stderr (redirigible a archivo).
//
// Uso manual:  npm run sync
//
// Cron (cada 30 min, de 7:00 a 23:00):
//   Ver sync-cron.sh
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

import dotenv from 'dotenv';
dotenv.config({ path: path.resolve(__dirname, '../.env') });

import { fetchReservasHoy } from './scraper.js';
import { syncReservasToSheets } from './sheets.js';

const ts = () => new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });

process.stderr.write(`[${ts()}] Iniciando sync...\n`);

try {
  const reservas = await fetchReservasHoy();
  const result = await syncReservasToSheets(reservas);
  process.stderr.write(`[${ts()}] ✓ ${result.message}\n`);
} catch (err) {
  process.stderr.write(`[${ts()}] ✗ Error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
