# Backlog

Ideas y features que están fuera del scope inmediato pero que queremos retomar.
Sin orden estricto; lo concretamos cuando llegue el momento.

---

## Onboarding: oferta de turnos por ubicación al día 5

**Decidido:** quitamos del flujo de onboarding la pregunta opcional sobre ubicación.
Hacía sentir el onboarding más largo y solo aplica a una minoría de clientes.

**Reemplazo:** cuando un negocio cumple **5 días registrando ventas** (≥ 1 venta en
cada uno de los últimos 5 días operativos), enviar al dueño un mensaje proactivo
explicando la función de turnos por ubicación.

- Canal: WhatsApp via Kapso, usando un **template Meta pre-aprobado**.
- Sugerido template name: `mostrador_offer_location_tracking`.
- Body (placeholders): saludo + 1 línea de qué hace la feature + CTA "mándame la
  ubicación del puesto" / "más info".
- Engagement: medir si el dueño responde con ubicación o pide más info.
- Dispatch: agregar al cron-tick check diario que filtre `businesses` con
  `activated_at <= now - 5 days` AND no tienen `locations` AND no hemos enviado
  esta oferta antes (nueva columna `business_settings.location_offer_sent_at`).

**Cuándo:** después de Fase 6 (reportes), cuando ya tenemos templates Meta
aprobados y el cron tiene observabilidad sólida.

---

## Fase 3: Production agent (registro de ventas)

Hoy, cuando un dueño/vendedor escribe estando el negocio en estado `production`,
el router cae a un stub temporal. Necesitamos el agente completo:

- Modelo: `claude-sonnet-4-6` (production agent del spec §10)
- Router de intents previo con `claude-haiku-4-5` para evitar invocar Sonnet
  ante saludos triviales.
- Tools del production agent (spec §10.2):
  - `register_sale` con deducción recursiva de inventario (combos → componentes
    → ingredientes). Validar idempotencia por `source_message_id`.
  - `correct_last_sale` (últimas 2 del mismo vendedor)
  - `register_purchase` (foto/audio/texto)
  - `query_inventory`, `set_inventory`
  - `start_shift`, `end_shift`
  - Updates al catálogo (update_product, update_combo, soft delete)
- Notificación proactiva al dueño en cada venta (mensaje al `owner_user_id`).
- Mensajes con tachado/cursiva al hacer correcciones.

**Cuándo:** siguiente sprint después de cerrar bugs críticos del onboarding.

---

## Validaciones pre-activación más robustas

Hoy `complete_onboarding` valida solo el checklist (has_name, has_products, etc.).
Pero el catálogo puede quedar en estados inconsistentes (combos sin composición,
productos duplicados, recetas con qty cero, etc.) y el negocio se activa igual.

Añadir validaciones:
- Todo combo (`is_composite=true`) debe tener al menos 1 entry en `product_components`.
- No duplicar productos por nombre dentro de un mismo `business_id` (case-insensitive).
- Métodos de pago canonicalizados (cash, nequi, daviplata, transfer, card).
- (Recomendado) al menos 1 vendedor distinto al owner si el dueño dijo "tengo equipo".

Si falla validación → no activar, devolver al agente un mensaje específico de
qué corregir antes de pasar a producción.

---

## Resiliencia ante mensajes en ráfaga (batching)

Síntoma observado: el dueño manda 2 mensajes seguidos (ej. "precios" + "ah, y
crispetas 7"). Kapso a veces los agrupa (buffer 5s) y a veces no. Cuando no
agrupa, mi código procesa cada mensaje en su propia invocación del webhook y
Opus puede duplicar acciones porque no recuerda qué tools llamó en el turn
anterior (solo ve su propio texto outbound).

Mitigaciones a evaluar:
- **Per-user processing queue** en Postgres (advisory lock por `user_id`) para
  serializar invocaciones y evitar paralelismo.
- **Tool result en history**: al cargar conversation history, incluir los
  `tool_calls` persistidos en `messages` y reconstruir los content blocks
  Anthropic-style. Así Opus ve qué hizo realmente, no solo qué dijo.
- **Idempotencia exhaustiva** en todas las tools (ya hecho en `create_product`).

---

## Observabilidad: tabla `agent_traces`

Los logs de Supabase están muy submuestreados. Hoy persistimos las traces en
`messages.tool_calls` (JSONB) pero solo del outbound. Sería útil:

- Tabla dedicada `agent_traces` con: business_id, user_id, inbound_message_id,
  turn, model, latency_ms, input_tokens, output_tokens, tool_uses[], errors[].
- Índice por business_id + created_at para queries de "últimas N convers".
- Dashboard simple (Supabase Studio queries) para ver:
  - P50/P95 latency por modelo
  - Tasa de tool errors
  - Conversaciones que llegaron a MAX_TURNS

---

## Prompt caching: trim del system prompt

El system prompt estático está en ~6K tokens. Funcionando con prompt caching pero
trim sería gratis. Candidatos:
- Compactar los ejemplos de R3 (precios COP) sin perder claridad.
- Mover los ejemplos de tono al final como apéndice y ver si Opus los respeta.

---

## Multi-tienda (V2)

Hoy un usuario puede tener máximo 1 negocio como owner (resolveBusiness toma
el primero). Para V2 (PRD §11.3): permitir que un owner gestione varios y
desambiguar por contexto del mensaje.
