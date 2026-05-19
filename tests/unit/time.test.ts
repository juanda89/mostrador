// Tests de ventanas del día operativo y helpers de tiempo.

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  lastClosedBusinessDay,
  localHHMM,
  localWeekday,
} from "../../supabase/functions/_shared/lib/time.ts";

const TZ = "America/Bogota"; // UTC-5, sin DST

Deno.test("localHHMM en Bogotá", () => {
  // 2026-05-20T11:30:00Z = 2026-05-20 06:30 local
  const d = new Date("2026-05-20T11:30:00Z");
  assertEquals(localHHMM(d, TZ), "06:30");
});

Deno.test("localWeekday devuelve lowercase inglés", () => {
  // Miércoles 20 de mayo de 2026.
  const d = new Date("2026-05-20T15:00:00Z");
  assertEquals(localWeekday(d, TZ), "wednesday");
});

Deno.test("lastClosedBusinessDay justo después del cutoff", () => {
  // now = 2026-05-20T11:01:00Z = 2026-05-20 06:01 local (justo pasó el cutoff de 06:00).
  // Ventana debe ser: 2026-05-19 06:01 local → 2026-05-20 06:00 local.
  // Etiquetada por 2026-05-19.
  const now = new Date("2026-05-20T11:01:00Z");
  const w = lastClosedBusinessDay("06:00", TZ, now);
  assertEquals(w.label, "2026-05-19");
  assertEquals(w.end.toISOString(), "2026-05-20T11:00:00.000Z");
  assertEquals(w.start.toISOString(), "2026-05-19T11:01:00.000Z");
});

Deno.test("lastClosedBusinessDay antes del cutoff toma el cutoff de ayer", () => {
  // now = 2026-05-20T09:00:00Z = 2026-05-20 04:00 local (antes de cutoff 06:00).
  // El último cutoff cerrado es 2026-05-19 06:00 local.
  // Ventana: 2026-05-18 06:01 → 2026-05-19 06:00. Label: 2026-05-18.
  const now = new Date("2026-05-20T09:00:00Z");
  const w = lastClosedBusinessDay("06:00", TZ, now);
  assertEquals(w.label, "2026-05-18");
  assertEquals(w.end.toISOString(), "2026-05-19T11:00:00.000Z");
  assertEquals(w.start.toISOString(), "2026-05-18T11:01:00.000Z");
});

Deno.test("cutoff distinto a 06:00", () => {
  // Cutoff a las 02:00 local. now = 2026-05-20 03:00 local = 08:00 UTC.
  // Ventana: 2026-05-19 02:01 → 2026-05-20 02:00. Label: 2026-05-19.
  const now = new Date("2026-05-20T08:00:00Z");
  const w = lastClosedBusinessDay("02:00", TZ, now);
  assertEquals(w.label, "2026-05-19");
  assertEquals(w.end.toISOString(), "2026-05-20T07:00:00.000Z");
});
