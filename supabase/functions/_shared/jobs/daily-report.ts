// Reporte diario de cierre.
//
// Determinístico (sin LLM) por simplicidad y predictibilidad. Se invoca
// desde cron-tick cuando la hora local del business coincide con
// business_settings.daily_report_time.
//
// Estrategia de envío:
//   - Por ahora, siempre sendWhatsAppText (free-form).
//   - Si la ventana 24h con el dueño está cerrada, Kapso probablemente
//     rechazará el mensaje. Lo logueamos y seguimos. Cuando se monten
//     templates Meta aprobadas, se cambiará a sendWhatsAppTemplate.
//
// Idempotencia: chequea report_logs por (business_id, type, period_start)
// antes de mandar — si ya se mandó uno para este período, skip.

import { db } from "../lib/supabase.ts";
import { log } from "../lib/log.ts";
import { sendWhatsAppText } from "../lib/whatsapp.ts";
import { lastClosedBusinessDay } from "../lib/time.ts";

const SPANISH_MONTHS = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];
const SPANISH_WEEKDAYS = [
  "Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado",
];

function formatCop(n: number): string {
  return Math.round(n).toLocaleString("es-CO");
}

function formatDate(d: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    weekday: "long",
  }).formatToParts(d);
  const get = (k: string) => parts.find((p) => p.type === k)!.value;
  const wd = get("weekday"); // English; convertir manualmente al índice ES
  const wdMap: Record<string, string> = {
    Sunday: "Domingo",
    Monday: "Lunes",
    Tuesday: "Martes",
    Wednesday: "Miércoles",
    Thursday: "Jueves",
    Friday: "Viernes",
    Saturday: "Sábado",
  };
  const day = parseInt(get("day"), 10);
  const monthIdx = parseInt(get("month"), 10) - 1;
  return `${wdMap[wd] ?? wd} ${day} de ${SPANISH_MONTHS[monthIdx]}`;
}

interface BusinessForReport {
  id: string;
  name: string;
  timezone: string;
  currency: string;
  owner_user_id: string;
  business_settings: {
    business_day_cutoff: string;
    daily_report_time: string;
    daily_report_enabled: boolean;
  };
}

export async function generateAndSendDailyReport(
  business: BusinessForReport,
  now: Date,
): Promise<{ ok: boolean; report_log_id?: string; reason?: string }> {
  const supabase = db();

  // 1. Calcular ventana del día operativo
  const window = lastClosedBusinessDay(
    business.business_settings.business_day_cutoff,
    business.timezone,
    now,
  );

  // 2. Idempotencia: ya enviado para este período?
  const { data: prevLog } = await supabase
    .from("report_logs")
    .select("id")
    .eq("business_id", business.id)
    .eq("type", "daily_close")
    .eq("period_start", window.start.toISOString())
    .maybeSingle();
  if (prevLog) {
    return { ok: true, report_log_id: (prevLog as any).id, reason: "already_sent" };
  }

  // 3. Cargar sales del período (status='active')
  const { data: salesData } = await supabase
    .from("sales")
    .select("id, total, payment_method, sold_at, seller_user_id, sale_items(qty, products(id, name, is_composite))")
    .eq("business_id", business.id)
    .eq("status", "active")
    .gte("sold_at", window.start.toISOString())
    .lte("sold_at", window.end.toISOString());
  const sales = (salesData ?? []) as any[];

  if (sales.length === 0) {
    log.info("daily_report_skipped_no_sales", {
      business_id: business.id,
      period: window.label,
    });
    return { ok: true, reason: "no_sales" };
  }

  // 4. Agregaciones
  const totalSales = sales.reduce((s, sa) => s + Number(sa.total), 0);

  // Por método de pago
  const byPayment = new Map<string, number>();
  for (const s of sales) {
    byPayment.set(s.payment_method, (byPayment.get(s.payment_method) ?? 0) + Number(s.total));
  }
  const paymentBreakdown = Array.from(byPayment.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([method, amount]) => ({
      method,
      amount,
      pct: Math.round((amount / totalSales) * 100),
    }));

  // Más vendido (por unidades del PRODUCTO TAL CUAL fue vendido — combos NO se desagregan)
  const productQty = new Map<string, { name: string; qty: number }>();
  for (const s of sales) {
    for (const it of (s.sale_items ?? []) as any[]) {
      const p = it.products;
      if (!p) continue;
      const cur = productQty.get(p.id) ?? { name: p.name, qty: 0 };
      cur.qty += Number(it.qty);
      productQty.set(p.id, cur);
    }
  }
  const topProducts = Array.from(productQty.values())
    .sort((a, b) => b.qty - a.qty)
    .slice(0, 5);

  // Inventario usado en el período (suma de consumption movements)
  const { data: movements } = await supabase
    .from("inventory_movements")
    .select("ingredient_id, qty_delta, ingredients(name, unit, current_stock, reorder_threshold)")
    .eq("business_id", business.id)
    .eq("type", "consumption")
    .gte("created_at", window.start.toISOString())
    .lte("created_at", window.end.toISOString());
  const usageByIng = new Map<string, { name: string; unit: string; used: number; current: number; threshold: number | null }>();
  for (const m of (movements ?? []) as any[]) {
    const ing = m.ingredients;
    if (!ing) continue;
    const cur = usageByIng.get(m.ingredient_id) ?? {
      name: ing.name,
      unit: ing.unit,
      used: 0,
      current: Number(ing.current_stock),
      threshold: ing.reorder_threshold !== null ? Number(ing.reorder_threshold) : null,
    };
    cur.used += -Number(m.qty_delta); // qty_delta es negativo en consumption
    usageByIng.set(m.ingredient_id, cur);
  }
  const inventoryUsed = Array.from(usageByIng.values())
    .filter((i) => i.used > 0)
    .sort((a, b) => b.used - a.used);

  // 5. Render del mensaje
  const lines: string[] = [];
  lines.push(`📊 *Cierre — ${formatDate(window.start, business.timezone)}*`);
  lines.push("");
  lines.push(`💰 Total vendido: *$${formatCop(totalSales)}*`);
  lines.push(`(${sales.length} venta${sales.length === 1 ? "" : "s"})`);
  lines.push("");
  lines.push("*Por método de pago:*");
  for (const p of paymentBreakdown) {
    lines.push(`• ${prettyPayment(p.method)}: $${formatCop(p.amount)} (${p.pct}%)`);
  }
  if (topProducts.length > 0) {
    lines.push("");
    lines.push(`🏆 *Más vendido:* ${topProducts[0].name} (${formatQty(topProducts[0].qty)} ${topProducts[0].qty === 1 ? "unidad" : "unidades"})`);
    if (topProducts.length > 1) {
      lines.push("");
      lines.push("*Top productos:*");
      for (const p of topProducts.slice(0, 5)) {
        lines.push(`• ${p.name} — ${formatQty(p.qty)}`);
      }
    }
  }
  if (inventoryUsed.length > 0) {
    lines.push("");
    lines.push("📦 *Inventario usado:*");
    for (const i of inventoryUsed.slice(0, 10)) {
      lines.push(`• ${i.name}: ${formatQty(i.used)} ${i.unit}`);
    }
    // Stock bajo
    const low = inventoryUsed.filter((i) => i.threshold !== null && i.current < i.threshold);
    if (low.length > 0) {
      lines.push("");
      lines.push("⚠️ *Stock bajo:*");
      for (const i of low) {
        lines.push(`• ${i.name}: ${formatQty(i.current)} ${i.unit} ${i.threshold !== null ? `(umbral ${formatQty(i.threshold)})` : ""}`);
      }
    }
  }

  const reportText = lines.join("\n");

  // 6. Enviar al dueño
  const { data: owner } = await supabase
    .from("users")
    .select("phone, name")
    .eq("id", business.owner_user_id)
    .maybeSingle();
  if (!owner || !(owner as any).phone) {
    log.error("daily_report_no_owner_phone", { business_id: business.id });
    return { ok: false, reason: "no_owner_phone" };
  }

  let sentId: string | null = null;
  let sendError: string | null = null;
  try {
    const sent = await sendWhatsAppText((owner as any).phone, reportText);
    sentId = sent.messages?.[0]?.id ?? sent.id ?? null;
  } catch (err) {
    sendError = String(err);
    log.error("daily_report_send_failed", { err: sendError, business_id: business.id });
  }

  // 7. Persistir el reporte en report_logs (siempre, incluso si falló el send)
  const payload = {
    total_sales: totalSales,
    sales_count: sales.length,
    payment_breakdown: paymentBreakdown,
    top_products: topProducts,
    inventory_used: inventoryUsed.map((i) => ({
      name: i.name,
      used: i.used,
      unit: i.unit,
      current: i.current,
    })),
    text: reportText,
    send_error: sendError,
  };

  const { data: logRow } = await supabase
    .from("report_logs")
    .insert({
      business_id: business.id,
      type: "daily_close",
      period_start: window.start.toISOString(),
      period_end: window.end.toISOString(),
      payload,
      sent_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  // 8. Persistir el outbound también (para que aparezca en la historia)
  if (sentId) {
    await supabase.from("messages").insert({
      business_id: business.id,
      user_id: business.owner_user_id,
      direction: "outbound",
      content_type: "text",
      raw_text: reportText,
      whatsapp_message_id: sentId,
      tool_calls: { kind: "daily_report", report_log_id: (logRow as any)?.id, period: window.label },
    });
  }

  log.info("daily_report_sent", {
    business_id: business.id,
    period: window.label,
    total: totalSales,
    sent_ok: !sendError,
  });

  return { ok: true, report_log_id: (logRow as any)?.id };
}

function prettyPayment(p: string): string {
  const map: Record<string, string> = {
    cash: "Efectivo",
    nequi: "Nequi",
    daviplata: "Daviplata",
    transfer: "Transferencia",
    card: "Tarjeta",
    bancolombia: "Bancolombia",
  };
  return map[p] ?? p;
}

function formatQty(n: number): string {
  // Si es entero, sin decimales. Si tiene decimales, máx 2.
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(2).replace(/\.?0+$/, "");
}
