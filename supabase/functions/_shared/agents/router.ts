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
export async function handleKapsoEvent(payload: unknown): Promise<void> {
  const p = payload as KapsoWebhookPayload;

  // Solo nos interesan los mensajes recibidos. Ignoramos sent/delivered/read/etc.
  if (p?.type && p.type !== "whatsapp.message.received") {
    log.debug("ignoring_event_type", { type: p.type });
    return;
  }

  // Si viene en formato batch (buffer_enabled), iterar sobre data[].
  // Si viene sin batch (no buffereado), procesar el payload directo.
  const items: KapsoEventItem[] = p.batch && Array.isArray(p.data)
    ? p.data
    : (p.message ? [p as KapsoEventItem] : []);

  if (items.length === 0) {
    log.info("payload_without_messages", { keys: Object.keys(p ?? {}) });
    return;
  }

  for (const item of items) {
    await processSingleMessage(item).catch((err) =>
      log.error("process_single_message_failed", { err: String(err), wa_id: item.message?.id })
    );
  }
}

async function processSingleMessage(item: KapsoEventItem): Promise<void> {
  if (!item.message) {
    log.debug("item_without_message");
    return;
  }
  const msg = item.message;

  // Ignorar mensajes outbound (echos del propio sistema).
  if (msg.kapso?.direction === "outbound") {
    log.debug("ignoring_outbound_event", { wa_id: msg.id });
    return;
  }

  if (!msg.from) {
    log.warn("incoming_without_from", { wa_id: msg.id });
    return;
  }

  // 1. Idempotencia: si ya tenemos este whatsapp_message_id, no procesar.
  const supabase = db();
  const { data: existing } = await supabase
    .from("messages")
    .select("id")
    .eq("whatsapp_message_id", msg.id)
    .maybeSingle();
  if (existing) {
    log.info("duplicate_message_ignored", { wa_id: msg.id });
    return;
  }

  // 2. Resolver / crear usuario por número.
  const phone = toE164(msg.from);
  const user = await upsertUserByPhone(phone);

  // 3. Procesar media → texto.
  const { userText, contentType, mediaUrl, lat, lng, transcript } = await resolveContent(msg);

  // 4. Resolver contexto de negocio.
  const memberships = await loadActiveMemberships(user.id);
  const business = await resolveBusiness(memberships);

  // 5. Insertar mensaje inbound.
  const inboundMessage = await insertInboundMessage({
    business_id: business?.id ?? null,
    user_id: user.id,
    content_type: contentType,
    raw_text: msg.text?.body ?? null,
    media_url: mediaUrl,
    transcript,
    latitude: lat,
    longitude: lng,
    whatsapp_message_id: msg.id,
  });

  // 6. Routing.
  const reply = await route({ user, business, memberships, userText, inboundMessage });

  // 7. Enviar respuesta + persistir outbound.
  if (reply) {
    try {
      const sent = await sendWhatsAppText(phone, reply);
      const sentId = sent.messages?.[0]?.id ?? sent.id ?? null;
      await supabase.from("messages").insert({
        business_id: business?.id ?? null,
        user_id: user.id,
        direction: "outbound",
        content_type: "text",
        raw_text: reply,
        whatsapp_message_id: sentId,
      });
    } catch (err) {
      log.error("outbound_send_failed", { err: String(err) });
    }
  }
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
  userText: string;
  contentType: ContentType;
  mediaUrl: string | null;
  lat: number | null;
  lng: number | null;
  transcript: string | null;
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
        };
      } catch (err) {
        log.error("audio_transcription_failed", { err: String(err) });
        return emptyAudio();
      }
    }
    case "image": {
      // Extracción de menú con Gemini (útil durante onboarding cuando el dueño
      // manda una foto del menú). Si falla, fallback al caption.
      const mediaUrl = msg.kapso?.media_url ?? msg.kapso?.media_data?.url ?? null;
      const captionHint = msg.image?.caption ?? "";
      let extractedText = captionHint || "[imagen]";

      if (mediaUrl) {
        try {
          const blob = await fetchKapsoMedia(msg.image?.id ?? "");
          const result = await extractMenu(blob);
          const lines = result.lines
            .map((l) => l.price ? `- ${l.name} — $${l.price}` : `- ${l.name}`)
            .join("\n");
          extractedText = lines
            ? `[Foto de menú extraída]\n${lines}\n${captionHint ? `(Nota del dueño: ${captionHint})` : ""}`.trim()
            : `[Imagen recibida, no se pudo extraer texto]${captionHint ? `\nNota: ${captionHint}` : ""}`;
        } catch (err) {
          log.error("image_extract_failed", { err: String(err) });
        }
      }

      return {
        userText: extractedText,
        contentType: "image",
        mediaUrl: msg.image?.id ?? null,
        lat: null,
        lng: null,
        transcript: null,
      };
    }
    case "location":
      return {
        userText: "[ubicación]",
        contentType: "location",
        mediaUrl: null,
        lat: msg.location?.latitude ?? null,
        lng: msg.location?.longitude ?? null,
        transcript: null,
      };
    default:
      return {
        userText: "[mensaje no soportado]",
        contentType: "interactive",
        mediaUrl: null,
        lat: null,
        lng: null,
        transcript: null,
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
  };
}

interface InsertInboundArgs {
  business_id: string | null;
  user_id: string;
  content_type: ContentType;
  raw_text: string | null;
  media_url: string | null;
  transcript: string | null;
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

async function route(args: RouteArgs): Promise<string> {
  const { user, business, memberships, userText, inboundMessage } = args;

  // CASO 1: Sin business → nuevo dueño potencial. Arrancamos onboarding.
  // El agente creará el business cuando tenga el nombre.
  if (!business) {
    const reply = await runOnboardingAgent({
      user,
      business: null,
      inboundMessage,
      userText,
    });
    // Si el agente acabó de crear un business durante este turn, asociamos
    // retroactivamente este mensaje y los previos sin business_id al nuevo.
    await retroactivelyLinkMessages(user.id);
    return reply;
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
      return await runOnboardingAgent({ user, business, inboundMessage, userText });
    }
    if (isSeller) {
      return "El dueño todavía está configurando el negocio. Te aviso cuando esté listo.";
    }
    return "Tu número no está asociado a ningún negocio. Pídele al dueño que te agregue.";
  }

  // CASO 3: Producción. Por ahora stub — Fase 3 implementará production agent.
  // STUB Fase 3: runProductionAgent.
  const role = isOwner ? "dueño" : "vendedor";
  return `[${business.name} · modo ${role}] Eco: ${userText}`;
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
