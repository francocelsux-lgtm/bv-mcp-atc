import { fileURLToPath } from 'url';
import path from 'path';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Carga .env desde el directorio del proyecto, sin importar el CWD al iniciar
import dotenv from 'dotenv';
dotenv.config({ path: path.resolve(__dirname, '../.env') });
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import { fetchReservasHoy, todayArgentina } from './scraper.js';
import { syncReservasToSheets } from './sheets.js';
import { Reserva, Ocupacion, CacheEntry } from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Cache en memoria (TTL por defecto: 5 minutos)
// ─────────────────────────────────────────────────────────────────────────────
const CACHE_TTL_MS = parseInt(process.env.CACHE_TTL_SECONDS ?? '300', 10) * 1_000;
let cache: CacheEntry<Reserva[]> | null = null;

async function getReservasCached(): Promise<Reserva[]> {
  const now = Date.now();
  if (cache && now - cache.fetchedAt < CACHE_TTL_MS) {
    process.stderr.write('[MCP] Usando reservas del caché.\n');
    return cache.data;
  }
  process.stderr.write('[MCP] Obteniendo reservas de ATC…\n');
  const reservas = await fetchReservasHoy();
  cache = { data: reservas, fetchedAt: now };
  return reservas;
}

function invalidateCache(): void {
  cache = null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Cálculo de ocupación
// ─────────────────────────────────────────────────────────────────────────────
const FRANJAS = [
  { nombre: 'Mañana',  desde: '06:00', hasta: '12:00' },
  { nombre: 'Tarde',   desde: '12:00', hasta: '18:00' },
  { nombre: 'Noche',   desde: '18:00', hasta: '00:00' },
] as const;

function timeToMinutes(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

function slotInFranja(horaInicio: string, desde: string, hasta: string): boolean {
  const start = timeToMinutes(horaInicio);
  const d = timeToMinutes(desde);
  const h = hasta === '00:00' ? 24 * 60 : timeToMinutes(hasta);
  return start >= d && start < h;
}

function calcularOcupacion(reservas: Reserva[]): Ocupacion {
  const fecha = todayArgentina();
  const canchas = [...new Set(reservas.map(r => r.cancha))].sort();
  const activas = reservas.filter(r => r.estado !== 'cancelada');

  // Asumimos slots de 90 min por franja y cancha (ajustable si querés granularidad real)
  const SLOT_MIN = 90;
  const slotsPerFranja = (franja: typeof FRANJAS[number]) => {
    const minutos = franja.hasta === '00:00'
      ? (24 * 60 - timeToMinutes(franja.desde))
      : timeToMinutes(franja.hasta) - timeToMinutes(franja.desde);
    return Math.floor(minutos / SLOT_MIN) * Math.max(1, canchas.length);
  };

  const ocupadosEnFranja = (desde: string, hasta: string) =>
    activas.filter(r => slotInFranja(r.horaInicio, desde, hasta)).length;

  const buildFranja = (f: typeof FRANJAS[number]) => {
    const total   = slotsPerFranja(f);
    const ocupados = ocupadosEnFranja(f.desde, f.hasta);
    const libres   = Math.max(0, total - ocupados);
    return {
      nombre:     f.nombre,
      desde:      f.desde,
      hasta:      f.hasta,
      totalSlots: total,
      ocupados,
      libres,
      porcentaje: total > 0 ? Math.round((ocupados / total) * 1000) / 10 : 0,
    };
  };

  const manana = buildFranja(FRANJAS[0]);
  const tarde  = buildFranja(FRANJAS[1]);
  const noche  = buildFranja(FRANJAS[2]);
  const totalDia  = manana.totalSlots + tarde.totalSlots + noche.totalSlots;
  const ocupDia   = manana.ocupados   + tarde.ocupados   + noche.ocupados;

  return {
    fecha,
    canchas,
    franjas: { manana, tarde, noche },
    resumenDia: {
      total:      totalDia,
      ocupados:   ocupDia,
      libres:     Math.max(0, totalDia - ocupDia),
      porcentaje: totalDia > 0 ? Math.round((ocupDia / totalDia) * 1000) / 10 : 0,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers de respuesta MCP
// ─────────────────────────────────────────────────────────────────────────────
function textResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

function jsonResult(obj: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] };
}

function errorResult(err: unknown): CallToolResult {
  const msg = err instanceof Error ? err.message : String(err);
  return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// MCP Server
// ─────────────────────────────────────────────────────────────────────────────
const server = new Server(
  { name: 'bv-atc-mcp', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'get_reservas_hoy',
      description:
        'Devuelve la lista completa de reservas de hoy en Bella Vista Paddle Club, ' +
        'obtenida en tiempo real desde ATC (Alquila Tu Cancha). ' +
        'Incluye: cancha, hora inicio/fin, estado (confirmada/pendiente/cancelada) y nombre del cliente.',
      inputSchema: {
        type: 'object',
        properties: {
          force_refresh: {
            type: 'boolean',
            description: 'Si es true, ignora el caché y vuelve a scrapear ATC (tarda ~10s más).',
          },
        },
        required: [],
      },
    },
    {
      name: 'get_ocupacion',
      description:
        'Calcula el porcentaje de ocupación por franja horaria del día actual: ' +
        'Mañana (06:00-12:00), Tarde (12:00-18:00) y Noche (18:00-00:00). ' +
        'También devuelve el resumen total del día y los nombres de las canchas.',
      inputSchema: {
        type: 'object',
        properties: {
          force_refresh: {
            type: 'boolean',
            description: 'Si es true, ignora el caché y vuelve a scrapear ATC.',
          },
        },
        required: [],
      },
    },
    {
      name: 'sync_to_sheets',
      description:
        'Sincroniza las reservas del día al Google Sheet "ATC Reservas". ' +
        'Reemplaza los datos del día actual manteniendo el historial de otros días. ' +
        'Devuelve la URL del spreadsheet y la cantidad de filas escritas.',
      inputSchema: {
        type: 'object',
        properties: {
          force_refresh: {
            type: 'boolean',
            description: 'Si es true, vuelve a scrapear ATC antes de sincronizar.',
          },
        },
        required: [],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const forceRefresh = (args as Record<string, unknown>)?.force_refresh === true;

  try {
    if (name === 'get_reservas_hoy') {
      if (forceRefresh) invalidateCache();
      const reservas = await getReservasCached();
      const resumen = {
        fecha: todayArgentina(),
        total: reservas.length,
        confirmadas: reservas.filter(r => r.estado === 'confirmada').length,
        pendientes:  reservas.filter(r => r.estado === 'pendiente').length,
        canceladas:  reservas.filter(r => r.estado === 'cancelada').length,
        reservas,
      };
      return jsonResult(resumen);
    }

    if (name === 'get_ocupacion') {
      if (forceRefresh) invalidateCache();
      const reservas = await getReservasCached();
      const ocupacion = calcularOcupacion(reservas);
      return jsonResult(ocupacion);
    }

    if (name === 'sync_to_sheets') {
      if (forceRefresh) invalidateCache();
      const reservas = await getReservasCached();
      const result = await syncReservasToSheets(reservas);
      invalidateCache(); // invalidamos para que el próximo read sea fresco
      return textResult(
        `✓ ${result.message}\n` +
        `Filas escritas: ${result.rowsWritten}\n` +
        `Sincronizado: ${result.timestamp}\n` +
        `URL: ${result.sheetUrl}`,
      );
    }

    return errorResult(`Herramienta desconocida: ${name}`);
  } catch (err) {
    return errorResult(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Arranque
// ─────────────────────────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write('[MCP] bv-atc-mcp listo y escuchando.\n');
