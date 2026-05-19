// Cliente Anthropic con proxy opcional a Helicone para observabilidad.

import Anthropic from "npm:@anthropic-ai/sdk@^0.30.0";

let _client: Anthropic | null = null;

export function anthropic(): Anthropic {
  if (_client) return _client;

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY es requerida");

  const heliconeKey = Deno.env.get("HELICONE_API_KEY");
  if (heliconeKey) {
    _client = new Anthropic({
      apiKey,
      baseURL: "https://anthropic.helicone.ai",
      defaultHeaders: { "Helicone-Auth": `Bearer ${heliconeKey}` },
    });
  } else {
    _client = new Anthropic({ apiKey });
  }
  return _client;
}

// IDs de modelos en uso (centralizados para que sea fácil reemplazarlos).
export const MODELS = {
  ONBOARDING: "claude-opus-4-7",
  RECIPE_INFERENCE: "claude-opus-4-7",
  PRODUCTION: "claude-sonnet-4-6",
  REPORTS: "claude-sonnet-4-6",
  ROUTER: "claude-haiku-4-5",
} as const;
