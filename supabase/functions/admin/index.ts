// API for administrasjonspanelet. Krever innlogget Supabase-bruker.
import { corsHeaders, json } from "../_shared/http.ts";
import { encrypt } from "../_shared/crypto.ts";
import { adminDb, apisFor, type ClientFull, runClientSync } from "../_shared/db.ts";
import { DEFAULT_SETTINGS } from "../_shared/sync.ts";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

const SECRET_FIELDS = {
  sqs_api_key: "sqs_api_key_enc",
  tx_api_token: "tx_api_token_enc",
  tx_consumer_token: "tx_consumer_token_enc",
  tx_employee_token: "tx_employee_token_enc",
} as const;

function publicClient(c: ClientFull & Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(c)) if (!k.endsWith("_enc") && k !== "locked_until") out[k] = v;
  out.has_secrets = Object.fromEntries(Object.entries(SECRET_FIELDS).map(([k, col]) => [k, !!c[col]]));
  out.settings = { ...DEFAULT_SETTINGS, ...(c.settings ?? {}) };
  return out;
}

class BadRequest extends Error {}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Kun POST" }, 405);

  const db = adminDb();

  // --- autentisering ---
  const jwt = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: auth } = await db.auth.getUser(jwt);
  if (!auth?.user) return json({ error: "Ikke innlogget" }, 401);
  const allow = (Deno.env.get("ADMIN_EMAILS") ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (allow.length && !allow.includes((auth.user.email ?? "").toLowerCase())) return json({ error: "Ingen tilgang" }, 403);

  const body = await req.json().catch(() => ({}));
  const { action } = body as { action?: string };

  const loadClient = async (id: string): Promise<ClientFull & Record<string, unknown>> => {
    const { data, error } = await db.from("clients").select("*").eq("id", id).maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new BadRequest("Klienten finnes ikke");
    return data;
  };

  const testConnection = async (c: ClientFull) => {
    const out: { squarespace: { ok: boolean; message: string }; tripletex: { ok: boolean; message: string } } = {
      squarespace: { ok: false, message: "" }, tripletex: { ok: false, message: "" },
    };
    let apis;
    try {
      apis = await apisFor(c);
    } catch (e) {
      out.squarespace.message = (e as Error).message;
      out.tripletex.message = (e as Error).message;
      return out;
    }
    try {
      await apis.sqs.test();
      out.squarespace = { ok: true, message: "Tilkoblet" };
    } catch (e) {
      out.squarespace.message = (e as Error).message;
    }
    try {
      const who = await apis.tx.whoAmI();
      out.tripletex = { ok: true, message: `Tilkoblet${who.companyName ? ` – ${who.companyName}` : ""}` };
    } catch (e) {
      out.tripletex.message = (e as Error).message;
    }
    return out;
  };

  try {
    switch (action) {
      case "list_clients": {
        const { data, error } = await db.from("clients").select("*").order("name");
        if (error) throw new Error(error.message);
        return json({ clients: (data ?? []).map(publicClient) });
      }

      case "get_client":
        return json({ client: publicClient(await loadClient(body.id)) });

      case "save_client": {
        const c = body.client ?? {};
        if (!c.name?.trim()) throw new BadRequest("Navn er påkrevd");
        const row: Record<string, unknown> = {
          name: c.name.trim(),
          tx_environment: c.tx_environment === "test" ? "test" : "production",
          tx_auth_mode: c.tx_auth_mode === "consumer_employee" ? "consumer_employee" : "api_token",
          tx_company_id: String(c.tx_company_id ?? "0").trim() || "0",
          settings: { ...DEFAULT_SETTINGS, ...(c.settings ?? {}) },
          updated_at: new Date().toISOString(),
        };
        if ("sync_from" in c) row.sync_from = c.sync_from || null;
        for (const [k, col] of Object.entries(SECRET_FIELDS)) {
          const v = body.secrets?.[k];
          if (typeof v === "string" && v.trim()) row[col] = await encrypt(v.trim());
        }
        const q = c.id ? db.from("clients").update(row).eq("id", c.id) : db.from("clients").insert(row);
        const { data, error } = await q.select("*").single();
        if (error) throw new Error(error.message);
        return json({ client: publicClient(data) });
      }

      case "test_connection":
        return json(await testConnection(await loadClient(body.id)));

      case "tripletex_options": {
        const { tx } = await apisFor(await loadClient(body.id));
        const [vatTypes, paymentTypes] = await Promise.all([tx.vatTypes(), tx.paymentTypes()]);
        return json({ vatTypes, paymentTypes });
      }

      case "activate": {
        const c = await loadClient(body.id);
        const t = await testConnection(c);
        if (!t.squarespace.ok || !t.tripletex.ok) return json({ ok: false, test: t }, 200);
        const s = { ...DEFAULT_SETTINGS, ...(c.settings ?? {}) };
        if (s.create_invoice && s.mark_invoice_paid && !s.payment_type_id) {
          throw new BadRequest("Velg betalingstype (konto for innbetaling) før aktivering, eller slå av «Marker faktura som betalt».");
        }
        const patch: Record<string, unknown> = { active: true, last_error: null, updated_at: new Date().toISOString() };
        if (!c.sync_from) patch.sync_from = new Date().toISOString();
        const { error } = await db.from("clients").update(patch).eq("id", c.id);
        if (error) throw new Error(error.message);
        const first = runClientSync(db, c.id, "aktivering", 120_000);
        if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(first);
        return json({ ok: true, test: t });
      }

      case "deactivate": {
        const { error } = await db.from("clients").update({ active: false, updated_at: new Date().toISOString() }).eq("id", body.id);
        if (error) throw new Error(error.message);
        return json({ ok: true });
      }

      case "run_now":
        await loadClient(body.id);
        return json(await runClientSync(db, body.id, "manuell", 100_000));

      case "logs": {
        const [runs, orders] = await Promise.all([
          db.from("sync_runs").select("*").eq("client_id", body.id).order("started_at", { ascending: false }).limit(25),
          db.from("synced_orders").select("*").eq("client_id", body.id).order("updated_at", { ascending: false }).limit(100),
        ]);
        if (runs.error) throw new Error(runs.error.message);
        if (orders.error) throw new Error(orders.error.message);
        return json({ runs: runs.data, orders: orders.data });
      }

      case "retry_order": {
        const { error } = await db.from("synced_orders").update({ status: "error", attempts: 0, updated_at: new Date().toISOString() })
          .eq("client_id", body.id).eq("sqs_order_id", body.sqs_order_id).neq("status", "done");
        if (error) throw new Error(error.message);
        return json({ ok: true });
      }

      case "reset_sync": {
        // Synkroniser på nytt fra en dato (allerede synkroniserte ordre hoppes over).
        const { error } = await db.from("clients").update({
          sync_from: body.sync_from, orders_watermark: null, updated_at: new Date().toISOString(),
        }).eq("id", body.id);
        if (error) throw new Error(error.message);
        return json({ ok: true });
      }

      case "delete_client": {
        const { error } = await db.from("clients").delete().eq("id", body.id);
        if (error) throw new Error(error.message);
        return json({ ok: true });
      }

      default:
        return json({ error: `Ukjent handling: ${action}` }, 400);
    }
  } catch (e) {
    return json({ error: (e as Error).message }, e instanceof BadRequest ? 400 : 500);
  }
});
