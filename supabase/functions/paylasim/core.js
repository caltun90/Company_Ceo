// Gunluk paylasim durumu: Buffer + YouTube verisini beklenen saat dilimleriyle eslestirir.
// Deno (Supabase Edge Function) ve Node 22 ile calisir. Anahtar icermez.

const TZ_OFFSET_MS = 3 * 3600e3; // Europe/Istanbul, sabit UTC+3
const MATCH_WINDOW = 45 * 60e3;
const CLUSTER_GAP = 5 * 60e3;
const KIND_PENALTY = 10 * 60e3;
const LATE_AFTER = 15 * 60e3;

const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

// Kanal yapisi. Saatler Istanbul saati. Gorevlerin talimatlarindan alindi.
export const BRANDS = [
  {
    id: "engrow", name: "Engrow", mono: "En", color: "#0F766E", avatarFrom: "6ae3af182f1f5ed648148e1b",
    rows: [
      { label: "Instagram", platform: "ig", pool: { type: "buffer", account: "engrow", channel: "6ae3af182f1f5ed648148e1b" }, slots: ["16:00", "17:00", "18:00", "19:00", "20:00"] },
      { label: "TikTok", platform: "tt", pool: { type: "buffer", account: "engrow", channel: "6ae3aa5e2f1f5ed648145d3c" }, slots: ["16:00", "17:00", "18:00", "19:00", "20:00"] },
    ],
  },
  {
    id: "pofu", name: "Pofu Kids", mono: "PK", color: "#EA580C", avatarFrom: "6af3aa3762b70b94b0eb79af",
    rows: [
      { label: "Instagram", platform: "ig", pool: { type: "buffer", account: "engrow", channel: "6af3aa3762b70b94b0eb79af" }, slots: ["11:00", "14:00", "17:00"] },
    ],
  },
  {
    id: "demek", name: "Demek O Yüzden", mono: "DY", color: "#292524", avatarFrom: "6af4e86d62b70b94b0fcf990",
    rows: [
      { label: "YouTube Shorts", platform: "yt", kind: "short", pool: { type: "yt", yt: "demek", account: "demek", channel: "6af4e86d62b70b94b0fcf990" }, slots: ["12:00", "15:00", "19:00"] },
      { label: "YouTube video", platform: "yt", kind: "video", pool: { type: "yt", yt: "demek", account: "demek", channel: "6af4e86d62b70b94b0fcf990" }, slots: ["12:00", "15:00", "19:00"] },
      { label: "YouTube uzun", platform: "yt", kind: "video", days: [1, 4, 6], pool: { type: "yt", yt: "demek", account: "demek", channel: "6af4e86d62b70b94b0fcf990" }, slots: ["16:00"] },
      { label: "TikTok", platform: "tt", pool: { type: "buffer", account: "demek", channel: "6af4dbe562b70b94b0fc2edf" }, slots: ["12:00", "15:00", "19:00"] },
      { label: "Instagram", platform: "ig", pool: { type: "buffer", account: "demek", channel: "6af4db8c62b70b94b0fc2a5e" }, slots: ["12:00", "15:00", "19:00"] },
      { label: "X", platform: "x", pool: { type: "buffer", account: "demekx", channel: "6afa35a9ece6dfde5fd9c3ac" }, slots: ["12:00", "15:00", "19:00"] },
    ],
  },
  {
    id: "thatswhy", name: "That's Why", mono: "TW", color: "#2563EB", avatarFrom: "6afc425eece6dfde5ff66196",
    rows: [
      { label: "YouTube Shorts", platform: "yt", pool: { type: "buffer", account: "thatswhy", channel: "6afc425eece6dfde5ff66196" }, slots: ["02:00", "14:00", "17:00", "20:00", "23:00"] },
      { label: "X", platform: "x", pool: { type: "buffer", account: "thatswhy", channel: "6afc42c0ece6dfde5ff66ab6" }, slots: ["02:00", "14:00", "17:00", "20:00", "23:00"] },
      { label: "TikTok", platform: "tt", pool: { type: "buffer", account: "thatswhy", channel: "6afc4c50ece6dfde5ff6d95f" }, slots: ["02:00", "14:00", "17:00", "20:00", "23:00"] },
    ],
  },
  {
    id: "dizivana", name: "dizivanastudio", mono: "DS", color: "#BE185D", avatarFrom: "6af79b9062b70b94b02368ea",
    rows: [
      { label: "YouTube Shorts", platform: "yt", kind: "short", pool: { type: "yt", yt: "dizivana", account: "dizivana", channel: "6af79b9062b70b94b02368ea" }, slots: ["18:00"] },
      { label: "YouTube bölüm", platform: "yt", kind: "video", pool: { type: "yt", yt: "dizivana", account: "dizivana", channel: "6af79b9062b70b94b02368ea" }, slots: ["18:05"] },
    ],
  },
  {
    id: "lala", name: "Lala Anlatıyor", mono: "LA", color: "#9A3412", avatarFrom: "6afc62b6ece6dfde5ff81bfd",
    rows: [
      { label: "YouTube uzun", platform: "yt", kind: "video", pool: { type: "yt", yt: "lala", account: "lala", channel: "6afc62b6ece6dfde5ff81bfd" }, slots: ["19:00"] },
      { label: "YouTube Shorts", platform: "yt", kind: "short", pool: { type: "yt", yt: "lala", account: "lala", channel: "6afc62b6ece6dfde5ff81bfd" }, slots: ["20:00"] },
      { label: "TikTok", platform: "tt", pool: { type: "buffer", account: "lala", channel: "6afc7ee4ece6dfde5ff9e2e3" }, slots: ["20:00"] },
      { label: "X", platform: "x", pool: { type: "buffer", account: "lala", channel: "6afc7e0fece6dfde5ff9d78c" }, slots: ["20:00"] },
    ],
  },
];

// ------------------------------------------------------------ yardimcilar

export function todayIstanbul(now = Date.now()) {
  return new Date(now + TZ_OFFSET_MS).toISOString().slice(0, 10);
}
function dayStartMs(date) {
  return Date.parse(date + "T00:00:00+03:00");
}
function hhmm(ms) {
  return new Date(ms + TZ_OFFSET_MS).toISOString().slice(11, 16);
}
function slotMs(date, t) {
  const [h, m] = t.split(":").map(Number);
  return dayStartMs(date) + h * 3600e3 + m * 60e3;
}
function poolKey(p) {
  return p.type === "yt" ? "yt:" + p.yt : "buf:" + p.channel;
}
function firstLine(s, n = 70) {
  const line = String(s || "").split("\n").find((l) => l.trim()) || "";
  return line.length > n ? line.slice(0, n - 1) + "…" : line;
}

async function bufferQuery(key, query, variables) {
  const res = await fetch("https://api.buffer.com", {
    method: "POST",
    headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables: variables || {} }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.errors) throw new Error("Buffer: " + (j.errors?.[0]?.message || res.status));
  return j.data;
}

// meta: { [account]: { org, avatars: {channelId: url} } } uzun sure onbellekte tutulur
export async function fetchBufferMeta(account, key) {
  const a = await bufferQuery(key, "{ account { organizations { id } } }");
  const org = a.account.organizations[0].id;
  const c = await bufferQuery(key, "query($o: OrganizationId!){ channels(input:{organizationId:$o}){ id avatar isDisconnected } }", { o: org });
  const avatars = {}, disconnected = [];
  for (const ch of c.channels) {
    avatars[ch.id] = ch.avatar;
    if (ch.isDisconnected) disconnected.push(ch.id);
  }
  return { org, avatars, disconnected };
}

async function fetchBufferPosts(key, org, date) {
  const start = new Date(dayStartMs(date) - 2 * 3600e3).toISOString();
  const end = new Date(dayStartMs(date) + 26 * 3600e3).toISOString();
  const d = await bufferQuery(key, `query($o: OrganizationId!, $s: DateTime!, $e: DateTime!){
    posts(first: 100, input:{organizationId:$o, filter:{dueAt:{start:$s, end:$e}}, sort:[{field: dueAt, direction: asc}]}){
      edges{ node{ id channelId status dueAt sentAt text error { message } } } } }`, { o: org, s: start, e: end });
  return d.posts.edges.map((e) => e.node);
}

async function fetchYouTube(creds, refreshToken) {
  const tok = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: creds.id, client_secret: creds.secret, refresh_token: refreshToken, grant_type: "refresh_token" }),
  }).then((r) => r.json());
  if (!tok.access_token) throw new Error("YouTube yetkisi: " + (tok.error || "token yok"));
  const h = { Authorization: "Bearer " + tok.access_token };
  const get = async (u) => {
    const r = await fetch("https://www.googleapis.com/youtube/v3/" + u, { headers: h });
    const j = await r.json();
    if (!r.ok) throw new Error("YouTube: " + (j.error?.message || r.status));
    return j;
  };
  const ch = await get("channels?part=contentDetails&mine=true");
  const uploads = ch.items[0].contentDetails.relatedPlaylists.uploads;
  const pl = await get("playlistItems?part=contentDetails&maxResults=20&playlistId=" + uploads);
  const ids = pl.items.map((i) => i.contentDetails.videoId).join(",");
  if (!ids) return [];
  const v = await get("videos?part=snippet,status&id=" + ids);
  return v.items.map((x) => ({
    id: x.id,
    title: x.snippet.title,
    privacy: x.status.privacyStatus,
    publishAt: x.status.publishAt || null,
    publishedAt: x.snippet.publishedAt,
  }));
}

// ------------------------------------------------------------ ham veriyi topla

// cache: { buffer: {acct: {at, posts}}, yt: {acct: {at, videos}}, meta: {acct: {...}} }
export async function collect(keys, date, cache, opts = {}) {
  const now = opts.now || Date.now();
  const bufTtl = opts.bufferTtl ?? 60e3;
  const ytTtl = opts.ytTtl ?? 15 * 60e3;
  const out = { buffer: {}, yt: {}, meta: { ...(cache?.meta || {}) }, errors: {} };
  const accounts = new Set(), yts = new Set();
  for (const b of BRANDS) for (const r of b.rows) {
    accounts.add(r.pool.account);
    if (r.pool.type === "yt") yts.add(r.pool.yt);
  }
  const jobs = [];
  for (const acct of accounts) {
    const key = keys.buffer?.[acct];
    if (!key) { out.errors["buf:" + acct] = "missing_key"; continue; }
    const prev = cache?.buffer?.[acct];
    if (prev && prev.date === date && now - prev.at < bufTtl && !opts.force) { out.buffer[acct] = prev; continue; }
    jobs.push((async () => {
      try {
        let meta = out.meta[acct];
        if (!meta || now - (meta.at || 0) > 24 * 3600e3) {
          meta = { ...(await fetchBufferMeta(acct, key)), at: now };
          out.meta[acct] = meta;
        }
        out.buffer[acct] = { date, at: now, posts: await fetchBufferPosts(key, meta.org, date) };
      } catch (e) {
        out.errors["buf:" + acct] = String(e.message || e);
        if (prev && prev.date === date) out.buffer[acct] = prev;
      }
    })());
  }
  for (const y of yts) {
    const rt = keys.yt?.[y];
    if (!rt) { out.errors["yt:" + y] = "missing_key"; continue; }
    const prev = cache?.yt?.[y];
    if (prev && now - prev.at < ytTtl && !opts.forceYt) { out.yt[y] = prev; continue; }
    jobs.push((async () => {
      try {
        out.yt[y] = { at: now, videos: await fetchYouTube({ id: keys.yt_client_id, secret: keys.yt_client_secret }, rt) };
      } catch (e) {
        out.errors["yt:" + y] = String(e.message || e);
        if (prev) out.yt[y] = prev;
      }
    })());
  }
  await Promise.all(jobs);
  return out;
}

// ------------------------------------------------------------ eslestirme

const RANK = { done: 3, ready: 2, error: 1 };

function bufferStatus(s) {
  if (s === "sent") return "done";
  if (s === "error") return "error";
  return "ready"; // scheduled, sending, needs_approval, draft
}

// Ayni kanalda 5 dk icindeki gonderileri tek gonderi say (hata + tekrar deneme gibi)
function clusterBuffer(posts) {
  const items = posts
    .map((p) => ({
      t: Date.parse(p.status === "sent" && p.sentAt ? p.sentAt : p.dueAt),
      due: Date.parse(p.dueAt),
      status: bufferStatus(p.status),
      title: firstLine(p.text),
      error: p.error?.message || null,
      src: "buffer",
    }))
    .sort((a, b) => a.due - b.due);
  const out = [];
  for (const it of items) {
    const last = out[out.length - 1];
    if (last && Math.abs(it.due - last.due) <= CLUSTER_GAP) {
      if (RANK[it.status] > RANK[last.status]) Object.assign(last, it);
      continue;
    }
    out.push({ ...it, t: it.due });
  }
  return out;
}

function assign(slots, items) {
  const pairs = [];
  slots.forEach((s, si) => items.forEach((it, ii) => {
    const d = Math.abs(s.ms - it.t);
    if (d <= MATCH_WINDOW) pairs.push({ si, ii, score: d + (s.kind && it.kind && s.kind !== it.kind ? KIND_PENALTY : 0) });
  }));
  pairs.sort((a, b) => a.score - b.score);
  const usedS = new Set(), usedI = new Set();
  for (const p of pairs) {
    if (usedS.has(p.si) || usedI.has(p.ii)) continue;
    usedS.add(p.si); usedI.add(p.ii);
    slots[p.si].item = items[p.ii];
  }
  return items.filter((_, i) => !usedI.has(i));
}

export function build(raw, date, now = Date.now()) {
  const dStart = dayStartMs(date), dEnd = dStart + 24 * 3600e3;
  const weekday = new Date(dStart + TZ_OFFSET_MS).getUTCDay();
  const pools = {};

  // havuzlari doldur
  for (const b of BRANDS) for (const r of b.rows) {
    const k = poolKey(r.pool);
    if (pools[k]) continue;
    const acct = r.pool.account;
    const buf = raw.buffer[acct];
    const bufErr = raw.errors["buf:" + acct];
    const posts = (buf?.posts || []).filter((p) => p.channelId === r.pool.channel);
    const clustered = clusterBuffer(posts);
    if (r.pool.type === "buffer") {
      pools[k] = { items: clustered, unknown: !buf, reason: bufErr };
    } else {
      const yt = raw.yt[r.pool.yt];
      const ytErr = raw.errors["yt:" + r.pool.yt];
      const sentTimes = clustered.filter((c) => c.status === "done").map((c) => c.t);
      const items = clustered.filter((c) => c.status !== "done").map((c) => ({ ...c, kind: "short" }));
      for (const v of yt?.videos || []) {
        const t = Date.parse(v.privacy === "private" && v.publishAt ? v.publishAt : (v.publishAt || v.publishedAt));
        const fromBuffer = sentTimes.some((st) => Math.abs(st - Date.parse(v.publishedAt)) <= 3 * 60e3);
        items.push({
          t,
          status: v.privacy === "private" ? "ready" : "done",
          title: v.title,
          kind: fromBuffer ? "short" : "video",
          src: "youtube",
        });
      }
      // YouTube verisi yoksa Buffer'in gonderildi bilgisini kullan
      if (!yt) for (const c of clustered.filter((c) => c.status === "done")) items.push({ ...c, kind: "short" });
      pools[k] = { items, unknown: !buf && !yt, ytUnknown: !yt, reason: ytErr || bufErr };
    }
  }

  // satirlari kur
  const brands = BRANDS.map((b) => ({
    id: b.id, name: b.name, mono: b.mono, color: b.color,
    avatar: Object.values(raw.meta).map((m) => m.avatars?.[b.avatarFrom]).find(Boolean) || null,
    rows: b.rows
      .filter((r) => (r.days || ALL_DAYS).includes(weekday))
      .map((r) => ({ label: r.label, platform: r.platform, kind: r.kind || null, pk: poolKey(r.pool), slots: r.slots.map((t) => ({ time: t, ms: slotMs(date, t), kind: r.kind || null })) })),
  }));

  const byPool = {};
  for (const b of brands) for (const r of b.rows) (byPool[r.pk] ||= []).push(r);
  for (const [k, rows] of Object.entries(byPool)) {
    const pool = pools[k];
    const slots = rows.flatMap((r) => r.slots);
    const inDay = pool.items.filter((it) => it.t >= dStart - MATCH_WINDOW && it.t < dEnd + MATCH_WINDOW);
    const rest = assign(slots, inDay);
    // beklenmeyen ama o gun icin planlanmis gonderiler (ornegin X'teki eski videolar)
    for (const it of rest) {
      if (it.t < dStart || it.t >= dEnd) continue;
      rows[0].slots.push({ time: hhmm(it.t), ms: it.t, item: it, extra: true });
    }
    for (const r of rows) {
      r.unknown = pool.unknown || (pool.ytUnknown && r.kind === "video");
      r.reason = pool.reason || null;
    }
  }

  const counts = { done: 0, ready: 0, todo: 0, unknown: 0 };
  for (const b of brands) {
    b.counts = { done: 0, ready: 0, todo: 0, unknown: 0 };
    for (const r of b.rows) {
      r.slots.sort((a, c) => a.ms - c.ms);
      r.slots = r.slots.map((s) => {
        let status, note = null;
        if (r.unknown) { status = "unknown"; note = r.reason === "missing_key" ? "Buffer anahtarı yok" : "Veri alınamadı"; }
        else if (!s.item) { status = "todo"; note = s.ms < now ? "Saati geçti, gönderi yok" : "Henüz hazırlanmadı"; }
        else if (s.item.status === "error") { status = "todo"; note = "Hata: " + (s.item.error || "gönderilemedi"); }
        else if (s.item.status === "ready") { status = "ready"; note = s.ms + LATE_AFTER < now ? "Saati geçti, hâlâ bekliyor" : "Hazır, saatini bekliyor"; }
        else { status = "done"; note = "Paylaşıldı " + hhmm(s.item.t); }
        b.counts[status]++; counts[status]++;
        return { time: s.time, status, note, title: s.item?.title || null, extra: !!s.extra };
      });
      delete r.pk;
    }
  }

  const warnings = Object.entries(raw.errors).map(([k, v]) => ({ source: k, message: v }));
  return { date, generatedAt: new Date(now).toISOString(), counts, brands, warnings };
}
