// Edge Function: whatsapp-webhook
// POST: recibe mensajes entrantes de Kapso (WhatsApp Business).
// GET:  handshake de verificación de webhook (Meta-style hub.challenge).
//
// Estrategia: responder 200 rápido y procesar async para evitar timeouts
// del lado de Kapso. La idempotencia (messages.whatsapp_message_id UNIQUE)
// nos protege contra reentregas.

import { handleKapsoEvent } from "../_shared/agents/router.ts";
import { verifyKapsoSignature } from "../_shared/lib/whatsapp.ts";
import { log } from "../_shared/lib/log.ts";

Deno.serve(async (req: Request): Promise<Response> => {
  // --- GET: handshake de verificación ---
  if (req.method === "GET") {
    const url = new URL(req.url);
    const challenge = url.searchParams.get("hub.challenge");
    const token = url.searchParams.get("hub.verify_token");
    const expected = Deno.env.get("KAPSO_WEBHOOK_VERIFY_TOKEN");
    if (expected && token === expected) {
      return new Response(challenge ?? "ok", { status: 200 });
    }
    return new Response("Forbidden", { status: 403 });
  }

  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  // --- POST: mensaje entrante ---
  const rawBody = await req.text();
  const signature = req.headers.get("x-kapso-signature") ?? "";

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

  // Procesar de forma asíncrona: respondemos 200 al toque y dejamos que el
  // handler corra en background. Edge Functions de Supabase permiten esto
  // con `EdgeRuntime.waitUntil()`.
  // deno-lint-ignore no-explicit-any
  const runtime: any = (globalThis as any).EdgeRuntime;
  const work = handleKapsoEvent(payload).catch((err) =>
    log.error("handler_failed", { err: String(err) })
  );
  if (runtime?.waitUntil) {
    runtime.waitUntil(work);
  } else {
    // Fallback para correr local con `supabase functions serve`.
    queueMicrotask(() => work);
  }

  return new Response("ok", { status: 200 });
});
