// Helper de checklist: lee onboarding_checklist + datos derivados (counts).

import { db } from "../../lib/supabase.ts";

export interface ChecklistSnapshot {
  has_name: boolean;
  has_products: boolean;
  has_seller: boolean;
  has_payment_methods: boolean;
  has_location: boolean;
  has_report_schedule: boolean;
  has_recipes: boolean;
  has_initial_inventory: boolean;
  productCount: number;
  sellerCount: number;
  hasAnyRecipe: boolean;
  readyForProduction: boolean;
}

export async function loadChecklistSnapshot(businessId: string): Promise<ChecklistSnapshot | null> {
  const supabase = db();

  const { data: checklist } = await supabase
    .from("onboarding_checklist")
    .select("*")
    .eq("business_id", businessId)
    .maybeSingle();
  if (!checklist) return null;

  const c = checklist as any;

  // Conteos en paralelo
  const [productsRes, sellersRes, recipesRes] = await Promise.all([
    supabase
      .from("products")
      .select("id", { count: "exact", head: true })
      .eq("business_id", businessId)
      .eq("active", true),
    supabase
      .from("business_members")
      .select("id", { count: "exact", head: true })
      .eq("business_id", businessId)
      .eq("role", "seller")
      .eq("active", true),
    supabase
      .from("product_recipes")
      .select("id, product:products!inner(business_id)", { count: "exact", head: true })
      .eq("product.business_id", businessId),
  ]);

  const productCount = productsRes.count ?? 0;
  const sellerCount = sellersRes.count ?? 0;
  const recipeCount = recipesRes.count ?? 0;

  const readyForProduction =
    !!c.has_name && !!c.has_products && !!c.has_seller && !!c.has_payment_methods;

  return {
    has_name: !!c.has_name,
    has_products: !!c.has_products,
    has_seller: !!c.has_seller,
    has_payment_methods: !!c.has_payment_methods,
    has_location: !!c.has_location,
    has_report_schedule: !!c.has_report_schedule,
    has_recipes: !!c.has_recipes,
    has_initial_inventory: !!c.has_initial_inventory,
    productCount,
    sellerCount,
    hasAnyRecipe: recipeCount > 0,
    readyForProduction,
  };
}
