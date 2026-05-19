# Mostrador

Agente conversacional por WhatsApp para negocios de comidas rápidas. El dueño configura su catálogo, ubicaciones y vendedores hablándole. Los vendedores reportan ventas por voz. El agente lleva inventario, procesa compras, gestiona turnos por ubicación y entrega reportes diarios y semanales.

**Stack:** Supabase (Postgres + Storage + Edge Functions Deno + pg_cron), Anthropic (Opus 4.7 onboarding, Sonnet 4.6 producción, Haiku 4.5 routing), OpenAI Whisper (audio), Google Gemini 2.5 Flash (imágenes), Kapso (WhatsApp Business).

Ver `docs/PRD-Mostrador.docx` y `docs/IMPLEMENTATION-SPEC.md` para el detalle de producto e implementación.

---

## Setup local

### 1. Prerrequisitos

```bash
brew install supabase/tap/supabase deno
```

### 2. Clonar y configurar

```bash
git clone https://github.com/juanda89/mostrador.git
cd mostrador
cp .env.example .env
# Editar .env con tus keys reales (ver §3)
```

### 3. Cuentas y keys a configurar en `.env`

| Servicio | Variable | Cómo obtenerla |
|---|---|---|
| Anthropic | `ANTHROPIC_API_KEY` | https://console.anthropic.com (billing activo) |
| OpenAI | `OPENAI_API_KEY` | https://platform.openai.com (billing activo) |
| Google AI | `GEMINI_API_KEY` | https://aistudio.google.com |
| Supabase | `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | https://supabase.com → crear proyecto → Settings → API |
| Kapso | `KAPSO_API_KEY`, `KAPSO_PHONE_NUMBER_ID`, `KAPSO_WEBHOOK_SECRET`, `KAPSO_WEBHOOK_VERIFY_TOKEN` | https://kapso.ai → provisionar número |
| Cron | `CRON_SECRET` | Generar: `openssl rand -hex 32` |

Opcionales (dejar vacío si no se usan):
- `HELICONE_API_KEY` — observabilidad LLM
- `SENTRY_DSN` — tracking de errores

### 4. Base de datos local

```bash
supabase start                 # arranca Postgres + Studio (http://localhost:54323)
supabase db reset              # aplica migrations 0001–0003 + seed
deno task db:types             # regenera tipos TS desde el schema
```

### 5. Servir Edge Functions

```bash
deno task serve:local          # http://localhost:54321/functions/v1/...
```

### 6. Exponer webhook a internet (para probar con Kapso real)

```bash
ngrok http 54321
# Copia la URL HTTPS de ngrok a Kapso, ruta:
#   <ngrok-url>/functions/v1/whatsapp-webhook
```

### 7. Tests

```bash
deno task test                 # unitarios
deno task test:integration     # requiere `supabase start` corriendo
```

---

## Despliegue a producción

```bash
# 1. Link al proyecto remoto
supabase link --project-ref <PROJECT_REF>

# 2. Subir secretos al proyecto Supabase
deno task secrets:push

# 3. Aplicar migrations a la DB remota
deno task db:push

# 4. En Supabase Studio → SQL Editor, configurar URLs del cron:
#   ALTER DATABASE postgres SET app.tick_url =
#     'https://<PROJECT_REF>.supabase.co/functions/v1/cron-tick';
#   ALTER DATABASE postgres SET app.cron_secret = '<...>';

# 5. Deploy de las edge functions
deno task deploy

# 6. Configurar webhook en Kapso apuntando a:
#   https://<PROJECT_REF>.supabase.co/functions/v1/whatsapp-webhook
```

---

## Estructura del repo

```
mostrador/
├── supabase/
│   ├── functions/
│   │   ├── whatsapp-webhook/     # POST de Kapso (mensajes entrantes)
│   │   ├── cron-tick/            # POST de pg_cron cada minuto
│   │   └── _shared/              # Lógica compartida (agents, tools, lib, jobs)
│   ├── migrations/               # 0001 schema, 0002 RLS, 0003 cron
│   └── seed.sql                  # Datos de prueba para dev local
├── tests/
│   ├── unit/                     # deno test
│   └── integration/              # Requieren Supabase local
├── scripts/                      # Utilidades de desarrollo
├── docs/                         # PRD + Implementation spec
├── deno.json                     # Tareas, imports map
└── .env.example                  # Plantilla de variables
```

Más detalle de cada módulo en `docs/IMPLEMENTATION-SPEC.md` §4 y en el plan en `/Users/jd/.claude/plans/eres-mi-asistente-de-hidden-nebula.md`.
