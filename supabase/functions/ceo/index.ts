// Sirket CEO beyni
// Claude CEO isi planlar, mudurlere (Gemini, GPT, Claude, Grok, gorsel modelleri) tool olarak dagitir,
// sonuclari toplar ve Cem'e tek cevap yazar. Her adim ayri bir fonksiyon cagrisinda calisir,
// boylece uzun isler zaman sinirina takilmaz ve mudurler paralel calisir.

import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
function secretKey(): string {
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy) return legacy;
  try {
    const keys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}");
    const first = Object.values(keys)[0];
    if (typeof first === "string") return first;
  } catch { /* yok */ }
  throw new Error("Servis anahtarı bulunamadı");
}
const SERVICE_KEY = secretKey();
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SELF_URL = `${SUPABASE_URL}/functions/v1/ceo`;

const MAX_STEPS = 8;
const HISTORY_LIMIT = 30;
const RESULT_CHAR_LIMIT = 24000;
const BUCKET = "ceo-files";

const KEYS = {
  anthropic: () => Deno.env.get("ANTHROPIC_API_KEY"),
  openai: () => Deno.env.get("OPENAI_API_KEY"),
  gemini: () => Deno.env.get("GEMINI_API_KEY"),
  xai: () => Deno.env.get("XAI_API_KEY"),
};

const PROVIDER_KEY: Record<string, keyof typeof KEYS> = {
  anthropic: "anthropic",
  openai: "openai",
  openai_image: "openai",
  gemini: "gemini",
  gemini_image: "gemini",
  xai: "xai",
};

const db: SupabaseClient = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false },
});

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-internal-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

type Agent = {
  key: string;
  name: string;
  title: string;
  provider: string;
  model: string;
  description: string;
  system_prompt: string;
  options: Record<string, any>;
  enabled: boolean;
};

// ---------------------------------------------------------------- giris

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST bekleniyor" }, 405);

  let body: any = {};
  try {
    body = await req.json();
  } catch {
    return json({ error: "Geçersiz JSON" }, 400);
  }

  const internal = req.headers.get("x-internal-key") === SERVICE_KEY;

  try {
    if (body.action === "step" || body.action === "work") {
      if (!internal) return json({ error: "Yetkisiz" }, 401);
      const job = body.action === "step" ? doStep(body.run_id) : doWork(body.task_id);
      EdgeRuntime.waitUntil(job.catch((e) => console.error(body.action, e)));
      return json({ ok: true }, 202);
    }

    // Uygulamadan gelen istekler: sahip kontrolu
    const userId = await ownerFromRequest(req);
    if (!userId) return json({ error: "Bu şirkete erişim yetkin yok." }, 403);

    if (body.action === "send") return await handleSend(body);
    if (body.action === "health") return json(health());
    if (body.action === "cancel") return await handleCancel(body);
    return json({ error: "Bilinmeyen işlem" }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});

async function ownerFromRequest(req: Request): Promise<string | null> {
  const auth = req.headers.get("Authorization") ?? "";
  const token = auth.replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const { data, error } = await db.auth.getUser(token);
  if (error || !data?.user) return null;
  const { data: owner } = await db.from("app_owner").select("user_id").eq("id", 1).maybeSingle();
  return owner?.user_id === data.user.id ? data.user.id : null;
}

function health() {
  return {
    keys: {
      anthropic: !!KEYS.anthropic(),
      openai: !!KEYS.openai(),
      gemini: !!KEYS.gemini(),
      xai: !!KEYS.xai(),
    },
  };
}

async function callSelf(action: "step" | "work", payload: Record<string, unknown>) {
  const res = await fetch(SELF_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-internal-key": SERVICE_KEY,
      Authorization: `Bearer ${ANON_KEY || SERVICE_KEY}`,
    },
    body: JSON.stringify({ action, ...payload }),
  });
  if (!res.ok && res.status !== 202) {
    throw new Error(`İç çağrı başarısız (${action}): ${res.status} ${await res.text()}`);
  }
}

// ---------------------------------------------------------------- mesaj gonder

async function handleSend(body: any) {
  const text = String(body.text ?? "").trim();
  if (!text) return json({ error: "Mesaj boş" }, 400);
  if (!KEYS.anthropic()) {
    return json({ error: "ANTHROPIC_API_KEY eksik. Supabase > Edge Functions > Secrets bölümüne ekle." }, 400);
  }

  let conversationId: string | null = body.conversation_id ?? null;
  if (!conversationId) {
    const title = text.replace(/\s+/g, " ").slice(0, 48);
    const { data, error } = await db.from("conversations").insert({ title }).select("id").single();
    if (error) throw error;
    conversationId = data.id;
  }

  const { error: mErr } = await db.from("messages").insert({
    conversation_id: conversationId,
    role: "user",
    content: text,
  });
  if (mErr) throw mErr;

  const history = await buildHistory(conversationId!);
  const { data: run, error: rErr } = await db
    .from("runs")
    .insert({ conversation_id: conversationId, status: "thinking", note: "CEO düşünüyor" })
    .select("id")
    .single();
  if (rErr) throw rErr;
  const { error: memErr } = await db.from("run_memory").insert({ run_id: run.id, llm_messages: history });
  if (memErr) throw memErr;

  await db.from("conversations").update({ updated_at: new Date().toISOString() }).eq("id", conversationId);
  await callSelf("step", { run_id: run.id });
  return json({ conversation_id: conversationId, run_id: run.id });
}

async function handleCancel(body: any) {
  const { data: run } = await db.from("runs").select("*").eq("id", body.run_id).maybeSingle();
  if (!run || run.status === "done" || run.status === "error") return json({ ok: true });
  await db.from("runs").update({ status: "error", error: "Cem iptal etti", note: null }).eq("id", run.id);
  await db.from("messages").insert({
    conversation_id: run.conversation_id,
    role: "error",
    content: "İş iptal edildi.",
    run_id: run.id,
  });
  return json({ ok: true });
}

async function buildHistory(conversationId: string) {
  const { data } = await db
    .from("messages")
    .select("role, content, images, created_at")
    .eq("conversation_id", conversationId)
    .in("role", ["user", "ceo"])
    .order("created_at", { ascending: false })
    .limit(HISTORY_LIMIT);
  const rows = (data ?? []).reverse();

  const msgs: { role: "user" | "assistant"; content: string }[] = [];
  for (const r of rows) {
    const role = r.role === "user" ? "user" : "assistant";
    let content = r.content || "";
    const imgCount = Array.isArray(r.images) ? r.images.length : 0;
    if (role === "assistant" && imgCount) content += `\n\n[Bu cevapla birlikte ${imgCount} görsel paylaşıldı.]`;
    if (!content.trim()) continue;
    const last = msgs[msgs.length - 1];
    if (last && last.role === role) last.content += "\n\n" + content;
    else msgs.push({ role, content });
  }
  while (msgs.length && msgs[0].role !== "user") msgs.shift();
  return msgs;
}

// ---------------------------------------------------------------- CEO adimi

async function loadAgents(): Promise<Agent[]> {
  const { data, error } = await db.from("agents").select("*").order("sort");
  if (error) throw error;
  return data as Agent[];
}

function toolsFor(agents: Agent[]) {
  return agents
    .filter((a) => a.key !== "ceo" && a.enabled)
    .map((a) => {
      const isImage = a.provider.endsWith("_image");
      const properties: Record<string, unknown> = {
        instruction: {
          type: "string",
          description: isImage
            ? "Detaylı görsel promptu (tercihen İngilizce): konu, kompozisyon, ışık, stil, renkler, görselde geçecek yazılar."
            : "Müdüre verilecek eksiksiz talimat. Sohbet geçmişini görmez; tüm bağlamı, hedefi, formatı ve dili yaz.",
        },
      };
      if (isImage) {
        properties.aspect = {
          type: "string",
          enum: ["square", "landscape", "portrait"],
          description: "Görsel oranı. Varsayılan square.",
        };
      }
      const keyMissing = !KEYS[PROVIDER_KEY[a.provider]]();
      return {
        name: a.key,
        description:
          `${a.name} (${a.title}). ${a.description}` +
          (keyMissing ? " [UYARI: Bu müdürün API anahtarı tanımlı değil, şu an çalışmaz.]" : ""),
        input_schema: { type: "object", properties, required: ["instruction"] },
      };
    });
}

async function anthropicCall(payload: Record<string, unknown>) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": KEYS.anthropic() ?? "",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${data?.error?.message ?? JSON.stringify(data).slice(0, 400)}`);
  return data;
}

function addUsage(acc: any, provider: string, u: any) {
  const out = { ...(acc ?? {}) };
  const cur = out[provider] ?? { input: 0, output: 0 };
  cur.input += u?.input_tokens ?? u?.prompt_tokens ?? u?.promptTokenCount ?? 0;
  cur.output += u?.output_tokens ?? u?.completion_tokens ?? u?.candidatesTokenCount ?? 0;
  out[provider] = cur;
  return out;
}

async function getMemory(runId: string): Promise<any[]> {
  const { data } = await db.from("run_memory").select("llm_messages").eq("run_id", runId).single();
  return data?.llm_messages ?? [];
}
async function setMemory(runId: string, llm_messages: any[]) {
  const { error } = await db.from("run_memory").update({ llm_messages }).eq("run_id", runId);
  if (error) throw error;
}

async function doStep(runId: string) {
  const { data: run } = await db.from("runs").select("*").eq("id", runId).single();
  if (!run || run.status === "done" || run.status === "error") return;

  try {
    const memory = await getMemory(runId);
    const agents = await loadAgents();
    const ceo = agents.find((a) => a.key === "ceo");
    if (!ceo) throw new Error("CEO tanımı bulunamadı");
    const tools = toolsFor(agents);
    const now = new Date().toLocaleString("tr-TR", { timeZone: "Europe/Istanbul" });
    const forceFinish = run.step >= MAX_STEPS;

    const payload: Record<string, unknown> = {
      model: ceo.model,
      max_tokens: ceo.options?.max_tokens ?? 8000,
      system:
        ceo.system_prompt +
        `\n\nŞu an (İstanbul saati): ${now}.` +
        (forceFinish ? "\n\nAdım sınırına gelindi. Yeni görev verme, eldeki sonuçlarla cevabı yaz." : ""),
      messages: memory,
    };
    if (tools.length) {
      payload.tools = tools;
      if (forceFinish) payload.tool_choice = { type: "none" };
    }

    const resp = await anthropicCall(payload);
    const messages = [...memory, { role: "assistant", content: resp.content }];
    await setMemory(run.id, messages);
    const usage = addUsage(run.usage, "anthropic", resp.usage);
    const blocks: any[] = resp.content ?? [];
    const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
    const toolUses = blocks.filter((b) => b.type === "tool_use");

    if (resp.stop_reason === "tool_use" && toolUses.length) {
      const step = run.step + 1;
      const rows = toolUses.map((t) => ({
        run_id: run.id,
        conversation_id: run.conversation_id,
        step,
        tool_use_id: t.id,
        agent_key: t.name,
        instruction: String(t.input?.instruction ?? ""),
        params: t.input ?? {},
      }));
      const { data: tasks, error } = await db.from("tasks").insert(rows).select("id");
      if (error) throw error;

      await db
        .from("runs")
        .update({
          usage,
          step,
          pending: tasks!.length,
          status: "delegating",
          note: text || `${tasks!.length} müdüre görev verildi`,
          updated_at: new Date().toISOString(),
        })
        .eq("id", run.id);

      await Promise.all(tasks!.map((t) => callSelf("work", { task_id: t.id })));
      return;
    }

    if (resp.stop_reason === "pause_turn") {
      await db.from("runs").update({ usage, updated_at: new Date().toISOString() }).eq("id", run.id);
      await callSelf("step", { run_id: run.id });
      return;
    }

    // Final cevap
    const { data: imgTasks } = await db.from("tasks").select("images").eq("run_id", run.id);
    const images = (imgTasks ?? []).flatMap((t: any) => (Array.isArray(t.images) ? t.images : []));
    let finalText = text;
    if (resp.stop_reason === "refusal" && !finalText) finalText = "Bu isteği yerine getiremiyorum.";
    if (!finalText) finalText = images.length ? "Görseller hazır." : "(Boş cevap)";

    await db.from("messages").insert({
      conversation_id: run.conversation_id,
      role: "ceo",
      content: finalText,
      images,
      run_id: run.id,
    });
    await db
      .from("runs")
      .update({ usage, status: "done", note: null, updated_at: new Date().toISOString() })
      .eq("id", run.id);
    await db.from("conversations").update({ updated_at: new Date().toISOString() }).eq("id", run.conversation_id);
  } catch (e) {
    await failRun(run, e);
  }
}

async function failRun(run: any, e: unknown) {
  const msg = String((e as Error)?.message ?? e);
  console.error("run error", run.id, msg);
  await db.from("runs").update({ status: "error", error: msg, note: null }).eq("id", run.id);
  await db.from("messages").insert({
    conversation_id: run.conversation_id,
    role: "error",
    content: `CEO bir hatayla karşılaştı: ${msg}`,
    run_id: run.id,
  });
}

// ---------------------------------------------------------------- mudur isi

async function doWork(taskId: string) {
  const { data: task } = await db.from("tasks").select("*").eq("id", taskId).single();
  if (!task || task.status !== "queued") return;

  await db.from("tasks").update({ status: "running", started_at: new Date().toISOString() }).eq("id", task.id);

  try {
    const { data: agent } = await db.from("agents").select("*").eq("key", task.agent_key).maybeSingle();
    if (!agent) throw new Error(`"${task.agent_key}" adında bir müdür yok`);
    if (!agent.enabled) throw new Error(`${agent.name} şu an devre dışı`);
    const keyName = PROVIDER_KEY[agent.provider];
    if (!KEYS[keyName]()) throw new Error(`${agent.name} için ${keyName.toUpperCase()} API anahtarı tanımlı değil`);

    const result = await runAgent(agent as Agent, task);
    await db
      .from("tasks")
      .update({
        status: "done",
        output: result.text,
        images: result.images,
        usage: result.usage ?? null,
        finished_at: new Date().toISOString(),
      })
      .eq("id", task.id);
  } catch (e) {
    await db
      .from("tasks")
      .update({ status: "error", error: String((e as Error)?.message ?? e), finished_at: new Date().toISOString() })
      .eq("id", task.id);
  }

  const { data: left } = await db.rpc("finish_task_step", { p_run: task.run_id });
  if (left === 0) await resumeRun(task.run_id);
}

async function resumeRun(runId: string) {
  const { data: run } = await db.from("runs").select("*").eq("id", runId).single();
  if (!run || run.status === "done" || run.status === "error") return;

  const { data: tasks } = await db.from("tasks").select("*").eq("run_id", runId).eq("step", run.step);
  const byToolId = new Map((tasks ?? []).map((t: any) => [t.tool_use_id, t]));
  const memory = await getMemory(runId);
  const lastAssistant = [...memory].reverse().find((m: any) => m.role === "assistant");
  const toolUses = (lastAssistant?.content ?? []).filter((b: any) => b.type === "tool_use");

  let usage = run.usage;
  const results = toolUses.map((tu: any) => {
    const t: any = byToolId.get(tu.id);
    if (!t) return { type: "tool_result", tool_use_id: tu.id, content: "Görev bulunamadı", is_error: true };
    if (t.usage) usage = addUsage(usage, t.usage.provider ?? t.agent_key, t.usage);
    if (t.status === "error") {
      return { type: "tool_result", tool_use_id: tu.id, content: `Hata: ${t.error}`, is_error: true };
    }
    let content = t.output || "";
    if (content.length > RESULT_CHAR_LIMIT) content = content.slice(0, RESULT_CHAR_LIMIT) + "\n\n[...kısaltıldı]";
    if (!content) content = "(boş sonuç)";
    return { type: "tool_result", tool_use_id: tu.id, content };
  });

  const messages = [...memory, { role: "user", content: results }];
  await setMemory(runId, messages);
  await db
    .from("runs")
    .update({
      usage,
      status: "thinking",
      note: "CEO sonuçları inceliyor",
      updated_at: new Date().toISOString(),
    })
    .eq("id", runId);
  await callSelf("step", { run_id: runId });
}

// ---------------------------------------------------------------- saglayicilar

type AgentResult = { text: string; images: { path: string; agent: string }[]; usage?: any };

async function runAgent(agent: Agent, task: any): Promise<AgentResult> {
  switch (agent.provider) {
    case "anthropic":
      return await runAnthropic(agent, task.instruction);
    case "openai":
      return await runOpenAIText(agent, task.instruction);
    case "xai":
      return await runXai(agent, task.instruction);
    case "gemini":
      return await runGeminiText(agent, task.instruction);
    case "openai_image":
      return await runOpenAIImage(agent, task);
    case "gemini_image":
      return await runGeminiImage(agent, task);
    default:
      throw new Error(`Desteklenmeyen sağlayıcı: ${agent.provider}`);
  }
}

async function runAnthropic(agent: Agent, instruction: string): Promise<AgentResult> {
  const data = await anthropicCall({
    model: agent.model,
    max_tokens: agent.options?.max_tokens ?? 8000,
    system: agent.system_prompt,
    messages: [{ role: "user", content: instruction }],
  });
  const text = (data.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
  return { text, images: [], usage: { provider: "anthropic", ...data.usage } };
}

function responsesText(data: any): string {
  if (typeof data.output_text === "string" && data.output_text) return data.output_text;
  const parts: string[] = [];
  const cites: string[] = [];
  for (const item of data.output ?? []) {
    if (item.type !== "message") continue;
    for (const c of item.content ?? []) {
      if (c.type === "output_text" && c.text) {
        parts.push(c.text);
        for (const a of c.annotations ?? []) {
          if (a.type === "url_citation" && a.url && !cites.includes(a.url)) cites.push(a.url);
        }
      }
    }
  }
  let text = parts.join("\n");
  if (cites.length && !cites.every((u) => text.includes(u))) {
    text += "\n\nKaynaklar:\n" + cites.slice(0, 12).map((u) => `- ${u}`).join("\n");
  }
  return text;
}

async function runOpenAIText(agent: Agent, instruction: string): Promise<AgentResult> {
  const body: Record<string, unknown> = {
    model: agent.model,
    instructions: agent.system_prompt,
    input: instruction,
  };
  if (agent.options?.reasoning) body.reasoning = { effort: agent.options.reasoning };
  if (agent.options?.web_search) body.tools = [{ type: "web_search" }];
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEYS.openai()}` },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${data?.error?.message ?? JSON.stringify(data).slice(0, 400)}`);
  return { text: responsesText(data), images: [], usage: { provider: "openai", ...data.usage } };
}

async function runXai(agent: Agent, instruction: string): Promise<AgentResult> {
  const tools: any[] = [];
  if (agent.options?.web_search) tools.push({ type: "web_search" });
  if (agent.options?.x_search) tools.push({ type: "x_search" });
  const body: Record<string, unknown> = {
    model: agent.model,
    input: [
      { role: "system", content: agent.system_prompt },
      { role: "user", content: instruction },
    ],
  };
  if (tools.length) body.tools = tools;
  const res = await fetch("https://api.x.ai/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEYS.xai()}` },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`xAI ${res.status}: ${data?.error?.message ?? data?.error ?? JSON.stringify(data).slice(0, 400)}`);
  return { text: responsesText(data), images: [], usage: { provider: "xai", ...data.usage } };
}

async function geminiCall(model: string, body: Record<string, unknown>) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": KEYS.gemini() ?? "" },
      body: JSON.stringify(body),
    },
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${data?.error?.message ?? JSON.stringify(data).slice(0, 400)}`);
  return data;
}

async function runGeminiText(agent: Agent, instruction: string): Promise<AgentResult> {
  const body: Record<string, unknown> = {
    contents: [{ role: "user", parts: [{ text: instruction }] }],
  };
  if (agent.system_prompt) body.systemInstruction = { parts: [{ text: agent.system_prompt }] };
  if (agent.options?.google_search) body.tools = [{ google_search: {} }];
  const data = await geminiCall(agent.model, body);
  const cand = data.candidates?.[0];
  let text = (cand?.content?.parts ?? [])
    .filter((p: any) => p.text && !p.thought)
    .map((p: any) => p.text)
    .join("\n");
  const chunks = cand?.groundingMetadata?.groundingChunks ?? [];
  const sources = chunks
    .map((c: any) => c.web)
    .filter((w: any) => w?.uri)
    .slice(0, 12)
    .map((w: any) => `- ${w.title ?? "kaynak"}: ${w.uri}`);
  if (sources.length) text += "\n\nKaynaklar:\n" + sources.join("\n");
  if (!text && cand?.finishReason) text = `(Cevap üretilmedi: ${cand.finishReason})`;
  return { text, images: [], usage: { provider: "gemini", ...data.usageMetadata } };
}

const OPENAI_SIZES: Record<string, string> = {
  square: "1024x1024",
  landscape: "1536x1024",
  portrait: "1024x1536",
};
const GEMINI_RATIOS: Record<string, string> = {
  square: "1:1",
  landscape: "16:9",
  portrait: "9:16",
};

function b64ToBytes(b64: string) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function saveImage(task: any, idx: number, b64: string, mime = "image/png") {
  const ext = mime.includes("jpeg") || mime.includes("jpg") ? "jpg" : mime.includes("webp") ? "webp" : "png";
  const path = `${task.conversation_id}/${task.id}-${idx}.${ext}`;
  const { error } = await db.storage.from(BUCKET).upload(path, b64ToBytes(b64), { contentType: mime, upsert: true });
  if (error) throw new Error(`Görsel kaydedilemedi: ${error.message}`);
  return { path, agent: task.agent_key };
}

async function runOpenAIImage(agent: Agent, task: any): Promise<AgentResult> {
  const aspect = task.params?.aspect ?? "square";
  const body: Record<string, unknown> = {
    model: agent.model,
    prompt: task.instruction,
    size: OPENAI_SIZES[aspect] ?? "1024x1024",
    n: 1,
  };
  if (agent.options?.quality) body.quality = agent.options.quality;
  const res = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEYS.openai()}` },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`OpenAI Görsel ${res.status}: ${data?.error?.message ?? JSON.stringify(data).slice(0, 400)}`);
  const images = [];
  let i = 0;
  for (const d of data.data ?? []) {
    if (d.b64_json) images.push(await saveImage(task, i++, d.b64_json, "image/png"));
    else if (d.url) {
      const img = await fetch(d.url);
      const buf = new Uint8Array(await img.arrayBuffer());
      let bin = "";
      for (let k = 0; k < buf.length; k++) bin += String.fromCharCode(buf[k]);
      images.push(await saveImage(task, i++, btoa(bin), img.headers.get("content-type") ?? "image/png"));
    }
  }
  if (!images.length) throw new Error("OpenAI görsel döndürmedi");
  const revised = data.data?.[0]?.revised_prompt;
  return {
    text: `${images.length} görsel üretildi (${agent.model}, ${aspect}). Cem'e otomatik gösterilecek.` +
      (revised ? `\nKullanılan prompt: ${revised}` : ""),
    images,
    usage: { provider: "openai", ...data.usage },
  };
}

async function runGeminiImage(agent: Agent, task: any): Promise<AgentResult> {
  const aspect = task.params?.aspect ?? "square";
  const data = await geminiCall(agent.model, {
    contents: [{ role: "user", parts: [{ text: task.instruction }] }],
    generationConfig: {
      responseModalities: ["TEXT", "IMAGE"],
      imageConfig: { aspectRatio: GEMINI_RATIOS[aspect] ?? "1:1" },
    },
  });
  const parts = data.candidates?.[0]?.content?.parts ?? [];
  const images = [];
  let i = 0;
  let note = "";
  for (const p of parts) {
    const inline = p.inlineData ?? p.inline_data;
    if (inline?.data && !p.thought) images.push(await saveImage(task, i++, inline.data, inline.mimeType ?? inline.mime_type ?? "image/png"));
    else if (p.text && !p.thought) note += p.text;
  }
  if (!images.length) {
    throw new Error(`Gemini görsel döndürmedi. ${note || data.candidates?.[0]?.finishReason || ""}`.trim());
  }
  return {
    text: `${images.length} görsel üretildi (${agent.model}, ${aspect}). Cem'e otomatik gösterilecek.` +
      (note ? `\nModel notu: ${note.slice(0, 500)}` : ""),
    images,
    usage: { provider: "gemini", ...data.usageMetadata },
  };
}
