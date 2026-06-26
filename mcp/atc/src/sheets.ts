import { google } from 'googleapis';
import type { sheets_v4 } from 'googleapis';
import { Reserva, Ocupacion, SyncResult } from './types.js';

const SHEET_HEADERS = [
  'Fecha',
  'Cancha',
  'Hora Inicio',
  'Hora Fin',
  'Estado',
  'Cliente',
  'Sincronizado',
];

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];

type Sheets = sheets_v4.Sheets;

// Soporta dos modos de autenticación:
//   1. GOOGLE_SERVICE_ACCOUNT_JSON definida → usa la service account (requiere clave)
//   2. Sin esa variable → usa Application Default Credentials (gcloud auth application-default login)
function buildSheetsClient(): Sheets {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

  if (raw) {
    let credentials: object;
    try {
      credentials = JSON.parse(raw);
    } catch {
      throw new Error(
        'GOOGLE_SERVICE_ACCOUNT_JSON no es JSON válido. ' +
        'Asegurate de que el valor esté en una sola línea sin caracteres escapados incorrectos.',
      );
    }
    const auth = new google.auth.GoogleAuth({ credentials, scopes: SCOPES });
    return google.sheets({ version: 'v4', auth });
  }

  // Application Default Credentials: usa `gcloud auth application-default login`
  const auth = new google.auth.GoogleAuth({ scopes: SCOPES });
  return google.sheets({ version: 'v4', auth });
}

function getSpreadsheetId(): string {
  const id = process.env.GOOGLE_SPREADSHEET_ID;
  if (!id) throw new Error('GOOGLE_SPREADSHEET_ID no está definido.');
  return id;
}

function getSheetName(): string {
  return process.env.GOOGLE_SHEET_NAME ?? 'ATC Reservas';
}

// ─────────────────────────────────────────────────────────────────────────────
// Asegura que la hoja exista; la crea con encabezados si es necesario.
// ─────────────────────────────────────────────────────────────────────────────
async function ensureSheet(sheets: Sheets, spreadsheetId: string, sheetName: string): Promise<void> {
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const exists = meta.data.sheets?.some(
    s => s.properties?.title === sheetName,
  );

  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{ addSheet: { properties: { title: sheetName } } }],
      },
    });
    // Escribimos la fila de encabezados
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${sheetName}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [SHEET_HEADERS] },
    });
    // Negrita en la fila de encabezados
    const sheetsMeta = await sheets.spreadsheets.get({ spreadsheetId });
    const sheetId = sheetsMeta.data.sheets?.find(s => s.properties?.title === sheetName)?.properties?.sheetId;
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
}

// ─────────────────────────────────────────────────────────────────────────────
// Reemplaza las filas de la fecha dada con los datos frescos.
// ─────────────────────────────────────────────────────────────────────────────
async function replaceRowsForDate(
  sheets: Sheets,
  spreadsheetId: string,
  sheetName: string,
  fecha: string,
  newRows: string[][],
): Promise<void> {
  // Leemos todas las filas existentes
  const readRes = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheetName}!A:G`,
  });
  const allRows: string[][] = (readRes.data.values ?? []) as string[][];

  // Filtramos las filas que NO son de esta fecha (conservamos encabezado + otros días)
  const filtered = allRows.filter((row, idx) => idx === 0 || row[0] !== fecha);

  // Concatenamos con las filas nuevas
  const combined = [...filtered, ...newRows];

  // Reescribimos todo
  await sheets.spreadsheets.values.clear({
    spreadsheetId,
    range: `${sheetName}!A:G`,
  });
  if (combined.length > 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${sheetName}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: combined },
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// API pública
// ─────────────────────────────────────────────────────────────────────────────
export async function syncReservasToSheets(reservas: Reserva[]): Promise<SyncResult> {
  const sheets = buildSheetsClient();
  const spreadsheetId = getSpreadsheetId();
  const sheetName = getSheetName();
  const syncTs = new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });

  await ensureSheet(sheets, spreadsheetId, sheetName);

  if (reservas.length === 0) {
    return {
      success: true,
      rowsWritten: 0,
      sheetUrl: `https://docs.google.com/spreadsheets/d/${spreadsheetId}`,
      timestamp: syncTs,
      message: 'Sin reservas para sincronizar.',
    };
  }

  const fecha = reservas[0].fecha;
  const newRows: string[][] = reservas.map(r => [
    r.fecha,
    r.cancha,
    r.horaInicio,
    r.horaFin,
    r.estado,
    r.nombreCliente ?? '',
    syncTs,
  ]);

  await replaceRowsForDate(sheets, spreadsheetId, sheetName, fecha, newRows);

  process.stderr.write(`[Sheets] ${newRows.length} filas escritas para ${fecha}\n`);

  return {
    success: true,
    rowsWritten: newRows.length,
    sheetUrl: `https://docs.google.com/spreadsheets/d/${spreadsheetId}`,
    timestamp: syncTs,
    message: `${newRows.length} reservas del ${fecha} sincronizadas correctamente.`,
  };
}
