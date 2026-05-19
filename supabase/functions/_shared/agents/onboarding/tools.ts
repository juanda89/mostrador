// Tools del onboarding agent.
// Cada tool tiene:
//   - schema: definición Anthropic (name, description, input_schema JSON)
//   - handler: ejecuta la acción contra Postgres y devuelve un resultado JSON
//
// El agente solo ve los `schema`. El handler se invoca desde el agent loop
// cuando Anthropic emite un content block de tipo "tool_use".

import { db } from "../../lib/supabase.ts";
import { log } from "../../lib/log.ts";
import { toE164 } from "../../lib/phone.ts";
import type { Business, User, UnitType, Weekday } from "../../types/domain.ts";

// =========================================================================
// Tipos compartidos
// =========================================================================

export interface OnboardingToolCtx {
  user: User;                                    // Quien escribe (owner)
  business: Business | null;                     // Negocio asociado (o null si recién empieza)
  /** Callback para refrescar business desde DB tras crear uno nuevo */
  refreshBusiness: () => Promise<Business | null>;
  /** Acumulador in-memory de cambios para que el siguiente turn los vea */
  state: {
    business: Business | null;
    sellerPhones: string[];                      // E.164
  };
}

export interface ToolResult {
  ok: boolean;
  data?: unknown;
  error?: string;
}

export interface ToolDef {
  schema: {
    name: string;
    description: string;
    input_schema: {
      type: "object";
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
  handler: (input: any, ctx: OnboardingToolCtx) => Promise<ToolResult>;
}

// =========================================================================
// Helpers comunes
// =========================================================================

function requireBusiness(ctx: OnboardingToolCtx): { ok: false; error: string } | { ok: true; business: Business } {
  const b = ctx.state.business ?? ctx.business;
  if (!b) {
    return {
      ok: false,
      error: "Primero crea el negocio con upsert_business_info({name}). Sin nombre no puedo guardar nada más.",
    };
  }
  return { ok: true, business: b };
}

/** Infiere timezone y currency a partir del phone E.164. V1 soporta Colombia. */
function inferLocaleFromPhone(phone: string): { timezone: string; currency: string } {
  // +57... → Colombia. Default fallback al mismo.
  return { timezone: "America/Bogota", currency: "COP" };
}

// =========================================================================
// 1. upsert_business_info  (crea o actualiza el negocio del owner)
// =========================================================================
const upsertBusinessInfo: ToolDef = {
  schema: {
    name: "upsert_business_info",
    description:
      "Crea el negocio o actualiza su nombre. Llamar como PRIMERA acción cuando aún no existe negocio. La currency y timezone se infieren del país por el número del owner; no las pidas.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Nombre del negocio tal como lo dijo el dueño." },
        timezone: { type: "string", description: "Opcional; si la persona explícitamente menciona otra ciudad/país, úsala (ej. America/Mexico_City)." },
        currency: { type: "string", description: "Opcional; código ISO 4217 (ej. MXN, ARS). Solo si dijo otro país." },
      },
      required: ["name"],
    },
  },
  handler: async (input, ctx) => {
    const supabase = db();
    const locale = inferLocaleFromPhone(ctx.user.phone);
    const timezone = input.timezone ?? locale.timezone;
    const currency = input.currency ?? locale.currency;

    // Si ya tenía un business en onboarding, actualizar el nombre.
    if (ctx.state.business) {
      const { error } = await supabase
        .from("businesses")
        .update({ name: input.name.trim() })
        .eq("id", ctx.state.business.id);
      if (error) return { ok: false, error: error.message };
      await supabase
        .from("onboarding_checklist")
        .update({ has_name: true })
        .eq("business_id", ctx.state.business.id);
      await ctx.refreshBusiness();
      return { ok: true, data: { business_id: ctx.state.business.id, name: input.name } };
    }

    // Crear business + settings + checklist + owner membership + seller membership (autoagrega owner).
    const { data: created, error: createErr } = await supabase
      .from("businesses")
      .insert({
        name: input.name.trim(),
        owner_user_id: ctx.user.id,
        timezone,
        currency,
        state: "onboarding",
      })
      .select("*")
      .single();
    if (createErr) return { ok: false, error: createErr.message };

    const businessId = (created as Business).id;

    await supabase.from("business_settings").insert({ business_id: businessId });
    await supabase.from("onboarding_checklist").insert({ business_id: businessId, has_name: true });
    await supabase.from("business_members").insert([
      { business_id: businessId, user_id: ctx.user.id, role: "owner" },
    ]);

    const newBusiness = await ctx.refreshBusiness();
    if (newBusiness) ctx.state.business = newBusiness;

    return {
      ok: true,
      data: {
        business_id: businessId,
        name: input.name,
        timezone,
        currency,
        inferred_from_phone: !input.timezone && !input.currency,
      },
    };
  },
};

// =========================================================================
// 2. create_product
// =========================================================================
const createProduct: ToolDef = {
  schema: {
    name: "create_product",
    description:
      "Crea un producto del catálogo. Llamar UNA vez por producto. Si es un combo (junta varios productos a precio fijo), pasar is_composite=true y después llamar set_combo_composition para definir qué incluye.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Nombre del producto tal como lo dijo el dueño." },
        price: { type: "number", description: "Precio al cliente final, número entero en la currency del negocio (no incluir símbolo)." },
        sku: { type: "string", description: "Identificador interno opcional." },
        is_composite: {
          type: "boolean",
          description: "true si es un combo (junta otros productos). Default false.",
        },
      },
      required: ["name", "price"],
    },
  },
  handler: async (input, ctx) => {
    const r = requireBusiness(ctx);
    if (!r.ok) return r;
    const { error, data } = await db()
      .from("products")
      .insert({
        business_id: r.business.id,
        name: input.name.trim(),
        price: input.price,
        sku: input.sku ?? null,
        is_composite: input.is_composite ?? false,
      })
      .select("id, name, price, is_composite")
      .single();
    if (error) return { ok: false, error: error.message };
    await db()
      .from("onboarding_checklist")
      .update({ has_products: true })
      .eq("business_id", r.business.id);
    return { ok: true, data };
  },
};

// =========================================================================
// 3. set_combo_composition
// =========================================================================
const setComboComposition: ToolDef = {
  schema: {
    name: "set_combo_composition",
    description:
      "Define qué productos contiene un combo y en qué cantidad. Llamar después de create_product con is_composite=true. V1: los combos solo se componen de productos SIMPLES (no de otros combos).",
    input_schema: {
      type: "object",
      properties: {
        parent_product_name: {
          type: "string",
          description: "Nombre del combo (tal como se creó).",
        },
        components: {
          type: "array",
          items: {
            type: "object",
            properties: {
              child_product_name: { type: "string", description: "Nombre del producto simple incluido en el combo." },
              qty: { type: "number", description: "Cantidad del componente por cada combo vendido (ej. 2 empanadas → qty=2)." },
            },
            required: ["child_product_name", "qty"],
          },
        },
      },
      required: ["parent_product_name", "components"],
    },
  },
  handler: async (input, ctx) => {
    const r = requireBusiness(ctx);
    if (!r.ok) return r;
    const supabase = db();

    const { data: parent, error: pErr } = await supabase
      .from("products")
      .select("id, is_composite")
      .eq("business_id", r.business.id)
      .ilike("name", input.parent_product_name.trim())
      .maybeSingle();
    if (pErr || !parent) {
      return { ok: false, error: `No encontré el combo "${input.parent_product_name}". Créalo primero con create_product({is_composite: true}).` };
    }

    for (const c of input.components) {
      const { data: child } = await supabase
        .from("products")
        .select("id")
        .eq("business_id", r.business.id)
        .ilike("name", c.child_product_name.trim())
        .maybeSingle();
      if (!child) {
        return {
          ok: false,
          error: `No encontré el componente "${c.child_product_name}". Créalo primero con create_product({is_composite: false}).`,
        };
      }
      const { error: linkErr } = await supabase.from("product_components").insert({
        parent_product_id: parent.id,
        child_product_id: child.id,
        qty: c.qty,
      });
      if (linkErr) return { ok: false, error: linkErr.message };
    }
    return { ok: true, data: { parent_product_id: parent.id, components_added: input.components.length } };
  },
};

// =========================================================================
// 4. create_ingredient
// =========================================================================
const createIngredient: ToolDef = {
  schema: {
    name: "create_ingredient",
    description:
      "Crea un ingrediente del inventario. Normalmente NO necesitas llamar esto directamente — propose_recipes ya crea los ingredientes que falten. Úsalo solo si el dueño te dice 'tengo X kg de carne' antes de definir cualquier receta.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        unit: { type: "string", enum: ["g", "kg", "ml", "l", "unit"] },
        initial_stock: { type: "number", description: "Cantidad inicial en la unit indicada. Opcional." },
      },
      required: ["name", "unit"],
    },
  },
  handler: async (input, ctx) => {
    const r = requireBusiness(ctx);
    if (!r.ok) return r;
    const supabase = db();
    const stock = input.initial_stock ?? 0;
    const { data, error } = await supabase
      .from("ingredients")
      .insert({
        business_id: r.business.id,
        name: input.name.trim(),
        unit: input.unit,
        current_stock: stock,
      })
      .select("id, name, unit, current_stock")
      .single();
    if (error) return { ok: false, error: error.message };
    if (stock > 0) {
      await supabase.from("inventory_movements").insert({
        business_id: r.business.id,
        ingredient_id: (data as any).id,
        type: "initial_set",
        qty_delta: stock,
        balance_after: stock,
        notes: "Stock inicial declarado en onboarding",
      });
      await supabase
        .from("onboarding_checklist")
        .update({ has_initial_inventory: true })
        .eq("business_id", r.business.id);
    }
    return { ok: true, data };
  },
};

// =========================================================================
// 5. propose_recipes  (el "wow moment" del onboarding)
// =========================================================================
const proposeRecipes: ToolDef = {
  schema: {
    name: "propose_recipes",
    description:
      "Guarda recetas inferidas para uno o varios productos simples. Crea automáticamente los ingredientes que falten (deduplicados por nombre). Llamar UNA vez con la propuesta completa, después de que el dueño aceptó (o si te dio recetas explícitas).",
    input_schema: {
      type: "object",
      properties: {
        proposals: {
          type: "array",
          items: {
            type: "object",
            properties: {
              product_name: { type: "string", description: "Nombre del producto simple (no combo) tal como existe en el catálogo." },
              ingredients: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    name: { type: "string", description: "Nombre del ingrediente (ej. 'Carne molida', 'Masa', 'Queso')." },
                    unit: { type: "string", enum: ["g", "kg", "ml", "l", "unit"] },
                    qty_per_unit: { type: "number", description: "Cantidad consumida por cada venta unitaria del producto, en la unit indicada." },
                  },
                  required: ["name", "unit", "qty_per_unit"],
                },
              },
            },
            required: ["product_name", "ingredients"],
          },
        },
      },
      required: ["proposals"],
    },
  },
  handler: async (input, ctx) => {
    const r = requireBusiness(ctx);
    if (!r.ok) return r;
    const supabase = db();
    const businessId = r.business.id;

    // Cache de ingredientes existentes (case-insensitive)
    const { data: existingIngs } = await supabase
      .from("ingredients")
      .select("id, name, unit")
      .eq("business_id", businessId);
    const ingByName = new Map<string, { id: string; unit: string }>();
    for (const ing of existingIngs ?? []) {
      ingByName.set(String((ing as any).name).toLowerCase().trim(), { id: (ing as any).id, unit: (ing as any).unit });
    }

    const created: string[] = [];
    let recipeCount = 0;

    for (const p of input.proposals) {
      const { data: product } = await supabase
        .from("products")
        .select("id, is_composite")
        .eq("business_id", businessId)
        .ilike("name", p.product_name.trim())
        .maybeSingle();
      if (!product) {
        log.warn("propose_recipes_product_not_found", { name: p.product_name });
        continue;
      }
      if ((product as any).is_composite) {
        log.warn("propose_recipes_skipping_composite", { name: p.product_name });
        continue;
      }

      for (const ing of p.ingredients) {
        const key = ing.name.toLowerCase().trim();
        let existing = ingByName.get(key);
        if (!existing) {
          const { data: newIng, error: ingErr } = await supabase
            .from("ingredients")
            .insert({
              business_id: businessId,
              name: ing.name.trim(),
              unit: ing.unit,
              current_stock: 0,
            })
            .select("id, unit")
            .single();
          if (ingErr) return { ok: false, error: ingErr.message };
          existing = { id: (newIng as any).id, unit: (newIng as any).unit };
          ingByName.set(key, existing);
          created.push(ing.name);
        }

        // Upsert receta (UNIQUE product_id+ingredient_id)
        const { error: recErr } = await supabase
          .from("product_recipes")
          .upsert(
            {
              product_id: (product as any).id,
              ingredient_id: existing.id,
              qty_per_unit: ing.qty_per_unit,
            },
            { onConflict: "product_id,ingredient_id" },
          );
        if (recErr) return { ok: false, error: recErr.message };
        recipeCount++;
      }
    }

    if (recipeCount > 0) {
      await supabase
        .from("onboarding_checklist")
        .update({ has_recipes: true })
        .eq("business_id", businessId);
    }

    return { ok: true, data: { created_ingredients: created, recipes_saved: recipeCount } };
  },
};

// =========================================================================
// 6. update_recipe
// =========================================================================
const updateRecipe: ToolDef = {
  schema: {
    name: "update_recipe",
    description: "Ajusta la cantidad de un ingrediente en la receta de un producto (ej. 'la de carne lleva 100g no 80').",
    input_schema: {
      type: "object",
      properties: {
        product_name: { type: "string" },
        ingredient_name: { type: "string" },
        qty_per_unit: { type: "number" },
      },
      required: ["product_name", "ingredient_name", "qty_per_unit"],
    },
  },
  handler: async (input, ctx) => {
    const r = requireBusiness(ctx);
    if (!r.ok) return r;
    const supabase = db();
    const { data: product } = await supabase
      .from("products")
      .select("id")
      .eq("business_id", r.business.id)
      .ilike("name", input.product_name.trim())
      .maybeSingle();
    if (!product) return { ok: false, error: `No encontré el producto "${input.product_name}".` };
    const { data: ingredient } = await supabase
      .from("ingredients")
      .select("id")
      .eq("business_id", r.business.id)
      .ilike("name", input.ingredient_name.trim())
      .maybeSingle();
    if (!ingredient) return { ok: false, error: `No encontré el ingrediente "${input.ingredient_name}".` };
    const { error } = await supabase
      .from("product_recipes")
      .upsert(
        {
          product_id: (product as any).id,
          ingredient_id: (ingredient as any).id,
          qty_per_unit: input.qty_per_unit,
        },
        { onConflict: "product_id,ingredient_id" },
      );
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  },
};

// =========================================================================
// 7. create_location
// =========================================================================
const createLocation: ToolDef = {
  schema: {
    name: "create_location",
    description:
      "Registra la ubicación del puesto (lat/lng del mensaje de ubicación). OPCIONAL. Habilita turnos por ubicación.",
    input_schema: {
      type: "object",
      properties: {
        lat: { type: "number" },
        lng: { type: "number" },
        name: { type: "string", description: "Opcional. Default 'Puesto principal'." },
        radius_m: { type: "number", description: "Radio en metros para detectar llegada/salida. Default 100." },
      },
      required: ["lat", "lng"],
    },
  },
  handler: async (input, ctx) => {
    const r = requireBusiness(ctx);
    if (!r.ok) return r;
    const supabase = db();
    const { data, error } = await supabase
      .from("locations")
      .insert({
        business_id: r.business.id,
        name: input.name ?? "Puesto principal",
        lat: input.lat,
        lng: input.lng,
        radius_m: input.radius_m ?? 100,
      })
      .select("id, name")
      .single();
    if (error) return { ok: false, error: error.message };
    await supabase
      .from("onboarding_checklist")
      .update({ has_location: true })
      .eq("business_id", r.business.id);
    return { ok: true, data };
  },
};

// =========================================================================
// 8. add_seller
// =========================================================================
const addSeller: ToolDef = {
  schema: {
    name: "add_seller",
    description:
      "Asocia un número de WhatsApp como vendedor del negocio. Crea el user si no existe. Si el dueño se incluye, también pásalo (es válido que sea owner Y seller).",
    input_schema: {
      type: "object",
      properties: {
        phone: { type: "string", description: "Número en cualquier formato (con o sin +57). Se normaliza a E.164." },
        name: { type: "string", description: "Nombre del vendedor si el dueño lo dijo. Opcional." },
      },
      required: ["phone"],
    },
  },
  handler: async (input, ctx) => {
    const r = requireBusiness(ctx);
    if (!r.ok) return r;
    const supabase = db();
    let phoneE164: string;
    try {
      phoneE164 = toE164(input.phone);
    } catch (err) {
      return { ok: false, error: `Número inválido: ${input.phone}` };
    }

    // Upsert user
    const { data: existing } = await supabase.from("users").select("*").eq("phone", phoneE164).maybeSingle();
    let userId: string;
    if (existing) {
      userId = (existing as any).id;
      if (input.name && !(existing as any).name) {
        await supabase.from("users").update({ name: input.name }).eq("id", userId);
      }
    } else {
      const { data: created, error } = await supabase
        .from("users")
        .insert({ phone: phoneE164, name: input.name ?? null })
        .select("id")
        .single();
      if (error) return { ok: false, error: error.message };
      userId = (created as any).id;
    }

    // Crear membership seller (idempotente vía UNIQUE constraint)
    const { error: memErr } = await supabase.from("business_members").upsert(
      { business_id: r.business.id, user_id: userId, role: "seller", active: true },
      { onConflict: "business_id,user_id,role" },
    );
    if (memErr) return { ok: false, error: memErr.message };

    if (!ctx.state.sellerPhones.includes(phoneE164)) ctx.state.sellerPhones.push(phoneE164);

    await supabase
      .from("onboarding_checklist")
      .update({ has_seller: true })
      .eq("business_id", r.business.id);

    return { ok: true, data: { user_id: userId, phone: phoneE164 } };
  },
};

// =========================================================================
// 9. set_payment_methods
// =========================================================================
const setPaymentMethods: ToolDef = {
  schema: {
    name: "set_payment_methods",
    description:
      "Define los métodos de pago que acepta el negocio. Normaliza nombres a canonical: cash, nequi, daviplata, transfer, card, bancolombia. Otros se aceptan tal cual en lowercase.",
    input_schema: {
      type: "object",
      properties: {
        methods: {
          type: "array",
          items: { type: "string" },
          description: "Lista normalizada (ej. ['cash','nequi','daviplata']).",
        },
      },
      required: ["methods"],
    },
  },
  handler: async (input, ctx) => {
    const r = requireBusiness(ctx);
    if (!r.ok) return r;
    const normalized = (input.methods as string[]).map((m) => m.toLowerCase().trim()).filter(Boolean);
    if (normalized.length === 0) return { ok: false, error: "Necesito al menos un método de pago." };
    const supabase = db();
    const { error } = await supabase
      .from("business_settings")
      .update({ accepted_payment_methods: normalized })
      .eq("business_id", r.business.id);
    if (error) return { ok: false, error: error.message };
    await supabase
      .from("onboarding_checklist")
      .update({ has_payment_methods: true })
      .eq("business_id", r.business.id);
    return { ok: true, data: { methods: normalized } };
  },
};

// =========================================================================
// 10. set_report_schedule
// =========================================================================
const setReportSchedule: ToolDef = {
  schema: {
    name: "set_report_schedule",
    description:
      "Cambia los defaults del horario de reportes (diario y semanal). Solo llamar si el dueño explícitamente pide otro horario; los defaults son 06:15 con cutoff 06:00.",
    input_schema: {
      type: "object",
      properties: {
        daily_report_time: { type: "string", description: "Formato HH:mm en hora local del negocio." },
        business_day_cutoff: { type: "string", description: "Formato HH:mm. Marca dónde corta el 'día operativo'." },
        weekly_report_day: { type: "string", enum: ["monday","tuesday","wednesday","thursday","friday","saturday","sunday"] },
        weekly_report_time: { type: "string", description: "Formato HH:mm." },
      },
    },
  },
  handler: async (input, ctx) => {
    const r = requireBusiness(ctx);
    if (!r.ok) return r;
    const update: Record<string, unknown> = {};
    if (input.daily_report_time) update.daily_report_time = input.daily_report_time;
    if (input.business_day_cutoff) update.business_day_cutoff = input.business_day_cutoff;
    if (input.weekly_report_day) update.weekly_report_day = input.weekly_report_day;
    if (input.weekly_report_time) update.weekly_report_time = input.weekly_report_time;
    if (Object.keys(update).length === 0) return { ok: true, data: { changed: false } };
    const { error } = await db().from("business_settings").update(update).eq("business_id", r.business.id);
    if (error) return { ok: false, error: error.message };
    return { ok: true, data: { changed: true, fields: Object.keys(update) } };
  },
};

// =========================================================================
// 11. check_onboarding_status
// =========================================================================
const checkOnboardingStatus: ToolDef = {
  schema: {
    name: "check_onboarding_status",
    description:
      "Devuelve qué falta del checklist mínimo para pasar a producción. Llamar después de cada paso importante para no preguntar cosas que ya están listas.",
    input_schema: { type: "object", properties: {} },
  },
  handler: async (_input, ctx) => {
    const r = requireBusiness(ctx);
    if (!r.ok) return { ok: true, data: { has_business: false, ready_for_production: false } };
    const supabase = db();
    const { data: checklist } = await supabase
      .from("onboarding_checklist")
      .select("*")
      .eq("business_id", r.business.id)
      .single();
    const c = checklist as any;
    const ready = c.has_name && c.has_products && c.has_seller && c.has_payment_methods;
    return {
      ok: true,
      data: {
        has_business: true,
        has_name: c.has_name,
        has_products: c.has_products,
        has_seller: c.has_seller,
        has_payment_methods: c.has_payment_methods,
        has_location: c.has_location,
        has_recipes: c.has_recipes,
        ready_for_production: ready,
      },
    };
  },
};

// =========================================================================
// 12. complete_onboarding
// =========================================================================
const completeOnboarding: ToolDef = {
  schema: {
    name: "complete_onboarding",
    description:
      "Activa el negocio (state='production'). SOLO llamar si check_onboarding_status confirma ready_for_production=true. A partir de aquí los vendedores pueden empezar a reportar ventas.",
    input_schema: { type: "object", properties: {} },
  },
  handler: async (_input, ctx) => {
    const r = requireBusiness(ctx);
    if (!r.ok) return r;
    const supabase = db();

    // Verificar checklist antes de activar
    const { data: checklist } = await supabase
      .from("onboarding_checklist")
      .select("has_name, has_products, has_seller, has_payment_methods")
      .eq("business_id", r.business.id)
      .single();
    const c = checklist as any;
    const ready = c?.has_name && c?.has_products && c?.has_seller && c?.has_payment_methods;
    if (!ready) {
      return {
        ok: false,
        error: "No puedo activar todavía: faltan obligatorios. Llama check_onboarding_status para saber cuáles.",
      };
    }

    const { data: updated, error } = await supabase
      .from("businesses")
      .update({ state: "production", activated_at: new Date().toISOString() })
      .eq("id", r.business.id)
      .select("id, name, state, activated_at")
      .single();
    if (error) return { ok: false, error: error.message };
    await supabase
      .from("onboarding_checklist")
      .update({ completed_at: new Date().toISOString() })
      .eq("business_id", r.business.id);

    // Lista de sellers para el mensaje final
    const { data: sellers } = await supabase
      .from("business_members")
      .select("user:users(phone, name)")
      .eq("business_id", r.business.id)
      .eq("role", "seller")
      .eq("active", true);
    const sellerInfo = (sellers ?? []).map((s: any) => ({
      phone: s.user.phone,
      name: s.user.name,
    }));

    return { ok: true, data: { business: updated, sellers: sellerInfo } };
  },
};

// =========================================================================
// Registry
// =========================================================================
export const ONBOARDING_TOOLS: Record<string, ToolDef> = {
  upsert_business_info: upsertBusinessInfo,
  create_product: createProduct,
  set_combo_composition: setComboComposition,
  create_ingredient: createIngredient,
  propose_recipes: proposeRecipes,
  update_recipe: updateRecipe,
  create_location: createLocation,
  add_seller: addSeller,
  set_payment_methods: setPaymentMethods,
  set_report_schedule: setReportSchedule,
  check_onboarding_status: checkOnboardingStatus,
  complete_onboarding: completeOnboarding,
};

export function onboardingToolSchemas() {
  return Object.values(ONBOARDING_TOOLS).map((t) => t.schema);
}

export async function executeOnboardingTool(
  name: string,
  input: any,
  ctx: OnboardingToolCtx,
): Promise<ToolResult> {
  const tool = ONBOARDING_TOOLS[name];
  if (!tool) return { ok: false, error: `Tool desconocida: ${name}` };
  try {
    return await tool.handler(input, ctx);
  } catch (err) {
    log.error("tool_handler_threw", { name, err: String(err) });
    return { ok: false, error: String(err) };
  }
}
