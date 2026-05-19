// Orquestador principal: recibe el payload de Kapso, resuelve contexto y
// dispatcha al agente correspondiente (onboarding o producción).
//
// Esqueleto V1: tiene la estructura completa pero algunas ramas son stubs
// que se completarán en las Fases 2 y 3 del plan.

import { db } from "../lib/supabase.ts";
import { log } from "../lib/log.ts";
import { toE164 } from "../lib/phone.ts";
import { sendWhatsAppText, fetchKapsoMedia } from "../lib/whatsapp.ts";
import { transcribeAudio } from "../media/whisper.ts";
import { extractMenu } from "../media/gemini.ts";
import { runOnboardingAgent } from "./onboarding/agent.ts";
import type {
  Business,
  ContentType,
  Membership,
  MessageRecord,
  User,
} from "../types/domain.ts";

// =========================================================================
// Tipos del webhook de Kapso (subset).
// Docs: https://docs.kapso.ai/docs/platform/webhooks/event-types
// La doc advierte: "Do not assume `phone_number`, `from`, `to`, or `wa_id`
// are always present." → todos opcionales.
// =========================================================================
interface KapsoIncomingMessage {
  id: string;
  timestamp?: string;
  from?: string;                       // número del usuario en formato Meta (sin +)
  type: "text" | "audio" | "image" | "location" | "interactive" | string;
  text?: { body: string };
  audio?: { id: string; mime_type?: string };
  image?: { id: string; mime_type?: string; caption?: string };
  location?: { latitude: number; longitude: number; name?: string; address?: string };
  /** Kapso v2 agrega un objeto enriquecido. */
  kapso?: {
    direction?: "inbound" | "outbound";
    status?: string;
    processing_status?: string;
    origin?: string;
    has_media?: boolean;
    content?: string;
    /** v2: transcript de audio ya hecho por Kapso */
    transcript?: { text?: string };
    /** v2: URL directa al media (audio/image) */
    media_url?: string;
    media_data?: {
      url?: string;
      filename?: string;
      content_type?: string;
      byte_size?: number;
    };
  };
}

interface KapsoEventItem {
  message?: KapsoIncomingMessage;
  conversation?: { id: string; phone_number?: string; kapso?: { contact_name?: string } };
  phone_number_id?: string;
  is_new_conversation?: boolean;
}

interface KapsoWebhookPayload extends KapsoEventItem {
  // Kapso v2 con buffer_enabled=true viene así:
  type?: string;
  batch?: boolean;
  data?: KapsoEventItem[];
  batch_info?: { size: number; window_ms: number; conversation_id?: string };
}

// =========================================================================
// Entry point: handleKapsoEvent
// =========================================================================
// Cuando Kapso bufferea con buffer_enabled=true, varios mensajes del usuario
// llegan AGRUPADOS en data[]. La intención del usuario es UNA SOLA, así que
// los procesamos como una sola unidad: persistimos todos los inbounds primero,
// y después invocamos al agente UNA SOLA VEZ con el último como "current"
// (el agente verá los anteriores en su history conversacional).
//
// Esto evita el bug de "2 mensajes → 2 respuestas" cuando vienen en un batch.
export async function handleKapsoEvent(payload: unknown): Promise<void> {
  const p = payload as KapsoWebhookPayload;

  if (p?.type && p.type !== "whatsapp.message.received") {
    log.debug("ignoring_event_type", { type: p.type });
    return;
  }

  const items: KapsoEventItem[] = p.batch && Array.isArray(p.data)
    ? p.data
    : (p.message ? [p as KapsoEventItem] : []);

  if (items.length === 0) {
    log.info("payload_without_messages", { keys: Object.keys(p ?? {}) });
    return;
  }

  // ---- Fase 1: ingest de todos los items del batch (rápido, en serie) ----
  // Persistimos los inbounds primero. Idempotencia por whatsapp_message_id.
  type Ingested = {
    user: User;
    msg: KapsoIncomingMessage;
    userText: string;
    inboundRecord: MessageRecord;
  };

  const ingested: Ingested[] = [];
  let lastUser: User | null = null;

  for (const item of items) {
    const result = await ingestItem(item).catch((err) => {
      log.error("ingest_failed", { err: String(err), wa_id: item.message?.id });
      return null;
    });
    if (result) {
      ingested.push(result);
      lastUser = result.user;
    }
  }

  if (ingested.length === 0 || !lastUser) {
    log.info("nothing_to_process", { items_total: items.length });
    return;
  }

  // ---- Fase 2: contexto del negocio + 1 sola llamada al router ----
  const supabase = db();
  const memberships = await loadActiveMemberships(lastUser.id);
  const business = await resolveBusiness(memberships);
  const lastInbound = ingested[ingested.length - 1].inboundRecord;

  // Si el batch trae varios mensajes del usuario, mostramos un userText
  // consolidado (útil para logs/agent prompt). El agent leerá la history
  // completa de DB de todos modos.
  const combinedUserText = ingested.length === 1
    ? ingested[0].userText
    : ingested.map((i, idx) => `[Mensaje ${idx + 1}/${ingested.length}] ${i.userText}`).join("\n");

  log.info("batch_processing", {
    batch_size: items.length,
    persisted_inbounds: ingested.length,
    business_id: business?.id ?? null,
  });

  const routed = await route({
    user: lastUser,
    business,
    memberships,
    userText: combinedUserText,
    inboundMessage: lastInbound,
  });

  // Re-leer business POR SI el agente lo acabó de crear durante este turn.
  const finalBusinessId = await resolveCurrentBusinessId(lastUser.id, business?.id ?? null);

  // Enviar respuesta(s) del turn + persistir outbound(s).
  // El agente puede dividir su respuesta en varios bubbles consecutivos
  // usando el marcador "[[NEXT_MSG]]". Cada parte se envía como un mensaje
  // independiente y se persiste como un outbound separado.
  if (routed.text) {
    const parts = splitOutbound(routed.text);
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      let sentId: string | null = null;
      try {
        const sent = await sendWhatsAppText(lastUser.phone, part);
        sentId = sent.messages?.[0]?.id ?? sent.id ?? null;
      } catch (err) {
        log.error("outbound_send_failed", { err: String(err), part_index: i });
      }
      await supabase.from("messages").insert({
        business_id: finalBusinessId,
        user_id: lastUser.id,
        direction: "outbound",
        content_type: "text",
        raw_text: part,
        whatsapp_message_id: sentId,
        // Solo el ÚLTIMO outbound del turn lleva las traces del agente
        // (para que toda la conversación tenga una sola entrada de tool_calls
        // por turn del agente). Las partes anteriores van con tool_calls=null.
        tool_calls: i === parts.length - 1 ? (routed.traces ?? null) : null,
      });
    }
  }
}

/**
 * Divide el texto de respuesta del agente en bubbles WhatsApp separados,
 * usando el marcador "[[NEXT_MSG]]". El marcador se descarta del output.
 * Cada parte se trim-ea para evitar espacios sobrantes.
 */
function splitOutbound(text: string): string[] {
  return text
    .split(/\s*\[\[NEXT_MSG\]\]\s*/g)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Ingest de un item del batch: validación, dedupe, resuelve content, persiste
 * inbound. Devuelve null si se debe ignorar (outbound, dupe, sin from, etc.).
 */
async function ingestItem(item: KapsoEventItem): Promise<{
  user: User;
  msg: KapsoIncomingMessage;
  userText: string;
  inboundRecord: MessageRecord;
} | null> {
  if (!item.message) {
    log.debug("item_without_message");
    return null;
  }
  const msg = item.message;

  if (msg.kapso?.direction === "outbound") {
    log.debug("ignoring_outbound_event", { wa_id: msg.id });
    return null;
  }
  if (!msg.from) {
    log.warn("incoming_without_from", { wa_id: msg.id });
    return null;
  }

  // Idempotencia: si ya tenemos este whatsapp_message_id, no procesar.
  const supabase = db();
  const { data: existing } = await supabase
    .from("messages")
    .select("id")
    .eq("whatsapp_message_id", msg.id)
    .maybeSingle();
  if (existing) {
    log.info("duplicate_message_ignored", { wa_id: msg.id });
    return null;
  }

  const phone = toE164(msg.from);
  const user = await upsertUserByPhone(phone);

  const { userText, contentType, mediaUrl, lat, lng, transcript, extractedData } =
    await resolveContent(msg);

  // Determinar business_id en el momento de persistir.
  const { data: ownership } = await supabase
    .from("business_members")
    .select("business_id")
    .eq("user_id", user.id)
    .eq("active", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const businessId = (ownership as { business_id?: string } | null)?.business_id ?? null;

  const inboundRecord = await insertInboundMessage({
    business_id: businessId,
    user_id: user.id,
    content_type: contentType,
    raw_text: userText || null,
    media_url: mediaUrl,
    transcript,
    extracted_data: extractedData,
    latitude: lat,
    longitude: lng,
    whatsapp_message_id: msg.id,
  });

  return { user, msg, userText, inboundRecord };
}

/**
 * Devuelve el business_id efectivo del usuario al cierre del turn. Si el agente
 * creó un business durante este turn, esta query lo detecta.
 */
async function resolveCurrentBusinessId(
  userId: string,
  fallback: string | null,
): Promise<string | null> {
  const { data } = await db()
    .from("business_members")
    .select("business_id")
    .eq("user_id", userId)
    .eq("active", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as { business_id?: string } | null)?.business_id ?? fallback;
}

// =========================================================================
// Helpers
// =========================================================================

async function upsertUserByPhone(phone: string): Promise<User> {
  const supabase = db();
  const { data: existing } = await supabase
    .from("users")
    .select("*")
    .eq("phone", phone)
    .maybeSingle();
  if (existing) return existing as User;

  const { data: created, error } = await supabase
    .from("users")
    .insert({ phone })
    .select("*")
    .single();
  if (error) throw error;
  return created as User;
}

async function loadActiveMemberships(userId: string): Promise<Membership[]> {
  const { data, error } = await db()
    .from("business_members")
    .select("business_id, user_id, role, active")
    .eq("user_id", userId)
    .eq("active", true);
  if (error) throw error;
  return (data ?? []) as Membership[];
}

async function resolveBusiness(memberships: Membership[]): Promise<Business | null> {
  if (memberships.length === 0) return null;
  // V1: si el usuario tiene varios negocios, tomamos el primero. Cuando V2 habilite
  // multi-tienda, resolveremos por contexto (último negocio activo, mención explícita, etc.).
  const businessId = memberships[0].business_id;
  const { data, error } = await db()
    .from("businesses")
    .select("*")
    .eq("id", businessId)
    .single();
  if (error) throw error;
  return data as Business;
}

interface ResolvedContent {
  /** Representación textual del mensaje del usuario lista para el agente. */
  userText: string;
  contentType: ContentType;
  /** ID o URL del media (referencia, no para descargar de nuevo). */
  mediaUrl: string | null;
  lat: number | null;
  lng: number | null;
  /** Para audio: transcripción. Para text/image/location: null. */
  transcript: string | null;
  /** Para image: el JSON estructurado de Gemini con líneas y precios. */
  extractedData: unknown | null;
}

async function resolveContent(msg: KapsoIncomingMessage): Promise<ResolvedContent> {
  switch (msg.type) {
    case "text":
      return {
        userText: msg.text?.body ?? "",
        contentType: "text",
        mediaUrl: null,
        lat: null,
        lng: null,
        transcript: null,
        extractedData: null,
      };
    case "audio": {
      // Si Kapso ya transcribió (v2), usamos eso y ahorramos Whisper.
      const kapsoTranscript = msg.kapso?.transcript?.text?.trim();
      if (kapsoTranscript) {
        return {
          userText: kapsoTranscript,
          contentType: "audio",
          mediaUrl: msg.kapso?.media_url ?? msg.audio?.id ?? null,
          lat: null,
          lng: null,
          transcript: kapsoTranscript,
          extractedData: null,
        };
      }
      // Fallback: descargar el blob y mandar a Whisper.
      if (!msg.audio?.id) return emptyAudio();
      try {
        const blob = await fetchKapsoMedia(msg.audio.id);
        const text = await transcribeAudio(blob);
        return {
          userText: text,
          contentType: "audio",
          mediaUrl: msg.audio.id,
          lat: null,
          lng: null,
          transcript: text,
          extractedData: null,
        };
      } catch (err) {
        log.error("audio_transcription_failed", { err: String(err), audio_id: msg.audio.id });
        return emptyAudio();
      }
    }
    case "image": {
      // Extracción de menú con Gemini. Tenemos imagen si tenemos image.id.
      // El media_url solo viene poblado a veces; siempre podemos descargar por id.
      const imageId = msg.image?.id;
      const captionHint = msg.image?.caption ?? "";
      let extractedText = captionHint ? `[Imagen recibida]\nNota del dueño: ${captionHint}` : "[Imagen recibida]";
      let extractedData: unknown = null;

      if (!imageId) {
        log.warn("image_without_id", { msg_id: msg.id });
        extractedData = { error: "image_without_id", phase: "intake" };
      } else {
        // Paso 1: descargar el blob desde Kapso. Capturamos errores granulares para
        // poder diagnosticar después por qué falla la extracción.
        let blob: Blob | null = null;
        try {
          blob = await fetchKapsoMedia(imageId);
          log.info("kapso_media_downloaded", {
            image_id: imageId,
            bytes: blob.size,
            mime: blob.type,
          });
        } catch (err) {
          const errMsg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
          log.error("kapso_media_fetch_failed", { err: errMsg, image_id: imageId });
          extractedData = { error: errMsg, phase: "kapso_fetch", image_id: imageId };
        }

        // Paso 2: si la descarga sirvió, mandar a Gemini.
        if (blob) {
          try {
            const result = await extractMenu(blob);
            extractedData = result;
            const lines = result.lines
              .map((l) => l.price ? `- ${l.name} — $${l.price}` : `- ${l.name} (sin precio)`)
              .join("\n");
            extractedText = lines
              ? `[Foto de menú extraída por OCR]\n${lines}${captionHint ? `\nNota del dueño: ${captionHint}` : ""}`
              : extractedText;
            log.info("image_extracted", {
              image_id: imageId,
              lines: result.lines.length,
              vendor: result.vendor_name,
            });
          } catch (err) {
            const errMsg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
            log.error("gemini_extract_failed", { err: errMsg, image_id: imageId });
            extractedData = {
              error: errMsg,
              phase: "gemini_extract",
              image_id: imageId,
              bytes: blob.size,
              mime: blob.type,
            };
          }
        }
      }

      return {
        userText: extractedText,
        contentType: "image",
        mediaUrl: imageId ?? null,
        lat: null,
        lng: null,
        transcript: null,
        extractedData,
      };
    }
    case "location":
      return {
        userText: `[Ubicación enviada: lat=${msg.location?.latitude}, lng=${msg.location?.longitude}]`,
        contentType: "location",
        mediaUrl: null,
        lat: msg.location?.latitude ?? null,
        lng: msg.location?.longitude ?? null,
        transcript: null,
        extractedData: null,
      };
    default:
      return {
        userText: "[mensaje no soportado]",
        contentType: "interactive",
        mediaUrl: null,
        lat: null,
        lng: null,
        transcript: null,
        extractedData: null,
      };
  }
}

function emptyAudio(): ResolvedContent {
  return {
    userText: "[audio no transcribible]",
    contentType: "audio",
    mediaUrl: null,
    lat: null,
    lng: null,
    transcript: null,
    extractedData: null,
  };
}

interface InsertInboundArgs {
  business_id: string | null;
  user_id: string;
  content_type: ContentType;
  raw_text: string | null;
  media_url: string | null;
  transcript: string | null;
  extracted_data: unknown | null;
  latitude: number | null;
  longitude: number | null;
  whatsapp_message_id: string;
}

async function insertInboundMessage(args: InsertInboundArgs): Promise<MessageRecord> {
  const { data, error } = await db()
    .from("messages")
    .insert({ ...args, direction: "inbound" })
    .select("*")
    .single();
  if (error) throw error;
  return data as MessageRecord;
}

// =========================================================================
// Routing por (rol + estado del negocio).
// Las ramas marcadas STUB se completan en fases siguientes del plan.
// =========================================================================

interface RouteArgs {
  user: User;
  business: Business | null;
  memberships: Membership[];
  userText: string;
  inboundMessage: MessageRecord;
}

interface RouteResult {
  text: string;
  /** Traces del agente si vino de un agent loop; sirve para persistir tool_calls. */
  traces?: unknown[];
}

async function route(args: RouteArgs): Promise<RouteResult> {
  const { user, business, memberships, userText, inboundMessage } = args;

  // CASO 1: Sin business → nuevo dueño potencial. Arrancamos onboarding.
  if (!business) {
    const result = await runOnboardingAgent({
      user,
      business: null,
      inboundMessage,
      userText,
    });
    // Si el agente acabó de crear un business durante este turn, asociamos
    // retroactivamente los mensajes previos sin business_id al nuevo.
    await retroactivelyLinkMessages(user.id);
    return { text: result.text, traces: result.traces };
  }

  const isOwner = memberships.some(
    (m) => m.business_id === business.id && m.role === "owner",
  );
  const isSeller = memberships.some(
    (m) => m.business_id === business.id && m.role === "seller",
  );

  // CASO 2: Onboarding en curso, escribe el owner.
  if (business.state === "onboarding") {
    if (isOwner) {
      const result = await runOnboardingAgent({ user, business, inboundMessage, userText });
      return { text: result.text, traces: result.traces };
    }
    if (isSeller) {
      return { text: "El dueño todavía está configurando el negocio. Te aviso cuando esté listo." };
    }
    return { text: "Tu número no está asociado a ningún negocio. Pídele al dueño que te agregue." };
  }

  // CASO 3: Producción.
  // STUB temporal: el production agent (Fase 3 del plan) está en backlog.
  // Mientras tanto respondemos con un mensaje honesto, no con un eco debug.
  if (isOwner) {
    return {
      text: "Tu negocio ya está activo. Estoy terminando de habilitar el reporte de ventas y las notificaciones — te aviso cuando estén listas. Mientras tanto, cualquier duda dime.",
    };
  }
  return {
    text: "Tu negocio ya está activo. Estoy terminando de habilitar el reporte de ventas; pronto podrás registrar las tuyas hablándome.",
  };
}

/**
 * Cuando el dueño manda su primer mensaje (sin business) y el agente acaba de
 * crear el business durante el turn, hay mensajes con business_id=NULL que
 * deberían asociarse al business recién creado. Esto los conecta.
 */
async function retroactivelyLinkMessages(userId: string): Promise<void> {
  const supabase = db();
  // Buscar el business del que este user es owner
  const { data: ownership } = await supabase
    .from("business_members")
    .select("business_id")
    .eq("user_id", userId)
    .eq("role", "owner")
    .eq("active", true)
    .limit(1)
    .maybeSingle();
  if (!ownership) return;
  const businessId = (ownership as any).business_id;

  await supabase
    .from("messages")
    .update({ business_id: businessId })
    .eq("user_id", userId)
    .is("business_id", null);
}
