// Tests de normalización de números E.164.

import { assertEquals, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { toE164, isE164 } from "../../supabase/functions/_shared/lib/phone.ts";

Deno.test("número nacional CO de 10 dígitos → +57…", () => {
  assertEquals(toE164("3001234567"), "+573001234567");
});

Deno.test("número con guiones se normaliza", () => {
  assertEquals(toE164("300-123-4567"), "+573001234567");
});

Deno.test("número con espacios se normaliza", () => {
  assertEquals(toE164("57 300 123 4567"), "+573001234567");
});

Deno.test("número ya en E.164 se respeta", () => {
  assertEquals(toE164("+573001234567"), "+573001234567");
});

Deno.test("input vacío lanza", () => {
  assertThrows(() => toE164(""));
});

Deno.test("isE164 acepta + y 8-15 dígitos", () => {
  assertEquals(isE164("+573001234567"), true);
  assertEquals(isE164("3001234567"), false);
  assertEquals(isE164("+1"), false);
});
