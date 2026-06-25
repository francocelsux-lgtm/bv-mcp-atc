export type EstadoReserva = 'confirmada' | 'pendiente' | 'cancelada' | 'desconocido';

export interface Reserva {
  id?: string;
  cancha: string;
  horaInicio: string;  // "HH:MM"
  horaFin: string;     // "HH:MM"
  estado: EstadoReserva;
  nombreCliente?: string;
  fecha: string;       // "YYYY-MM-DD"
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
