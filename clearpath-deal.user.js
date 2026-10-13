// ==UserScript==
// @name         Clear Path — Deal panel for GHL
// @namespace    clearpath
// @version      2.0.0
// @description  Adds a DEAL button on the right side of GHL lead and contact pages with the ACQ DEAL fields in one clean panel. Loads the latest panel code live.
// @match        https://spark.magnyfi.com/*
// @match        https://app.gohighlevel.com/*
// @grant        GM_xmlhttpRequest
// @connect      voitbqpvynbvlibuzxbz.supabase.co
// @connect      nicholliday.github.io
// @updateURL    https://nicholliday.github.io/clearpath-acq/clearpath-deal.user.js
// @downloadURL  https://nicholliday.github.io/clearpath-acq/clearpath-deal.user.js
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";
  // Thin loader: fetches the live panel code every page load so updates ship without reinstalling.
  const SRC = "https://nicholliday.github.io/clearpath-acq/deal-panel.js";
  const FALLBACK_KEY = "cp-deal-src";
  function run(code) { try { new Function("GM_xmlhttpRequest", code)(typeof GM_xmlhttpRequest === "function" ? GM_xmlhttpRequest : undefined); } catch (e) { console.error("[cp-deal] run failed", e); } }
  function fromCache() { try { const c = localStorage.getItem(FALLBACK_KEY); if (c) run(c); } catch (e) {} }
  GM_xmlhttpRequest({
    method: "GET", url: SRC + "?t=" + Math.floor(Date.now() / 60000), headers: { "Cache-Control": "no-cache" },
    onload: (r) => { if (r.status === 200 && r.responseText.includes("cp-deal-btn")) { try { localStorage.setItem(FALLBACK_KEY, r.responseText); } catch (e) {} run(r.responseText); } else fromCache(); },
    onerror: fromCache,
  });
})();
