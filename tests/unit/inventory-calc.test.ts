// Tests del algoritmo de deducción recursiva de inventario.
// Regla crítica #1 del spec — tener tests es obligatorio.

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  computeIngredientUsage,
  type ComponentLink,
  type ProductLike,
  type RecipeLink,
  type SaleItemInput,
} from "../../supabase/functions/_shared/lib/inventory-calc.ts";

function fixtures() {
  // Empanadas Doña Mary: dos productos simples + un combo.
  const products = new Map<string, ProductLike>([
    ["emp-carne", { id: "emp-carne", is_composite: false }],
    ["gaseosa", { id: "gaseosa", is_composite: false }],
    ["combo", { id: "combo", is_composite: true }],
  ]);

  const components: ComponentLink[] = [
    { parent_product_id: "combo", child_product_id: "emp-carne", qty: 2 },
    { parent_product_id: "combo", child_product_id: "gaseosa", qty: 1 },
  ];

  const recipes: RecipeLink[] = [
    { product_id: "emp-carne", ingredient_id: "carne", qty_per_unit: 0.080 },
    { product_id: "emp-carne", ingredient_id: "masa", qty_per_unit: 0.050 },
    // Gaseosa NO tiene receta a propósito → no consume inventario.
  ];

  return { products, components, recipes };
}

Deno.test("producto simple con receta deduce ingredientes proporcionalmente", () => {
  const { products, components, recipes } = fixtures();
  const items: SaleItemInput[] = [{ product_id: "emp-carne", qty: 3 }];
  const usage = computeIngredientUsage(items, products, components, recipes);
  // 3 × 80g = 240g carne, 3 × 50g = 150g masa
  assertEquals(sortById(usage), sortById([
    { ingredient_id: "carne", qty: 0.240 },
    { ingredient_id: "masa", qty: 0.150 },
  ]));
});

Deno.test("combo se desagrega recursivamente y suma a sus componentes", () => {
  const { products, components, recipes } = fixtures();
  // 1 combo = 2 empanadas + 1 gaseosa
  // → 2×80g carne, 2×50g masa, 0 gaseosa
  const items: SaleItemInput[] = [{ product_id: "combo", qty: 1 }];
  const usage = computeIngredientUsage(items, products, components, recipes);
  assertEquals(sortById(usage), sortById([
    { ingredient_id: "carne", qty: 0.160 },
    { ingredient_id: "masa", qty: 0.100 },
  ]));
});

Deno.test("combos y simples en la misma venta acumulan en los mismos ingredientes", () => {
  const { products, components, recipes } = fixtures();
  // 1 combo (= 2 empanadas + 1 gaseosa) + 1 empanada suelta
  // → carne: 2×80 + 1×80 = 240g, masa: 2×50 + 1×50 = 150g
  const items: SaleItemInput[] = [
    { product_id: "combo", qty: 1 },
    { product_id: "emp-carne", qty: 1 },
  ];
  const usage = computeIngredientUsage(items, products, components, recipes);
  assertEquals(sortById(usage), sortById([
    { ingredient_id: "carne", qty: 0.240 },
    { ingredient_id: "masa", qty: 0.150 },
  ]));
});

Deno.test("producto simple sin receta no genera movimientos (válido, no error)", () => {
  const { products, components, recipes } = fixtures();
  const items: SaleItemInput[] = [{ product_id: "gaseosa", qty: 5 }];
  const usage = computeIngredientUsage(items, products, components, recipes);
  assertEquals(usage, []);
});

Deno.test("producto inexistente se ignora silenciosamente (caller debió validar)", () => {
  const { products, components, recipes } = fixtures();
  const items: SaleItemInput[] = [{ product_id: "unknown", qty: 99 }];
  const usage = computeIngredientUsage(items, products, components, recipes);
  assertEquals(usage, []);
});

Deno.test("qty fraccional se respeta", () => {
  const { products, components, recipes } = fixtures();
  const items: SaleItemInput[] = [{ product_id: "emp-carne", qty: 0.5 }];
  const usage = computeIngredientUsage(items, products, components, recipes);
  assertEquals(sortById(usage), sortById([
    { ingredient_id: "carne", qty: 0.040 },
    { ingredient_id: "masa", qty: 0.025 },
  ]));
});

function sortById<T extends { ingredient_id: string }>(arr: T[]): T[] {
  return [...arr].sort((a, b) => a.ingredient_id.localeCompare(b.ingredient_id));
}
