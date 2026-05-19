// Logger JSON estructurado. Supabase Edge Functions ya capta stdout y lo
// stream-ea al panel de logs. JSON facilita filtros.

type Level = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const CURRENT_LEVEL: number =
  LEVEL_ORDER[(Deno.env.get("LOG_LEVEL") as Level) ?? "info"] ?? 20;

function emit(level: Level, msg: string, fields?: Record<string, unknown>) {
  if (LEVEL_ORDER[level] < CURRENT_LEVEL) return;
  const record = {
    level,
    msg,
    ts: new Date().toISOString(),
    ...(fields ?? {}),
  };
  // console.log para warn/info/debug, console.error para error (Supabase los separa).
  const out = level === "error" ? console.error : console.log;
  out(JSON.stringify(record));
}

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => emit("debug", msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => emit("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => emit("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => emit("error", msg, fields),
};
