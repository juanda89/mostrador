// Tipos de dominio. Cuando corramos `deno task db:types` se generará db.ts
// con los tipos exactos del schema. Mientras tanto, estos son los aliases
// que usan agents/tools/jobs sin acoplarse al cliente Supabase.

export type UUID = string;
export type BusinessState = "onboarding" | "production";
export type MemberRole = "owner" | "seller";
export type SaleStatus = "active" | "corrected" | "voided";
export type MovementType =
  | "purchase"
  | "consumption"
  | "manual_adjust"
  | "initial_set"
  | "correction";
export type PurchaseSource = "photo" | "voice" | "text";
export type Direction = "inbound" | "outbound";
export type ContentType = "text" | "audio" | "image" | "location" | "interactive";
export type ReportType = "daily_close" | "weekly";
export type ShiftStartSource = "location" | "auto_from_sale";
export type ShiftEndSource = "location" | "manual" | "auto_cutoff";
export type UnitType = "g" | "kg" | "ml" | "l" | "unit";
export type Weekday =
  | "monday"
  | "tuesday"
  | "wednesday"
  | "thursday"
  | "friday"
  | "saturday"
  | "sunday";

export interface User {
  id: UUID;
  phone: string;
  name: string | null;
}

export interface Business {
  id: UUID;
  name: string;
  owner_user_id: UUID;
  timezone: string;
  currency: string;
  state: BusinessState;
  activated_at: string | null;
}

export interface Membership {
  business_id: UUID;
  user_id: UUID;
  role: MemberRole;
  active: boolean;
}

export interface BusinessSettings {
  business_id: UUID;
  accepted_payment_methods: string[];
  daily_report_time: string;        // "HH:mm"
  business_day_cutoff: string;      // "HH:mm"
  daily_report_enabled: boolean;
  weekly_report_day: Weekday;
  weekly_report_time: string;       // "HH:mm"
  sale_notifications_enabled: boolean;
  correction_notifications_enabled: boolean;
  default_location_radius_m: number;
}

export interface MessageRecord {
  id: UUID;
  business_id: UUID | null;
  user_id: UUID;
  direction: Direction;
  content_type: ContentType;
  raw_text: string | null;
  media_url: string | null;
  transcript: string | null;
  extracted_data: unknown | null;
  latitude: number | null;
  longitude: number | null;
  parsed_intent: string | null;
  tool_calls: unknown | null;
  whatsapp_message_id: string | null;
  created_at: string;
}

/**
 * Contexto que las tools reciben al ejecutarse.
 * Lo construye el router antes de invocar al agente.
 */
export interface ToolContext {
  user: User;
  business: Business;
  settings: BusinessSettings;
  memberships: Membership[];
  inboundMessage: MessageRecord;
  /** Rol efectivo del speaker en este business (owner o seller; prioriza owner si tiene ambos) */
  role: MemberRole;
}
