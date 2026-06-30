import { Reserva, SyncResult } from './types.js';

const SHEET_HEADERS = [
  'Fecha', 'Cancha', 'Hora Inicio', 'Hora Fin', 'Duración',
  'Cliente', 'Teléfono', 'Cobro', 'Monto', 'Saldo',
  'Tipo', 'Origen', 'Notas', 'Cargado', 'Sincronizado',
];

const COBRO_LABEL: Record<string, string> = { cobrado: 'COBRADO', pendiente: 'PENDIENTE', sin_cargo: 'SIN CARGO' };
const TIPO_LABEL:  Record<string, string> = { fijo: 'FIJO', eventual: 'EVENTUAL', bloqueo: 'BLOQUEO' };

function getAppsScriptConfig(): { url: string; token: string } {
  const url   = process.env.APPS_SCRIPT_URL;
  const token = process.env.APPS_SCRIPT_TOKEN;
  if (!url)   throw new Error('APPS_SCRIPT_URL no está definido.');
  if (!token) throw new Error('APPS_SCRIPT_TOKEN no está definido.');
  return { url, token };
}

function getSheetName(): string {
  return process.env.GOOGLE_SHEET_NAME ?? 'ATC Reservas';
}

// ─────────────────────────────────────────────────────────────────────────────
// API pública
// ─────────────────────────────────────────────────────────────────────────────
export async function syncReservasToSheets(reservas: Reserva[]): Promise<SyncResult> {
  const { url, token } = getAppsScriptConfig();
  const sheetName = getSheetName();
  const syncTs = new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
  const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID ?? '';

  if (reservas.length === 0) {
    return {
      success: true, rowsWritten: 0,
      sheetUrl: `https://docs.google.com/spreadsheets/d/${spreadsheetId}`,
      timestamp: syncTs,
      message: 'Sin reservas para sincronizar.',
    };
  }

  const fecha = reservas[0].fecha;

  const rows = reservas.map(r => [
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

  const body = JSON.stringify({ token, sheetName, fecha, rows });

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    // Apps Script redirige el POST — seguir redirecciones manualmente
    redirect: 'follow',
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '(sin cuerpo)');
    throw new Error(`Apps Script respondió ${res.status}: ${text}`);
  }

  const json = await res.json() as { ok?: boolean; rows?: number; error?: string };
  if (!json.ok) {
    throw new Error(`Apps Script error: ${json.error ?? JSON.stringify(json)}`);
  }

  process.stderr.write(`[Sheets] ${rows.length} filas escritas para ${fecha}\n`);

  return {
    success: true,
    rowsWritten: rows.length,
    sheetUrl: `https://docs.google.com/spreadsheets/d/${spreadsheetId}`,
    timestamp: syncTs,
    message: `${rows.length} reservas del ${fecha} sincronizadas correctamente.`,
  };
}
