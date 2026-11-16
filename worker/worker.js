// bishTV reminder service (Cloudflare Worker).
// Needs: a KV namespace bound as "KV", and a Cron Trigger of "* * * * *" (every minute).
// It stores only "wake this phone at this minute" - no programme details. The phone works out what to show.

const ORIGIN = "https://perhamface.github.io";          // the only site allowed to use this service
const CONTACT = "https://perhamface.github.io/bishtv/"; // identifies the sender to the push services
const PUSH_HOSTS = /(^|\.)(fcm\.googleapis\.com|push\.services\.mozilla\.com|notify\.windows\.com|push\.apple\.com)$/;
const MIN = 60000;

const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const cors = { "Access-Control-Allow-Origin": ORIGIN, "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS", "Access-Control-Allow-Headers": "Content-Type", "Vary": "Origin" };
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...cors } });

// The signing keys are created once, on first use, and kept in KV. Nothing secret ever needs pasting in.
async function keys(env, create) {
  let k = await env.KV.get("vapid", "json");
  if (!k && create) {
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    k = { pub: b64u(await crypto.subtle.exportKey("raw", pair.publicKey)), jwk: await crypto.subtle.exportKey("jwk", pair.privateKey) };
    await env.KV.put("vapid", JSON.stringify(k));
  }
  return k;
}

// Send an empty push message; it simply wakes bishTV's service worker on the phone.
async function push(endpoint, k) {
  const key = await crypto.subtle.importKey("jwk", k.jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const enc = (o) => b64u(new TextEncoder().encode(JSON.stringify(o)));
  const unsigned = enc({ typ: "JWT", alg: "ES256" }) + "." + enc({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 3600, sub: CONTACT });
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(unsigned));
  return fetch(endpoint, { method: "POST", headers: { Authorization: `vapid t=${unsigned}.${b64u(sig)}, k=${k.pub}`, TTL: "600", Urgency: "high", "Content-Length": "0" } });
}

function valid(body) {
  try {
    const u = new URL(body.endpoint), at = +body.at, now = Date.now();
    return u.protocol === "https:" && PUSH_HOSTS.test(u.hostname) && body.endpoint.length < 1000 && at > now - 5 * MIN && at < now + 9 * 864e5;
  } catch (e) { return false; }
}
const bucket = (at) => "m:" + Math.floor(at / MIN);

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (!env.KV) return json({ error: "KV namespace is not bound as KV" }, 500);
    if (request.method === "GET" && path === "/key") return json({ key: (await keys(env, true)).pub });
    if (path === "/remind" && (request.method === "POST" || request.method === "DELETE")) {
      if (request.headers.get("Origin") !== ORIGIN) return json({ error: "forbidden" }, 403);
      let body; try { body = await request.json(); } catch (e) { return json({ error: "bad request" }, 400); }
      if (!valid(body)) return json({ error: "bad request" }, 400);
      // new reminders are never earlier than the next minute; cancellations use the time they were stored under
      const at = request.method === "POST" ? Math.max(+body.at, Date.now() + MIN) : +body.at;
      const name = bucket(at);
      let list = (await env.KV.get(name, "json")) || [];
      list = list.filter((e) => e !== body.endpoint);
      if (request.method === "POST") { if (list.length >= 200) return json({ error: "full" }, 429); list.push(body.endpoint); }
      if (list.length) await env.KV.put(name, JSON.stringify(list), { expirationTtl: 10 * 864e2 });
      else await env.KV.delete(name);
      return json({ ok: true, at });
    }
    return json({ service: "bishTV reminders", ok: true });
  },

  // Runs every minute: wake every phone with a reminder due now (or missed in the last couple of minutes).
  async scheduled(event, env, ctx) {
    const now = Math.floor(Date.now() / MIN), due = new Set(), used = [];
    for (let m = now - 2; m <= now; m++) {
      const list = await env.KV.get("m:" + m, "json");
      if (list) { used.push("m:" + m); list.forEach((e) => due.add(e)); }
    }
    if (!due.size) return;
    const k = await keys(env, false);
    if (k) await Promise.all([...due].slice(0, 40).map((e) => push(e, k).catch(() => {})));
    await Promise.all(used.map((name) => env.KV.delete(name)));
  }
};
