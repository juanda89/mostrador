// Normalización de números a E.164.
// Default country: Colombia (+57). Configurable vía env var DEFAULT_COUNTRY_CODE.

const DEFAULT_CC = Deno.env.get("DEFAULT_COUNTRY_CODE") ?? "57";

/**
 * Acepta inputs como:
 *   "3001234567"          → "+573001234567"
 *   "+573001234567"       → "+573001234567"
 *   "57 300 123 4567"     → "+573001234567"
 *   "300-123-4567"        → "+573001234567"
 * Lanza si no puede normalizar.
 */
export function toE164(input: string): string {
  if (!input) throw new Error("phone vacío");
  const digits = input.replace(/[^\d+]/g, "");

  if (digits.startsWith("+")) {
    if (digits.length < 8) throw new Error(`phone inválido: ${input}`);
    return digits;
  }

  // Si empieza con el código de país sin +, lo aceptamos tal cual.
  if (digits.startsWith(DEFAULT_CC) && digits.length >= 10) {
    return `+${digits}`;
  }

  // Si es solo el número nacional (10 dígitos en CO), prependear el CC.
  if (digits.length >= 7 && digits.length <= 11) {
    return `+${DEFAULT_CC}${digits}`;
  }

  throw new Error(`phone inválido: ${input}`);
}

export function isE164(s: string): boolean {
  return /^\+\d{8,15}$/.test(s);
}
