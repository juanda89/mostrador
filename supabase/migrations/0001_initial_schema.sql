-- =========================================================
-- ENUMS
-- =========================================================
CREATE TYPE business_state AS ENUM ('onboarding', 'production');
CREATE TYPE member_role AS ENUM ('owner', 'seller');
CREATE TYPE sale_status AS ENUM ('active', 'corrected', 'voided');
CREATE TYPE movement_type AS ENUM ('purchase', 'consumption', 'manual_adjust', 'initial_set', 'correction');
CREATE TYPE purchase_source AS ENUM ('photo', 'voice', 'text');
CREATE TYPE price_source AS ENUM ('purchase', 'manual');
CREATE TYPE direction AS ENUM ('inbound', 'outbound');
CREATE TYPE content_type AS ENUM ('text', 'audio', 'image', 'location', 'interactive');
CREATE TYPE report_type AS ENUM ('daily_close', 'weekly');
CREATE TYPE shift_start_source AS ENUM ('location', 'auto_from_sale');
CREATE TYPE shift_end_source AS ENUM ('location', 'manual', 'auto_cutoff');
CREATE TYPE unit_type AS ENUM ('g', 'kg', 'ml', 'l', 'unit');
CREATE TYPE weekday AS ENUM ('monday','tuesday','wednesday','thursday','friday','saturday','sunday');

-- =========================================================
-- CORE
-- =========================================================
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone TEXT NOT NULL UNIQUE,           -- E.164, ej. +573001234567
  name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_users_phone ON users(phone);

CREATE TABLE businesses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  owner_user_id UUID NOT NULL REFERENCES users(id),
  timezone TEXT NOT NULL DEFAULT 'America/Bogota',
  currency TEXT NOT NULL DEFAULT 'COP',
  state business_state NOT NULL DEFAULT 'onboarding',
  activated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE business_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id),
  role member_role NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, user_id, role)
);
CREATE INDEX idx_business_members_user ON business_members(user_id) WHERE active = TRUE;

CREATE TABLE business_settings (
  business_id UUID PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
  accepted_payment_methods JSONB NOT NULL DEFAULT '[]'::jsonb,
  daily_report_time TIME NOT NULL DEFAULT '06:15',
  business_day_cutoff TIME NOT NULL DEFAULT '06:00',
  daily_report_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  weekly_report_day weekday NOT NULL DEFAULT 'monday',
  weekly_report_time TIME NOT NULL DEFAULT '06:15',
  sale_notifications_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  correction_notifications_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  default_location_radius_m INTEGER NOT NULL DEFAULT 100
);

CREATE TABLE onboarding_checklist (
  business_id UUID PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
  has_name BOOLEAN NOT NULL DEFAULT FALSE,
  has_products BOOLEAN NOT NULL DEFAULT FALSE,
  has_seller BOOLEAN NOT NULL DEFAULT FALSE,
  has_payment_methods BOOLEAN NOT NULL DEFAULT FALSE,
  has_location BOOLEAN NOT NULL DEFAULT FALSE,         -- opcional
  has_report_schedule BOOLEAN NOT NULL DEFAULT TRUE,   -- por default
  has_recipes BOOLEAN NOT NULL DEFAULT FALSE,          -- opcional
  has_initial_inventory BOOLEAN NOT NULL DEFAULT FALSE,-- opcional
  completed_at TIMESTAMPTZ
);

-- =========================================================
-- CATÁLOGO
-- =========================================================
CREATE TABLE locations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name TEXT,
  lat DOUBLE PRECISION NOT NULL,
  lng DOUBLE PRECISION NOT NULL,
  radius_m INTEGER NOT NULL DEFAULT 100,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sku TEXT,
  price NUMERIC(14,2) NOT NULL,
  is_composite BOOLEAN NOT NULL DEFAULT FALSE,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_products_business_active ON products(business_id) WHERE active = TRUE;

CREATE TABLE product_components (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  child_product_id UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  qty NUMERIC(14,4) NOT NULL CHECK (qty > 0),
  UNIQUE (parent_product_id, child_product_id),
  CHECK (parent_product_id <> child_product_id)
);

CREATE TABLE ingredients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  unit unit_type NOT NULL,
  current_stock NUMERIC(14,4) NOT NULL DEFAULT 0,
  reorder_threshold NUMERIC(14,4),
  last_unit_cost NUMERIC(14,4),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE product_recipes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  ingredient_id UUID NOT NULL REFERENCES ingredients(id) ON DELETE RESTRICT,
  qty_per_unit NUMERIC(14,4) NOT NULL CHECK (qty_per_unit > 0),
  UNIQUE (product_id, ingredient_id)
);

-- =========================================================
-- VENTAS Y TURNOS
-- =========================================================
CREATE TABLE shifts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  seller_user_id UUID NOT NULL REFERENCES users(id),
  location_id UUID REFERENCES locations(id),
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ,
  start_source shift_start_source NOT NULL,
  end_source shift_end_source,
  start_lat DOUBLE PRECISION,
  start_lng DOUBLE PRECISION,
  end_lat DOUBLE PRECISION,
  end_lng DOUBLE PRECISION,
  total_sales_count INTEGER NOT NULL DEFAULT 0,
  total_revenue NUMERIC(14,2) NOT NULL DEFAULT 0
);
CREATE INDEX idx_shifts_active ON shifts(business_id, seller_user_id) WHERE ended_at IS NULL;

CREATE TABLE messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id),
  direction direction NOT NULL,
  content_type content_type NOT NULL,
  raw_text TEXT,
  media_url TEXT,
  transcript TEXT,
  extracted_data JSONB,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  parsed_intent TEXT,
  tool_calls JSONB,
  whatsapp_message_id TEXT UNIQUE,         -- idempotencia
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_messages_business_time ON messages(business_id, created_at DESC);

CREATE TABLE sales (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  seller_user_id UUID NOT NULL REFERENCES users(id),
  location_id UUID REFERENCES locations(id),
  shift_id UUID REFERENCES shifts(id),
  total NUMERIC(14,2) NOT NULL,
  payment_method TEXT NOT NULL,
  status sale_status NOT NULL DEFAULT 'active',
  source_message_id UUID REFERENCES messages(id),
  sold_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_sales_business_time ON sales(business_id, sold_at DESC);
CREATE INDEX idx_sales_seller_recent ON sales(seller_user_id, sold_at DESC);

CREATE TABLE sale_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id UUID NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  qty NUMERIC(14,4) NOT NULL DEFAULT 1 CHECK (qty > 0),
  unit_price NUMERIC(14,2) NOT NULL,
  subtotal NUMERIC(14,2) NOT NULL
);
CREATE INDEX idx_sale_items_sale ON sale_items(sale_id);

CREATE TABLE sale_corrections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id UUID NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  corrected_by_user_id UUID NOT NULL REFERENCES users(id),
  before_snapshot JSONB NOT NULL,
  after_snapshot JSONB NOT NULL,
  reason TEXT,
  source_message_id UUID REFERENCES messages(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =========================================================
-- INVENTARIO Y COMPRAS
-- =========================================================
CREATE TABLE purchases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  registered_by_user_id UUID NOT NULL REFERENCES users(id),
  vendor_name TEXT,
  total NUMERIC(14,2),
  source purchase_source NOT NULL,
  source_message_id UUID REFERENCES messages(id),
  purchased_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE purchase_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_id UUID NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
  ingredient_id UUID NOT NULL REFERENCES ingredients(id) ON DELETE RESTRICT,
  qty NUMERIC(14,4) NOT NULL CHECK (qty > 0),
  unit_price NUMERIC(14,4) NOT NULL,
  subtotal NUMERIC(14,2) NOT NULL
);

CREATE TABLE inventory_movements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  ingredient_id UUID NOT NULL REFERENCES ingredients(id) ON DELETE RESTRICT,
  type movement_type NOT NULL,
  qty_delta NUMERIC(14,4) NOT NULL,
  balance_after NUMERIC(14,4) NOT NULL,
  unit_cost NUMERIC(14,4),
  related_sale_id UUID REFERENCES sales(id),
  related_purchase_id UUID REFERENCES purchases(id),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_inv_mov_ingredient_time ON inventory_movements(ingredient_id, created_at DESC);

CREATE TABLE price_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  ingredient_id UUID NOT NULL REFERENCES ingredients(id) ON DELETE RESTRICT,
  unit_price NUMERIC(14,4) NOT NULL,
  source price_source NOT NULL,
  related_purchase_id UUID REFERENCES purchases(id),
  observed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_price_history_ingredient_time ON price_history(ingredient_id, observed_at DESC);

-- =========================================================
-- REPORTES
-- =========================================================
CREATE TABLE report_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  type report_type NOT NULL,
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  payload JSONB NOT NULL,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at TIMESTAMPTZ
);

-- =========================================================
-- TRIGGERS PARA updated_at
-- =========================================================
CREATE OR REPLACE FUNCTION touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_users_updated BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER trg_businesses_updated BEFORE UPDATE ON businesses
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER trg_products_updated BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER trg_ingredients_updated BEFORE UPDATE ON ingredients
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER trg_sales_updated BEFORE UPDATE ON sales
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
