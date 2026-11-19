// Paylasim takip uygulamasinin sunucu tarafi.
// Anahtarlar Supabase Vault'ta (paylasim_keys); telefona hic gitmez.
import { createClient } from "npm:@supabase/supabase-js@2";
import { build, collect, todayIstanbul } from "./core.js";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

async function isOwner(req: Request): Promise<boolean> {
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return false;
  const { data, error } = await db.auth.getUser(token);
  if (error || !data?.user) return false;
  const { data: owner } = await db.from("app_owner").select("user_id").eq("id", 1).maybeSingle();
  return owner?.user_id === data.user.id;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST bekleniyor" }, 405);
  try {
    if (!(await isOwner(req))) return json({ error: "Giriş gerekli" }, 401);
    const body = await req.json().catch(() => ({}));
    const date = /^\d{4}-\d{2}-\d{2}$/.test(body.date ?? "") ? body.date : todayIstanbul();

    const { data: keys, error: kErr } = await db.rpc("paylasim_keys");
    if (kErr || !keys) return json({ error: "Anahtarlar okunamadı" }, 500);

    const { data: row } = await db.from("paylasim_cache").select("data").eq("key", "raw").maybeSingle();
    const cache = row?.data ?? null;
    const raw = await collect(keys, date, cache, { force: !!body.force });

    // bugunun ham verisini onbellege yaz (baska gunler onbellegi ezmesin)
    if (date === todayIstanbul()) {
      await db.from("paylasim_cache").upsert({ key: "raw", data: { buffer: raw.buffer, yt: raw.yt, meta: raw.meta }, updated_at: new Date().toISOString() });
    } else if (cache) {
      await db.from("paylasim_cache").upsert({ key: "raw", data: { ...cache, meta: raw.meta }, updated_at: new Date().toISOString() });
    }
    return json(build(raw, date));
  } catch (e) {
    console.error(e);
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
