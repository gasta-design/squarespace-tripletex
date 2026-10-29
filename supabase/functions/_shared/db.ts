import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { decrypt } from "./crypto.ts";
import { Squarespace } from "./squarespace.ts";
import { Tripletex, type TxEnv } from "./tripletex.ts";
import { type ClientRow, type Store, SyncEngine, type SyncedOrderRow } from "./sync.ts";

export function serviceKey(): string {
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy) return legacy;
  // Nyere prosjekter: SUPABASE_SECRET_KEYS = {"default": "sb_secret_..."}
  try {
    const keys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}");
    const k = keys.default ?? Object.values(keys)[0];
    if (k) return k as string;
  } catch { /* ignorer */ }
  throw new Error("Fant ingen service-nøkkel i miljøet");
}

export function adminDb(): SupabaseClient {
  return createClient(Deno.env.get("SUPABASE_URL")!, serviceKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function check<T>(r: { data: T; error: { message: string } | null }): T {
  if (r.error) throw new Error(`Database: ${r.error.message}`);
  return r.data;
}

export class SupabaseStore implements Store {
  constructor(private db: SupabaseClient) {}

  async updateClient(id: string, patch: Record<string, unknown>) {
    check(await this.db.from("clients").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id));
  }
  async getSyncedOrder(clientId: string, orderId: string) {
    return check(await this.db.from("synced_orders").select("*").eq("client_id", clientId).eq("sqs_order_id", orderId).maybeSingle()) as SyncedOrderRow | null;
  }
  async saveSyncedOrder(row: SyncedOrderRow) {
    check(await this.db.from("synced_orders").upsert({ ...row, updated_at: new Date().toISOString() }, { onConflict: "client_id,sqs_order_id" }));
  }
  async listRetryable(clientId: string, maxAttempts: number) {
    return check(await this.db.from("synced_orders").select("*").eq("client_id", clientId).eq("status", "error")
      .lt("attempts", maxAttempts).order("updated_at").limit(20)) as SyncedOrderRow[];
  }
  async getProductId(clientId: string, number: string) {
    const r = check(await this.db.from("product_map").select("tx_product_id").eq("client_id", clientId).eq("product_number", number).maybeSingle()) as { tx_product_id: number } | null;
    return r?.tx_product_id ?? null;
  }
  async setProductId(clientId: string, number: string, id: number) {
    check(await this.db.from("product_map").upsert({ client_id: clientId, product_number: number, tx_product_id: id, updated_at: new Date().toISOString() }));
  }
  async getCustomerId(clientId: string, email: string) {
    const r = check(await this.db.from("customer_map").select("tx_customer_id").eq("client_id", clientId).eq("email", email).maybeSingle()) as { tx_customer_id: number } | null;
    return r?.tx_customer_id ?? null;
  }
  async setCustomerId(clientId: string, email: string, id: number) {
    check(await this.db.from("customer_map").upsert({ client_id: clientId, email, tx_customer_id: id, updated_at: new Date().toISOString() }));
  }
}

export interface ClientFull extends ClientRow {
  sqs_api_key_enc: string | null;
  tx_environment: TxEnv;
  tx_auth_mode: "api_token" | "consumer_employee";
  tx_api_token_enc: string | null;
  tx_consumer_token_enc: string | null;
  tx_employee_token_enc: string | null;
  tx_company_id: string;
}

export async function apisFor(c: ClientFull) {
  const key = await decrypt(c.sqs_api_key_enc);
  if (!key) throw new Error("Squarespace API-nøkkel mangler");
  const sqs = new Squarespace(key);
  const tx = new Tripletex({
    environment: c.tx_environment,
    mode: c.tx_auth_mode,
    apiToken: await decrypt(c.tx_api_token_enc),
    consumerToken: await decrypt(c.tx_consumer_token_enc),
    employeeToken: await decrypt(c.tx_employee_token_enc),
    companyId: c.tx_company_id,
  });
  return { sqs, tx };
}

/** Kjører én synk for én klient med lås og logging. */
export async function runClientSync(db: SupabaseClient, clientId: string, trigger: string, budgetMs = 120_000) {
  const store = new SupabaseStore(db);
  const client = check(await db.from("clients").select("*").eq("id", clientId).maybeSingle()) as ClientFull | null;
  if (!client) throw new Error("Klient finnes ikke");
  if (!client.active && trigger === "cron") return { skipped: "inaktiv" };

  const locked = check(await db.rpc("try_lock_client", { p_client_id: clientId, p_seconds: Math.ceil(budgetMs / 1000) + 60 })) as boolean;
  if (!locked) return { skipped: "en annen kjøring pågår" };

  const run = check(await db.from("sync_runs").insert({ client_id: clientId, trigger }).select("id").single()) as { id: number };
  const startedAt = new Date().toISOString();
  try {
    const { sqs, tx } = await apisFor(client);
    const engine = new SyncEngine(client, store, sqs, tx, { deadline: Date.now() + budgetMs });
    const res = await engine.run();
    const status = res.ordersFailed > 0 || res.messages.some((m) => m.includes("feilet")) ? "warning" : "ok";
    const message = res.messages.slice(0, 30).join("\n") || null;
    check(await db.from("sync_runs").update({
      finished_at: new Date().toISOString(), status, message,
      orders_synced: res.ordersSynced, orders_failed: res.ordersFailed, products_synced: res.productsSynced,
    }).eq("id", run.id));
    await store.updateClient(clientId, { last_run_at: startedAt, last_run_status: status, last_error: status === "ok" ? null : message });
    return { status, ...res };
  } catch (e) {
    const msg = (e as Error).message;
    await db.from("sync_runs").update({ finished_at: new Date().toISOString(), status: "error", message: msg }).eq("id", run.id);
    await store.updateClient(clientId, { last_run_at: startedAt, last_run_status: "error", last_error: msg });
    return { status: "error", error: msg };
  } finally {
    await db.rpc("unlock_client", { p_client_id: clientId });
  }
}
