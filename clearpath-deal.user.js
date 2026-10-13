// ==UserScript==
// @name         Clear Path — Deal panel for GHL
// @namespace    clearpath
// @version      2.3.0
// @description  DEAL button + dark mode for GHL (Clear Path).
// @match        https://spark.magnyfi.com/*
// @match        https://app.gohighlevel.com/*
// @grant        GM_xmlhttpRequest
// @connect      voitbqpvynbvlibuzxbz.supabase.co
// @updateURL    https://nicholliday.github.io/clearpath-acq/clearpath-deal.user.js
// @downloadURL  https://nicholliday.github.io/clearpath-acq/clearpath-deal.user.js
// @run-at       document-idle
// ==/UserScript==

// Clear Path — Deal panel body. Loaded live by clearpath-deal.user.js; edit THIS file, no reinstall needed.
(function () {
  "use strict";
  function cpMark(txt, bg) { try { const d = document.createElement("div"); d.className = "cp-mark"; d.textContent = txt; d.style.cssText = "position:fixed;left:0;bottom:0;z-index:2147483647;background:" + bg + ";color:#fff;padding:3px 8px;font:11px/1.2 monospace;opacity:.85;max-width:60vw;white-space:pre-wrap"; (document.body || document.documentElement).appendChild(d); return d; } catch (e) { return null; } }
  if (document.getElementById("cp-deal-loaded")) { cpMark("cp-deal: already loaded", "#6b7280"); return; }
  { const mk = document.createElement("meta"); mk.id = "cp-deal-loaded"; (document.head || document.documentElement).appendChild(mk); }
  const alive = cpMark("cp " + (typeof GM_xmlhttpRequest === "function" ? "tm" : "page") + " v2.3", "#047857");
  try {
  const FN = "https://voitbqpvynbvlibuzxbz.supabase.co/functions/v1/deal-panel";
  const KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZvaXRicXB2eW5idmxpYnV6eGJ6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM3OTU1MTAsImV4cCI6MjA5OTM3MTUxMH0.TymsmmBkOIsyI-_TuC57yi2-fEseH5ivek8w-UD82EQ";

  const css = `
  #cp-deal-btn{position:fixed;right:0;top:50%;transform:translateY(-50%);z-index:2147483000;background:#111827;color:#fff;font:700 16px/1 Inter,system-ui,sans-serif;letter-spacing:.12em;writing-mode:vertical-rl;padding:22px 14px;border-radius:10px 0 0 10px;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.25);user-select:none}
  #cp-deal-btn:hover{background:#1f2937}
  #cp-deal{position:fixed;top:0;right:0;height:100vh;width:840px;max-width:95vw;background:#fff;z-index:2147483001;box-shadow:-6px 0 24px rgba(0,0,0,.18);display:flex;flex-direction:column;font:16px/1.5 Inter,system-ui,sans-serif;color:#111827;transform:translateX(100%);transition:transform .18s ease}
  #cp-deal.open{transform:translateX(0)}
  #cp-deal.drag{transition:none;user-select:none}
  #cp-deal .grip{position:absolute;left:0;top:0;bottom:0;width:10px;cursor:ew-resize;background:transparent;z-index:5;border-left:1px solid #e5e7eb}
  #cp-deal .grip:hover,#cp-deal.drag .grip{background:#2563eb33}
  #cp-deal header{padding:14px 16px;border-bottom:1px solid #e5e7eb;display:flex;align-items:center;gap:10px}
  #cp-deal header b{font-size:15px;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  #cp-deal header button{border:0;background:transparent;font-size:20px;cursor:pointer;color:#6b7280;line-height:1}
  #cp-deal .body{padding:12px 16px 90px;overflow:auto;flex:1}
  #cp-deal label{display:block;font-size:12px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:#6b7280;margin:12px 0 4px}
  #cp-deal input,#cp-deal textarea,#cp-deal select{width:100%;box-sizing:border-box;border:1px solid #d1d5db;border-radius:6px;padding:10px 12px;font:inherit;color:#111827;background:#fff}
  #cp-deal textarea{resize:none;overflow:hidden;min-height:60px}
  #cp-deal input:focus,#cp-deal textarea:focus,#cp-deal select:focus{outline:2px solid #2563eb;border-color:transparent}
  #cp-deal footer{position:absolute;bottom:0;left:0;right:0;padding:12px 16px;border-top:1px solid #e5e7eb;background:#fff;display:flex;align-items:center;gap:10px}
  #cp-deal footer button{background:#2563eb;color:#fff;border:0;border-radius:6px;padding:10px 18px;font:600 14px Inter,system-ui,sans-serif;cursor:pointer}
  #cp-deal footer button:disabled{opacity:.5;cursor:default}
  #cp-deal .msg{font-size:12px;color:#6b7280;flex:1}
  #cp-deal .msg.err{color:#b91c1c}
  #cp-deal .msg.ok{color:#047857}
  #cp-deal .empty{padding:40px 10px;color:#6b7280;text-align:center}
  #cp-dark-btn{position:fixed;right:14px;bottom:14px;z-index:2147483000;width:38px;height:38px;border-radius:50%;background:#111827;color:#fff;font:18px/38px system-ui,sans-serif;text-align:center;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.3);user-select:none;opacity:.75}
  #cp-dark-btn:hover{opacity:1}
  html.cp-dark{filter:invert(.92) hue-rotate(180deg);background:#111 !important}
  html.cp-dark img,html.cp-dark video,html.cp-dark canvas,html.cp-dark svg image,html.cp-dark [style*="background-image"],html.cp-dark iframe{filter:invert(1) hue-rotate(180deg)}
  html.cp-dark #cp-deal-btn,html.cp-dark #cp-dark-btn{filter:invert(1) hue-rotate(180deg)}
  #cp-deal .addr{font-size:18px;font-weight:700;color:#111827;padding:4px 0 10px;border-bottom:1px solid #e5e7eb;margin-bottom:4px;line-height:1.3}
  `;
  const style = document.createElement("style"); style.textContent = css; document.documentElement.appendChild(style);

  function ctx() {
    const u = location.pathname;
    if (!u.includes("/location/X3V3CEzeEFuuMMN2MsM7/")) return null;
    let m = u.match(/\/contacts\/detail\/([A-Za-z0-9]{15,})/); if (m) return { contactId: m[1] };
    m = u.match(/\/opportunities\/(?:list\/|pipeline\/)?([A-Za-z0-9]{15,})\/?$/); if (m && !/^(list|pipeline|kanban)$/.test(m[1])) return { opportunityId: m[1] };
    return null;
  }

  function api(body) {
    if (typeof GM_xmlhttpRequest !== "function") {
      return fetch(FN, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json", Authorization: "Bearer " + KEY, apikey: KEY } }).then((r) => r.json());
    }
    return new Promise((res, rej) => {
      GM_xmlhttpRequest({
        method: "POST", url: FN, data: JSON.stringify(body),
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + KEY, apikey: KEY },
        onload: (r) => { try { res(JSON.parse(r.responseText)); } catch (e) { rej(new Error("bad response")); } },
        onerror: () => rej(new Error("network error")),
      });
    });
  }

  let panel, btn, state = { oppId: null, schema: null };

  function grow(t) { t.style.height = "auto"; t.style.height = Math.max(60, t.scrollHeight + 2) + "px"; }

  function render(data) {
    const body = panel.querySelector(".body");
    body.innerHTML = "";
    if (!data.ok) { body.innerHTML = `<div class="empty">${data.error || "Nothing here"}</div>`; panel.querySelector("footer button").disabled = true; return; }
    state.oppId = data.opportunityId; state.schema = data.schema;
    panel.querySelector("header b").textContent = data.name || "Deal";
    const addr = document.createElement("div"); addr.className = "addr";
    addr.textContent = data.address || (data.name || "").replace(/^[^-]*-\s*/, "") || "No address on file";
    body.appendChild(addr);
    for (const f of data.schema) {
      const lab = document.createElement("label"); lab.textContent = f.label; body.appendChild(lab);
      let el;
      if (f.kind === "pick") {
        el = document.createElement("select");
        el.innerHTML = `<option value=""></option>` + f.options.map((o) => `<option>${o}</option>`).join("");
        el.value = data.fields[f.key] || "";
      } else if (f.kind === "long") {
        el = document.createElement("textarea"); el.value = data.fields[f.key] || "";
        el.addEventListener("input", () => grow(el)); setTimeout(() => grow(el), 0);
      } else {
        el = document.createElement("input"); el.type = "text"; el.value = data.fields[f.key] || "";
      }
      el.dataset.key = f.key; body.appendChild(el);
    }
    panel.querySelector("footer button").disabled = false;
    msg("");
  }

  function msg(t, cls) { const m = panel.querySelector(".msg"); m.textContent = t; m.className = "msg " + (cls || ""); }

  async function load() {
    const c = ctx(); if (!c) return;
    panel.querySelector("header b").textContent = "Loading…";
    panel.querySelector(".body").innerHTML = `<div class="empty">Loading…</div>`;
    try { render(await api(c)); } catch (e) { render({ ok: false, error: e.message }); }
  }

  async function save() {
    if (!state.oppId) return;
    const fields = {};
    panel.querySelectorAll("[data-key]").forEach((el) => { fields[el.dataset.key] = el.value; });
    const b = panel.querySelector("footer button"); b.disabled = true; msg("Saving…");
    try {
      const r = await api({ action: "save", opportunityId: state.oppId, fields });
      if (r.ok) msg("Saved", "ok"); else msg(r.error || "Save failed", "err");
    } catch (e) { msg(e.message, "err"); }
    b.disabled = false;
  }

  function build() {
    if (panel) return;
    btn = document.createElement("div"); btn.id = "cp-deal-btn"; btn.textContent = "DEAL";
    btn.addEventListener("click", () => { panel.classList.toggle("open"); if (panel.classList.contains("open")) { if (panel.__snap) panel.__snap(); load(); } });
    panel = document.createElement("aside"); panel.id = "cp-deal";
    panel.innerHTML = `<div class="grip" title="Drag to resize"></div><header><b>Deal</b><button title="Close">×</button></header><div class="body"></div><footer><span class="msg"></span><button>Save</button></footer>`;
    try { const w = parseInt(localStorage.getItem("cp-deal-w") || "", 10); if (w >= 360) panel.style.width = w + "px"; } catch (e) {}
    // default width: stretch to the left border of GHL's right sidebar (Tasks column) when no saved size
    function snapWidth() {
      try { if (localStorage.getItem("cp-deal-w")) return; } catch (e) {}
      const col = document.querySelector(".right-sidebar-container, [class*='right-sidebar']");
      if (col) { const w = window.innerWidth - col.getBoundingClientRect().left; if (w >= 360 && w <= window.innerWidth * 0.95) panel.style.width = Math.round(w) + "px"; }
    }
    panel.__snap = snapWidth;
    const grip = panel.querySelector(".grip");
    grip.addEventListener("dblclick", () => { try { localStorage.removeItem("cp-deal-w"); } catch (e) {} panel.style.width = ""; snapWidth(); });
    grip.addEventListener("mousedown", (e) => {
      e.preventDefault(); panel.classList.add("drag");
      const move = (ev) => { const w = Math.min(window.innerWidth * 0.95, Math.max(360, window.innerWidth - ev.clientX)); panel.style.width = w + "px"; };
      const up = () => { panel.classList.remove("drag"); document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up); try { localStorage.setItem("cp-deal-w", String(parseInt(panel.style.width, 10))); } catch (e) {} };
      document.addEventListener("mousemove", move); document.addEventListener("mouseup", up);
    });
    panel.querySelector("header button").addEventListener("click", () => panel.classList.remove("open"));
    panel.querySelector("footer button").addEventListener("click", save);
    panel.addEventListener("keydown", (e) => { if ((e.metaKey || e.ctrlKey) && e.key === "s") { e.preventDefault(); save(); } });
    document.body.appendChild(btn); document.body.appendChild(panel);
  }

  // ---- Dark mode toggle (every GHL page) ----
  function darkApply(on) { document.documentElement.classList.toggle("cp-dark", on); const b = document.getElementById("cp-dark-btn"); if (b) { b.textContent = on ? "\u2600" : "\u263E"; b.title = on ? "Light mode" : "Dark mode"; } }
  function darkInit() {
    if (document.getElementById("cp-dark-btn")) return;
    const b = document.createElement("div"); b.id = "cp-dark-btn"; b.title = "Toggle dark mode";
    let on = false; try { on = localStorage.getItem("cp-dark") === "1"; } catch (e) {}
    b.addEventListener("click", () => { on = !on; try { localStorage.setItem("cp-dark", on ? "1" : "0"); } catch (e) {} darkApply(on); });
    (document.body || document.documentElement).appendChild(b); darkApply(on);
  }
  if (location.pathname.includes("/location/X3V3CEzeEFuuMMN2MsM7/")) { if (document.body) darkInit(); else document.addEventListener("DOMContentLoaded", darkInit); }

  let lastPath = "";
  function tick() {
    const c = ctx();
    if (c) { build(); btn.style.display = ""; } else if (btn) { btn.style.display = "none"; panel.classList.remove("open"); }
    if (btn && !document.body.contains(btn)) { document.body.appendChild(btn); document.body.appendChild(panel); }
    const db = document.getElementById("cp-dark-btn"); if (!db && location.pathname.includes("/location/X3V3CEzeEFuuMMN2MsM7/")) darkInit();
    if (location.pathname !== lastPath) { lastPath = location.pathname; if (panel && panel.classList.contains("open") && c) load(); }
  }
  setInterval(tick, 800); tick();
  if (alive) setTimeout(() => { try { alive.remove(); } catch (e) {} }, 15000);
  } catch (e) { cpMark("cp-deal error: " + (e && e.stack || e), "#b91c1c"); }
})();
