// Edge Function: cron-tick
// Invocada cada minuto por pg_cron (ver supabase/migrations/0003_cron.sql).
// Recorre los negocios en producción y dispara, según la hora local:
//   - autoCloseOpenShifts si hh:mm === business_day_cutoff
//   - generateDailyReport si hh:mm === daily_report_time
//   - generateWeeklyReport si weekday + hh:mm coinciden
//
// Autenticación: header x-cron-secret que comparte secret con pg_cron.

import { runTick } from "../_shared/jobs/tick.ts";
import { log } from "../_shared/lib/log.ts";

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const secret = req.headers.get("x-cron-secret");
  const expected = Deno.env.get("CRON_SECRET");
  if (!expected || secret !== expected) {
    log.warn("cron_unauthorized");
    return new Response("Unauthorized", { status: 401 });
  }

  try {
    const summary = await runTick(new Date());
    return new Response(JSON.stringify({ ok: true, ...summary }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    log.error("cron_tick_failed", { err: String(err) });
    return new Response(JSON.stringify({ ok: false, error: String(err) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
