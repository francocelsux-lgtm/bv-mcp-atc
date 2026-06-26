import { fileURLToPath } from 'url';
import { google } from 'googleapis';
import { instance as gaxiosInstance } from 'gaxios';
import type { sheets_v4 } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import http from 'http';
import { URL } from 'url';
import { exec } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { Reserva, SyncResult } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Retry on transient network errors (Premature close, ECONNRESET, ETIMEDOUT)
gaxiosInstance.defaults = {
  ...gaxiosInstance.defaults,
  retryConfig: {
    retry: 4,
    noResponseRetries: 4,
    retryDelay: 1000,
    httpMethodsToRetry: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
    statusCodesToRetry: [[100, 199], [408, 408], [429, 429], [500, 599]],
  },
};

const SHEET_HEADERS = [
  'Fecha', 'Cancha', 'Hora Inicio', 'Hora Fin', 'Duración',
  'Cliente', 'Teléfono', 'Cobro', 'Monto', 'Saldo',
  'Tipo', 'Origen', 'Notas', 'Cargado', 'Sincronizado',
];
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];
// TOKEN_PATH resuelto relativo al proyecto, no al CWD
const TOKEN_PATH = path.resolve(process.env.GOOGLE_TOKEN_PATH ?? path.join(__dirname, '../google-token.json'));

type Sheets = sheets_v4.Sheets;

// ─────────────────────────────────────────────────────────────────────────────
// Autenticación — tres modos en orden de preferencia:
//   1. GOOGLE_SERVICE_ACCOUNT_JSON  → service account (requiere clave sin bloqueo de org)
//   2. GOOGLE_OAUTH_CLIENT_JSON     → OAuth2 Desktop App (recomendado, sin restricciones)
//   3. Ninguno                      → Application Default Credentials (gcloud ADC)
// ─────────────────────────────────────────────────────────────────────────────
async function buildSheetsClient(): Promise<Sheets> {
  // Modo 1: Service Account
  const saJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (saJson) {
    const credentials = JSON.parse(saJson);
    const auth = new google.auth.GoogleAuth({ credentials, scopes: SCOPES });
    return google.sheets({ version: 'v4', auth });
  }

  // Modo 2: OAuth2 Desktop App
  const oauthJson = process.env.GOOGLE_OAUTH_CLIENT_JSON;
  if (oauthJson) {
    const auth = await getOAuth2Client(oauthJson);
    return google.sheets({ version: 'v4', auth });
  }

  // Modo 3: ADC (funciona para GCP APIs, puede fallar con Sheets por scope)
  const auth = new google.auth.GoogleAuth({ scopes: SCOPES });
  return google.sheets({ version: 'v4', auth });
}

// ─────────────────────────────────────────────────────────────────────────────
// OAuth2 Desktop App: primer uso abre el navegador, guarda token localmente.
// ─────────────────────────────────────────────────────────────────────────────
async function getOAuth2Client(oauthJson: string): Promise<OAuth2Client> {
  const { installed } = JSON.parse(oauthJson) as {
    installed: { client_id: string; client_secret: string; redirect_uris: string[] };
  };

  const oAuth2 = new google.auth.OAuth2(
    installed.client_id,
    installed.client_secret,
    'http://localhost:3142',
  );

  // Intentar cargar token guardado
  try {
    const token = JSON.parse(await fs.readFile(TOKEN_PATH, 'utf8'));
    oAuth2.setCredentials(token);
    // Auto-guardar tokens renovados
    oAuth2.on('tokens', async (tokens) => {
      const current = JSON.parse(await fs.readFile(TOKEN_PATH, 'utf8').catch(() => '{}')).catch?.(() => ({})) ?? {};
      await fs.writeFile(TOKEN_PATH, JSON.stringify({ ...current, ...tokens }));
    });
    return oAuth2;
  } catch {
    // Primera vez: hacer el flujo OAuth2 en el navegador
    return firstTimeOAuthFlow(oAuth2);
  }
}

async function firstTimeOAuthFlow(oAuth2: OAuth2Client): Promise<OAuth2Client> {
  const authUrl = oAuth2.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
  });

  process.stderr.write('\n[Sheets] ─────────────────────────────────────────\n');
  process.stderr.write('[Sheets] Autorización requerida (primera vez).\n');
  process.stderr.write(`[Sheets] Abriendo navegador: ${authUrl}\n`);
  process.stderr.write('[Sheets] ─────────────────────────────────────────\n\n');

  // Intentar abrir el navegador automáticamente
  exec(`open "${authUrl}"`);

  // Servidor local que captura el código de callback
  const code = await new Promise<string>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost:3142');
        const code = url.searchParams.get('code');
        if (code) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<h2 style="font-family:sans-serif">✓ Autorización exitosa. Podés cerrar esta ventana.</h2>');
          server.close();
          resolve(code);
        } else {
          res.end('Esperando código...');
        }
      } catch (err) {
        reject(err);
      }
    });
    server.listen(3142);
    server.on('error', reject);
    // Timeout de 5 minutos
    setTimeout(() => { server.close(); reject(new Error('Timeout esperando autorización OAuth2 (5 min).')); }, 5 * 60_000);
  });

  const { tokens } = await oAuth2.getToken(code);
  oAuth2.setCredentials(tokens);
  await fs.writeFile(TOKEN_PATH, JSON.stringify(tokens));
  process.stderr.write(`[Sheets] Token guardado en: ${TOKEN_PATH}\n`);
  return oAuth2;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function getSpreadsheetId(): string {
  const id = process.env.GOOGLE_SPREADSHEET_ID;
  if (!id) throw new Error('GOOGLE_SPREADSHEET_ID no está definido.');
  return id;
}

function getSheetName(): string {
  return process.env.GOOGLE_SHEET_NAME ?? 'ATC Reservas';
}

async function ensureSheet(sheets: Sheets, spreadsheetId: string, sheetName: string): Promise<void> {
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const exists = meta.data.sheets?.some(s => s.properties?.title === sheetName);
  if (exists) return;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests: [{ addSheet: { properties: { title: sheetName } } }] },
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${sheetName}!A1`,
    valueInputOption: 'RAW',
    requestBody: { values: [SHEET_HEADERS] },
  });
  const meta2 = await sheets.spreadsheets.get({ spreadsheetId });
  const sheetId = meta2.data.sheets?.find(s => s.properties?.title === sheetName)?.properties?.sheetId;
  if (sheetId !== undefined) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{
          repeatCell: {
            range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
            cell: { userEnteredFormat: { textFormat: { bold: true } } },
            fields: 'userEnteredFormat.textFormat.bold',
          },
        }],
      },
    });
  }
  process.stderr.write(`[Sheets] Hoja creada: "${sheetName}"\n`);
}

async function replaceRowsForDate(
  sheets: Sheets, spreadsheetId: string, sheetName: string,
  fecha: string, newRows: string[][],
): Promise<void> {
  const readRes = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${sheetName}!A:O` });
  const allRows = (readRes.data.values ?? []) as string[][];
  // Always use current headers; discard old header and rows matching today's date
  const dataRows = allRows.filter((row, idx) => idx !== 0 && row[0] !== fecha);
  const combined = [SHEET_HEADERS, ...dataRows, ...newRows];
  await sheets.spreadsheets.values.clear({ spreadsheetId, range: `${sheetName}!A:O` });
  if (combined.length > 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId, range: `${sheetName}!A1`,
      valueInputOption: 'RAW', requestBody: { values: combined },
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// API pública
// ─────────────────────────────────────────────────────────────────────────────
export async function syncReservasToSheets(reservas: Reserva[]): Promise<SyncResult> {
  const sheets = await buildSheetsClient();
  const spreadsheetId = getSpreadsheetId();
  const sheetName = getSheetName();
  const syncTs = new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });

  await ensureSheet(sheets, spreadsheetId, sheetName);

  if (reservas.length === 0) {
    return { success: true, rowsWritten: 0, sheetUrl: `https://docs.google.com/spreadsheets/d/${spreadsheetId}`, timestamp: syncTs, message: 'Sin reservas para sincronizar.' };
  }

  const fecha = reservas[0].fecha;

  const COBRO_LABEL: Record<string, string> = { cobrado: 'COBRADO', pendiente: 'PENDIENTE', sin_cargo: 'SIN CARGO' };
  const TIPO_LABEL:  Record<string, string> = { fijo: 'FIJO', eventual: 'EVENTUAL', bloqueo: 'BLOQUEO' };

  const newRows = reservas.map(r => [
    r.fecha,
    r.cancha,
    r.horaInicio,
    r.horaFin,
    r.duracion != null ? String(r.duracion) : '',
    r.nombreCliente   ?? '',
    r.telefonoCliente ?? '',
    r.estadoCobro != null ? (COBRO_LABEL[r.estadoCobro] ?? r.estadoCobro) : '',
    r.monto  ?? '',
    r.saldo  ?? '',
    r.tipoTurno != null ? (TIPO_LABEL[r.tipoTurno] ?? r.tipoTurno) : '',
    r.origen === 'online' ? 'Online' : 'Manual',
    r.nota   ?? '',
    r.creadoEn ?? '',
    syncTs,
  ]);
  await replaceRowsForDate(sheets, spreadsheetId, sheetName, fecha, newRows);
  process.stderr.write(`[Sheets] ${newRows.length} filas escritas para ${fecha}\n`);

  return {
    success: true, rowsWritten: newRows.length,
    sheetUrl: `https://docs.google.com/spreadsheets/d/${spreadsheetId}`,
    timestamp: syncTs,
    message: `${newRows.length} reservas del ${fecha} sincronizadas correctamente.`,
  };
}
