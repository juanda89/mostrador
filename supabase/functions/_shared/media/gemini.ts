// Extracción estructurada de imágenes (facturas, menús) con Gemini 2.5 Flash.

import { gemini, GEMINI_MODEL } from "../lib/gemini.ts";
import { log } from "../lib/log.ts";

export interface MenuLine {
  name: string;
  price?: number;
  notes?: string;
}

export interface InvoiceLine {
  ingredient_name: string;
  qty?: number;
  unit?: string;     // "kg", "g", "l", "ml", "unit"
  unit_price?: number;
  subtotal?: number;
}

export interface ExtractionResult<T> {
  lines: T[];
  vendor_name?: string;
  total?: number;
  /** Texto plano para feedback al usuario / debugging */
  summary: string;
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
  return btoa(bin);
}

export async function extractMenu(image: Blob): Promise<ExtractionResult<MenuLine>> {
  return await extract<MenuLine>(
    image,
    `Analiza esta imagen de un menú de comidas rápidas y devuelve JSON con esta forma exacta:
{ "lines": [{ "name": string, "price"?: number, "notes"?: string }] }
- "name" es el nombre del producto tal como aparece.
- "price" en COP (números enteros, sin separadores).
- Si no se ve el precio claramente, omitirlo.
- Responde SOLO el JSON, sin explicaciones ni markdown.`,
  );
}

export async function extractInvoice(image: Blob): Promise<ExtractionResult<InvoiceLine>> {
  return await extract<InvoiceLine>(
    image,
    `Analiza esta foto de una factura de proveedor y devuelve JSON con esta forma exacta:
{ "vendor_name"?: string, "total"?: number,
  "lines": [{ "ingredient_name": string, "qty"?: number, "unit"?: "kg"|"g"|"l"|"ml"|"unit", "unit_price"?: number, "subtotal"?: number }] }
- Cantidades, precios en COP sin separadores.
- "unit" debe ser uno de: kg, g, l, ml, unit.
- Si un campo no se ve claro, omitirlo.
- Responde SOLO el JSON, sin explicaciones ni markdown.`,
  );
}

async function extract<T>(image: Blob, instruction: string): Promise<ExtractionResult<T>> {
  const model = gemini().getGenerativeModel({ model: GEMINI_MODEL });
  const base64 = await blobToBase64(image);
  try {
    const result = await model.generateContent([
      instruction,
      { inlineData: { mimeType: image.type || "image/jpeg", data: base64 } },
    ]);
    const text = result.response.text().trim();
    const clean = text.replace(/^```json\s*/i, "").replace(/```$/, "").trim();
    const parsed = JSON.parse(clean) as Omit<ExtractionResult<T>, "summary">;
    return {
      ...parsed,
      summary: text,
    };
  } catch (err) {
    log.error("gemini_failed", { err: String(err) });
    throw err;
  }
}
