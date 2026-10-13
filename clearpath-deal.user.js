// ==UserScript==
// @name         Clear Path — Deal panel for GHL
// @namespace    clearpath
// @version      1.0.0
// @description  Adds a DEAL button on the right side of GHL lead and contact pages with the ACQ DEAL fields in one clean panel.
// @match        https://spark.magnyfi.com/*
// @match        https://app.gohighlevel.com/*
// @grant        GM_xmlhttpRequest
// @connect      voitbqpvynbvlibuzxbz.supabase.co
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";
  const FN = "https://voitbqpvynbvlibuzxbz.supabase.co/functions/v1/deal-panel";
  const KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZvaXRicXB2eW5idmxpYnV6eGJ6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM3OTU1MTAsImV4cCI6MjA5OTM3MTUxMH0.TymsmmBkOIsyI-_TuC57yi2-fEseH5ivek8w-UD82EQ";

  const css = `
  #cp-deal-btn{position:fixed;right:0;top:50%;transform:translateY(-50%);z-index:2147483000;background:#111827;color:#fff;font:600 12px/1 Inter,system-ui,sans-serif;letter-spacing:.08em;writing-mode:vertical-rl;padding:14px 9px;border-radius:8px 0 0 8px;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.25);user-select:none}
  #cp-deal-btn:hover{background:#1f2937}
  #cp-deal{position:fixed;top:0;right:0;height:100vh;width:460px;max-width:95vw;background:#fff;z-index:2147483001;box-shadow:-6px 0 24px rgba(0,0,0,.18);display:flex;flex-direction:column;font:14px/1.45 Inter,system-ui,sans-serif;color:#111827;transform:translateX(100%);transition:transform .18s ease}
  #cp-deal.open{transform:translateX(0)}
  #cp-deal header{padding:14px 16px;border-bottom:1px solid #e5e7eb;display:flex;align-items:center;gap:10px}
  #cp-deal header b{font-size:15px;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  #cp-deal header button{border:0;background:transparent;font-size:20px;cursor:pointer;color:#6b7280;line-height:1}
  #cp-deal .body{padding:12px 16px 90px;overflow:auto;flex:1}
  #cp-deal label{display:block;font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:#6b7280;margin:12px 0 4px}
  #cp-deal input,#cp-deal textarea,#cp-deal select{width:100%;box-sizing:border-box;border:1px solid #d1d5db;border-radius:6px;padding:8px 10px;font:inherit;color:#111827;background:#fff}
  #cp-deal textarea{resize:none;overflow:hidden;min-height:60px}
  #cp-deal input:focus,#cp-deal textarea:focus,#cp-deal select:focus{outline:2px solid #2563eb;border-color:transparent}
  #cp-deal footer{position:absolute;bottom:0;left:0;right:0;padding:12px 16px;border-top:1px solid #e5e7eb;background:#fff;display:flex;align-items:center;gap:10px}
  #cp-deal footer button{background:#2563eb;color:#fff;border:0;border-radius:6px;padding:10px 18px;font:600 14px Inter,system-ui,sans-serif;cursor:pointer}
  #cp-deal footer button:disabled{opacity:.5;cursor:default}
  #cp-deal .msg{font-size:12px;color:#6b7280;flex:1}
  #cp-deal .msg.err{color:#b91c1c}
  #cp-deal .msg.ok{color:#047857}
  #cp-deal .empty{padding:40px 10px;color:#6b7280;text-align:center}
  `;
  const style = document.createElement("style"); style.textContent = css; document.documentElement.appendChild(style);

  function ctx() {
    const u = location.pathname;
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
    btn.addEventListener("click", () => { panel.classList.toggle("open"); if (panel.classList.contains("open")) load(); });
    panel = document.createElement("aside"); panel.id = "cp-deal";
    panel.innerHTML = `<header><b>Deal</b><button title="Close">×</button></header><div class="body"></div><footer><span class="msg"></span><button>Save</button></footer>`;
    panel.querySelector("header button").addEventListener("click", () => panel.classList.remove("open"));
    panel.querySelector("footer button").addEventListener("click", save);
    panel.addEventListener("keydown", (e) => { if ((e.metaKey || e.ctrlKey) && e.key === "s") { e.preventDefault(); save(); } });
    document.body.appendChild(btn); document.body.appendChild(panel);
  }

  let lastPath = "";
  function tick() {
    const c = ctx();
    if (c) { build(); btn.style.display = ""; } else if (btn) { btn.style.display = "none"; panel.classList.remove("open"); }
    if (location.pathname !== lastPath) { lastPath = location.pathname; if (panel && panel.classList.contains("open") && c) load(); }
  }
  setInterval(tick, 800); tick();
})();
