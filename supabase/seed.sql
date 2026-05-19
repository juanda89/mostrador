-- =========================================================
-- Seed para desarrollo local.
-- Crea un negocio de prueba en estado PRODUCCIÓN para iterar
-- sobre los agentes sin tener que correr onboarding cada vez.
-- =========================================================

-- 1. Usuario dueño y vendedor.
INSERT INTO users (id, phone, name) VALUES
  ('11111111-1111-1111-1111-111111111111', '+573001112222', 'María (dueña test)'),
  ('22222222-2222-2222-2222-222222222222', '+573003334444', 'Jhon (vendedor test)');

-- 2. Negocio activo.
INSERT INTO businesses (id, name, owner_user_id, timezone, currency, state, activated_at) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Empanadas Doña Mary (TEST)',
   '11111111-1111-1111-1111-111111111111', 'America/Bogota', 'COP', 'production', now());

-- 3. Membresías.
INSERT INTO business_members (business_id, user_id, role) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'owner'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'seller'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '22222222-2222-2222-2222-222222222222', 'seller');

-- 4. Settings (defaults explícitos).
INSERT INTO business_settings (business_id, accepted_payment_methods) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '["cash","nequi","daviplata"]'::jsonb);

-- 5. Ubicación.
INSERT INTO locations (id, business_id, name, lat, lng) VALUES
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'Puesto principal', 6.2442, -75.5812);

-- 6. Productos simples + combo.
INSERT INTO products (id, business_id, name, price, is_composite) VALUES
  ('p0000001-0000-0000-0000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Empanada de carne',  3000, FALSE),
  ('p0000002-0000-0000-0000-000000000002', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Empanada de pollo',  3000, FALSE),
  ('p0000003-0000-0000-0000-000000000003', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Empanada de queso',  2500, FALSE),
  ('p0000004-0000-0000-0000-000000000004', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Gaseosa personal',   2500, FALSE),
  ('p0000005-0000-0000-0000-000000000005', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Combo (2 empanadas + gaseosa)', 7500, TRUE);

-- 7. Composición del combo: 2 empanadas de carne + 1 gaseosa.
INSERT INTO product_components (parent_product_id, child_product_id, qty) VALUES
  ('p0000005-0000-0000-0000-000000000005', 'p0000001-0000-0000-0000-000000000001', 2),
  ('p0000005-0000-0000-0000-000000000005', 'p0000004-0000-0000-0000-000000000004', 1);

-- 8. Ingredientes con stock inicial.
INSERT INTO ingredients (id, business_id, name, unit, current_stock) VALUES
  ('i0000001-0000-0000-0000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Carne molida', 'kg', 5),
  ('i0000002-0000-0000-0000-000000000002', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Pollo',        'kg', 5),
  ('i0000003-0000-0000-0000-000000000003', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Queso',        'kg', 2),
  ('i0000004-0000-0000-0000-000000000004', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Masa',         'kg', 10);

-- 9. Recetas (gramos por porción → convertidos a kg para coincidir con la unidad).
INSERT INTO product_recipes (product_id, ingredient_id, qty_per_unit) VALUES
  ('p0000001-0000-0000-0000-000000000001', 'i0000001-0000-0000-0000-000000000001', 0.080), -- 80g carne
  ('p0000001-0000-0000-0000-000000000001', 'i0000004-0000-0000-0000-000000000004', 0.050), -- 50g masa
  ('p0000002-0000-0000-0000-000000000002', 'i0000002-0000-0000-0000-000000000002', 0.070), -- 70g pollo
  ('p0000002-0000-0000-0000-000000000002', 'i0000004-0000-0000-0000-000000000004', 0.050), -- 50g masa
  ('p0000003-0000-0000-0000-000000000003', 'i0000003-0000-0000-0000-000000000003', 0.040), -- 40g queso
  ('p0000003-0000-0000-0000-000000000003', 'i0000004-0000-0000-0000-000000000004', 0.050); -- 50g masa
-- Gaseosa no tiene receta a propósito (no se trackea su inventario).
