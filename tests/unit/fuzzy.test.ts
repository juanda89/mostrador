// Tests de matching difuso de métodos de pago.

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { matchPaymentMethod } from "../../supabase/functions/_shared/lib/fuzzy.ts";

const ACCEPTED = ["cash", "nequi", "daviplata"];

Deno.test("exact canonical match → high confidence", () => {
  assertEquals(matchPaymentMethod("nequi", ACCEPTED), { match: "nequi", confidence: "high" });
  assertEquals(matchPaymentMethod("cash", ACCEPTED), { match: "cash", confidence: "high" });
});

Deno.test("synonym match en español → high confidence", () => {
  assertEquals(matchPaymentMethod("efectivo", ACCEPTED), { match: "cash", confidence: "high" });
  assertEquals(matchPaymentMethod("en efectivo", ACCEPTED), { match: "cash", confidence: "high" });
  assertEquals(matchPaymentMethod("daviplata", ACCEPTED), { match: "daviplata", confidence: "high" });
});

Deno.test("método no aceptado por el negocio → null (forzar repregunta)", () => {
  // "tarjeta" matchea card pero el negocio no acepta card.
  const r = matchPaymentMethod("tarjeta", ACCEPTED);
  assertEquals(r.match, null);
});

Deno.test("input vacío → null", () => {
  assertEquals(matchPaymentMethod("", ACCEPTED), { match: null, confidence: "low" });
});

Deno.test("input desconocido → null", () => {
  assertEquals(matchPaymentMethod("bitcoin", ACCEPTED), { match: null, confidence: "low" });
});

Deno.test("substring loose match → medium confidence si está aceptado", () => {
  // "pago con nequi por favor" contiene "nequi"
  const r = matchPaymentMethod("pago con nequi por favor", ACCEPTED);
  assertEquals(r.match, "nequi");
  // Pasa por la rama exacta (palabras separadas) → high.
  assertEquals(r.confidence, "high");
});
