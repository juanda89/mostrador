// Edge Function: whatsapp-webhook
// POST: recibe mensajes entrantes de Kapso (WhatsApp Business).
// GET:  health check (Kapso NO requiere hub.challenge / verify-token handshake).
//
// Estrategia: responder 200 rápido y procesar async para evitar timeouts
// del lado de Kapso. La idempotencia (messages.whatsapp_message_id UNIQUE)
// nos protege contra reentregas/retries.

import { handleKapsoEvent } from "../_shared/agents/router.ts";
import { verifyKapsoSignature } from "../_shared/lib/whatsapp.ts";
import { log } from "../_shared/lib/log.ts";

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "GET") {
    return new Response("ok", { status: 200 });
  }

  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const rawBody = await req.text();
  const signature = req.headers.get("x-webhook-signature") ?? "";

  if (!(await verifyKapsoSignature(rawBody, signature))) {
    log.warn("invalid_signature", { signature_prefix: signature.slice(0, 8) });
    return new Response("Unauthorized", { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new Response("Bad Request", { status: 400 });
  }

  // Procesamos sincrónicamente y devolvemos 200 después. Kapso aguanta ~30s y
  // nuestro handler típicamente toma 3-12s (Opus + tools + WhatsApp send).
  // La idempotencia (whatsapp_message_id UNIQUE) protege contra retries.
  try {
    await handleKapsoEvent(payload);
  } catch (err) {
    log.error("handler_failed", { err: String(err) });
    // Aún así devolvemos 200 para que Kapso no nos siga reintentando con el mismo mensaje.
  }
  return new Response("ok", { status: 200 });
});
