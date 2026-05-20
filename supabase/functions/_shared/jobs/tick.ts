// Loop del cron-tick.
// Por cada negocio en producción, evalúa si en esta hora local hay que disparar:
//   - autoCloseOpenShifts (en cutoff)
//   - generateDailyReport (en daily_report_time)
//   - generateWeeklyReport (en weekly_report_day + weekly_report_time)
//
// La lógica concreta de cada job vive en jobs/auto-close-shifts.ts, jobs/daily-report.ts, etc.
// V1: solo el shell. Los jobs detallados se completan en Fases 5 y 6 del plan.

import { db } from "../lib/supabase.ts";
import { log } from "../lib/log.ts";
import { localHHMM, localWeekday } from "../lib/time.ts";
import { generateAndSendDailyReport } from "./daily-report.ts";

interface TickSummary {
  businesses_evaluated: number;
  shifts_auto_closed: number;
  daily_reports_sent: number;
  weekly_reports_sent: number;
}

export async function runTick(now: Date): Promise<TickSummary> {
  const supabase = db();
  const { data: businesses, error } = await supabase
    .from("businesses")
    .select("id, name, timezone, currency, owner_user_id, state, business_settings(*)")
    .eq("state", "production");
  if (error) throw error;

  const summary: TickSummary = {
    businesses_evaluated: 0,
    shifts_auto_closed: 0,
    daily_reports_sent: 0,
    weekly_reports_sent: 0,
  };

  // deno-lint-ignore no-explicit-any
  for (const b of (businesses ?? []) as any[]) {
    summary.businesses_evaluated++;
    const settings = b.business_settings;
    if (!settings) continue;

    const hhmm = localHHMM(now, b.timezone);
    const weekday = localWeekday(now, b.timezone);

    // Cutoff → autoCloseOpenShifts (Fase 5).
    if (hhmm === settings.business_day_cutoff.slice(0, 5)) {
      try {
        // const closed = await autoCloseOpenShifts(b.id, b.timezone, now);
        // summary.shifts_auto_closed += closed;
        log.info("auto_close_pending_impl", { business_id: b.id });
      } catch (err) {
        log.error("auto_close_failed", { business_id: b.id, err: String(err) });
      }
    }

    // Daily report.
    if (
      settings.daily_report_enabled &&
      hhmm === settings.daily_report_time.slice(0, 5)
    ) {
      try {
        const result = await generateAndSendDailyReport(
          {
            id: b.id,
            name: b.name,
            timezone: b.timezone,
            currency: b.currency,
            owner_user_id: b.owner_user_id,
            business_settings: settings,
          },
          now,
        );
        if (result.ok && result.report_log_id) summary.daily_reports_sent++;
      } catch (err) {
        log.error("daily_report_failed", { business_id: b.id, err: String(err) });
      }
    }

    // Weekly report (Fase 6).
    if (
      weekday === settings.weekly_report_day &&
      hhmm === settings.weekly_report_time.slice(0, 5)
    ) {
      try {
        // await generateAndSendWeeklyReport(b.id, b.timezone, now);
        // summary.weekly_reports_sent++;
        log.info("weekly_report_pending_impl", { business_id: b.id });
      } catch (err) {
        log.error("weekly_report_failed", { business_id: b.id, err: String(err) });
      }
    }
  }

  return summary;
}
