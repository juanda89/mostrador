// Production agent loop.
// Modelo: Claude Sonnet 4.6 (más barato y rápido que Opus, suficiente para
// el flujo operativo del día a día).
//
// Maneja owner y seller con prompts diferentes y permisos por tool.

import { anthropic, MODELS } from "../../lib/anthropic.ts";
import { db } from "../../lib/supabase.ts";
import { log } from "../../lib/log.ts";
import type { Business, MessageRecord, User } from "../../types/domain.ts";
import {
  executeProductionTool,
  productionToolSchemas,
  type ProductionToolCtx,
} from "./tools.ts";
import { productionSystemPrompt, type ProductionPromptCtx } from "./system-prompt.ts";

const MAX_TURNS = 8;
const HISTORY_LIMIT = 24; // un poco menos que onboarding (24h de operación cabe)

interface RunProductionArgs {
  user: User;
  business: Business;
  role: "owner" | "seller";
  inboundMessage: MessageRecord;
  userText: string;
}

export interface ProductionTurnTrace {
  turn: number;
  model: string;
  latency_ms: number;
  stop_reason: string | null;
  input_tokens?: number;
  output_tokens?: number;
  tool_uses: Array<{ name: string; input: unknown; ok: boolean; error?: string }>;
  text_chars: number;
}

export interface ProductionAgentResult {
  text: string;
  traces: ProductionTurnTrace[];
}

export async function runProductionAgent(args: RunProductionArgs): Promise<ProductionAgentResult> {
  const supabase = db();

  // Cargar contexto: catálogo + sellers + payment methods + inventario
  const ctxData = await loadProductionContext(args.business.id);

  const systemPrompt = productionSystemPrompt({
    user: args.user,
    business: args.business,
    role: args.role,
    products: ctxData.products,
    sellers: ctxData.sellers,
    paymentMethods: ctxData.paymentMethods,
    inventory: ctxData.inventory,
  });

  // Cargar historial
  const history = await loadConversationHistory(args.business.id);
  const rawMessages = history.map((m) => ({
    role: m.direction === "inbound" ? ("user" as const) : ("assistant" as const),
    content: m.raw_text ?? m.transcript ?? "[mensaje vacío]",
  }));
  const anthropicMessages: any[] = mergeConsecutiveSameRole(rawMessages);

  const toolCtx: ProductionToolCtx = {
    user: args.user,
    business: args.business,
    role: args.role,
    inboundMessageId: args.inboundMessage.id,
  };

  const tools = productionToolSchemas(args.role);
  const traces: ProductionTurnTrace[] = [];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    let response;
    const t0 = performance.now();
    try {
      response = await anthropic().messages.create({
        model: MODELS.PRODUCTION,
        max_tokens: 1024,
        system: systemPrompt,
        tools,
        messages: anthropicMessages,
      });
    } catch (err) {
      const latency = Math.round(performance.now() - t0);
      log.error("production_anthropic_failed", { err: String(err), turn, latency });
      traces.push({
        turn,
        model: MODELS.PRODUCTION,
        latency_ms: latency,
        stop_reason: "anthropic_error",
        tool_uses: [],
        text_chars: 0,
      });
      return { text: "Algo me cortó. Mándame el último mensaje de nuevo, porfa.", traces };
    }
    const latency = Math.round(performance.now() - t0);
    const text = extractText(response.content);

    if (response.stop_reason === "end_turn") {
      traces.push({
        turn,
        model: MODELS.PRODUCTION,
        latency_ms: latency,
        stop_reason: "end_turn",
        input_tokens: response.usage?.input_tokens,
        output_tokens: response.usage?.output_tokens,
        tool_uses: [],
        text_chars: text.length,
      });
      return { text: text || "Listo.", traces };
    }

    if (response.stop_reason === "tool_use") {
      const toolUses = response.content.filter(
        (b): b is { type: "tool_use"; id: string; name: string; input: Record<string, unknown> } =>
          b.type === "tool_use",
      );
      const toolResultsContent: any[] = [];
      const turnTools: ProductionTurnTrace["tool_uses"] = [];

      for (const tu of toolUses) {
        log.info("production_tool_use", { name: tu.name, business_id: args.business.id, role: args.role });
        const result = await executeProductionTool(tu.name, tu.input, toolCtx);
        turnTools.push({
          name: tu.name,
          input: tu.input,
          ok: result.ok,
          error: result.ok ? undefined : (result.error ?? "unknown"),
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
        model: MODELS.PRODUCTION,
        latency_ms: latency,
        stop_reason: "tool_use",
        input_tokens: response.usage?.input_tokens,
        output_tokens: response.usage?.output_tokens,
        tool_uses: turnTools,
        text_chars: text.length,
      });

      anthropicMessages.push({ role: "assistant", content: response.content });
      anthropicMessages.push({ role: "user", content: toolResultsContent });
      continue;
    }

    log.warn("production_unexpected_stop_reason", { stop_reason: response.stop_reason, turn });
    traces.push({
      turn,
      model: MODELS.PRODUCTION,
      latency_ms: latency,
      stop_reason: response.stop_reason ?? null,
      input_tokens: response.usage?.input_tokens,
      output_tokens: response.usage?.output_tokens,
      tool_uses: [],
      text_chars: text.length,
    });
    return { text: text || "Algo me cortó la respuesta. ¿Puedes repetir lo último?", traces };
  }

  log.warn("production_max_turns_reached", { user_id: args.user.id });
  return { text: "Me enredé. ¿Puedes decirme en una sola frase qué necesitas?", traces };
}

function extractText(content: any[]): string {
  return content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

function mergeConsecutiveSameRole(
  msgs: Array<{ role: string; content: string }>,
): Array<{ role: string; content: string }> {
  const out: Array<{ role: string; content: string }> = [];
  for (const m of msgs) {
    const prev = out[out.length - 1];
    if (prev && prev.role === m.role && typeof prev.content === "string") {
      prev.content = `${prev.content}\n${m.content}`;
    } else {
      out.push({ ...m });
    }
  }
  return out;
}

async function loadConversationHistory(businessId: string): Promise<MessageRecord[]> {
  const supabase = db();
  const { data, error } = await supabase
    .from("messages")
    .select("*")
    .eq("business_id", businessId)
    .order("created_at", { ascending: false })
    .limit(HISTORY_LIMIT);
  if (error) {
    log.error("load_history_failed_production", { err: error.message });
    return [];
  }
  return ((data ?? []) as MessageRecord[]).reverse();
}

async function loadProductionContext(businessId: string): Promise<{
  products: ProductionPromptCtx["products"];
  sellers: ProductionPromptCtx["sellers"];
  paymentMethods: string[];
  inventory: ProductionPromptCtx["inventory"];
}> {
  const supabase = db();
  const [productsRes, sellersRes, settingsRes, inventoryRes, recipesRes, componentsRes] = await Promise.all([
    supabase.from("products").select("id, name, price, is_composite").eq("business_id", businessId).eq("active", true).order("created_at"),
    supabase.from("business_members").select("user:users(phone, name)").eq("business_id", businessId).eq("role", "seller").eq("active", true),
    supabase.from("business_settings").select("accepted_payment_methods").eq("business_id", businessId).maybeSingle(),
    supabase.from("ingredients").select("name, unit, current_stock").eq("business_id", businessId).order("name"),
    supabase.from("product_recipes").select("product_id, ingredient_id, qty_per_unit"),
    supabase.from("product_components").select("parent_product_id, child_product_id, qty"),
  ]);

  // deno-lint-ignore no-explicit-any
  const productsRaw = (productsRes.data ?? []) as any[];
  // deno-lint-ignore no-explicit-any
  const recipes = (recipesRes.data ?? []) as any[];
  // deno-lint-ignore no-explicit-any
  const components = (componentsRes.data ?? []) as any[];
  // deno-lint-ignore no-explicit-any
  const inventoryData = (inventoryRes.data ?? []) as any[];

  // Mapear stock por ingrediente
  const stockById = new Map<string, number>();
  // necesitamos también ingredient_id por nombre para resolver inventario
  // pero aquí solo lo usamos para estimar disponibilidad.
  // simplificamos: si producto simple tiene recetas, estimar mínimo de
  // unidades disponibles según el ingrediente más restrictivo.
  // (esto es heurística para mostrar al user; no es perfecto pero útil).
  const ingredientsByName = new Map<string, { id: string; stock: number; unit: string }>();
  for (const i of inventoryData) {
    ingredientsByName.set(String(i.name).toLowerCase(), { id: "", stock: Number(i.current_stock), unit: i.unit });
  }

  // Construir map: product_id → recetas; product_id → componentes
  const recipesByProduct = new Map<string, Array<{ ingredient_id: string; qty_per_unit: number }>>();
  for (const r of recipes) {
    const arr = recipesByProduct.get(r.product_id) ?? [];
    arr.push({ ingredient_id: r.ingredient_id, qty_per_unit: Number(r.qty_per_unit) });
    recipesByProduct.set(r.product_id, arr);
  }
  // Para estimación de disponibilidad necesitaríamos ingredient_id → stock.
  // Vamos a obtenerlo aparte:
  const { data: ingFullData } = await supabase.from("ingredients").select("id, current_stock").eq("business_id", businessId);
  const stockByIngId = new Map<string, number>();
  for (const ing of (ingFullData ?? []) as any[]) stockByIngId.set(ing.id, Number(ing.current_stock));

  const products: ProductionPromptCtx["products"] = productsRaw.map((p) => {
    let est: number | null = null;
    if (!p.is_composite) {
      const recipe = recipesByProduct.get(p.id);
      if (recipe && recipe.length > 0) {
        // unidades disponibles = min(stock_i / qty_per_unit_i)
        let minUnits = Number.POSITIVE_INFINITY;
        for (const r of recipe) {
          const stock = stockByIngId.get(r.ingredient_id) ?? 0;
          const units = r.qty_per_unit > 0 ? stock / r.qty_per_unit : Number.POSITIVE_INFINITY;
          if (units < minUnits) minUnits = units;
        }
        est = isFinite(minUnits) ? minUnits : null;
      }
    }
    return {
      name: p.name,
      price: Number(p.price),
      is_composite: p.is_composite,
      estimated_units_available: est,
    };
  });

  const sellers: ProductionPromptCtx["sellers"] = ((sellersRes.data ?? []) as any[]).map((s) => ({
    phone: s.user.phone,
    name: s.user.name,
  }));

  const paymentMethods = ((settingsRes.data as any)?.accepted_payment_methods ?? []) as string[];

  const inventory: ProductionPromptCtx["inventory"] = inventoryData
    .slice(0, 20)
    .map((i) => ({ name: i.name, unit: i.unit, current_stock: Number(i.current_stock) }));

  return { products, sellers, paymentMethods, inventory };
}
