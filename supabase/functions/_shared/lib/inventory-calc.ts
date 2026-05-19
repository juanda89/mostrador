// Algoritmo de deducción de inventario al registrar una venta.
// Regla crítica #1 del spec (§11) y PRD §9.4. Recursivo: combos → componentes → ingredientes.
//
// Esta función es pura sobre los datos que recibe; el caller hace fetch + transacción.

export interface ProductLike {
  id: string;
  is_composite: boolean;
}

export interface ComponentLink {
  parent_product_id: string;
  child_product_id: string;
  qty: number;
}

export interface RecipeLink {
  product_id: string;
  ingredient_id: string;
  qty_per_unit: number;
}

export interface SaleItemInput {
  product_id: string;
  qty: number;
}

export interface IngredientUsage {
  ingredient_id: string;
  qty: number;
}

/**
 * Calcula el consumo agregado de ingredientes para una lista de sale_items.
 *
 * @param items Items vendidos: { product_id, qty }
 * @param products Mapa de productos (por id) — debe incluir todos los componentes referenciados
 * @param components Lista de product_components del negocio
 * @param recipes Lista de product_recipes del negocio
 */
export function computeIngredientUsage(
  items: SaleItemInput[],
  products: Map<string, ProductLike>,
  components: ComponentLink[],
  recipes: RecipeLink[],
): IngredientUsage[] {
  const componentsByParent = new Map<string, ComponentLink[]>();
  for (const c of components) {
    const arr = componentsByParent.get(c.parent_product_id) ?? [];
    arr.push(c);
    componentsByParent.set(c.parent_product_id, arr);
  }

  const recipesByProduct = new Map<string, RecipeLink[]>();
  for (const r of recipes) {
    const arr = recipesByProduct.get(r.product_id) ?? [];
    arr.push(r);
    recipesByProduct.set(r.product_id, arr);
  }

  const usage = new Map<string, number>(); // ingredient_id → qty acumulada

  for (const item of items) {
    accumulate(item.product_id, item.qty, products, componentsByParent, recipesByProduct, usage);
  }

  return Array.from(usage.entries()).map(([ingredient_id, qty]) => ({ ingredient_id, qty }));
}

function accumulate(
  productId: string,
  qty: number,
  products: Map<string, ProductLike>,
  componentsByParent: Map<string, ComponentLink[]>,
  recipesByProduct: Map<string, RecipeLink[]>,
  usage: Map<string, number>,
): void {
  const product = products.get(productId);
  if (!product) {
    // Producto no encontrado: el caller debería haber validado. Saltamos silencioso
    // para no corromper inventario por un dato faltante.
    return;
  }

  if (product.is_composite) {
    // Expandir a sus componentes. V1: los combos NO se componen de otros combos
    // (regla D-01 del PRD); aún así soportamos recursión por si V2 lo habilita.
    const children = componentsByParent.get(productId) ?? [];
    for (const c of children) {
      accumulate(c.child_product_id, qty * c.qty, products, componentsByParent, recipesByProduct, usage);
    }
    return;
  }

  // Producto simple: aplicar receta.
  const recipe = recipesByProduct.get(productId) ?? [];
  for (const r of recipe) {
    usage.set(r.ingredient_id, (usage.get(r.ingredient_id) ?? 0) + qty * r.qty_per_unit);
  }
  // Si no hay receta → no se deduce inventario para este producto (válido).
}
