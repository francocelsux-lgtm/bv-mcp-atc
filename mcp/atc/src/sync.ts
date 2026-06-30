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

async function withRetry<T>(fn: () => Promise<T>, label: string, attempts = 5): Promise<T> {
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (i === attempts - 1) throw err;
      const delayMs = 2000 * Math.pow(2, i); // 2s, 4s, 8s, 16s
      process.stderr.write(`[${ts()}] ${label}: reintento ${i + 1}/${attempts - 1} en ${delayMs / 1000}s... (${msg})\n`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  throw new Error('unreachable');
}

process.stderr.write(`[${ts()}] Iniciando sync...\n`);

try {
  const reservas = await fetchReservasHoy();
  const result   = await withRetry(() => syncReservasToSheets(reservas), 'Sheets');
  process.stderr.write(`[${ts()}] ✓ ${result.message}\n`);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes('invalid_grant') || msg.includes('Token has been expired') || msg.includes('invalid_token')) {
    process.stderr.write(`[${ts()}] ✗ Token de Google revocado o expirado.\n`);
    process.stderr.write(`[${ts()}]   Eliminá google-token.json y corré 'npm run sync' de nuevo para re-autenticar.\n`);
  } else if (msg.includes('Premature close') || msg.includes('ECONNRESET') || msg.includes('ETIMEDOUT')) {
    process.stderr.write(`[${ts()}] ✗ Error de red con Google OAuth (después de reintentos).\n`);
    process.stderr.write(`[${ts()}]   OAuth2 Desktop App no es confiable en CI/CD — usar Service Account en su lugar.\n`);
    process.stderr.write(`[${ts()}]   → Configurá el secret GOOGLE_SERVICE_ACCOUNT_JSON con las credenciales de una cuenta de servicio.\n`);
    process.stderr.write(`[${ts()}]   → Compartí la planilla con el email de la cuenta de servicio (editor).\n`);
  } else {
    process.stderr.write(`[${ts()}] ✗ Error: ${msg}\n`);
  }
  process.exit(1);
}
