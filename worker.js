/* ฝากจำ — Cloudflare Worker
 *
 * หน้าที่ 2 อย่าง:
 *  1) /read      รับรูป+ข้อความ ส่งให้ Claude อ่าน แล้วส่ง JSON กลับ (ไม่เก็บรูปหรือข้อความไว้)
 *  2) การเตือน   เก็บแค่ "เวลา" ที่ต้องปลุกมือถือ ทุก 1 นาทีเช็กว่าถึงเวลาหรือยัง แล้วส่ง push เปล่า ๆ
 *                มือถือจะตื่นมาอ่านเนื้อหาจากเครื่องตัวเอง
 *
 * ต้องตั้งค่า (ดู README.md):
 *   KV binding ชื่อ KV
 *   Secrets: ANTHROPIC_API_KEY, VAPID_PRIVATE, (APP_TOKEN ถ้าต้องการ)
 *   Vars:    VAPID_PUBLIC, VAPID_SUBJECT, ALLOWED_ORIGIN, (MODEL)
 *   Cron:    * * * * *
 */

export default {
  async fetch(req, env, ctx) {
    const c = cors(req, env);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: c.headers });
    if (!c.ok) return json({ error: "origin_not_allowed" }, 403, c.headers);
    if (env.APP_TOKEN && req.headers.get("x-app-token") !== env.APP_TOKEN) return json({ error: "bad_token" }, 401, c.headers);

    const url = new URL(req.url);
    try {
      if (url.pathname === "/read" && req.method === "POST") return await handleRead(req, env, c.headers);
      if (url.pathname === "/subscribe" && req.method === "POST") return await handleSubscribe(req, env, c.headers);
      if (url.pathname === "/subscribe" && req.method === "DELETE") return await handleUnsubscribe(req, env, c.headers);
      if (url.pathname === "/reminders" && req.method === "PUT") return await handleReminders(req, env, c.headers);
      if (url.pathname === "/test" && req.method === "POST") return await handleTest(req, env, c.headers);
      if (url.pathname === "/last" && req.method === "GET") return await handleLast(url, env, c.headers);
      if (url.pathname === "/" ) return json({ ok: true, app: "fakjam" }, 200, c.headers);
      return json({ error: "not_found" }, 404, c.headers);
    } catch (err) {
      return json({ error: "server_error", message: String(err && err.message || err) }, 500, c.headers);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runDue(env));
  }
};

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */
function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { ...headers, "content-type": "application/json; charset=utf-8" } });
}
function cors(req, env) {
  const origin = req.headers.get("origin") || "";
  const allowed = String(env.ALLOWED_ORIGIN || "*").split(",").map(s => s.trim().replace(/\/+$/, "")).filter(Boolean);
  const any = allowed.includes("*");
  const ok = any || allowed.includes(origin);
  return {
    ok,
    headers: {
      "access-control-allow-origin": any ? "*" : (ok ? origin : allowed[0] || ""),
      "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
      "access-control-allow-headers": "content-type,x-app-token",
      "access-control-max-age": "86400",
      "vary": "origin"
    }
  };
}
const b64u = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64uToBytes = s => { s = s.replace(/-/g, "+").replace(/_/g, "/"); s += "===".slice((s.length + 3) % 4); return Uint8Array.from(atob(s), c => c.charCodeAt(0)); };
const validId = id => typeof id === "string" && /^[0-9a-f-]{36}$/.test(id);

async function getUser(env, id) { return validId(id) ? await env.KV.get("u:" + id, "json") : null; }
async function putUser(env, id, u) { await env.KV.put("u:" + id, JSON.stringify(u)); }
async function getIndex(env) { return (await env.KV.get("index", "json")) || []; }

/* ------------------------------------------------------------------ */
/* 1) อ่านรูป+ข้อความด้วย Claude                                         */
/* ------------------------------------------------------------------ */
const DAYS = ["อาทิตย์", "จันทร์", "อังคาร", "พุธ", "พฤหัสบดี", "ศุกร์", "เสาร์"];

function bangkokNow() {
  const d = new Date(Date.now() + 7 * 3600e3);
  return { now: d.toISOString().slice(0, 16), weekday: DAYS[d.getUTCDay()] };
}

function buildPrompt(text, hasImg, now, weekday) {
  return `คุณเป็นตัวอ่านของแอป "ฝากจำ" ผู้ใช้ส่ง${hasImg ? "รูป 1 รูปและ" : ""}ข้อความมาให้ช่วยจำ
ตอนนี้คือ ${now} (เวลาไทย) วัน${weekday}
ข้อความผู้ใช้: """${text || "(ไม่มีข้อความ ดูจากรูป)"}"""
${hasImg ? "รูปอาจเป็นแคปแชต รูปที่จอดรถ ใบเสร็จ หรือของที่ต้องเอาไป อ่านตัวอักษรในรูปด้วย" : ""}

ตอบเป็น JSON object เดียวเท่านั้น ไม่มีข้อความอื่น รูปแบบ:
{"kind":"appointment|bring|location|document|note","title":"ชื่อเรื่องสั้น ภาษาไทย ไม่เกิน 40 ตัวอักษร","when":"YYYY-MM-DDTHH:MM หรือ null","place":"ชื่อสถานที่สำหรับเปิดแผนที่ หรือ null","note":"สิ่งที่ต้องจำเพิ่ม สั้นๆ หรือ null","warranty_until":"YYYY-MM-DD หรือ null","tags":["คำค้นภาษาไทย 3-6 คำ"],"understood":"ประโยคเดียวเป็นภาษาพูด บอกว่าเข้าใจว่าให้จำอะไร","unsure":["สิ่งที่ไม่แน่ใจ ถ้าไม่มีให้เป็น []"]}

กติกา:
- appointment = นัดหรือกิจกรรมที่มีวันเวลา
- bring = ของที่ต้องเอาไป เอาไปคืน หรือต้องทำก่อนออกจากบ้าน; when = วันที่ต้องเอาไป ถ้าไม่บอกเวลาให้ใช้ 07:30
- location = ตำแหน่งที่จอดรถหรือวางของ ใส่ตำแหน่งละเอียด (ชั้น โซน เสา) ใน note
- document = ใบเสร็จ เอกสาร การรับประกัน; ใส่ชื่อสินค้า ร้าน ราคา วันที่ซื้อใน note; ถ้ารู้ระยะประกันให้คำนวณ warranty_until จากวันที่ซื้อ
- note = อย่างอื่น
- "หกโมง" ที่เป็นมื้อเย็นหรือนัดกินข้าวคือ 18:00, "x ทุ่ม" คือ 18+x นาฬิกา, "บ่ายสอง" คือ 14:00
- "เสาร์นี้" คือวันเสาร์ถัดไปที่ยังมาไม่ถึง ถ้าวันนี้เป็นวันนั้นและเวลายังไม่ผ่านให้เป็นวันนี้
- ปี พ.ศ. ในใบเสร็จให้แปลงเป็น ค.ศ. (ลบ 543)
- ห้ามเดาข้อมูลที่ไม่มีในข้อความหรือรูป ใส่ null แล้วบอกใน unsure`;
}

async function handleRead(req, env, headers) {
  if (!env.ANTHROPIC_API_KEY) return json({ error: "no_api_key" }, 500, headers);
  const body = await req.json().catch(() => ({}));
  const text = typeof body.text === "string" ? body.text.slice(0, 1500) : "";
  const image = typeof body.image === "string" && body.image.length < 700000 && /^[A-Za-z0-9+/=]+$/.test(body.image) ? body.image : null;
  if (!text && !image) return json({ error: "empty" }, 400, headers);
  const bkk = bangkokNow();
  const now = typeof body.now === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(body.now) ? body.now : bkk.now;
  const weekday = DAYS.includes(body.weekday) ? body.weekday : bkk.weekday;

  const content = [];
  if (image) content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: image } });
  content.push({ type: "text", text: buildPrompt(text, !!image, now, weekday) });

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: env.MODEL || "claude-sonnet-5-5", max_tokens: 900, messages: [{ role: "user", content }] })
  });
  if (!r.ok) return json({ error: "upstream", status: r.status, detail: (await r.text()).slice(0, 300) }, 502, headers);
  const data = await r.json();
  const out = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("");
  const s = out.indexOf("{"), e = out.lastIndexOf("}");
  if (s < 0 || e <= s) return json({ error: "no_json" }, 502, headers);
  try { return json(JSON.parse(out.slice(s, e + 1)), 200, headers); }
  catch (err) { return json({ error: "bad_json" }, 502, headers); }
}

/* ------------------------------------------------------------------ */
/* 2) การเตือน                                                          */
/* ------------------------------------------------------------------ */
async function handleSubscribe(req, env, headers) {
  const { id, subscription } = await req.json().catch(() => ({}));
  const sub = subscription || {};
  if (typeof sub.endpoint !== "string" || !/^https:\/\//.test(sub.endpoint) || !sub.keys || !sub.keys.p256dh || !sub.keys.auth)
    return json({ error: "bad_subscription" }, 400, headers);
  const clean = { endpoint: sub.endpoint, keys: { p256dh: String(sub.keys.p256dh), auth: String(sub.keys.auth) } };

  let uid = validId(id) ? id : null;
  let u = uid ? await getUser(env, uid) : null;
  if (!u) {
    uid = crypto.randomUUID();
    u = { times: [], last: Date.now() };
    const index = await getIndex(env);
    index.push(uid);
    await env.KV.put("index", JSON.stringify(index));
  }
  u.sub = clean;
  await putUser(env, uid, u);
  return json({ id: uid }, 200, headers);
}

async function handleUnsubscribe(req, env, headers) {
  const { id } = await req.json().catch(() => ({}));
  if (validId(id)) await removeUser(env, id);
  return json({ ok: true }, 200, headers);
}

async function removeUser(env, id) {
  await env.KV.delete("u:" + id);
  const index = (await getIndex(env)).filter(x => x !== id);
  await env.KV.put("index", JSON.stringify(index));
}

async function handleReminders(req, env, headers) {
  const { id, times } = await req.json().catch(() => ({}));
  const u = await getUser(env, id);
  if (!u) return json({ error: "unknown_id" }, 404, headers);
  const now = Date.now();
  const clean = [...new Set((Array.isArray(times) ? times : [])
    .map(Number).filter(t => Number.isFinite(t) && t > now - 6 * 36e5 && t < now + 400 * 864e5))]
    .sort((a, b) => a - b).slice(0, 300);
  if (JSON.stringify(clean) !== JSON.stringify(u.times || [])) {
    u.times = clean;
    await putUser(env, id, u);
  }
  return json({ ok: true, count: clean.length }, 200, headers);
}

async function handleTest(req, env, headers) {
  const { id } = await req.json().catch(() => ({}));
  const u = await getUser(env, id);
  if (!u || !u.sub) return json({ error: "unknown_id" }, 404, headers);
  u.lastKind = "test";
  await putUser(env, id, u);
  const status = await sendPush(u.sub, env);
  if (status === 404 || status === 410) { await removeUser(env, id); return json({ error: "subscription_gone" }, 410, headers); }
  return json({ ok: status >= 200 && status < 300, status }, 200, headers);
}

async function handleLast(url, env, headers) {
  const u = await getUser(env, url.searchParams.get("id"));
  return json({ kind: u && u.lastKind || "reminder" }, 200, headers);
}

/* ทุก 1 นาที: ใครมีเวลาที่ถึงแล้วตั้งแต่รอบก่อน → ส่ง push */
async function runDue(env) {
  const index = await getIndex(env);
  const now = Date.now();
  for (const id of index) {
    const u = await getUser(env, id);
    if (!u || !u.sub) continue;
    const last = u.last || 0;
    const due = (u.times || []).some(t => t <= now && t > last);
    if (!due) continue;
    u.last = now;
    u.lastKind = "reminder";
    u.times = (u.times || []).filter(t => t > now - 6 * 36e5);
    await putUser(env, id, u);
    const status = await sendPush(u.sub, env);
    if (status === 404 || status === 410) await removeUser(env, id);
  }
}

/* push เปล่า (ไม่มี payload) ลงชื่อด้วย VAPID — ไม่ต้องเข้ารหัสเนื้อหา */
let keyCache = null;
async function vapidKey(env) {
  if (keyCache) return keyCache;
  const pub = b64uToBytes(env.VAPID_PUBLIC);
  if (pub.length !== 65 || pub[0] !== 4) throw new Error("VAPID_PUBLIC ไม่ถูกต้อง");
  keyCache = await crypto.subtle.importKey(
    "jwk",
    { kty: "EC", crv: "P-256", x: b64u(pub.slice(1, 33)), y: b64u(pub.slice(33, 65)), d: env.VAPID_PRIVATE, ext: true },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );
  return keyCache;
}

export async function vapidJWT(endpoint, env) {
  const enc = s => b64u(new TextEncoder().encode(JSON.stringify(s)));
  const header = enc({ typ: "JWT", alg: "ES256" });
  const claims = enc({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: env.VAPID_SUBJECT || "mailto:admin@example.com" });
  const data = new TextEncoder().encode(header + "." + claims);
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, await vapidKey(env), data);
  return header + "." + claims + "." + b64u(sig);
}

async function sendPush(sub, env) {
  try {
    const jwt = await vapidJWT(sub.endpoint, env);
    const r = await fetch(sub.endpoint, {
      method: "POST",
      headers: { "TTL": "3600", "Urgency": "high", "Authorization": `vapid t=${jwt}, k=${env.VAPID_PUBLIC}`, "Content-Length": "0" }
    });
    return r.status;
  } catch (err) {
    return 0;
  }
}
