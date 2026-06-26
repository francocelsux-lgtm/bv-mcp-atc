import puppeteer from 'puppeteer';
import type { Browser, Page, HTTPResponse } from 'puppeteer';
import path from 'path';
import fs from 'fs/promises';
import { Reserva, EstadoReserva } from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Selectores CSS – sobreescribibles por env vars.
// Si ATC actualiza su markup, ajustá estas variables en .env sin tocar código.
// ─────────────────────────────────────────────────────────────────────────────
const SEL = {
  email:    process.env.ATC_SEL_EMAIL    ?? 'input[type="email"]',
  password: process.env.ATC_SEL_PASSWORD ?? 'input[type="password"]',
  submit:   process.env.ATC_SEL_SUBMIT   ?? 'button[type="submit"]',
};

// Patrones de URL de la API interna de ATC (atcsports.io) que contienen reservas
const BOOKING_URL_PATTERNS = [
  /atcsports\.io\/api\//i,
  /\/api\/.*\/(booking|reserva|slot|schedule|turn|grid|availability)/i,
  /\/bookings?[/?]/i,
  /\/reservas?[/?]/i,
  /\/slots?[/?]/i,
  /\/schedule[/?]/i,
  /\/turns?[/?]/i,
  /\/grid[/?]/i,
  /\/availability[/?]/i,
];

export function todayArgentina(): string {
  return new Date().toLocaleDateString('en-CA', {
    timeZone: 'America/Argentina/Buenos_Aires',
  });
}

function getScheduleUrl(): string {
  const date = todayArgentina();
  if (process.env.ATC_CLUB_SCHEDULE_URL) {
    const base = process.env.ATC_CLUB_SCHEDULE_URL;
    // Si ya tiene fecha en el hash (date=...) la reemplazamos por hoy
    return base.replace(/date=[\d-]+/, `date=${date}`);
  }
  const slug = process.env.ATC_CLUB_SLUG ?? '';
  // URL real de atcsports.io con hash routing
  return `https://atcsports.io/club/${slug}#!/app/grid?date=${date}`;
}

function normalizeTime(raw: unknown): string {
  if (!raw) return '';
  const s = String(raw).trim();
  // "18:00:00" → "18:00" | "1800" → "18:00" | already "18:00" stays
  const m = s.match(/^(\d{1,2}):(\d{2})/);
  if (m) return `${m[1].padStart(2, '0')}:${m[2]}`;
  if (/^\d{4}$/.test(s)) return `${s.slice(0, 2)}:${s.slice(2)}`;
  return s;
}

function parseEstado(raw: string): EstadoReserva {
  const s = raw.toLowerCase();
  if (s.includes('confirm') || s.includes('activ') || s.includes('paid') || s.includes('pago')) return 'confirmada';
  if (s.includes('pend') || s.includes('reserv') || s.includes('waiting')) return 'pendiente';
  if (s.includes('cancel') || s.includes('rechaz') || s.includes('refund')) return 'cancelada';
  return 'desconocido';
}

// ─────────────────────────────────────────────────────────────────────────────
// ATCScraper
// ─────────────────────────────────────────────────────────────────────────────
export class ATCScraper {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private capturedReservas: Reserva[] = [];
  private readonly debug = process.env.ATC_DEBUG === 'true';
  private readonly debugDir = path.resolve(process.env.ATC_DEBUG_DIR ?? './debug');

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async init(): Promise<void> {
    this.browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
      ],
      executablePath: process.env.CHROMIUM_PATH || undefined,
    });
    this.page = await this.browser.newPage();
    await this.page.setViewport({ width: 1280, height: 900 });
    await this.page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    );

    // Capturamos respuestas JSON de la API interna de ATC
    this.page.on('response', async (res: HTTPResponse) => {
      try {
        if (!this.isBookingUrl(res.url())) return;
        if (res.status() !== 200) return;
        const ct = res.headers()['content-type'] ?? '';
        if (!ct.includes('application/json')) return;
        const json: unknown = await res.json();
        const extracted = this.extractFromApiPayload(json);
        if (extracted.length > 0) {
          this.capturedReservas.push(...extracted);
          this.log(`Capturadas ${extracted.length} reservas vía API: ${res.url()}`);
        }
      } catch { /* ignorar errores de parse */ }
    });
  }

  async close(): Promise<void> {
    await this.browser?.close();
    this.browser = null;
    this.page = null;
  }

  // ── Login ──────────────────────────────────────────────────────────────────

  async login(): Promise<void> {
    const p = this.requirePage();
    const email    = this.requireEnv('ATC_EMAIL');
    const password = this.requireEnv('ATC_PASSWORD');
    const loginUrl = process.env.ATC_LOGIN_URL ?? 'https://atcsports.io/login';

    this.log(`Navegando a login: ${loginUrl}`);
    await p.goto(loginUrl, { waitUntil: 'networkidle2', timeout: 30_000 });
    await this.debugSnapshot('01-login-page');

    // Esperamos que aparezca el campo email
    await p.waitForSelector(SEL.email, { timeout: 10_000 });

    await p.click(SEL.email);
    await p.evaluate((sel) => {
      const el = document.querySelector(sel) as HTMLInputElement | null;
      if (el) el.value = '';
    }, SEL.email);
    await p.type(SEL.email, email, { delay: 40 });

    await p.click(SEL.password);
    await p.evaluate((sel) => {
      const el = document.querySelector(sel) as HTMLInputElement | null;
      if (el) el.value = '';
    }, SEL.password);
    await p.type(SEL.password, password, { delay: 40 });

    await this.debugSnapshot('02-form-filled');

    await Promise.all([
      p.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30_000 }),
      p.click(SEL.submit),
    ]);

    const finalUrl = p.url();
    await this.debugSnapshot('03-post-login');

    if (finalUrl.includes('/login') || finalUrl.includes('/signin')) {
      throw new Error(
        `Login fallido. URL actual: ${finalUrl}\n` +
        `Verificá ATC_EMAIL, ATC_PASSWORD y el selector ATC_SEL_SUBMIT.\n` +
        `Guardá ATC_DEBUG=true para ver capturas en ${this.debugDir}`,
      );
    }
    this.log(`Login exitoso. URL: ${finalUrl}`);
  }

  // ── Scraping principal ─────────────────────────────────────────────────────

  async getReservasHoy(): Promise<Reserva[]> {
    const p = this.requirePage();
    this.capturedReservas = [];

    const scheduleUrl = getScheduleUrl();
    this.log(`Navegando a agenda: ${scheduleUrl}`);
    await p.goto(scheduleUrl, { waitUntil: 'networkidle2', timeout: 30_000 });

    // Espera adicional para que la SPA termine de renderizar
    await new Promise(res => setTimeout(res, 2_000));
    await this.debugSnapshot('04-schedule-page');

    // Si la API interception ya capturó datos, los usamos
    if (this.capturedReservas.length > 0) {
      this.log(`Usando ${this.capturedReservas.length} reservas capturadas de API.`);
      return this.dedupe(this.capturedReservas);
    }

    // Fallback: scraping del DOM
    this.log('API interception sin resultados. Intentando scraping de DOM…');
    const domReservas = await this.scrapeDOM(p);
    if (domReservas.length > 0) return domReservas;

    // Si no encontramos nada, guardamos snapshot de debug y advertimos
    await this.debugSnapshot('05-no-data');
    if (this.debug) {
      const html = await p.content();
      await fs.writeFile(path.join(this.debugDir, '05-page.html'), html, 'utf8');
    }

    throw new Error(
      'No se encontraron reservas en la página.\n' +
      `URL cargada: ${p.url()}\n` +
      'Asegurate de que ATC_CLUB_SCHEDULE_URL apunte a la vista de agenda del día.\n' +
      'Activá ATC_DEBUG=true para guardar capturas y HTML en ' + this.debugDir,
    );
  }

  // ── DOM scraping fallback ──────────────────────────────────────────────────

  private async scrapeDOM(p: Page): Promise<Reserva[]> {
    const fecha = todayArgentina();

    // Intentamos detectar elementos de reserva con varios patrones comunes
    const reservas = await p.evaluate((fecha: string) => {
      const result: Array<{
        cancha: string; horaInicio: string; horaFin: string;
        estado: string; nombreCliente: string; fecha: string;
      }> = [];

      // Estrategia 1: celdas con data-attributes (patrón común en calendarios)
      const byData = document.querySelectorAll<HTMLElement>(
        '[data-booking-id], [data-reservation], [data-court][data-start]',
      );
      byData.forEach(el => {
        result.push({
          cancha:        el.dataset.court ?? el.dataset.cancha ?? el.dataset.courtName ?? 'Sin datos',
          horaInicio:    el.dataset.start ?? el.dataset.startTime ?? el.dataset.horaInicio ?? '',
          horaFin:       el.dataset.end   ?? el.dataset.endTime   ?? el.dataset.horaFin   ?? '',
          estado:        el.dataset.status ?? el.dataset.estado ?? 'desconocido',
          nombreCliente: el.dataset.player ?? el.dataset.client ?? el.dataset.playerName ?? '',
          fecha,
        });
      });

      if (result.length > 0) return result;

      // Estrategia 2: cards o filas con clases comunes de booking
      const byClass = document.querySelectorAll<HTMLElement>(
        '.booking-item, .reservation-card, .slot-booked, .turn-card, ' +
        '[class*="booking"], [class*="reservation"], [class*="reserva"], [class*="turno"]',
      );
      byClass.forEach(el => {
        const text = el.innerText ?? '';
        const timeMatch = text.match(/(\d{2}:\d{2})\s*[-–]\s*(\d{2}:\d{2})/);
        result.push({
          cancha:        el.querySelector('[class*="court"], [class*="cancha"]')?.textContent?.trim() ?? 'Sin datos',
          horaInicio:    timeMatch?.[1] ?? '',
          horaFin:       timeMatch?.[2] ?? '',
          estado:        'desconocido',
          nombreCliente: el.querySelector('[class*="player"], [class*="user"], [class*="client"], [class*="nombre"]')?.textContent?.trim() ?? '',
          fecha,
        });
      });

      return result;
    }, fecha);

    return reservas.map(r => ({
      ...r,
      horaInicio:    normalizeTime(r.horaInicio),
      horaFin:       normalizeTime(r.horaFin),
      estado:        parseEstado(r.estado) as EstadoReserva,
      nombreCliente: r.nombreCliente || undefined,
    })).filter(r => r.horaInicio !== '');
  }

  // ── API payload parser ─────────────────────────────────────────────────────

  private extractFromApiPayload(payload: unknown): Reserva[] {
    const fecha = todayArgentina();
    const items = this.findArraysInPayload(payload);
    const reservas: Reserva[] = [];

    for (const item of items) {
      const r = this.parseBookingObject(item as Record<string, unknown>, fecha);
      if (r) reservas.push(r);
    }
    return reservas;
  }

  private findArraysInPayload(payload: unknown): unknown[] {
    if (Array.isArray(payload)) return payload;
    if (payload && typeof payload === 'object') {
      const p = payload as Record<string, unknown>;
      // Claves comunes donde las APIs meten sus arrays
      for (const key of ['data', 'bookings', 'reservas', 'items', 'results', 'turns', 'slots', 'schedule', 'content']) {
        if (Array.isArray(p[key])) return p[key] as unknown[];
      }
      // Búsqueda recursiva un nivel más
      for (const val of Object.values(p)) {
        const found = this.findArraysInPayload(val);
        if (found.length > 0) return found;
      }
    }
    return [];
  }

  private parseBookingObject(item: Record<string, unknown>, fecha: string): Reserva | null {
    const cancha = String(
      item.court_name ?? item.courtName ?? item.cancha ?? item.court ??
      item.facility    ?? item.place     ?? item.court_id ?? '',
    ).trim();

    const horaInicio = normalizeTime(
      item.start_time ?? item.startTime ?? item.start ?? item.hora_inicio ??
      item.from       ?? item.time_from ?? item.begin ?? '',
    );
    const horaFin = normalizeTime(
      item.end_time   ?? item.endTime   ?? item.end   ?? item.hora_fin  ??
      item.to         ?? item.time_to   ?? item.finish ?? '',
    );

    if (!horaInicio) return null;  // sin hora de inicio no tiene sentido

    const clientRaw = String(
      item.player_name ?? item.playerName ?? item.user_name ?? item.userName ??
      item.client_name ?? item.clientName ?? item.nombre    ?? item.name     ??
      item.player      ?? item.client     ?? item.user      ?? '',
    ).trim();

    const estadoRaw = String(item.status ?? item.estado ?? item.state ?? item.booking_status ?? '');

    return {
      id:            String(item.id ?? item.booking_id ?? item.bookingId ?? '').trim() || undefined,
      cancha:        cancha || 'Sin especificar',
      horaInicio,
      horaFin,
      estado:        parseEstado(estadoRaw),
      nombreCliente: clientRaw || undefined,
      fecha,
    };
  }

  // ── Utilidades ─────────────────────────────────────────────────────────────

  private isBookingUrl(url: string): boolean {
    return BOOKING_URL_PATTERNS.some(p => p.test(url));
  }

  private dedupe(reservas: Reserva[]): Reserva[] {
    const seen = new Set<string>();
    return reservas.filter(r => {
      const key = `${r.cancha}|${r.horaInicio}|${r.fecha}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  private requirePage(): Page {
    if (!this.page) throw new Error('ATCScraper no inicializado. Llamá a init() primero.');
    return this.page;
  }

  private requireEnv(key: string): string {
    const val = process.env[key];
    if (!val) throw new Error(`Variable de entorno requerida no encontrada: ${key}`);
    return val;
  }

  private log(msg: string): void {
    process.stderr.write(`[ATC] ${msg}\n`);
  }

  private async debugSnapshot(name: string): Promise<void> {
    if (!this.debug || !this.page) return;
    await fs.mkdir(this.debugDir, { recursive: true });
    await this.page.screenshot({
      path: path.join(this.debugDir, `${name}.png`),
      fullPage: true,
    });
    this.log(`Debug snapshot: ${name}.png`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Función de alto nivel para uso externo
// ─────────────────────────────────────────────────────────────────────────────
export async function fetchReservasHoy(): Promise<Reserva[]> {
  // Modo mock para desarrollo sin ATC
  if (process.env.ATC_MOCK === 'true') {
    return buildMockReservas();
  }

  const scraper = new ATCScraper();
  try {
    await scraper.init();
    await scraper.login();
    return await scraper.getReservasHoy();
  } finally {
    await scraper.close();
  }
}

function buildMockReservas(): Reserva[] {
  const fecha = todayArgentina();
  return [
    { cancha: 'Pádel 1', horaInicio: '09:00', horaFin: '10:30', estado: 'confirmada', nombreCliente: 'Juan García', fecha },
    { cancha: 'Pádel 2', horaInicio: '09:00', horaFin: '10:30', estado: 'confirmada', nombreCliente: 'María López', fecha },
    { cancha: 'Pádel 1', horaInicio: '10:30', horaFin: '12:00', estado: 'pendiente',  nombreCliente: 'Carlos Ruiz',  fecha },
    { cancha: 'Pádel 3', horaInicio: '14:00', horaFin: '15:30', estado: 'confirmada', nombreCliente: 'Ana Martínez', fecha },
    { cancha: 'Pádel 2', horaInicio: '16:00', horaFin: '17:30', estado: 'confirmada', nombreCliente: 'Pedro Sosa',   fecha },
    { cancha: 'Pádel 1', horaInicio: '19:00', horaFin: '20:30', estado: 'confirmada', nombreCliente: 'Laura Fernández', fecha },
    { cancha: 'Pádel 3', horaInicio: '20:30', horaFin: '22:00', estado: 'cancelada',  nombreCliente: 'Diego Torres', fecha },
  ];
}
