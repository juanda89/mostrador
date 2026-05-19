// Helpers de tiempo y ventanas del día operativo.
// El "día operativo" del PRD §6.7 va de cutoff(día-1)+1min a cutoff(día).
// Se etiqueta por la fecha de inicio de la ventana.

export interface BusinessDayWindow {
  /** ISO timestamp en UTC del inicio (exclusive si tomas +1min, inclusive si no) */
  start: Date;
  /** ISO timestamp en UTC del fin (inclusive) */
  end: Date;
  /** Fecha local YYYY-MM-DD que rotula el día operativo */
  label: string;
}

/**
 * Devuelve la ventana operativa que termina en el cutoff más reciente al `now` dado.
 *
 * Ejemplo: si cutoff="06:00", tz="America/Bogota", now=2026-05-20T11:00:00Z
 * (= 2026-05-20 06:00 local), la ventana cubre 2026-05-19 06:01 → 2026-05-20 06:00 local.
 */
export function lastClosedBusinessDay(
  cutoff: string, // "HH:mm"
  tz: string,
  now: Date,
): BusinessDayWindow {
  const [cutH, cutM] = cutoff.split(":").map(Number);
  const local = getLocalParts(now, tz);

  // Calcular el cutoff anterior (puede ser el de hoy si ya pasó, o el de ayer).
  const passedTodayCutoff =
    local.hour > cutH || (local.hour === cutH && local.minute >= cutM);
  const endDayParts = passedTodayCutoff
    ? local
    : addDays(local, -1);

  const end = makeUTCFromLocal(
    endDayParts.year,
    endDayParts.month,
    endDayParts.day,
    cutH,
    cutM,
    tz,
  );

  const startDay = addDays(endDayParts, -1);
  const start = makeUTCFromLocal(
    startDay.year,
    startDay.month,
    startDay.day,
    cutH,
    cutM,
    tz,
  );
  // +1 minuto para que sea (cutoff(día-1), cutoff(día)].
  start.setUTCMinutes(start.getUTCMinutes() + 1);

  const label = `${startDay.year}-${pad(startDay.month)}-${pad(startDay.day)}`;
  return { start, end, label };
}

interface LocalParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
}

function getLocalParts(d: Date, tz: string): LocalParts {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(d);
  const get = (k: string) => parseInt(parts.find((p) => p.type === k)!.value, 10);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour") === 24 ? 0 : get("hour"),
    minute: get("minute"),
  };
}

function addDays(p: LocalParts, n: number): LocalParts {
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day));
  d.setUTCDate(d.getUTCDate() + n);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: p.hour,
    minute: p.minute,
  };
}

/**
 * Construye un Date UTC que represente "el momento en que el reloj local del tz
 * marca year-month-day H:M". Aproxima usando offset del tz para esa fecha.
 */
function makeUTCFromLocal(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  tz: string,
): Date {
  // Primer pase: tomar el timestamp como si fuera UTC y corregir por el offset del tz en esa fecha.
  const naive = new Date(Date.UTC(year, month - 1, day, hour, minute));
  const tzOffsetMs = getTzOffsetMinutes(naive, tz) * 60_000;
  return new Date(naive.getTime() - tzOffsetMs);
}

function getTzOffsetMinutes(d: Date, tz: string): number {
  // Diferencia entre la representación "local-en-tz" y UTC, en minutos.
  const localFmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (k: string) => parseInt(localFmt.find((p) => p.type === k)!.value, 10);
  const localAsUTC = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour") === 24 ? 0 : get("hour"),
    get("minute"),
    get("second"),
  );
  return Math.round((localAsUTC - d.getTime()) / 60_000);
}

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}

/**
 * Devuelve "HH:mm" en la timezone del negocio.
 */
export function localHHMM(d: Date, tz: string): string {
  const parts = getLocalParts(d, tz);
  return `${pad(parts.hour)}:${pad(parts.minute)}`;
}

/**
 * Devuelve el día de la semana en la timezone del negocio (monday..sunday).
 */
export function localWeekday(d: Date, tz: string): string {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "long",
  });
  return fmt.format(d).toLowerCase();
}
