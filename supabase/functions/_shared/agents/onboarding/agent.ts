// Onboarding agent loop.
// Modelo: Claude Opus 4.7. Temperatura 0.3 (algo de calidez con precisión).
//
// Maneja:
//   - Carga del historial conversacional (por business_id o user_id si no hay business todavía)
//   - Llamadas tool_use → ejecutar handler → tool_result → re-llamar
//   - Tope de iteraciones para evitar loops infinitos

import { anthropic, MODELS } from "../../lib/anthropic.ts";
import { db } from "../../lib/supabase.ts";
import { log } from "../../lib/log.ts";
import type { Business, BusinessSettings, MessageRecord, User } from "../../types/domain.ts";
import { loadChecklistSnapshot } from "./checklist.ts";
import { executeOnboardingTool, onboardingToolSchemas, type OnboardingToolCtx } from "./tools.ts";
import { onboardingSystemPrompt } from "./system-prompt.ts";

const MAX_TURNS = 6;          // Tope hard de iteraciones agent ↔ tools en un mismo turn de usuario
const HISTORY_LIMIT = 30;     // Últimos N mensajes a cargar como contexto

interface RunOnboardingArgs {
  user: User;
  business: Business | null;
  inboundMessage: MessageRecord;
  /** Texto procesado del mensaje del usuario (post-Whisper/Gemini si aplicable). */
  userText: string;
}

/**
 * Ejecuta un turn del onboarding agent y devuelve la respuesta que el bot
 * debe enviar de vuelta por WhatsApp.
 */
export async function runOnboardingAgent(args: RunOnboardingArgs): Promise<string> {
  const supabase = db();

  // 1. Cargar settings y checklist si ya existe negocio
  let settings: BusinessSettings | null = null;
  let checklist = null as Awaited<ReturnType<typeof loadChecklistSnapshot>> | null;

  if (args.business) {
    const { data: settingsRow } = await supabase
      .from("business_settings")
      .select("*")
      .eq("business_id", args.business.id)
      .maybeSingle();
    settings = (settingsRow as BusinessSettings | null) ?? null;
    checklist = await loadChecklistSnapshot(args.business.id);
  }

  // 2. Cargar historial conversacional
  const history = await loadConversationHistory(args.user.id, args.business?.id ?? null);

  // 3. Preparar contexto del system prompt
  const systemPrompt = onboardingSystemPrompt({
    user: args.user,
    business: args.business,
    settings,
    memberships: [],
    checklist: checklist
      ? {
        has_name: checklist.has_name,
        has_products: checklist.has_products,
        has_seller: checklist.has_seller,
        has_payment_methods: checklist.has_payment_methods,
        has_location: checklist.has_location,
        has_report_schedule: checklist.has_report_schedule,
        has_recipes: checklist.has_recipes,
        has_initial_inventory: checklist.has_initial_inventory,
      }
      : null,
    productCount: checklist?.productCount ?? 0,
    sellerCount: checklist?.sellerCount ?? 0,
    hasAnyRecipe: checklist?.hasAnyRecipe ?? false,
  });

  // 4. Estado mutable que las tools comparten entre llamadas dentro del mismo turn
  const toolCtx: OnboardingToolCtx = {
    user: args.user,
    business: args.business,
    state: {
      business: args.business,
      sellerPhones: [],
    },
    refreshBusiness: async () => {
      const bid = toolCtx.state.business?.id;
      if (!bid) return null;
      const { data } = await db().from("businesses").select("*").eq("id", bid).maybeSingle();
      const updated = (data as Business | null) ?? null;
      if (updated) toolCtx.state.business = updated;
      return updated;
    },
  };

  // 5. Construir messages para Anthropic
  // history ya incluye el inboundMessage actual (se insertó antes de invocar al agente),
  // así que no lo agregamos por separado.
  const anthropicMessages: any[] = history.map((m) => ({
    role: m.direction === "inbound" ? "user" : "assistant",
    content: m.raw_text ?? m.transcript ?? "[mensaje vacío]",
  }));

  // 6. Loop con tool calling
  const tools = onboardingToolSchemas();

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    let response;
    try {
      response = await anthropic().messages.create({
        model: MODELS.ONBOARDING,
        max_tokens: 1024,
        system: systemPrompt,
        tools,
        messages: anthropicMessages,
      });
    } catch (err) {
      log.error("anthropic_call_failed", { err: String(err), turn });
      return "Tuve un problema momentáneo. ¿Puedes intentar de nuevo en un segundo?";
    }

    // Si el agente respondió texto y terminó, devolverlo
    if (response.stop_reason === "end_turn") {
      const text = extractText(response.content);
      log.info("onboarding_agent_responded", {
        business_id: toolCtx.state.business?.id ?? null,
        turns_used: turn + 1,
        text_len: text.length,
      });
      return text || "Listo.";
    }

    // Si pidió usar tools, ejecutarlas y devolverle los resultados
    if (response.stop_reason === "tool_use") {
      const toolUses = response.content.filter(
        (b): b is { type: "tool_use"; id: string; name: string; input: Record<string, unknown> } =>
          b.type === "tool_use",
      );
      const toolResultsContent: any[] = [];

      for (const tu of toolUses) {
        log.info("tool_use", { name: tu.name, business_id: toolCtx.state.business?.id ?? null });
        const result = await executeOnboardingTool(tu.name, tu.input, toolCtx);
        toolResultsContent.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: JSON.stringify(result),
          is_error: !result.ok,
        });
      }

      // Agregar el assistant turn con el content original y el user turn con los results
      anthropicMessages.push({ role: "assistant", content: response.content });
      anthropicMessages.push({ role: "user", content: toolResultsContent });
      continue;
    }

    // stop_reason inesperado (max_tokens, etc.)
    log.warn("unexpected_stop_reason", { stop_reason: response.stop_reason, turn });
    const text = extractText(response.content);
    return text || "Algo me cortó la respuesta. ¿Puedes repetir lo último?";
  }

  log.warn("onboarding_max_turns_reached", { user_id: args.user.id });
  return "Me enredé un poco. ¿Puedes decirme en una sola frase qué necesitas?";
}

function extractText(content: any[]): string {
  return content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

/**
 * Carga el historial conversacional para feed al agente.
 * Estrategia:
 *   - Si hay business: por business_id (todos los mensajes del business)
 *   - Si no hay business todavía: por user_id sin business_id (pre-onboarding)
 */
async function loadConversationHistory(
  userId: string,
  businessId: string | null,
): Promise<MessageRecord[]> {
  const supabase = db();
  let query = supabase
    .from("messages")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(HISTORY_LIMIT);

  if (businessId) {
    query = query.eq("business_id", businessId);
  } else {
    query = query.eq("user_id", userId).is("business_id", null);
  }

  const { data, error } = await query;
  if (error) {
    log.error("load_history_failed", { err: error.message });
    return [];
  }
  // DESC → reverse a chronological order
  return ((data ?? []) as MessageRecord[]).reverse();
}
