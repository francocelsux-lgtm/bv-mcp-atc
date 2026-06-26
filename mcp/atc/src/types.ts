export type EstadoReserva = 'confirmada' | 'pendiente' | 'cancelada' | 'desconocido';
export type EstadoCobro  = 'cobrado' | 'pendiente' | 'sin_cargo';
export type TipoTurno    = 'fijo' | 'eventual' | 'bloqueo';
export type OrigenTurno  = 'online' | 'manual';

export interface Reserva {
  id?: string;
  cancha: string;
  horaInicio: string;       // "HH:MM"
  horaFin: string;          // "HH:MM"
  duracion?: number;        // minutos
  estado: EstadoReserva;
  nombreCliente?: string;
  telefonoCliente?: string;
  estadoCobro?: EstadoCobro;
  monto?: string;           // "$18.000"
  saldo?: string;           // "$0"
  tipoTurno?: TipoTurno;
  origen?: OrigenTurno;
  nota?: string;
  creadoEn?: string;        // "HH:MM"
  fecha: string;            // "YYYY-MM-DD"
}

export interface OcupacionFranja {
  nombre: string;
  desde: string;       // "HH:MM" inclusive
  hasta: string;       // "HH:MM" exclusive
  totalSlots: number;
  ocupados: number;
  libres: number;
  porcentaje: number;  // 0-100, redondeado a 1 decimal
}

export interface Ocupacion {
  fecha: string;
  canchas: string[];
  franjas: {
    manana: OcupacionFranja;   // 06:00-12:00
    tarde: OcupacionFranja;    // 12:00-18:00
    noche: OcupacionFranja;    // 18:00-00:00
  };
  resumenDia: {
    total: number;
    ocupados: number;
    libres: number;
    porcentaje: number;
  };
}

export interface SyncResult {
  success: boolean;
  rowsWritten: number;
  sheetUrl: string;
  timestamp: string;
  message: string;
}

export interface CacheEntry<T> {
  data: T;
  fetchedAt: number;  // epoch ms
}
