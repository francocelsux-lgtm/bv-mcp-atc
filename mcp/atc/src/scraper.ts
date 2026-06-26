import puppeteer from 'puppeteer';
import type { Browser, Page, HTTPResponse } from 'puppeteer';
// HTTPResponse used only in debug mode response listener
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
  // ATC usa "ready" para reservas confirmadas activas
  if (s === 'ready' || s.includes('confirm') || s.includes('activ') || s.includes('paid') || s.includes('pago')) return 'confirmada';
  if (s.includes('pend') || s.includes('reserv') || s.includes('waiting')) return 'pendiente';
  if (s.includes('cancel') || s.includes('rechaz') || s.includes('refund')) return 'cancelada';
  if (s === 'done' || s === 'finished') return 'confirmada'; // reservas ya jugadas
  return 'desconocido';
}

function addMinutes(hora: string, minutes: number): string {
  const [h, m] = hora.split(':').map(Number);
  const total = (h ?? 0) * 60 + (m ?? 0) + minutes;
  const eh = Math.floor(total / 60) % 24;
  const em = total % 60;
  return `${String(eh).padStart(2, '0')}:${String(em).padStart(2, '0')}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// ATCScraper
// ─────────────────────────────────────────────────────────────────────────────
export class ATCScraper {
  private browser: Browser | null = null;
  private page: Page | null = null;
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

    // Logueamos todas las respuestas JSON en debug (útil para descubrir endpoints)
    if (this.debug) {
      this.page.on('response', (res: HTTPResponse) => {
        if (res.status() !== 200) return;
        const ct = res.headers()['content-type'] ?? '';
        if (ct.includes('application/json')) {
          this.log(`API JSON [${res.status()}]: ${res.url()}`);
        }
      });
    }
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
    const date = todayArgentina();

    // Navegamos al grid para refrescar la sesión
    const scheduleUrl = getScheduleUrl();
    this.log(`Navegando a agenda: ${scheduleUrl}`);
    const currentBase = p.url().split('#')[0];
    const targetBase  = scheduleUrl.split('#')[0];
    const hashPart    = scheduleUrl.includes('#') ? scheduleUrl.slice(scheduleUrl.indexOf('#') + 1) : '';
    if (currentBase === targetBase && hashPart) {
      this.log(`SPA detectada. Cambiando hash a: #${hashPart}`);
      await p.evaluate((h) => { window.location.hash = h; }, hashPart);
    } else {
      await p.goto(scheduleUrl, { waitUntil: 'networkidle2', timeout: 30_000 });
    }
    await new Promise(res => setTimeout(res, 2_000));
    await this.debugSnapshot('04-schedule-page');

    // ── Llamada directa a la API de ATC ───────────────────────────────────────
    // Usamos las cookies de sesión del browser (mucho más confiable que event interception)
    const clubId    = await this.getClubId(p);
    const courtsMap = await this.fetchCourtsMap(p, clubId);

    const bookingsUrl = `https://atcsports.io/c/sportclubs/${clubId}/bookings?day=${date}`;
    this.log(`Llamando API: ${bookingsUrl}`);

    let rawData: unknown;
    try {
      rawData = await p.evaluate(async (url) => {
        const res = await fetch(url, { credentials: 'include' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      }, bookingsUrl);
    } catch (err) {
      throw new Error(`No se pudo obtener reservas de ATC: ${err}`);
    }

    if (this.debug) {
      await fs.mkdir(this.debugDir, { recursive: true });
      await fs.writeFile(
        path.join(this.debugDir, '06-bookings-raw.json'),
        JSON.stringify(rawData, null, 2),
        'utf8',
      );
      this.log('JSON crudo guardado en debug/06-bookings-raw.json');
    }

    return this.parseATCBookings(rawData, courtsMap, date);
  }

  // ── Investigación de URLs ──────────────────────────────────────────────────

  async navigateAndLogApis(targetUrl: string): Promise<void> {
    const p = this.requirePage();
    const captured: Array<{ url: string; preview: string }> = [];

    // Capturar todas las respuestas JSON durante la navegación
    p.on('response', async (res: HTTPResponse) => {
      try {
        if (res.status() !== 200) return;
        const ct = res.headers()['content-type'] ?? '';
        if (!ct.includes('application/json')) return;
        const url = res.url();
        if (url.includes('atcsports.io')) {
          const json = await res.json();
          const preview = JSON.stringify(json).slice(0, 200);
          captured.push({ url, preview });
        }
      } catch { /* ignorar */ }
    });

    // Navegar usando hash change (ya estamos logueados en la SPA)
    const base = p.url().split('#')[0];
    const targetBase = targetUrl.split('#')[0];
    const hashPart = targetUrl.includes('#') ? targetUrl.slice(targetUrl.indexOf('#') + 1) : '';

    if (base === targetBase && hashPart) {
      this.log(`Navegando a hash: #${hashPart}`);
      await p.evaluate((h) => { window.location.hash = h; }, hashPart);
    } else {
      await p.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 30_000 });
    }

    await new Promise(res => setTimeout(res, 5_000));
    await this.debugSnapshot('investigate-page');

    this.log('\n═══ APIs de atcsports.io detectadas ═══');
    for (const { url, preview } of captured) {
      this.log(`\n  URL: ${url}`);
      this.log(`  Datos: ${preview}…`);
    }

    if (this.debug) {
      await fs.mkdir(this.debugDir, { recursive: true });
      await fs.writeFile(
        path.join(this.debugDir, 'investigate-apis.json'),
        JSON.stringify(captured, null, 2),
        'utf8',
      );
      this.log(`\nResultados completos en: debug/investigate-apis.json`);
    }
  }

  // ── Helpers de API de ATC ──────────────────────────────────────────────────

  private async getClubId(p: Page): Promise<string> {
    if (process.env.ATC_CLUB_ID) return process.env.ATC_CLUB_ID;
    // Intentar extraer el ID numérico de la URL actual de la SPA
    const fromUrl = p.url().match(/sportclubs\/(\d+)/)?.[1];
    if (fromUrl) return fromUrl;
    // Hardcoded para bella-vista-paddle basado en los logs de debug
    this.log('ATC_CLUB_ID no definido. Usando 1629 (bella-vista-paddle). Agregá ATC_CLUB_ID=1629 al .env para evitar este mensaje.');
    return '1629';
  }

  private async fetchCourtsMap(p: Page, clubId: string): Promise<Map<number, string>> {
    const map = new Map<number, string>();
    try {
      const data = await p.evaluate(async (url) => {
        const res = await fetch(url, { credentials: 'include' });
        return res.json();
      }, `https://atcsports.io/c/sportclubs/${clubId}/courts?full=true`);

      const items = Array.isArray(data) ? data :
        ((data as Record<string, unknown>)?.courts ?? []) as unknown[];
      for (const c of items as Record<string, unknown>[]) {
        const id   = Number(c.id);
        const name = String(c.name ?? c.court_name ?? `Cancha ${id}`);
        if (id) map.set(id, name);
      }
      this.log(`Canchas cargadas: ${[...map.values()].join(', ')}`);
    } catch {
      this.log('No se pudo cargar la lista de canchas (no crítico).');
    }
    return map;
  }

  // ── Parser dedicado para el formato real de ATC ───────────────────────────
  //
  // Estructura de la API /c/sportclubs/{id}/bookings?day={date}:
  // {
  //   "data": [
  //     { "id": 6057, "name": "Cancha 1",
  //       "booking_once":  [ { booking... } ],
  //       "booking_fixed": [ { booking... } ],
  //       "booking_done":  [ { booking... } ] },
  //     ...
  //   ]
  // }
  // Cada booking tiene:
  //   state: "ready" | "cancelled" | "done" ...
  //   user: { name: "..." }
  //   bookeable: { datetime_start: "2026-06-26 15:00", duration: 90 }

  private parseATCBookings(data: unknown, _courts: Map<number, string>, fecha: string): Reserva[] {
    const courtList = (data as Record<string, unknown>)?.data;
    if (!Array.isArray(courtList)) {
      this.log(`Estructura inesperada. Keys encontradas: ${Object.keys(data as object ?? {}).join(', ')}`);
      return [];
    }

    const reservas: Reserva[] = [];
    for (const court of courtList as Record<string, unknown>[]) {
      const courtName = String(court.name ?? `Cancha ${court.id}`);
      for (const key of ['booking_once', 'booking_fixed', 'booking_done'] as const) {
        const bookings = court[key];
        if (!Array.isArray(bookings)) continue;
        for (const b of bookings as Record<string, unknown>[]) {
          const r = this.parseATCItem(b, courtName, fecha);
          if (r) reservas.push(r);
        }
      }
    }

    // Ordenar por cancha y hora de inicio
    reservas.sort((a, b) => a.cancha.localeCompare(b.cancha) || a.horaInicio.localeCompare(b.horaInicio));
    this.log(`${reservas.length} reservas parseadas.`);
    return reservas;
  }

  private parseATCItem(item: Record<string, unknown>, courtName: string, fecha: string): Reserva | null {
    // bookeable contiene la hora y duración
    const bookeable = item.bookeable as Record<string, unknown> | undefined;
    if (!bookeable?.datetime_start) return null;

    // "2026-06-26 15:00" → "15:00"
    const datetimeStr = String(bookeable.datetime_start);
    const horaInicio  = normalizeTime(datetimeStr.split(' ')[1] ?? '');
    if (!horaInicio) return null;

    const duration = Number(bookeable.duration ?? 90); // minutos
    const horaFin  = addMinutes(horaInicio, duration);

    const userObj = item.user as Record<string, unknown> | undefined;
    const cliente = String(userObj?.name ?? '').trim();

    return {
      id:            String(item.id ?? '').trim() || undefined,
      cancha:        courtName,
      horaInicio,
      horaFin,
      estado:        parseEstado(String(item.state ?? item.status ?? '')),
      nombreCliente: cliente || undefined,
      fecha,
    };
  }

  // ── Utilidades ─────────────────────────────────────────────────────────────

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
// Función de investigación: navega a una URL y loguea todos los endpoints JSON
// Usada para descubrir APIs nuevas. Ejecutar con ATC_DEBUG=true.
// ─────────────────────────────────────────────────────────────────────────────
export async function investigateUrl(targetUrl: string): Promise<void> {
  const scraper = new ATCScraper();
  try {
    await scraper.init();
    await scraper.login();
    await scraper.navigateAndLogApis(targetUrl);
  } finally {
    await scraper.close();
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
