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

const MAX_TURNS = 12;         // Tope hard de iteraciones agent ↔ tools en un mismo turn de usuario
const HISTORY_LIMIT = 30;     // Últimos N mensajes a cargar como contexto

interface RunOnboardingArgs {
  user: User;
  business: Business | null;
  inboundMessage: MessageRecord;
  /** Texto procesado del mensaje del usuario (post-Whisper/Gemini si aplicable). */
  userText: string;
}

/** Trace de un turn dentro del loop del agente, para observabilidad. */
export interface AgentTurnTrace {
  turn: number;
  model: string;
  latency_ms: number;
  stop_reason: string | null;
  input_tokens?: number;
  output_tokens?: number;
  tool_uses: Array<{ name: string; input: unknown; ok: boolean; error?: string }>;
  text_chars: number;
}

export interface AgentResult {
  text: string;
  traces: AgentTurnTrace[];
}

/**
 * Ejecuta un turn del onboarding agent y devuelve la respuesta que el bot
 * debe enviar de vuelta por WhatsApp, junto con traces para observabilidad.
 */
export async function runOnboardingAgent(args: RunOnboardingArgs): Promise<AgentResult> {
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
  const traces: AgentTurnTrace[] = [];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    let response;
    const t0 = performance.now();
    try {
      response = await anthropic().messages.create({
        model: MODELS.ONBOARDING,
        max_tokens: 1024,
        system: systemPrompt,
        tools,
        messages: anthropicMessages,
      });
    } catch (err) {
      const latency = Math.round(performance.now() - t0);
      log.error("anthropic_call_failed", { err: String(err), turn, latency });
      traces.push({
        turn, model: MODELS.ONBOARDING, latency_ms: latency,
        stop_reason: "anthropic_error", tool_uses: [], text_chars: 0,
      });
      return {
        text: "Algo me cortó. Mándame el último mensaje de nuevo, porfa.",
        traces,
      };
    }
    const latency = Math.round(performance.now() - t0);

    const text = extractText(response.content);
    const toolUses = response.content.filter(
      (b): b is { type: "tool_use"; id: string; name: string; input: Record<string, unknown> } =>
        b.type === "tool_use",
    );

    // Si el agente respondió texto y terminó, devolverlo
    if (response.stop_reason === "end_turn") {
      traces.push({
        turn,
        model: MODELS.ONBOARDING,
        latency_ms: latency,
        stop_reason: "end_turn",
        input_tokens: response.usage?.input_tokens,
        output_tokens: response.usage?.output_tokens,
        tool_uses: [],
        text_chars: text.length,
      });
      log.info("onboarding_agent_responded", {
        business_id: toolCtx.state.business?.id ?? null,
        turns_used: turn + 1,
        text_len: text.length,
      });
      return { text: text || "Listo.", traces };
    }

    // Si pidió usar tools, ejecutarlas y devolverle los resultados
    if (response.stop_reason === "tool_use") {
      const toolResultsContent: any[] = [];
      const turnTools: AgentTurnTrace["tool_uses"] = [];

      for (const tu of toolUses) {
        log.info("tool_use", { name: tu.name, business_id: toolCtx.state.business?.id ?? null });
        const result = await executeOnboardingTool(tu.name, tu.input, toolCtx);
        turnTools.push({
          name: tu.name,
          input: tu.input,
          ok: result.ok,
          error: result.ok ? undefined : (result.error ?? String(result)),
        });
        toolResultsContent.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: JSON.stringify(result),
          is_error: !result.ok,
        });
      }

      traces.push({
        turn,
        model: MODELS.ONBOARDING,
        latency_ms: latency,
        stop_reason: "tool_use",
        input_tokens: response.usage?.input_tokens,
        output_tokens: response.usage?.output_tokens,
        tool_uses: turnTools,
        text_chars: text.length,
      });

      // Agregar el assistant turn con el content original y el user turn con los results
      anthropicMessages.push({ role: "assistant", content: response.content });
      anthropicMessages.push({ role: "user", content: toolResultsContent });
      continue;
    }

    // stop_reason inesperado (max_tokens, etc.)
    log.warn("unexpected_stop_reason", { stop_reason: response.stop_reason, turn });
    traces.push({
      turn, model: MODELS.ONBOARDING, latency_ms: latency,
      stop_reason: response.stop_reason ?? null,
      input_tokens: response.usage?.input_tokens,
      output_tokens: response.usage?.output_tokens,
      tool_uses: [], text_chars: text.length,
    });
    return {
      text: text || "Algo me cortó la respuesta. ¿Puedes repetir lo último?",
      traces,
    };
  }

  log.warn("onboarding_max_turns_reached", { user_id: args.user.id });
  return {
    text: "Me enredé. ¿Puedes decirme en una sola frase qué necesitas hacer?",
    traces,
  };
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
