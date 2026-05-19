// Cliente WhatsApp via Kapso (BSP sobre Meta Cloud API).
// Documentación oficial: https://docs.kapso.ai
// ⚠️ Verificar URL base y nombres de endpoint contra docs vigentes.

import { log } from "./log.ts";

const KAPSO_BASE = Deno.env.get("KAPSO_BASE_URL") ?? "https://api.kapso.ai/v1";

interface SendResult {
  id: string;
  [key: string]: unknown;
}

function kapsoAuthHeaders(): HeadersInit {
  const key = Deno.env.get("KAPSO_API_KEY");
  if (!key) throw new Error("KAPSO_API_KEY es requerida");
  return {
    "Authorization": `Bearer ${key}`,
    "Content-Type": "application/json",
  };
}

/**
 * Envía un mensaje de texto plano a un número de WhatsApp.
 * Solo funciona dentro de la ventana de 24h. Fuera de ella, usar sendTemplate.
 */
export async function sendWhatsAppText(toPhone: string, body: string): Promise<SendResult> {
  const phoneNumberId = Deno.env.get("KAPSO_PHONE_NUMBER_ID");
  const res = await fetch(`${KAPSO_BASE}/messages`, {
    method: "POST",
    headers: kapsoAuthHeaders(),
    body: JSON.stringify({
      phone_number_id: phoneNumberId,
      to: toPhone,
      type: "text",
      text: { body },
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    log.error("kapso_send_failed", { status: res.status, body: errText });
    throw new Error(`Kapso send failed: ${res.status} ${errText}`);
  }
  return (await res.json()) as SendResult;
}

/**
 * Envía un mensaje basado en una template aprobada (reportes programados,
 * notificaciones fuera de ventana de 24h).
 */
export async function sendWhatsAppTemplate(
  toPhone: string,
  templateName: string,
  languageCode: string,
  components: unknown[],
): Promise<SendResult> {
  const phoneNumberId = Deno.env.get("KAPSO_PHONE_NUMBER_ID");
  const res = await fetch(`${KAPSO_BASE}/messages`, {
    method: "POST",
    headers: kapsoAuthHeaders(),
    body: JSON.stringify({
      phone_number_id: phoneNumberId,
      to: toPhone,
      type: "template",
      template: {
        name: templateName,
        language: { code: languageCode },
        components,
      },
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    log.error("kapso_template_failed", { status: res.status, body: errText });
    throw new Error(`Kapso template send failed: ${res.status} ${errText}`);
  }
  return (await res.json()) as SendResult;
}

/**
 * Descarga el blob de un media adjunto (audio, imagen) reportado en un webhook.
 */
export async function fetchKapsoMedia(mediaId: string): Promise<Blob> {
  const res = await fetch(`${KAPSO_BASE}/media/${mediaId}`, {
    headers: kapsoAuthHeaders(),
  });
  if (!res.ok) {
    throw new Error(`Kapso media fetch failed: ${res.status}`);
  }
  return await res.blob();
}

/**
 * Valida la firma HMAC-SHA256 de un payload entrante.
 * Kapso firma el body con KAPSO_WEBHOOK_SECRET y manda el hex en x-kapso-signature.
 */
export async function verifyKapsoSignature(
  rawBody: string,
  signatureHex: string,
): Promise<boolean> {
  const secret = Deno.env.get("KAPSO_WEBHOOK_SECRET");
  if (!secret) {
    log.warn("missing_kapso_webhook_secret");
    return false;
  }
  if (!signatureHex) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const expected = Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return timingSafeEqual(expected, signatureHex.replace(/^sha256=/, "").toLowerCase());
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
