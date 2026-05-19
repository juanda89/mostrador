// Cliente Google Gemini (usado para extracción de imágenes: facturas, menús).

import { GoogleGenerativeAI } from "@google/generative-ai";

let _client: GoogleGenerativeAI | null = null;

export function gemini(): GoogleGenerativeAI {
  if (_client) return _client;
  const apiKey = Deno.env.get("GEMINI_API_KEY");
  if (!apiKey) throw new Error("GEMINI_API_KEY es requerida");
  _client = new GoogleGenerativeAI(apiKey);
  return _client;
}

export const GEMINI_MODEL = "gemini-2.5-flash";
