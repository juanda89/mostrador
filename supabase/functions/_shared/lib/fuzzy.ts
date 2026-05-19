// Fuzzy matching de métodos de pago.
// El vendedor dice cosas como "en efectivo", "nequi", "trans". Las matcheamos
// contra la lista de business_settings.accepted_payment_methods.
//
// Regla del PRD §6.2: si confianza alta → asumir y registrar; si baja → repreguntar.

const SYNONYMS: Record<string, string[]> = {
  cash: ["cash", "efectivo", "en efectivo", "plata", "billete", "contado"],
  nequi: ["nequi"],
  daviplata: ["daviplata", "davi plata", "davi"],
  transfer: ["transfer", "transferencia", "trans", "consignacion", "consignación", "consigno"],
  card: ["card", "tarjeta", "credito", "crédito", "debito", "débito", "datafono", "datáfono"],
  bancolombia: ["bancolombia", "qr bancolombia", "btb"],
};

// Regex de los "combining diacritical marks" Unicode (U+0300 a U+036F).
// Aplicado después de NFD, strip-ea los acentos.
const COMBINING_DIACRITICS = /[̀-ͯ]/g;

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(COMBINING_DIACRITICS, "")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface MatchResult {
  match: string | null; // canonical method key (ej. "cash", "nequi") o null
  confidence: "high" | "medium" | "low";
}

/**
 * Matchea el texto del vendedor contra los métodos aceptados del negocio.
 * Si el método matcheado no está en accepted, devuelve match=null con confidence=low
 * para forzar repregunta listando las opciones válidas.
 */
export function matchPaymentMethod(
  input: string,
  acceptedMethods: string[],
): MatchResult {
  if (!input) return { match: null, confidence: "low" };
  const norm = normalize(input);
  const accepted = new Set(acceptedMethods.map((m) => m.toLowerCase()));

  // Búsqueda exacta entre canonical keys + sinónimos.
  for (const [canonical, syns] of Object.entries(SYNONYMS)) {
    for (const syn of syns) {
      const synNorm = normalize(syn);
      if (norm === synNorm || norm.split(" ").includes(synNorm)) {
        if (accepted.has(canonical)) {
          return { match: canonical, confidence: "high" };
        }
        // Reconocimos el método pero no está aceptado → repreguntar.
        return { match: null, confidence: "low" };
      }
    }
  }

  // Substring loose match.
  for (const [canonical, syns] of Object.entries(SYNONYMS)) {
    for (const syn of syns) {
      const synNorm = normalize(syn);
      if (norm.includes(synNorm) || synNorm.includes(norm)) {
        if (accepted.has(canonical)) {
          return { match: canonical, confidence: "medium" };
        }
      }
    }
  }

  return { match: null, confidence: "low" };
}
