/* ฝากจำ — service worker
   - เก็บหน้าแอปไว้ใช้ตอนไม่มีเน็ต
   - รับสัญญาณเตือน (push) จาก Worker แล้วดึงรายการที่ถึงเวลามาแสดง */
const SHELL = "fakjam-shell-v1";
const FILES = ["./", "index.html", "manifest.json", "icons/icon-192.png", "icons/icon-512.png", "icons/badge-96.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k.startsWith("fakjam-shell-") && k !== SHELL).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

/* หน้าแอป: ลองเน็ตก่อน (ได้เวอร์ชันใหม่เสมอ) ถ้าไม่มีเน็ตใช้ของที่เก็บไว้ */
self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  e.respondWith((async () => {
    try {
      const fresh = await fetch(req);
      if (fresh.ok) { const c = await caches.open(SHELL); c.put(req, fresh.clone()); }
      return fresh;
    } catch (err) {
      const hit = await caches.match(req, { ignoreSearch: true });
      return hit || caches.match("index.html");
    }
  })());
});

async function readConfig() {
  try {
    const c = await caches.open("fakjam-config");
    const r = await c.match("config");
    return r ? await r.json() : {};
  } catch (e) { return {}; }
}

/* ---- อ่านตั๋วจากมือถือเอง (Worker รู้แค่เวลา ไม่รู้เนื้อหา) ---- */
function readItems() {
  return new Promise(res => {
    try {
      const r = indexedDB.open("fakjam", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("items", { keyPath: "id" });
      r.onerror = () => res([]);
      r.onsuccess = () => {
        try {
          const g = r.result.transaction("items", "readonly").objectStore("items").getAll();
          g.onsuccess = () => res(g.result || []);
          g.onerror = () => res([]);
        } catch (e) { res([]); }
      };
    } catch (e) { res([]); }
  });
}
/* ต้องตรงกับ remindAt() ใน index.html */
function remindAt(it) {
  if (it.kind === "appointment" && it.when) return new Date(it.when).getTime() - 60 * 6e4;
  if (it.kind === "bring" && it.when) return new Date(it.when).getTime();
  if (it.kind === "document" && it.warranty_until) { const d = new Date(it.warranty_until + "T09:00"); d.setDate(d.getDate() - 30); return d.getTime(); }
  if (it.kind === "note" && it.when) return new Date(it.when).getTime();
  return null;
}
function notifText(it) {
  const head = { appointment: "อีก 1 ชม. มีนัด", bring: "ก่อนออกจากบ้าน อย่าลืม", document: "ประกันใกล้หมด", note: "ถึงเวลา" }[it.kind] || "ถึงเวลา";
  return { rid: it.id, title: head + ": " + it.title, body: [it.place, it.note].filter(Boolean).join(" · ") || "แตะเพื่อดูสิ่งที่ฝากไว้" };
}
async function notifiedSet() {
  try { const c = await caches.open("fakjam-config"); const r = await c.match("notified"); return new Set(r ? await r.json() : []); }
  catch (e) { return new Set(); }
}
async function saveNotified(set) {
  try { const c = await caches.open("fakjam-config"); await c.put("notified", new Response(JSON.stringify([...set].slice(-300)))); } catch (e) {}
}

/* สัญญาณเตือนไม่มีเนื้อหา — ตื่นมาดูว่าตั๋วไหนถึงเวลา */
self.addEventListener("push", e => {
  e.waitUntil((async () => {
    const now = Date.now();
    const items = await readItems();
    const seen = await notifiedSet();
    let list = [];
    for (const it of items) {
      if (it.done) continue;
      const t = remindAt(it);
      if (!t || t > now + 90e3 || t < now - 6 * 36e5) continue;
      const key = it.id + "@" + t;
      if (seen.has(key)) continue;
      seen.add(key); list.push(notifText(it));
    }
    await saveNotified(seen);
    if (!list.length) {
      let test = false;
      const cfg = await readConfig();
      if (cfg.api && cfg.id) {
        try {
          const r = await fetch(cfg.api + "/last?id=" + encodeURIComponent(cfg.id), { headers: cfg.token ? { "x-app-token": cfg.token } : {} });
          if (r.ok) test = (await r.json()).kind === "test";
        } catch (err) {}
      }
      list = [test
        ? { rid: "", title: "ฝากจำ", body: "ทดสอบการเตือน: ใช้ได้แล้ว" }
        : { rid: "", title: "ฝากจำ", body: "มีเรื่องที่ฝากไว้ถึงเวลาแล้ว แตะเพื่อดู" }];
    }
    for (const n of list.slice(0, 5)) {
      await self.registration.showNotification(n.title, {
        body: n.body || "",
        tag: n.rid || "fakjam",
        renotify: true,
        icon: "icons/icon-192.png",
        badge: "icons/badge-96.png",
        data: { rid: n.rid || "" }
      });
    }
  })());
});

/* แตะการแจ้งเตือน → เปิดแอปที่ตั๋วนั้น */
self.addEventListener("notificationclick", e => {
  e.notification.close();
  const rid = (e.notification.data && e.notification.data.rid) || "";
  const target = new URL(rid ? "./#t-" + encodeURIComponent(rid) : "./", self.registration.scope).href;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const w of wins) {
      if (w.url.startsWith(self.registration.scope)) {
        await w.focus();
        if (rid) w.postMessage({ type: "open", rid });
        return;
      }
    }
    await self.clients.openWindow(target);
  })());
});
