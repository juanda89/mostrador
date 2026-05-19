// Cliente WhatsApp via Kapso.
// Docs: https://docs.kapso.ai/docs/whatsapp/send-messages/text
//       https://docs.kapso.ai/docs/platform/webhooks/security
//
// Contrato:
//   Base URL:   https://api.kapso.ai/meta/whatsapp/v24.0
//   Endpoint:   POST /{phone_number_id}/messages   (phone_number_id en el PATH)
//   Auth:       header X-API-Key: <KAPSO_API_KEY>
//   Body:       { messaging_product: "whatsapp", to, type, text: { body } }
//   Webhook:    payload firmado con HMAC-SHA256, header X-Webhook-Signature (hex).
//               El secret lo define el usuario y lo pega en Kapso al crear el webhook.

import { log } from "./log.ts";

const KAPSO_BASE = Deno.env.get("KAPSO_BASE_URL") ?? "https://api.kapso.ai/meta/whatsapp/v24.0";

interface SendResult {
  /** ID del mensaje saliente en WhatsApp (wamid....) */
  id?: string;
  /** Algunos endpoints devuelven { messages: [{ id }] } al estilo Meta */
  messages?: Array<{ id: string }>;
  [key: string]: unknown;
}

function kapsoAuthHeaders(): HeadersInit {
  const key = Deno.env.get("KAPSO_API_KEY");
  if (!key) throw new Error("KAPSO_API_KEY es requerida");
  return {
    "X-API-Key": key,
    "Content-Type": "application/json",
  };
}

function phoneNumberId(): string {
  const id = Deno.env.get("KAPSO_PHONE_NUMBER_ID");
  if (!id) throw new Error("KAPSO_PHONE_NUMBER_ID es requerida");
  return id;
}

/**
 * Normaliza un número E.164 (+57...) al formato que Meta/Kapso esperan: solo dígitos.
 */
function toMetaPhone(phone: string): string {
  return phone.replace(/^\+/, "");
}

/**
 * Envía un mensaje de texto plano a un número de WhatsApp.
 * Solo funciona dentro de la ventana de 24h. Fuera de ella, usar sendTemplate.
 */
export async function sendWhatsAppText(toPhone: string, body: string): Promise<SendResult> {
  const res = await fetch(`${KAPSO_BASE}/${phoneNumberId()}/messages`, {
    method: "POST",
    headers: kapsoAuthHeaders(),
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: toMetaPhone(toPhone),
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
 * notificaciones fuera de la ventana de 24h).
 */
export async function sendWhatsAppTemplate(
  toPhone: string,
  templateName: string,
  languageCode: string,
  components: unknown[],
): Promise<SendResult> {
  const res = await fetch(`${KAPSO_BASE}/${phoneNumberId()}/messages`, {
    method: "POST",
    headers: kapsoAuthHeaders(),
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: toMetaPhone(toPhone),
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
 * Endpoint Meta-style: GET /{media_id} → { url, mime_type, ... } y luego fetch del url.
 */
export async function fetchKapsoMedia(mediaId: string): Promise<Blob> {
  const meta = await fetch(`${KAPSO_BASE}/${mediaId}`, {
    headers: kapsoAuthHeaders(),
  });
  if (!meta.ok) {
    throw new Error(`Kapso media metadata fetch failed: ${meta.status}`);
  }
  const info = await meta.json() as { url?: string; mime_type?: string };
  if (!info.url) throw new Error("Kapso media response missing url");

  const blobRes = await fetch(info.url, { headers: kapsoAuthHeaders() });
  if (!blobRes.ok) {
    throw new Error(`Kapso media blob fetch failed: ${blobRes.status}`);
  }
  return await blobRes.blob();
}

/**
 * Valida la firma HMAC-SHA256 de un payload entrante.
 * Kapso firma el body raw con KAPSO_WEBHOOK_SECRET y manda el hex en X-Webhook-Signature.
 *
 * Si KAPSO_WEBHOOK_SECRET está vacío (modo sandbox de desarrollo), devuelve true
 * para no bloquear. En producción siempre debe estar definido.
 */
export async function verifyKapsoSignature(
  rawBody: string,
  signatureHex: string,
): Promise<boolean> {
  const secret = Deno.env.get("KAPSO_WEBHOOK_SECRET");
  if (!secret || secret === "...") {
    log.warn("kapso_signature_skipped_no_secret");
    return true; // Modo dev sin verificación. NO usar en producción.
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

  // Aceptamos formato "hex" plano o "sha256=hex".
  const incoming = signatureHex.replace(/^sha256=/i, "").toLowerCase();
  return timingSafeEqual(expected, incoming);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
