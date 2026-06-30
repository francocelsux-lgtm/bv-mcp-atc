// Carga histórica de reservas ATC → Google Sheets.
// Itera un rango de fechas con una sola sesión de login,
// escribiendo cada día en la planilla via Apps Script.
//
// Uso: npm run sync:historico -- --desde=2026-01-01 --hasta=2026-06-30
//      npm run sync:historico                        (todo el año 2026 hasta hoy)
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

import dotenv from 'dotenv';
dotenv.config({ path: path.resolve(__dirname, '../.env') });

import { fetchReservasRango, todayArgentina } from './scraper.js';
import { syncReservasToSheets } from './sheets.js';

const ts = () => new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });

function parseArg(name: string): string | undefined {
  const arg = process.argv.find(a => a.startsWith(`--${name}=`));
  return arg?.split('=')[1];
}

function dateRange(desde: string, hasta: string): string[] {
  const dates: string[] = [];
  const cur = new Date(`${desde}T12:00:00Z`);
  const end = new Date(`${hasta}T12:00:00Z`);
  while (cur <= end) {
    dates.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return dates;
}

const desde = parseArg('desde') ?? '2026-01-01';
const hasta = parseArg('hasta') ?? todayArgentina();
const fechas = dateRange(desde, hasta);

process.stderr.write(`[${ts()}] Histórico: ${fechas.length} días (${desde} → ${hasta})\n`);

let ok = 0;
let errores = 0;

await fetchReservasRango(fechas, async (fecha, reservas) => {
  try {
    if (reservas.length === 0) {
      process.stderr.write(`[${ts()}] ${fecha}: sin reservas — omitido\n`);
      ok++;
      return;
    }
    const result = await syncReservasToSheets(reservas);
    process.stderr.write(`[${ts()}] ${fecha}: ✓ ${result.rowsWritten} reservas\n`);
    ok++;
    // Pausa breve para no saturar Apps Script
    await new Promise(r => setTimeout(r, 500));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[${ts()}] ${fecha}: ✗ ${msg}\n`);
    errores++;
  }
});

process.stderr.write(`\n[${ts()}] Histórico completado: ${ok} días OK, ${errores} errores.\n`);
if (errores > 0) process.exit(1);
