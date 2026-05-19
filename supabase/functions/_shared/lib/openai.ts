// Cliente OpenAI (solo usado para Whisper).

import OpenAI from "openai";

let _client: OpenAI | null = null;

export function openai(): OpenAI {
  if (_client) return _client;
  const apiKey = Deno.env.get("OPENAI_API_KEY");
  if (!apiKey) throw new Error("OPENAI_API_KEY es requerida");
  _client = new OpenAI({ apiKey });
  return _client;
}
