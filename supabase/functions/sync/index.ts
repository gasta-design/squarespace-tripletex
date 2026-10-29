// Kalles av pg_cron (hvert 10. minutt) – én forespørsel per aktiv klient.
import { corsHeaders, json } from "../_shared/http.ts";
import { adminDb, runClientSync } from "../_shared/db.ts";

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const secret = Deno.env.get("CRON_SECRET");
  const given = req.headers.get("x-cron-secret") ?? "";
  if (!secret || !safeEqual(given, secret)) return json({ error: "Ikke autorisert" }, 401);

  const { client_id, trigger } = await req.json().catch(() => ({}));
  if (!client_id) return json({ error: "client_id mangler" }, 400);

  const result = await runClientSync(adminDb(), client_id, trigger ?? "cron", 120_000);
  return json(result);
});
