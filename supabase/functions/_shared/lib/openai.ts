// Cliente OpenAI (solo usado para Whisper).

import OpenAI from "npm:openai@^4.67.0";

let _client: OpenAI | null = null;

export function openai(): OpenAI {
  if (_client) return _client;
  const apiKey = Deno.env.get("OPENAI_API_KEY");
  if (!apiKey) throw new Error("OPENAI_API_KEY es requerida");
  _client = new OpenAI({ apiKey });
  return _client;
}
