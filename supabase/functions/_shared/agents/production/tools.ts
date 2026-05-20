// Tools del production agent (Sonnet 4.6).
// Cada tool valida el rol (owner/seller) y opera sobre el business en producción.

import { db } from "../../lib/supabase.ts";
import { log } from "../../lib/log.ts";
import { toE164 } from "../../lib/phone.ts";
import { matchPaymentMethod } from "../../lib/fuzzy.ts";
import { computeIngredientUsage } from "../../lib/inventory-calc.ts";
import type { Business, User } from "../../types/domain.ts";

export interface ProductionToolCtx {
  user: User;
  business: Business;
  role: "owner" | "seller";
  /** ID del mensaje inbound actual (para idempotencia). */
  inboundMessageId: string;
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
  handler: (input: any, ctx: ProductionToolCtx) => Promise<ToolResult>;
  /** Roles que pueden invocar esta tool. */
  allowedRoles: Array<"owner" | "seller">;
}

// =========================================================================
// HELPERS
// =========================================================================

async function findProductByName(
  businessId: string,
  name: string,
): Promise<{ id: string; name: string; price: number; is_composite: boolean; active: boolean } | null> {
  const { data } = await db()
    .from("products")
    .select("id, name, price, is_composite, active")
    .eq("business_id", businessId)
    .ilike("name", name.trim())
    .maybeSingle();
  // deno-lint-ignore no-explicit-any
  return data as any ?? null;
}

async function findIngredientByName(
  businessId: string,
  name: string,
): Promise<{ id: string; name: string; unit: string; current_stock: number } | null> {
  const { data } = await db()
    .from("ingredients")
    .select("id, name, unit, current_stock")
    .eq("business_id", businessId)
    .ilike("name", name.trim())
    .maybeSingle();
  // deno-lint-ignore no-explicit-any
  return data as any ?? null;
}

// =========================================================================
// 1. register_sale  (core del producto)
// =========================================================================
const registerSale: ToolDef = {
  allowedRoles: ["owner", "seller"],
  schema: {
    name: "register_sale",
    description:
      "Registra una venta del negocio. Acepta uno o varios productos. Calcula totales, deduce inventario (incluyendo combos recursivamente), y persiste. Idempotente por source_message_id: si el mismo mensaje del usuario llega dos veces, NO duplica.",
    input_schema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              product_name: { type: "string", description: "Nombre del producto tal como existe en el catálogo (puedes usar variación case-insensitive)." },
              qty: { type: "number", description: "Cantidad vendida. Default 1." },
            },
            required: ["product_name"],
          },
        },
        payment_method: {
          type: "string",
          description: "Método de pago según el dueño (efectivo, nequi, daviplata, etc). Si no estás seguro, igual pásalo y la tool lo normaliza/valida.",
        },
        notes: { type: "string", description: "Notas opcionales del vendedor." },
      },
      required: ["items", "payment_method"],
    },
  },
  handler: async (input, ctx) => {
    const supabase = db();

    // Idempotencia: si ya hay una venta con este source_message_id, devolverla.
    const { data: existing } = await supabase
      .from("sales")
      .select("id, total, payment_method")
      .eq("source_message_id", ctx.inboundMessageId)
      .maybeSingle();
    if (existing) {
      log.info("register_sale_idempotent_hit", { sale_id: (existing as any).id });
      return { ok: true, data: { sale: existing, _existed: true } };
    }

    // Validar método de pago contra los aceptados del negocio.
    const { data: settings } = await supabase
      .from("business_settings")
      .select("accepted_payment_methods")
      .eq("business_id", ctx.business.id)
      .maybeSingle();
    const accepted = (settings as any)?.accepted_payment_methods ?? [];
    const pmMatch = matchPaymentMethod(input.payment_method, accepted);
    if (!pmMatch.match) {
      return {
        ok: false,
        error: `Método de pago "${input.payment_method}" no reconocido. Métodos aceptados: ${accepted.join(", ")}. Pregúntale al usuario cuál usar.`,
      };
    }
    const paymentMethod = pmMatch.match;

    // Resolver productos.
    const itemsResolved: Array<{ product_id: string; product_name: string; qty: number; unit_price: number; subtotal: number; is_composite: boolean }> = [];
    for (const it of input.items as Array<{ product_name: string; qty?: number }>) {
      const p = await findProductByName(ctx.business.id, it.product_name);
      if (!p) {
        return {
          ok: false,
          error: `Producto "${it.product_name}" no existe en el catálogo. NO lo crees automáticamente; primero pregúntale al usuario.`,
        };
      }
      if (!p.active) {
        return {
          ok: false,
          error: `Producto "${p.name}" está desactivado.`,
        };
      }
      const qty = it.qty ?? 1;
      const subtotal = Number(p.price) * qty;
      itemsResolved.push({
        product_id: p.id,
        product_name: p.name,
        qty,
        unit_price: Number(p.price),
        subtotal,
        is_composite: p.is_composite,
      });
    }

    const total = itemsResolved.reduce((s, it) => s + it.subtotal, 0);

    // Crear sale
    const { data: sale, error: saleErr } = await supabase
      .from("sales")
      .insert({
        business_id: ctx.business.id,
        seller_user_id: ctx.user.id,
        location_id: null,
        shift_id: null,
        total,
        payment_method: paymentMethod,
        status: "active",
        source_message_id: ctx.inboundMessageId,
        sold_at: new Date().toISOString(),
      })
      .select("id, total, payment_method, sold_at")
      .single();
    if (saleErr) return { ok: false, error: `No pude guardar la venta: ${saleErr.message}` };

    // Crear sale_items
    for (const it of itemsResolved) {
      const { error: itErr } = await supabase.from("sale_items").insert({
        sale_id: (sale as any).id,
        product_id: it.product_id,
        qty: it.qty,
        unit_price: it.unit_price,
        subtotal: it.subtotal,
      });
      if (itErr) return { ok: false, error: `No pude guardar item: ${itErr.message}` };
    }

    // Deducción recursiva de inventario.
    const { data: allProducts } = await supabase
      .from("products")
      .select("id, is_composite")
      .eq("business_id", ctx.business.id);
    const { data: allComponents } = await supabase
      .from("product_components")
      .select("parent_product_id, child_product_id, qty");
    const { data: allRecipes } = await supabase
      .from("product_recipes")
      .select("product_id, ingredient_id, qty_per_unit");

    const productsMap = new Map<string, { id: string; is_composite: boolean }>();
    for (const p of (allProducts ?? []) as any[]) productsMap.set(p.id, p);

    const usage = computeIngredientUsage(
      itemsResolved.map((it) => ({ product_id: it.product_id, qty: it.qty })),
      productsMap,
      (allComponents ?? []) as any,
      (allRecipes ?? []) as any,
    );

    // Aplicar movements a inventario
    const lowStockAlerts: Array<{ name: string; unit: string; remaining: number }> = [];
    for (const u of usage) {
      const ing = await supabase
        .from("ingredients")
        .select("name, unit, current_stock, reorder_threshold")
        .eq("id", u.ingredient_id)
        .maybeSingle();
      if (!ing.data) continue;
      const newBalance = Number((ing.data as any).current_stock) - u.qty;
      await supabase.from("inventory_movements").insert({
        business_id: ctx.business.id,
        ingredient_id: u.ingredient_id,
        type: "consumption",
        qty_delta: -u.qty,
        balance_after: newBalance,
        related_sale_id: (sale as any).id,
      });
      await supabase
        .from("ingredients")
        .update({ current_stock: newBalance })
        .eq("id", u.ingredient_id);
      // Stock bajo: < 20% del threshold o menos de 5 unidades
      const thr = (ing.data as any).reorder_threshold;
      if (thr !== null && newBalance < Number(thr)) {
        lowStockAlerts.push({
          name: (ing.data as any).name,
          unit: (ing.data as any).unit,
          remaining: newBalance,
        });
      }
    }

    return {
      ok: true,
      data: {
        sale_id: (sale as any).id,
        total,
        payment_method: paymentMethod,
        items: itemsResolved.map((it) => ({
          name: it.product_name,
          qty: it.qty,
          subtotal: it.subtotal,
        })),
        low_stock_alerts: lowStockAlerts,
      },
    };
  },
};

// =========================================================================
// 2. query_inventory
// =========================================================================
const queryInventory: ToolDef = {
  allowedRoles: ["owner", "seller"],
  schema: {
    name: "query_inventory",
    description: "Devuelve el stock actual de un ingrediente específico o de todos. Si ingredient_name está vacío, devuelve todos.",
    input_schema: {
      type: "object",
      properties: {
        ingredient_name: { type: "string", description: "Opcional. Si vacío, devuelve todo el inventario." },
      },
    },
  },
  handler: async (input, ctx) => {
    const supabase = db();
    let query = supabase
      .from("ingredients")
      .select("name, unit, current_stock, reorder_threshold, last_unit_cost")
      .eq("business_id", ctx.business.id);
    if (input.ingredient_name) {
      query = query.ilike("name", input.ingredient_name.trim());
    }
    const { data, error } = await query;
    if (error) return { ok: false, error: error.message };
    return { ok: true, data: { ingredients: data ?? [] } };
  },
};

// =========================================================================
// 3. list_catalog
// =========================================================================
const listCatalog: ToolDef = {
  allowedRoles: ["owner", "seller"],
  schema: {
    name: "list_catalog",
    description: "Devuelve el catálogo activo de productos del negocio con precios y si son combos.",
    input_schema: { type: "object", properties: {} },
  },
  handler: async (_input, ctx) => {
    const { data, error } = await db()
      .from("products")
      .select("name, price, is_composite")
      .eq("business_id", ctx.business.id)
      .eq("active", true)
      .order("created_at");
    if (error) return { ok: false, error: error.message };
    return { ok: true, data: { products: data ?? [] } };
  },
};

// =========================================================================
// 4. update_product  (owner only)
// =========================================================================
const updateProduct: ToolDef = {
  allowedRoles: ["owner"],
  schema: {
    name: "update_product",
    description: "Modifica un producto existente: precio, nombre, o lo desactiva (active=false).",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Nombre actual del producto en el catálogo." },
        new_price: { type: "number" },
        new_name: { type: "string" },
        active: { type: "boolean", description: "false para desactivar (soft-delete). true para reactivar." },
      },
      required: ["name"],
    },
  },
  handler: async (input, ctx) => {
    const product = await findProductByName(ctx.business.id, input.name);
    if (!product) return { ok: false, error: `Producto "${input.name}" no encontrado.` };
    const update: Record<string, unknown> = {};
    if (input.new_price !== undefined) update.price = input.new_price;
    if (input.new_name !== undefined) update.name = input.new_name.trim();
    if (input.active !== undefined) update.active = input.active;
    if (Object.keys(update).length === 0) return { ok: false, error: "No me dijiste qué cambiar." };
    const { error } = await db().from("products").update(update).eq("id", product.id);
    if (error) return { ok: false, error: error.message };
    return { ok: true, data: { product_id: product.id, updated: update } };
  },
};

// =========================================================================
// 5. create_product  (owner only — para agregar productos en producción)
// =========================================================================
const createProduct: ToolDef = {
  allowedRoles: ["owner"],
  schema: {
    name: "create_product",
    description: "Agrega un producto nuevo al catálogo durante producción. Idempotente por nombre.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        price: { type: "number" },
        is_composite: { type: "boolean" },
      },
      required: ["name", "price"],
    },
  },
  handler: async (input, ctx) => {
    if (typeof input.price !== "number" || input.price < 0) {
      return { ok: false, error: "Precio inválido (debe ser ≥ 0)." };
    }
    const supabase = db();
    const existing = await findProductByName(ctx.business.id, input.name);
    if (existing) {
      // Idempotente: actualizar precio si difiere
      if (Number(existing.price) !== input.price) {
        await supabase.from("products").update({ price: input.price }).eq("id", existing.id);
      }
      return { ok: true, data: { product_id: existing.id, name: existing.name, price: input.price, _existed: true } };
    }
    const { data, error } = await supabase
      .from("products")
      .insert({
        business_id: ctx.business.id,
        name: input.name.trim(),
        price: input.price,
        is_composite: input.is_composite ?? false,
      })
      .select("id, name, price, is_composite")
      .single();
    if (error) return { ok: false, error: error.message };
    return { ok: true, data };
  },
};

// =========================================================================
// 6. add_seller  (owner only)
// =========================================================================
const addSeller: ToolDef = {
  allowedRoles: ["owner"],
  schema: {
    name: "add_seller",
    description: "Asocia un número de WhatsApp como vendedor del negocio. Crea el user si no existe. Idempotente.",
    input_schema: {
      type: "object",
      properties: {
        phone: { type: "string" },
        name: { type: "string" },
      },
      required: ["phone"],
    },
  },
  handler: async (input, ctx) => {
    const supabase = db();
    let phoneE164: string;
    try {
      phoneE164 = toE164(input.phone);
    } catch {
      return { ok: false, error: `Número inválido: ${input.phone}` };
    }
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
    await supabase.from("business_members").upsert(
      { business_id: ctx.business.id, user_id: userId, role: "seller", active: true },
      { onConflict: "business_id,user_id,role" },
    );
    return { ok: true, data: { user_id: userId, phone: phoneE164 } };
  },
};

// =========================================================================
// 7. remove_seller  (owner only)
// =========================================================================
const removeSeller: ToolDef = {
  allowedRoles: ["owner"],
  schema: {
    name: "remove_seller",
    description: "Desactiva (active=false) la membresía como seller de un número. No borra el usuario.",
    input_schema: {
      type: "object",
      properties: { phone: { type: "string" } },
      required: ["phone"],
    },
  },
  handler: async (input, ctx) => {
    let phoneE164: string;
    try {
      phoneE164 = toE164(input.phone);
    } catch {
      return { ok: false, error: `Número inválido: ${input.phone}` };
    }
    const supabase = db();
    const { data: user } = await supabase.from("users").select("id").eq("phone", phoneE164).maybeSingle();
    if (!user) return { ok: false, error: `No encontré un usuario con ${phoneE164}.` };
    const { error } = await supabase
      .from("business_members")
      .update({ active: false })
      .eq("business_id", ctx.business.id)
      .eq("user_id", (user as any).id)
      .eq("role", "seller");
    if (error) return { ok: false, error: error.message };
    return { ok: true, data: { phone: phoneE164 } };
  },
};

// =========================================================================
// 8. update_payment_methods  (owner only)
// =========================================================================
const updatePaymentMethods: ToolDef = {
  allowedRoles: ["owner"],
  schema: {
    name: "update_payment_methods",
    description: "Reemplaza la lista de métodos de pago aceptados. Normaliza a canonical (cash, nequi, daviplata, transfer, card, bancolombia).",
    input_schema: {
      type: "object",
      properties: {
        methods: { type: "array", items: { type: "string" } },
      },
      required: ["methods"],
    },
  },
  handler: async (input, ctx) => {
    const methods = (input.methods as string[]).map((m) => m.toLowerCase().trim()).filter(Boolean);
    if (methods.length === 0) return { ok: false, error: "Necesito al menos un método." };
    const { error } = await db()
      .from("business_settings")
      .update({ accepted_payment_methods: methods })
      .eq("business_id", ctx.business.id);
    if (error) return { ok: false, error: error.message };
    return { ok: true, data: { methods } };
  },
};

// =========================================================================
// 9. update_recipe  (owner only — reusa lógica del onboarding)
// =========================================================================
const updateRecipe: ToolDef = {
  allowedRoles: ["owner"],
  schema: {
    name: "update_recipe",
    description: "Ajusta la cantidad de un ingrediente en la receta de un producto. Devuelve la receta completa post-update + el valor anterior.",
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
    const supabase = db();
    const product = await findProductByName(ctx.business.id, input.product_name);
    if (!product) return { ok: false, error: `No encontré el producto "${input.product_name}".` };
    const ingredient = await findIngredientByName(ctx.business.id, input.ingredient_name);
    if (!ingredient) return { ok: false, error: `No encontré el ingrediente "${input.ingredient_name}".` };
    const { data: prev } = await supabase
      .from("product_recipes")
      .select("qty_per_unit")
      .eq("product_id", product.id)
      .eq("ingredient_id", ingredient.id)
      .maybeSingle();
    const previous_qty = prev ? Number((prev as any).qty_per_unit) : null;
    const { error } = await supabase
      .from("product_recipes")
      .upsert(
        { product_id: product.id, ingredient_id: ingredient.id, qty_per_unit: input.qty_per_unit },
        { onConflict: "product_id,ingredient_id" },
      );
    if (error) return { ok: false, error: error.message };
    const { data: full } = await supabase
      .from("product_recipes")
      .select("qty_per_unit, ingredient:ingredients(name, unit)")
      .eq("product_id", product.id);
    return {
      ok: true,
      data: {
        product_name: product.name,
        changed_ingredient: ingredient.name,
        new_qty: input.qty_per_unit,
        previous_qty,
        recipe: (full ?? []).map((r: any) => ({
          name: r.ingredient?.name,
          unit: r.ingredient?.unit,
          qty_per_unit: Number(r.qty_per_unit),
        })),
      },
    };
  },
};

// =========================================================================
// 10. correct_last_sale  (vendedor + dueño)
// =========================================================================
const correctLastSale: ToolDef = {
  allowedRoles: ["owner", "seller"],
  schema: {
    name: "correct_last_sale",
    description: "Modifica la última venta o la penúltima registrada por el MISMO usuario que está hablando. Solo cambios a items o payment_method.",
    input_schema: {
      type: "object",
      properties: {
        position: { type: "string", enum: ["last", "second_to_last"], description: "Cuál de las últimas 2 corregir. Default 'last'." },
        new_items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              product_name: { type: "string" },
              qty: { type: "number" },
            },
            required: ["product_name"],
          },
        },
        new_payment_method: { type: "string" },
        reason: { type: "string" },
      },
    },
  },
  handler: async (input, ctx) => {
    const supabase = db();
    const position = input.position ?? "last";
    const offset = position === "last" ? 0 : 1;

    const { data: lastSales } = await supabase
      .from("sales")
      .select("id, total, payment_method, sold_at, status")
      .eq("business_id", ctx.business.id)
      .eq("seller_user_id", ctx.user.id)
      .eq("status", "active")
      .order("sold_at", { ascending: false })
      .limit(2);
    const sale = lastSales?.[offset] as any;
    if (!sale) return { ok: false, error: `No tienes una ${position === "last" ? "última" : "penúltima"} venta para corregir.` };

    // Cargar items previos para snapshot
    const { data: prevItems } = await supabase
      .from("sale_items")
      .select("product_id, qty, unit_price, subtotal, products(name)")
      .eq("sale_id", sale.id);
    const beforeSnapshot = {
      total: sale.total,
      payment_method: sale.payment_method,
      items: prevItems,
    };

    const update: Record<string, unknown> = {};

    // Cambio de payment method
    if (input.new_payment_method) {
      const { data: settings } = await supabase
        .from("business_settings")
        .select("accepted_payment_methods")
        .eq("business_id", ctx.business.id)
        .maybeSingle();
      const accepted = (settings as any)?.accepted_payment_methods ?? [];
      const pm = matchPaymentMethod(input.new_payment_method, accepted);
      if (!pm.match) return { ok: false, error: `Método "${input.new_payment_method}" no reconocido.` };
      update.payment_method = pm.match;
    }

    // Cambio de items: re-crear sale_items, recalcular total, ajustar inventario
    if (input.new_items && input.new_items.length > 0) {
      // 1. Revertir consumo previo (sumar de vuelta al stock)
      const { data: prevMovements } = await supabase
        .from("inventory_movements")
        .select("ingredient_id, qty_delta")
        .eq("related_sale_id", sale.id);
      for (const m of (prevMovements ?? []) as any[]) {
        // qty_delta es negativo (consumption); revertir = sumar el abs
        const reverseAmount = -Number(m.qty_delta);
        const { data: ing } = await supabase
          .from("ingredients")
          .select("current_stock")
          .eq("id", m.ingredient_id)
          .maybeSingle();
        if (ing) {
          const newStock = Number((ing as any).current_stock) + reverseAmount;
          await supabase.from("ingredients").update({ current_stock: newStock }).eq("id", m.ingredient_id);
          await supabase.from("inventory_movements").insert({
            business_id: ctx.business.id,
            ingredient_id: m.ingredient_id,
            type: "correction",
            qty_delta: reverseAmount,
            balance_after: newStock,
            related_sale_id: sale.id,
            notes: "Reversión por corrección de venta",
          });
        }
      }

      // 2. Borrar sale_items viejos
      await supabase.from("sale_items").delete().eq("sale_id", sale.id);

      // 3. Resolver nuevos items
      const newItemsResolved: Array<{ product_id: string; qty: number; unit_price: number; subtotal: number; is_composite: boolean }> = [];
      for (const it of input.new_items as any[]) {
        const p = await findProductByName(ctx.business.id, it.product_name);
        if (!p) return { ok: false, error: `Producto "${it.product_name}" no existe.` };
        const qty = it.qty ?? 1;
        newItemsResolved.push({
          product_id: p.id,
          qty,
          unit_price: Number(p.price),
          subtotal: Number(p.price) * qty,
          is_composite: p.is_composite,
        });
      }
      const newTotal = newItemsResolved.reduce((s, it) => s + it.subtotal, 0);

      // 4. Insertar sale_items nuevos
      for (const it of newItemsResolved) {
        await supabase.from("sale_items").insert({
          sale_id: sale.id,
          product_id: it.product_id,
          qty: it.qty,
          unit_price: it.unit_price,
          subtotal: it.subtotal,
        });
      }
      update.total = newTotal;

      // 5. Re-deducir inventario con los items nuevos
      const { data: allProducts } = await supabase
        .from("products")
        .select("id, is_composite")
        .eq("business_id", ctx.business.id);
      const { data: allComponents } = await supabase
        .from("product_components")
        .select("parent_product_id, child_product_id, qty");
      const { data: allRecipes } = await supabase
        .from("product_recipes")
        .select("product_id, ingredient_id, qty_per_unit");
      const productsMap = new Map<string, { id: string; is_composite: boolean }>();
      for (const p of (allProducts ?? []) as any[]) productsMap.set(p.id, p);
      const usage = computeIngredientUsage(
        newItemsResolved.map((it) => ({ product_id: it.product_id, qty: it.qty })),
        productsMap,
        (allComponents ?? []) as any,
        (allRecipes ?? []) as any,
      );
      for (const u of usage) {
        const { data: ing } = await supabase
          .from("ingredients")
          .select("current_stock")
          .eq("id", u.ingredient_id)
          .maybeSingle();
        if (!ing) continue;
        const newBalance = Number((ing as any).current_stock) - u.qty;
        await supabase.from("inventory_movements").insert({
          business_id: ctx.business.id,
          ingredient_id: u.ingredient_id,
          type: "consumption",
          qty_delta: -u.qty,
          balance_after: newBalance,
          related_sale_id: sale.id,
          notes: "Re-consumo post corrección",
        });
        await supabase.from("ingredients").update({ current_stock: newBalance }).eq("id", u.ingredient_id);
      }
    }

    // Aplicar update a la venta
    if (Object.keys(update).length > 0) {
      await supabase.from("sales").update(update).eq("id", sale.id);
    }

    // Audit
    await supabase.from("sale_corrections").insert({
      sale_id: sale.id,
      corrected_by_user_id: ctx.user.id,
      before_snapshot: beforeSnapshot,
      after_snapshot: { ...beforeSnapshot, ...update, items: input.new_items },
      reason: input.reason ?? null,
      source_message_id: ctx.inboundMessageId,
    });

    // Marcar la venta como corregida
    await supabase.from("sales").update({ status: "corrected" }).eq("id", sale.id);

    return {
      ok: true,
      data: { sale_id: sale.id, before: beforeSnapshot, after: { ...beforeSnapshot, ...update, items: input.new_items } },
    };
  },
};

// =========================================================================
// Registry
// =========================================================================
export const PRODUCTION_TOOLS: Record<string, ToolDef> = {
  register_sale: registerSale,
  correct_last_sale: correctLastSale,
  query_inventory: queryInventory,
  list_catalog: listCatalog,
  update_product: updateProduct,
  create_product: createProduct,
  add_seller: addSeller,
  remove_seller: removeSeller,
  update_payment_methods: updatePaymentMethods,
  update_recipe: updateRecipe,
};

export function productionToolSchemas(role: "owner" | "seller") {
  return Object.values(PRODUCTION_TOOLS)
    .filter((t) => t.allowedRoles.includes(role))
    .map((t) => t.schema);
}

export async function executeProductionTool(
  name: string,
  input: any,
  ctx: ProductionToolCtx,
): Promise<ToolResult> {
  const tool = PRODUCTION_TOOLS[name];
  if (!tool) return { ok: false, error: `Tool desconocida: ${name}` };
  if (!tool.allowedRoles.includes(ctx.role)) {
    return {
      ok: false,
      error: `Solo el dueño puede ejecutar "${name}". El vendedor no tiene permiso.`,
    };
  }
  try {
    return await tool.handler(input, ctx);
  } catch (err) {
    log.error("production_tool_threw", { name, err: String(err) });
    return { ok: false, error: String(err) };
  }
}
