# IMPLEMENTATION SPEC — Mostrador

> Brief técnico para construir el producto. Documento autocontenido: Claude Code debe poder empezar a desarrollar con esto en mano + los API keys configurados.

**Versión:** 0.3 | **Fecha:** Mayo 2026 | **Acompaña a:** `PRD-Mostrador.docx` v0.6

---

## 1. Quick context

Mostrador es un agente conversacional por WhatsApp para dueños de negocios de comidas rápidas. El dueño configura su catálogo, ubicaciones y vendedores hablándole. Los vendedores reportan ventas por voz. El agente lleva inventario, procesa compras, gestiona turnos por ubicación y entrega reportes diarios y semanales.

Estados del negocio: **ONBOARDING** → **PRODUCCIÓN**. Identificador de usuarios: número de WhatsApp.

Para detalle de producto, leer `PRD-Mostrador.docx` antes de empezar.

---

## 2. Prerrequisitos: cuentas y API keys

Cuentas a crear antes de empezar a codear. **Cada fila resulta en una env var.**

| # | Servicio | Para qué | Dónde crear cuenta | Qué generar | Env var |
|---|---|---|---|---|---|
| 1 | **Anthropic** | Claude Opus 4.7, Sonnet 4.6, Haiku 4.5 | https://console.anthropic.com | API key + billing activo | `ANTHROPIC_API_KEY` |
| 2 | **OpenAI** | Whisper large-v3 (transcripción) | https://platform.openai.com | API key + billing activo | `OPENAI_API_KEY` |
| 3 | **Google AI Studio** | Gemini 2.5 Flash (imágenes) | https://aistudio.google.com | API key | `GEMINI_API_KEY` |
| 4 | **Supabase** | Postgres, Storage, Edge Functions, Cron | https://supabase.com | Proyecto nuevo. Copiar URL + anon key + service role key | `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` |
| 5 | **Kapso** | Provisión del número WABA + conexión Meta | https://kapso.ai (verificar URL actual) | Provisionar número, generar API key, configurar webhook URL del backend | `KAPSO_API_KEY`, `KAPSO_PHONE_NUMBER_ID`, `KAPSO_WEBHOOK_VERIFY_TOKEN` |
| 6 | **Meta Business** (probable) | Verificación del WABA, plantillas | https://business.facebook.com | Solo si Kapso lo requiere para verificación inicial | — |
| 7 | **GitHub** | Repo del código | https://github.com | Repo privado + personal access token si CI | `GITHUB_TOKEN` (opcional) |
| 8 | **Vercel** | Hosting del backend (serverless functions) | https://vercel.com | Proyecto. Conectar al repo de GitHub. **Plan Pro o superior** (necesario para `maxDuration` > 10s). | Configurar env vars en el Vercel Dashboard |
| 9 | **Helicone** (opcional pero recomendado) | Observabilidad de llamadas LLM | https://helicone.ai | API key | `HELICONE_API_KEY` |
| 10 | **Sentry** (opcional) | Tracking de errores | https://sentry.io | DSN del proyecto | `SENTRY_DSN` |

### Notas operativas sobre el setup

- **Kapso**: el número debe estar verificado y aprobado antes de poder enviar mensajes a usuarios que no hayan escrito primero (ventana de 24h). Para reportes programados se necesitan plantillas pre-aprobadas (ver §12).
- **Anthropic**: Claude Opus 4.7 tiene rate limits más bajos que Sonnet/Haiku. Solicitar tier elevado si se hace piloto con >3 negocios.
- **Supabase**: usar el **Free tier** alcanza para piloto (hasta 500MB DB, 1GB storage). Pasar a Pro cuando se valide.
- **Vercel**: requiere **plan Pro** o superior. El registro de venta toma 4–10s típicos (Whisper + LLM + tool calls + WhatsApp send) y Hobby tiene timeout duro de 10s. Configurar `maxDuration: 60` en `vercel.json` para los webhook handlers. **No usar Vercel Cron Jobs**: corre cada minuto resultaría caro y está atado al mismo timeout; en su lugar, Supabase pg_cron (ya configurado en migración 0003) hace HTTP request al backend.

---

## 3. Stack técnico

```
Runtime:        Node.js 20.x LTS
Lenguaje:       TypeScript 5.x (strict mode)
Framework:      Hono (web framework liviano, type-safe; con adapter para Vercel)
DB:             Supabase (Postgres 15+)
ORM/Query:      Supabase JS client v2
Validación:     Zod 3.x
LLM SDKs:       @anthropic-ai/sdk, openai, @google/generative-ai
Audio:          openai (whisper-1)
Imágenes:       @google/generative-ai (gemini-2.5-flash)
WhatsApp:       Kapso SDK (verificar nombre exacto del paquete)
Scheduler:      Supabase Cron (pg_cron) + Edge Functions
Logging:        pino + Helicone (LLM) + Sentry (errores)
Testing:        Vitest + tsx para scripts
```

---

## 4. Estructura del repo

Layout Vercel: cada archivo bajo `api/` es un endpoint serverless. La lógica compartida vive en `src/` y se importa desde los handlers.

```
mostrador/
├── api/                              # Vercel Functions (cada archivo = endpoint)
│   ├── webhooks/
│   │   └── whatsapp.ts               # POST /api/webhooks/whatsapp
│   └── cron/
│       └── tick.ts                   # POST /api/cron/tick (lo invoca Supabase pg_cron)
├── src/                              # Lógica compartida (importada por api/*)
│   ├── agents/
│   │   ├── router.ts                 # Intent classification (Haiku 4.5)
│   │   ├── onboarding/
│   │   │   ├── agent.ts              # Opus 4.7
│   │   │   ├── system-prompt.ts
│   │   │   └── checklist.ts
│   │   └── production/
│   │       ├── agent.ts              # Sonnet 4.6
│   │       └── system-prompt.ts
│   ├── tools/                        # Function-calling tools
│   │   ├── catalog.ts                # create_product, set_recipe, etc.
│   │   ├── sales.ts                  # register_sale, correct_last_sale
│   │   ├── inventory.ts              # query_inventory, set_inventory
│   │   ├── purchases.ts              # register_purchase
│   │   ├── shifts.ts                 # start_shift, end_shift, autoCloseOpenShifts
│   │   └── reports.ts                # generateDailyReport, generateWeeklyReport
│   ├── media/
│   │   ├── whisper.ts                # audio → text
│   │   └── gemini.ts                 # image → structured data
│   ├── lib/
│   │   ├── whatsapp.ts               # Kapso client wrapper
│   │   ├── anthropic.ts
│   │   ├── supabase.ts
│   │   ├── time.ts                   # business_day windows
│   │   └── fuzzy.ts                  # payment method matching
│   └── types/
│       └── db.ts                     # Types generados por Supabase CLI
├── supabase/
│   ├── migrations/
│   │   ├── 0001_initial_schema.sql
│   │   ├── 0002_rls_policies.sql
│   │   └── 0003_cron.sql
│   └── seed.sql
├── docs/
│   ├── PRD.md
│   └── IMPLEMENTATION-SPEC.md        # este documento
├── vercel.json                       # config de Vercel (maxDuration, regions)
├── package.json
├── tsconfig.json
├── .env.example
└── README.md
```

### 4.1 `vercel.json`

```json
{
  "functions": {
    "api/webhooks/whatsapp.ts": {
      "maxDuration": 60
    },
    "api/cron/tick.ts": {
      "maxDuration": 60
    }
  },
  "regions": ["gru1"]
}
```

Elegir region según ubicación del cliente principal. `gru1` (São Paulo) es razonable para LATAM. Vercel también ofrece `iad1` (US East) que tiene mejor latencia con APIs de OpenAI/Anthropic, a costa de algo más de latencia hacia el usuario final. Validar en piloto.

## 5. Variables de entorno

`.env.example` (commit este archivo; el `.env` real va en `.gitignore`):

```bash
# Anthropic
ANTHROPIC_API_KEY=sk-ant-...

# OpenAI (Whisper)
OPENAI_API_KEY=sk-...

# Google Gemini
GEMINI_API_KEY=...

# Supabase
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...

# Kapso (WhatsApp)
KAPSO_API_KEY=...
KAPSO_PHONE_NUMBER_ID=...
KAPSO_WEBHOOK_VERIFY_TOKEN=...        # Lo defines tú; tiene que coincidir con lo configurado en Kapso

# Observabilidad
HELICONE_API_KEY=...
SENTRY_DSN=...

# App
NODE_ENV=production
LOG_LEVEL=info
PUBLIC_BASE_URL=https://mostrador.vercel.app
CRON_SECRET=...                       # Shared secret entre Supabase pg_cron y /api/cron/tick
```

---

## 6. Asignación de modelos LLM

| Flujo | Modelo | Por qué |
|---|---|---|
| **Onboarding del dueño** | `claude-opus-4-7` | Primera impresión. Conversación matizada, debe inferir bien (ej. recetas a partir de nombres de productos). Tono y empatía importan. |
| Router de intents | `claude-haiku-4-5` | <500ms por mensaje. Clasificación simple, alto volumen. |
| Agente de producción (ventas, correcciones, consultas) | `claude-sonnet-4-6` | Balance costo/capacidad. Tool calling robusto en español. |
| Generación de reportes | `claude-sonnet-4-6` | Coherencia narrativa en textos largos. |
| Inferencia de recetas/ingredientes (caso especial onboarding) | `claude-opus-4-7` | Razonamiento de dominio. Vale el costo: corre 1 vez por negocio. |
| Transcripción de audio | `whisper-1` (OpenAI) | Mejor para español LATAM con jerga. |
| Extracción de imágenes (facturas, menús) | `gemini-2.5-flash` | Costo bajo, buena precisión visual. |

**Strings de modelo (Anthropic):** `claude-opus-4-7`, `claude-sonnet-4-6`, `claude-haiku-4-5`.

---

## 7. Esquema de Supabase

### 7.1 Migración inicial — `supabase/migrations/0001_initial_schema.sql`

```sql
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
```

### 7.2 RLS — `supabase/migrations/0002_rls_policies.sql`

Política base: el backend usa **service role** (bypassa RLS) y siempre filtra por `business_id` en código. RLS queda activado por defensa en profundidad.

```sql
ALTER TABLE businesses ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE onboarding_checklist ENABLE ROW LEVEL SECURITY;
ALTER TABLE locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_components ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingredients ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_recipes ENABLE ROW LEVEL SECURITY;
ALTER TABLE shifts ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales ENABLE ROW LEVEL SECURITY;
ALTER TABLE sale_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE sale_corrections ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchases ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE price_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_logs ENABLE ROW LEVEL SECURITY;

-- Política deny-all explícita; en V1 todo va por service role.
-- (Sin policy = deny por default cuando RLS está enabled).
```

### 7.3 Cron — `supabase/migrations/0003_cron.sql`

```sql
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Tick cada minuto: el backend revisa qué negocios deben recibir reporte o auto-cerrar turnos en esa hora local.
SELECT cron.schedule(
  'mostrador-tick',
  '* * * * *',
  $$ SELECT net.http_post(
       url := current_setting('app.tick_url'),
       headers := jsonb_build_object('x-cron-secret', current_setting('app.cron_secret'))
     ) $$
);
```

Configurar al inicio: `ALTER DATABASE postgres SET app.tick_url = 'https://.../cron/tick';` y `app.cron_secret`.

---

## 8. Arquitectura del backend (flujo de un mensaje)

```
POST /webhooks/whatsapp
  │
  ▼
1. Verificar firma del webhook (Kapso)
2. Idempotencia: descartar si whatsapp_message_id ya existe
3. Insertar registro en `messages` (inbound)
4. Resolver usuario por phone
   - upsert users(phone, name?)
5. Si content_type = audio → Whisper → guardar transcript
   Si content_type = image → Gemini → guardar extracted_data
6. Resolver contexto:
   - business_members del usuario (puede ser owner, seller, ambos)
   - business.state
7. Routing:
   ┌─ Sin business asociado y mensaje parece saludo → flujo "onboarding nuevo"
   ├─ Usuario es owner Y business.state = onboarding → onboarding agent
   ├─ Usuario es seller Y business.state = onboarding → mensaje "el dueño todavía está configurando"
   ├─ Usuario es owner Y business.state = production → production agent (modo owner)
   └─ Usuario es seller Y business.state = production → production agent (modo seller)
8. Agente correspondiente procesa (con tools) y emite respuesta
9. Enviar respuesta vía Kapso
10. Persistir `messages` (outbound) con tool_calls, parsed_intent
```

### 8.1 Idempotencia y reintentos

WhatsApp puede reentregar el mismo webhook. Usar `messages.whatsapp_message_id UNIQUE` para descarte rápido. Cualquier tool que escriba (register_sale, register_purchase, etc.) debe verificar primero si `source_message_id` ya existe en la tabla destino — si sí, retornar lo ya creado.

---

## 9. Onboarding agent

**Modelo:** `claude-opus-4-7`
**Temperatura:** 0.3 (algo de calidez, pero precisión en estructura)

### 9.1 System prompt

```
Eres Mostrador, un asistente que ayuda a dueños de negocios de comidas rápidas a
configurar su negocio para que tú puedas llevarles las ventas, el inventario y
los reportes vía WhatsApp.

Estás en la etapa de ONBOARDING. Tu objetivo único en esta etapa es completar el
checklist mínimo para activar el negocio:

  Obligatorios:
    1. Nombre del negocio
    2. Al menos un producto con precio
    3. Al menos un vendedor (puede ser el mismo dueño)
    4. Métodos de pago aceptados

  Opcionales (ofrecer pero no bloquear):
    5. Ubicación del puesto (habilita turnos por ubicación)
    6. Horario del reporte diario (tiene default: 06:15 con ventana 06:01–06:00)
    7. Recetas (ingredientes por producto)
    8. Inventario inicial

Cuando los 4 obligatorios estén completos, llama a `complete_onboarding` y avisa
al dueño que su negocio está activo.

== TONO ==

Habla en español neutro latinoamericano. Tutea ("tú", no "usted").

Sé:
- Cercano pero no empalagoso.
- Conciso. Una idea por mensaje cuando se pueda.
- Concreto. Si guardaste algo, dilo en una línea con el dato.

NO:
- No saludes en cada turno (solo en el primer mensaje).
- No agradezcas compulsivamente.
- No uses jerga técnica (nada de "comando", "endpoint", "API", "registro").
- No expliques tu razonamiento a menos que te pregunten.
- No uses emojis decorativos. Solo:
    ✅ confirmación de algo registrado importante
    ✏️ corrección
    🎉 activación del negocio (una sola vez, al final del onboarding)
    ⚠️ alerta

== ORDEN DEL FLUJO ==

Sigue este orden cuando no haya datos previos. Si el dueño aporta varios datos
en un mensaje, captúralos todos y salta directo a lo que falte.

  1. Saludo + pedir nombre del negocio.
  2. Pedir productos. Acepta foto del menú, audio, o lista de texto.
     Para cada producto necesitas: nombre, precio. SKU opcional.
     Si detectas combos (productos que se venden como conjunto a precio fijo),
     marcalos con is_composite=true y pregunta su composición.

  3. CASO ESPECIAL — recetas/ingredientes:
     Si el dueño te dio productos + precios y nada más, pregúntale:

       "¿Quieres que asuma los ingredientes y cuánto se usa de cada uno por
        porción? Así te puedo llevar el inventario. Te los presento para que
        los revises, y los puedes ajustar después en cualquier momento."

     Si dice que sí:
       a. Usa tu conocimiento de cocina y los nombres de los productos para
          inferir ingredientes razonables con cantidades estimadas por porción
          (en gramos, mililitros o unidades).
       b. Llama a `propose_recipes` con tu propuesta completa.
       c. Muestra al dueño un resumen breve, agrupado por producto.
       d. Confírmale: "Lo puedes ajustar cuando quieras diciéndome, por ejemplo,
          'la hamburguesa lleva 100 gramos de carne, no 80'."

     Si dice que no, o que prefiere hacerlo después, sigue al paso 4 sin
     bloquear. El producto funciona sin recetas; simplemente no habrá tracking
     de inventario por ingrediente.

  4. Pedir números de WhatsApp de vendedores.
     Acepta múltiples en un mismo mensaje.
     Si el dueño dice "yo también atiendo", agrégalo como seller además de owner.

  5. Preguntar métodos de pago aceptados (texto libre, ej. "efectivo, Nequi").

  6. Ofrecer ubicación del puesto como OPCIONAL.
     Texto sugerido: "Una última cosa, opcional: si quieres que controle los
     turnos de tus vendedores (que envíen ubicación al llegar y al irse, y yo
     te reporto horarios), mándame la ubicación del puesto. Si no te interesa,
     escríbeme 'saltar'."

  7. Confirmar configuración de reportes:
     "Te mando el reporte de cierre todos los días a las 6:15 am, con la info
     desde las 6 am del día anterior. Después lo puedes cambiar."

  8. Llama a `complete_onboarding` y manda el mensaje de activación:
     "🎉 ¡Listo, {nombre del negocio} ya está activa! Tus vendedores ({nombres
     o números}) ya pueden reportar ventas. Yo te aviso cada vez que registren
     una."

== EJEMPLOS DE TONO (calibración) ==

Bien:
  "Listo, Empanadas Doña Mary."
  "Encontré 6 productos. Antes de seguir necesito los precios."
  "Anotados los dos números. ¿Qué métodos de pago aceptas?"

Mal (no hagas esto):
  "¡Perfecto! ¡Qué buen nombre! 😊 Vamos a configurar todo paso a paso..."
  "Genial, María, has dado un gran paso. Como tu asistente virtual, ahora..."
  "He registrado satisfactoriamente la información proporcionada."

== REGLAS DURAS ==

- NO inventes precios. Si el dueño no te los dio, pregúntalos.
- NO continúes a producción si falta algún obligatorio.
- Si el dueño quiere saltarse el paso actual con palabras como "después",
  "ahora no", "skip": acéptalo solo si el paso es opcional.
- Si el dueño se desvía a algo no relacionado, responde brevemente y vuelve al
  flujo: "Te ayudo con eso cuando termines de configurar. ¿Vamos con [paso
  pendiente]?"
```

### 9.2 Tools del onboarding agent

Todas las tools reciben implícitamente `business_id` (resuelto del contexto). Solo se muestran args explícitos.

```typescript
// Crea el negocio inicial cuando el owner da su nombre por primera vez.
upsert_business_info({
  name: string,
  timezone?: string,         // inferir del país por phone si no se da
  currency?: string,         // default COP
}): { business_id: string }

create_product({
  name: string,
  price: number,
  sku?: string,
  is_composite?: boolean,    // default false
}): { product_id: string }

set_combo_composition({
  parent_product_id: string,
  components: { child_product_id: string, qty: number }[],
}): { ok: true }

create_ingredient({
  name: string,
  unit: 'g' | 'kg' | 'ml' | 'l' | 'unit',
  initial_stock?: number,
}): { ingredient_id: string }

// IMPORTANTE: el caso especial de "asume los ingredientes"
propose_recipes({
  proposals: {
    product_name: string,    // para presentar al dueño; el agente debe matchear con product_id
    product_id: string,
    ingredients: {
      name: string,          // si no existe, se crea
      unit: 'g' | 'kg' | 'ml' | 'l' | 'unit',
      qty_per_unit: number,
    }[],
  }[],
}): { created_ingredients: string[], created_recipes: number }
// Esta tool crea los ingredientes que falten y los recipes en una transacción.
// El dueño puede modificar después con update_recipe.

update_recipe({
  product_id: string,
  ingredient_id: string,
  qty_per_unit: number,
}): { ok: true }

create_location({
  name?: string,
  lat: number,
  lng: number,
  radius_m?: number,         // default 100
}): { location_id: string }

add_seller({
  phone: string,             // E.164
  name?: string,
}): { user_id: string }

set_payment_methods({
  methods: string[],         // ej. ['cash', 'nequi', 'daviplata']
}): { ok: true }

set_report_schedule({
  daily_report_time?: string,        // 'HH:mm', default 06:15
  business_day_cutoff?: string,      // default 06:00
  weekly_report_day?: weekday,
  weekly_report_time?: string,
}): { ok: true }

check_onboarding_status(): {
  has_name: boolean,
  has_products: boolean,
  has_seller: boolean,
  has_payment_methods: boolean,
  has_location: boolean,
  has_report_schedule: boolean,
  ready_for_production: boolean,
}

complete_onboarding(): {
  ok: true,
  business: { id, name, state: 'production' },
  sellers: { phone: string, name?: string }[],
}
```

---

## 10. Production agent

**Modelo:** `claude-sonnet-4-6`
**Temperatura:** 0.2

### 10.1 System prompt (resumen)

```
Eres Mostrador, asistente del negocio "{business_name}".
Estás en modo PRODUCCIÓN. El negocio ya está configurado.

Quien te habla ahora es {owner|seller} llamado {name}.
Su número es {phone}.

== TONO ==
Igual al onboarding: cercano, conciso, sin jerga, sin emojis decorativos.
Solo: ✅ ✏️ 📊 ☀️ 🌙 ⚠️ 📦 📈 📐 🏆 🥇 cuando agreguen información.

== REGLAS DURAS ==

1. NUNCA bloquees pidiendo confirmación. Si tienes la info completa para
   registrar una venta, regístrala y muestra el resultado.
2. Si falta el método de pago en una venta → pregúntalo.
3. Si falta precio o cantidad en una compra → pregúntalo.
4. Para método de pago, acepta texto libre y matchea contra la lista
   {accepted_payment_methods} con tolerancia ("en efectivo" → cash,
   "nequi" → nequi). Si la confianza es baja, repregunta listando opciones.
5. Combos: si la combinación que dice el vendedor coincide exactamente con
   un combo del catálogo, pregunta si se cobró como combo o sueltos.
6. Correcciones: solo permitidas para las últimas 2 ventas del MISMO vendedor.
7. Inventario: cuando se registra una venta, el cálculo de consumo se hace
   server-side, tú no lo calculas en el prompt.

== INTENTS QUE MANEJAS ==

Vendedor:
- register_sale (audio o texto)
- correct_last_sale
- start_shift / end_shift (vía mensaje de ubicación, manejado en el código antes
  de invocarte; tú confirmas con texto)
- query_inventory
- register_purchase

Dueño:
- todo lo anterior, más:
- update_catalog (productos, precios, combos, recetas)
- update_sellers
- update_payment_methods
- update_report_schedule
- update_inventory (set/adjust)
- query reports (genera on-demand si lo pide)
```

### 10.2 Tools del production agent

```typescript
register_sale({
  items: { product_id: string, qty: number }[],
  payment_method: string,
  notes?: string,
}): { sale_id, total, ... }

correct_last_sale({
  seller_user_id: string,        // el que escribió
  position: 'last' | 'second_to_last',
  new_items?: ...,
  new_payment_method?: string,
  reason?: string,
}): { sale_id, before, after, ... }

register_purchase({
  items: { ingredient_name: string, qty: number, unit_price: number, unit }[],
  vendor_name?: string,
  source: 'photo' | 'voice' | 'text',
}): { purchase_id, total, ... }

query_inventory({ ingredient_name?: string }):
  { ingredients: { name, current_stock, unit, last_purchase_at? }[] }

set_inventory({ ingredient_name: string, qty: number, unit: string }):
  { ingredient_id, new_stock }

start_shift({ lat: number, lng: number, source: 'location' | 'auto_from_sale' }):
  { shift_id, location_id?, location_name? }

end_shift({ shift_id: string, lat?: number, lng?: number, source: shift_end_source }):
  { shift_id, total_sales_count, total_revenue, duration_minutes }

update_product / update_combo / update_recipe / update_payment_methods /
update_report_schedule / add_seller / remove_seller / add_location /
soft_delete_product (active=false): ...
```

---

## 11. Reglas críticas (no negociables)

1. **Deducción de inventario en venta:** server-side, en la misma transacción que `register_sale`. Algoritmo en §9.4 del PRD. Tests obligatorios.
2. **Combos en "top productos" del reporte:** cuentan como combo, NO se desagregan.
3. **Inventario consumido en reporte:** SÍ desagrega combos hasta ingredientes.
4. **Soft-delete de productos:** `active=false`, nunca `DELETE`.
5. **Auto-cierre de turnos:** corre a `business_day_cutoff` (default 06:00), antes del reporte diario (06:15). `ended_at` = timestamp de la última venta del turno; si el turno no tuvo ventas, `ended_at` = cutoff. `end_source = 'auto_cutoff'`. `end_lat/lng` quedan NULL.
6. **Auto-inicio de turno:** si llega una venta sin shift activo y el negocio tiene ubicaciones, crear shift con `start_source='auto_from_sale'`.
7. **Ventana del día operativo:** `(cutoff(día-1), cutoff(día)]`. Reporte etiquetado por la fecha del inicio de la ventana.
8. **Idempotencia:** todo write tool revisa `source_message_id` antes de crear.
9. **Sin confirmación bloqueante:** el agente siempre asume lo transcrito.
10. **Identificador externo de usuario:** `phone` E.164. Internamente `id` UUID.

---

## 12. Cron jobs

Implementar como Edge Functions de Supabase O endpoints del backend con secret compartido. Recomendado: endpoints del backend para tener un solo lugar de lógica.

### 12.1 `/cron/tick` (cada minuto)

```typescript
// Pseudocódigo
const now = new Date();
const businesses = await db.businesses
  .where({ state: 'production' })
  .join(business_settings);

for (const b of businesses) {
  const localNow = toLocal(now, b.timezone);
  const hhmm = format(localNow, 'HH:mm');

  // 06:00 → auto-cerrar turnos abiertos
  if (hhmm === b.business_day_cutoff) {
    await autoCloseOpenShifts(b.id, localNow);
  }

  // 06:15 → generar y enviar reporte diario
  if (hhmm === b.daily_report_time && b.daily_report_enabled) {
    await generateAndSendDailyReport(b.id, localNow);
  }

  // Día de la semana + hora → reporte semanal
  if (isWeeklyTrigger(localNow, b)) {
    await generateAndSendWeeklyReport(b.id, localNow);
  }
}

// ---------------------------------------------------------
// Auto-cierre: ended_at = última venta del turno (o cutoff si no hubo ventas)
// ---------------------------------------------------------
async function autoCloseOpenShifts(businessId, localCutoffTime) {
  const openShifts = await db.shifts.find({
    business_id: businessId,
    ended_at: null,
  });

  for (const shift of openShifts) {
    // Buscar la última venta activa del turno
    const lastSale = await db.sales.findOne({
      shift_id: shift.id,
      status: 'active',
      orderBy: { sold_at: 'desc' },
    });

    // Si el turno tuvo ventas → ended_at = timestamp de la última
    // Si no hubo ventas → ended_at = cutoff (vendedor abrió y no vendió nada)
    const endedAt = lastSale ? lastSale.sold_at : localCutoffTime;

    await db.shifts.update(shift.id, {
      ended_at: endedAt,
      end_source: 'auto_cutoff',
      // end_lat, end_lng quedan NULL (no se envió ubicación de cierre)
      total_sales_count: await countSalesInShift(shift.id),
      total_revenue: await sumRevenueInShift(shift.id),
    });
  }
}
```

### 12.2 Plantillas de WhatsApp aprobadas

Para enviar mensajes proactivos fuera de la ventana de 24h, registrar y pre-aprobar estas templates en Meta/Kapso:

- `mostrador_daily_report` — body con placeholders del cierre
- `mostrador_weekly_report`
- `mostrador_low_inventory_alert` (V2)

---

## 13. Tono del agente — referencia rápida

Ver §9.1 para el bloque completo. En cualquier respuesta:

**Hacer:**
- Frases cortas. Datos al grano.
- Confirmar lo guardado en una línea.
- Tutear, español neutro LATAM.
- Una pregunta por mensaje.

**No hacer:**
- No saludar más allá del primer mensaje.
- No agradecer compulsivamente.
- Sin frases tipo "qué bueno", "perfecto", "excelente" a cada turno.
- Sin emojis decorativos (solo los funcionales listados).
- Sin disclaimers tipo "como tu asistente virtual".
- Sin pedir "OK" para guardar algo cuando la info ya está completa.

**Calibración por ejemplos:**

| Bien | Mal |
|---|---|
| "Listo, Empanadas Doña Mary." | "¡Perfecto, María! Qué lindo nombre 😊" |
| "Anotados los dos números." | "He registrado satisfactoriamente la información." |
| "¿Con qué pagaron?" | "Para finalizar el registro de la venta, necesitaría que me indiques el método de pago." |
| "✅ Venta registrada. Total: $11.500 — Nequi" | "✨ ¡Genial! Tu venta ha sido procesada exitosamente 🎉" |

---

## 14. Orden de implementación

### Fase 0 — Setup (1 día)
1. Crear todas las cuentas de §2.
2. Crear repo en GitHub. Crear proyecto en Vercel (plan Pro), conectarlo al repo.
3. Crear proyecto Supabase, correr migrations 0001–0003.
4. Configurar `.env` en Vercel Dashboard (Settings → Environment Variables).
5. Provisionar número en Kapso, configurar webhook a `https://<your-domain>.vercel.app/api/webhooks/whatsapp`.
6. En Supabase, configurar las variables del cron: `ALTER DATABASE postgres SET app.tick_url = 'https://<your-domain>.vercel.app/api/cron/tick';` y `app.cron_secret = '<random secret>'`.

### Fase 1 — Plumbing (2 días)
1. Webhook handler: recibe, verifica firma, persiste `messages`, retorna 200.
2. Resolución de usuario por phone (upsert).
3. Helpers: Anthropic client, Whisper, Gemini, Kapso send.
4. Eco simple: el agente responde lo que recibe. Validar end-to-end.

### Fase 2 — Onboarding agent (3-4 días)
1. System prompt + tools de §9.
2. Tracking del checklist (lectura/escritura a `onboarding_checklist`).
3. **Caso especial:** flujo de inferencia de recetas con Opus 4.7.
4. Transición a producción.

### Fase 3 — Production agent: ventas (3 días)
1. Router + production agent base.
2. `register_sale` con deducción de inventario recursiva (incluyendo combos).
3. `correct_last_sale` con notificación al dueño (tachado/cursiva en el formato).
4. Notificación proactiva al dueño en cada venta.

### Fase 4 — Inventario y compras (2 días)
1. `query_inventory`, `set_inventory`.
2. `register_purchase` con foto (Gemini), audio (Whisper) y texto.
3. Preguntas automáticas si falta precio/cantidad.

### Fase 5 — Turnos (2 días)
1. Inicio/cierre explícito por ubicación.
2. Auto-inicio por primera venta del día.
3. Auto-cierre por cutoff.

### Fase 6 — Reportes (3 días)
1. Cron tick.
2. Daily report (con templates aprobadas).
3. Weekly report con tendencias y márgenes.

### Fase 7 — Hardening (2 días)
1. Idempotencia exhaustiva.
2. Observabilidad (Helicone + Sentry).
3. Manejo de errores de transcripción/extracción con fallback elegante.

---

## 15. Testing

### Mínimos para considerar la fase completa

- **Fase 2:** un piloto interno completa onboarding en <20 min sin asistencia.
- **Fase 3:** 100 ventas simuladas registradas correctamente, incluyendo:
  - 20 ventas con combo
  - 20 ventas sin método de pago (debe preguntar)
  - 10 correcciones (5 inmediatas, 5 después de otras ventas)
- **Fase 4:** 30 facturas de prueba (foto + audio + texto) con ≥85% precisión en línea.
- **Fase 5:** simulación de 5 turnos: explícitos, auto-inicio, auto-cierre.
- **Fase 6:** reporte diario y semanal generados y enviados correctamente vía template.

### Tests unitarios obligatorios

- Algoritmo de deducción de inventario (recursivo combos → ingredientes).
- Cálculo de ventana del día operativo según `business_day_cutoff`.
- Fuzzy matching de métodos de pago.
- Idempotencia de `register_sale` y `register_purchase`.

---

## 16. Cómo correr local

```bash
# 1. Clonar y entrar
git clone <repo> && cd mostrador

# 2. Instalar
pnpm install   # o npm install

# 3. Setup Supabase local (opcional pero recomendado)
supabase start
supabase db reset    # corre las migrations

# 4. .env
cp .env.example .env
# editar con keys reales

# 5. Run con Vercel CLI (replica el runtime de Vercel localmente)
npx vercel dev    # arranca en :3000

# 6. Exponer webhook (para test con Kapso real)
ngrok http 3000
# copiar URL a Kapso config
```

---

## 17. Documentos relacionados

- `PRD-Mostrador.docx` v0.4 — qué construir y por qué.
- Este documento — cómo construirlo.

Cualquier discrepancia entre los dos: este documento gana para detalles de implementación; el PRD gana para decisiones de producto.
