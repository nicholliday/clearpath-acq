// TOM BOT — acq AI texter "Tom" (Nic, Oct 15 2026). Master switch tom_settings.enabled = false by default and Claude never flips it.
// Jobs (POST JSON):
//   {"job":"sync"}                 pull ACQ pipeline leads + contact DND + notes + tasks + threads + transcripts into tom_leads / acq_lead_msgs
//   {"job":"think","limit":12}     draft the next text for leads that are due (seller waiting first) -> tom_drafts status=pending
//   {"job":"send"}                 cron: send approved drafts whose window is open. If enabled=true, pending drafts auto-approve (that's the master switch).
//   {"job":"send","draft_id":N,"text":"optional edited text"}   Nic's "yes" from the page: approve + send now (window permitting)
//   {"job":"skip","draft_id":N,"reason":"..."}                  Nic's "no" from the page (saved as training)
//   {"job":"alerts"}               cron: text the rep 5 min before a booked call; close old bookings
//   {"job":"lost","contact_id":"..."}  opt-out: move the lead to Good Lead, Lost (Nic approved Tom doing this one stage move)
//   {"job":"preview","contact_id":"..."} draft for one lead, nothing stored
import { createClient } from "npm:@supabase/supabase-js@2";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const ANTHROPIC = Deno.env.get("ANTHROPIC_API_KEY") || "";
const OPENPHONE = Deno.env.get("OPENPHONE_API_KEY") || "";
const TOKENS = [Deno.env.get("GHL_API_KEY"), Deno.env.get("GHL_TOKEN"), Deno.env.get("GHL_KEY")].filter(Boolean) as string[];
const LOC = Deno.env.get("GHL_LOCATION_ID") || "X3V3CEzeEFuuMMN2MsM7";
const GHL = "https://services.leadconnectorhq.com";
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };

const ACQ = "owsE1AXkoVrQSMsLOkqR";
const CONTRACTS = "j6husz7Equh3sGNpXP71";
const NIC = "UvBSAHJwAJYCcaz9fc3v", BT = "M5wUjnyx5fEyErXT21mv";
const REPS: Record<string, string> = { [NIC]: "Nic", [BT]: "BT" };
const ST = {
  contractMonth: "c7e05377-6ec2-44c6-b14a-ff08b2ec48df", coldCall: "0e8f9728-f3f8-4e76-a746-f3a88dce0be0", sTier: "633e3505-eeba-4c9d-9c41-2911b4f09b67",
  untouched: "b1960775-e04e-411c-87b2-f314229ea72a", attempt: "da4627ba-b8eb-4d1a-86e4-ca3bb671d2bc", noReply: "3fb04729-e55b-4eba-b3f5-2abe18f7f285",
  inConv: "cc60bd32-2d06-4445-8593-61a933170d06", interested: "2756d7d4-d11f-4e27-9e1b-b63e3905b0dc", distressed: "3bd80eb7-1eea-4e60-b54b-d5e187bd9123",
  rejected: "5f92b756-fb92-43b2-9ff7-9302ed3c1314", competitor: "ed7c5f79-fb09-4202-b3a2-1ee39689eeaf", listedRealtor: "7a1c95cf-e2c2-4824-8873-00c240594ba3",
  longTerm: "7d0bbfbd-cc21-47ff-9932-ed27eb4eac9b", noLonger: "0196e221-5099-4a18-ac18-b7713d4d6a8e", wantsRetail: "032073aa-b852-41c1-a24f-9fb29ca6083f",
  alreadyListed: "4cdd2595-0258-4e1a-9957-e3b3a4794085", notInterested: "50bd8706-1242-4731-9350-c49243196af7", lost: "02e1b0b6-d6be-43f9-b617-c14bcc59aacd",
};
const SILENT = new Set([ST.untouched, ST.attempt, ST.noReply]);
const JUDGMENT = new Set([ST.contractMonth, ST.coldCall, ST.sTier, ST.inConv, ST.interested, ST.distressed, ST.rejected, ST.competitor, ST.listedRealtor, ST.longTerm, ST.noLonger, ST.wantsRetail, ST.alreadyListed, ST.notInterested]);
// everything else in ACQ (Spam, Wholesaler/Agent, Out of Area, Good Lead Lost, Bad Lead, Numbers Not Workable) = never

const STOP_RX = /^\s*(stop|stop all|stopall|unsubscribe|cancel|end|quit|remove me|no more|take me off( your list)?|do not (text|contact|call) me|dont (text|call) me|don't (text|call) me|stop (texting|calling|contacting)( me)?|please stop)\s*[.!]*\s*$/i;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ten = (v: unknown) => String(v ?? "").replace(/\D/g, "").slice(-10);
const e164 = (p: unknown) => { const d = String(p ?? "").replace(/\D/g, ""); return d.length === 10 ? "+1" + d : d.length === 11 && d.startsWith("1") ? "+" + d : d ? "+" + d : ""; };
const now = () => new Date();
const iso = (d: Date) => d.toISOString();
const days = (n: number) => n * 86400e3;

async function log(contact_id: string | null, event: string, detail = "") { await sb.from("tom_log").insert({ contact_id, event, detail: detail.slice(0, 900) }); }

async function ghl(path: string, init: RequestInit = {}): Promise<{ ok: boolean; status: number; body: any }> {
  let last = { ok: false, status: 0, body: null as any };
  for (const t of TOKENS) {
    for (let i = 0; i < 3; i++) {
      const r = await fetch(GHL + path, { ...init, headers: { Authorization: "Bearer " + t, Version: "2021-07-28", Accept: "application/json", "Content-Type": "application/json", ...(init.headers || {}) } });
      let body: any = null; try { body = await r.json(); } catch { /* empty */ }
      if (r.status === 429) { await sleep(1500); continue; }
      last = { ok: r.ok, status: r.status, body }; break;
    }
    if (last.status !== 401 && last.status !== 403) return last;
  }
  return last;
}

// ---------- time windows (property state) ----------
const TZ: Record<string, string> = { TX: "America/Chicago", OK: "America/Chicago", LA: "America/Chicago", MS: "America/Chicago", TN: "America/Chicago", AL: "America/Chicago", AR: "America/Chicago", MO: "America/Chicago", FL: "America/New_York", GA: "America/New_York", NC: "America/New_York", SC: "America/New_York", OH: "America/New_York", IN: "America/New_York", MI: "America/New_York", KY: "America/New_York", VA: "America/New_York", PA: "America/New_York", NY: "America/New_York", NJ: "America/New_York", CO: "America/Denver", AZ: "America/Phoenix", NM: "America/Denver", CA: "America/Los_Angeles", NV: "America/Los_Angeles", WA: "America/Los_Angeles", OR: "America/Los_Angeles" };
const tzOf = (state?: string | null) => TZ[String(state ?? "").toUpperCase()] || "America/Chicago";
function local(d: Date, tz: string) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour12: false, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(d).map((x) => [x.type, x.value]));
  return { hour: Number(p.hour) % 24, minute: Number(p.minute), dow: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday), ymd: `${p.year}-${p.month}-${p.day}` };
}
// legal window for the PROPERTY state. TX 9-9 Mon-Sat, Sun noon-9. Everyone else 8-9 (federal). Not legal advice; Nic to confirm.
function windowOpen(d: Date, state?: string | null): boolean {
  const l = local(d, tzOf(state)); const st = String(state ?? "").toUpperCase();
  const start = st === "TX" ? (l.dow === 0 ? 12 : 9) : 8;
  return l.hour >= start && l.hour < 21;
}
function nextOpen(from: Date, state?: string | null): Date {
  const d = new Date(from.getTime());
  for (let i = 0; i < 48 * 4; i++) { if (windowOpen(d, state)) return d; d.setTime(d.getTime() + 15 * 60e3); }
  return d;
}
// "2026-10-15T20:00" written in the property's local time -> real instant
function fromLocal(str: string, tz: string): Date | null {
  if (!str) return null;
  const m = String(str).match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/); if (!m) { const d = new Date(str); return isNaN(d.getTime()) ? null : d; }
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(String(str).trim())) { const d = new Date(str); return isNaN(d.getTime()) ? null : d; }
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  const l = local(new Date(guess), tz);
  const asIf = Date.UTC(+l.ymd.slice(0, 4), +l.ymd.slice(5, 7) - 1, +l.ymd.slice(8, 10), l.hour, l.minute);
  return new Date(guess - (asIf - guess));
}
// drifted minutes: never on a round number
function drift(d: Date): Date { const m = d.getUTCMinutes(); const add = (m % 15 === 0 || m % 10 === 0) ? 3 + Math.floor(Math.random() * 9) : 0; return new Date(d.getTime() + add * 60e3); }

// ---------- settings ----------
async function settings() {
  const { data } = await sb.from("tom_settings").select("*").eq("id", 1).single();
  if (data && !data.brief) { await sb.from("tom_settings").update({ brief: DEFAULT_BRIEF }).eq("id", 1); data.brief = DEFAULT_BRIEF; }
  return data!;
}

// ---------- SYNC ----------
function splitName(n = "") { const i = n.indexOf(" - "); return i === -1 ? { seller: n.trim(), address: "" } : { seller: n.slice(0, i).trim(), address: n.slice(i + 3).replace(/,\s*$/, "").trim() }; }
const STATE_NAMES: Record<string, string> = { illinois: "IL", pennsylvania: "PA", "new york": "NY", "new jersey": "NJ", washington: "WA", oregon: "OR", wisconsin: "WI", minnesota: "MN", iowa: "IA", kansas: "KS", nebraska: "NE", maryland: "MD", utah: "UT", idaho: "ID", texas: "TX", tennessee: "TN", florida: "FL", oklahoma: "OK", louisiana: "LA", mississippi: "MS", alabama: "AL", arkansas: "AR", georgia: "GA", missouri: "MO", kentucky: "KY", ohio: "OH", indiana: "IN", michigan: "MI", virginia: "VA", colorado: "CO", arizona: "AZ", california: "CA", "new mexico": "NM", "north carolina": "NC", "south carolina": "SC", nevada: "NV" };
const STATE_ABBR = "TX|TN|FL|OK|LA|MS|AL|AR|GA|NC|SC|MO|KY|OH|IN|MI|VA|CO|AZ|NM|CA|NV|IL|PA|NY|NJ|WA|OR|WI|MN|IA|KS|NE|SD|ND|WV|MD|DE|DC|UT|ID|MT|WY|ME|NH|VT|MA|CT|RI";
const stateFromAddress = (a = "") => {
  const m = a.match(new RegExp("\\b(" + STATE_ABBR + ")\\b(?=[\\s,.]*\\d{5}|[\\s,.]*$)", "i")); if (m) return m[1].toUpperCase();
  const low = a.toLowerCase(); for (const k of Object.keys(STATE_NAMES).sort((x, y) => y.length - x.length)) if (new RegExp("\\b" + k + "\\b").test(low)) return STATE_NAMES[k];
  return null;
};

async function syncOpps(deadline: number) {
  const stageNames = new Map<string, string>();
  const pl = await ghl(`/opportunities/pipelines?locationId=${LOC}`);
  for (const p of pl.body?.pipelines ?? []) for (const s of p.stages ?? []) stageNames.set(s.id, s.name);
  const seen = new Set<string>(); const contracted = new Set<string>();
  // CONTRACTS pipeline = dispo's. Anyone there is under contract -> Tom never texts.
  for (let page = 1; page < 30; page++) {
    const r = await ghl(`/opportunities/search?location_id=${LOC}&pipeline_id=${CONTRACTS}&status=open&limit=100&page=${page}`);
    const list = r.body?.opportunities ?? []; for (const o of list) if (o.contactId) contracted.add(o.contactId);
    if (list.length < 100) break;
  }
  let complete = false, n = 0;
  for (let page = 1; page < 60; page++) {
    if (Date.now() > deadline) break;
    const r = await ghl(`/opportunities/search?location_id=${LOC}&pipeline_id=${ACQ}&status=open&limit=100&page=${page}`);
    if (!r.ok) { await log(null, "sync_error", `opps page ${page} ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`); break; }
    const list = r.body?.opportunities ?? [];
    const rows: any[] = [];
    for (const o of list) {
      const cid = o.contactId || o.contact?.id; if (!cid) continue;
      if (seen.has(cid)) continue; // duplicate opps: first one wins (Nic owes a merge)
      seen.add(cid);
      const sid = o.pipelineStageId;
      const mode = contracted.has(cid) ? "off" : SILENT.has(sid) ? "silent" : JUDGMENT.has(sid) ? "judgment" : "off";
      const { seller, address } = splitName(o.name || "");
      rows.push({
        contact_id: cid, opp_id: o.id, pipeline_id: ACQ, stage_id: sid, stage: stageNames.get(sid) ?? sid,
        name: seller || o.contact?.name || null, first_name: (seller || o.contact?.name || "").split(/\s+/)[0] || null,
        address: address || null, phone: e164(o.contact?.phone) || null, email: o.contact?.email || null,
        assigned_to: o.assignedTo || null, assigned_name: REPS[o.assignedTo] ?? null,
        mode, tags: o.contact?.tags ?? [], form_at: o.createdAt, stage_changed_at: o.lastStageChangeAt || null,
        under_contract: contracted.has(cid), synced_at: iso(now()), updated_at: iso(now()),
      });
    }
    if (rows.length) {
      // keep per-lead fields we learned elsewhere: upsert only the columns above
      const { error } = await sb.from("tom_leads").upsert(rows, { onConflict: "contact_id" });
      if (error) await log(null, "sync_error", error.message);
      n += rows.length;
    }
    if (list.length < 100) { complete = true; break; }
    await sleep(120);
  }
  if (complete) {
    // leads that left the open ACQ pipeline (won, lost, deleted, moved) -> off
    const { data: all } = await sb.from("tom_leads").select("contact_id").neq("mode", "off");
    const gone = (all ?? []).map((x: any) => x.contact_id).filter((c: string) => !seen.has(c));
    for (let i = 0; i < gone.length; i += 200) await sb.from("tom_leads").update({ mode: "off", updated_at: iso(now()) }).in("contact_id", gone.slice(i, i + 200));
    if (gone.length) await sb.from("tom_drafts").update({ status: "expired", guard: "lead left the pipeline" }).in("contact_id", gone).eq("status", "pending");
  }
  // anything now 'off' loses its pending drafts
  const { data: offs } = await sb.from("tom_drafts").select("id,contact_id").eq("status", "pending");
  if (offs?.length) {
    const { data: offLeads } = await sb.from("tom_leads").select("contact_id").eq("mode", "off").in("contact_id", offs.map((x: any) => x.contact_id));
    const ids = (offLeads ?? []).map((x: any) => x.contact_id);
    if (ids.length) await sb.from("tom_drafts").update({ status: "expired", guard: "stage no longer worked / under contract" }).in("contact_id", ids).eq("status", "pending");
  }
  return { opps: n, complete, contracted: contracted.size };
}

function msgRow(contactId: string, m: any) {
  const mt = String(m.messageType ?? "");
  const kind = /CALL/.test(mt) ? "call" : /EMAIL/.test(mt) ? "email" : /SMS|FACEBOOK|WHATSAPP|INSTAGRAM|LIVE_CHAT/.test(mt) ? "sms" : /ACTIVITY/.test(mt) ? "activity" : "other";
  return { id: String(m.id), contact_id: contactId, at: m.dateAdded, direction: String(m.direction ?? "").toLowerCase() || null, kind, body: (String(m.body ?? "").trim() || (Array.isArray(m.attachments) && m.attachments.length ? "[photo/attachment x" + m.attachments.length + "]" : "")).slice(0, 4000) || null, status: m.status ?? null, duration_sec: m.meta?.call?.duration ?? null, user_id: m.userId ?? null, from_num: null, to_num: null, source: m.source ?? null, raw: { messageType: mt, attachments: m.attachments ?? null, callStatus: m.meta?.call?.status ?? null }, fetched_at: iso(now()) };
}

async function refreshLead(cid: string): Promise<string> {
  const { data: lead } = await sb.from("tom_leads").select("*").eq("contact_id", cid).single();
  if (!lead) return "no lead";
  const upd: any = { updated_at: iso(now()) };
  // contact: phone, email, DND, address
  const c = (await ghl(`/contacts/${encodeURIComponent(cid)}`)).body?.contact;
  if (c) {
    const on = (s: any) => ["active", "permanent"].includes(String(s?.status ?? ""));
    upd.phone = e164(c.phone) || lead.phone; upd.email = c.email || lead.email;
    upd.dnd_sms = c.dnd === true || on(c.dndSettings?.SMS) || on(c.dndSettings?.sms);
    upd.dnd_call = c.dnd === true || on(c.dndSettings?.Call) || on(c.dndSettings?.call);
    upd.dnd_email = c.dnd === true || on(c.dndSettings?.Email) || on(c.dndSettings?.email);
    upd.city = c.city || lead.city; upd.state = (c.state && c.state.length === 2 ? c.state.toUpperCase() : STATE_NAMES[String(c.state ?? "").toLowerCase()] ?? null) || stateFromAddress(lead.address || "") || lead.state; upd.postal = c.postalCode || lead.postal;
    if (!lead.address && c.address1) upd.address = c.address1;
    upd.tags = c.tags ?? lead.tags;
    if (!lead.first_name && c.firstName) upd.first_name = c.firstName;
  }
  // notes + tasks
  const notes = (await ghl(`/contacts/${encodeURIComponent(cid)}/notes`)).body?.notes ?? [];
  upd.notes_text = notes.sort((a: any, b: any) => String(a.dateAdded).localeCompare(String(b.dateAdded))).map((n: any) => `[${String(n.dateAdded).slice(0, 10)}${REPS[n.userId] ? " " + REPS[n.userId] : ""}] ${String(n.body ?? "").replace(/\s+/g, " ").trim()}`).join("\n").slice(-6000);
  const tasks = (await ghl(`/contacts/${encodeURIComponent(cid)}/tasks`)).body?.tasks ?? [];
  const open = tasks.filter((t: any) => !t.completed).sort((a: any, b: any) => String(a.dueDate).localeCompare(String(b.dueDate)));
  upd.tasks_text = tasks.sort((a: any, b: any) => String(a.dueDate).localeCompare(String(b.dueDate))).slice(-25).map((t: any) => `[${t.completed ? "done" : "OPEN"} due ${String(t.dueDate ?? "").slice(0, 10)}${REPS[t.assignedTo] ? " " + REPS[t.assignedTo] : ""}] ${t.title ?? ""}${t.body ? " - " + String(t.body).replace(/\s+/g, " ").slice(0, 160) : ""}`).join("\n").slice(-3000);
  upd.open_task_title = open[0]?.title ?? null; upd.open_task_due = open[0]?.dueDate ?? null;
  // thread
  let convId = lead.conv_id;
  if (!convId) { const cs = await ghl(`/conversations/search?locationId=${LOC}&contactId=${encodeURIComponent(cid)}`); convId = cs.body?.conversations?.[0]?.id ?? null; upd.conv_id = convId; }
  if (convId) {
    const ms = await ghl(`/conversations/${convId}/messages?limit=100`);
    const list: any[] = ms.body?.messages?.messages ?? ms.body?.messages ?? [];
    if (list.length) {
      const rows = list.map((m) => msgRow(cid, m)).filter((r) => r.kind !== "other");
      const { error } = await sb.from("acq_lead_msgs").upsert(rows, { onConflict: "id" });
      if (error) await log(cid, "msgs_error", error.message);
    }
  }
  // transcripts for the 2 newest rep calls >= 45s that we have not read yet
  const { data: calls } = await sb.from("acq_lead_msgs").select("id,at,duration_sec,raw").eq("contact_id", cid).eq("kind", "call").gte("duration_sec", 45).order("at", { ascending: false }).limit(4);
  let tx = 0;
  for (const call of calls ?? []) {
    if (tx >= 2) break;
    if (call.raw?.transcript !== undefined) continue;
    const t = await ghl(`/conversations/locations/${LOC}/messages/${call.id}/transcription`);
    const segs: any[] = Array.isArray(t.body) ? t.body : (t.body?.transcription ?? t.body?.transcripts ?? []);
    const text = segs.map((s: any) => String(s.transcript ?? s.text ?? "")).join(" ").replace(/\s+/g, " ").trim().slice(0, 6000);
    await sb.from("acq_lead_msgs").update({ raw: { ...(call.raw ?? {}), transcript: t.ok ? text : "" } }).eq("id", call.id);
    tx++;
  }
  // derived state from the thread
  const { data: msgs } = await sb.from("acq_lead_msgs").select("id,at,direction,kind,body,status,duration_sec,user_id,source").eq("contact_id", cid).order("at", { ascending: false }).limit(120);
  const { data: mine } = await sb.from("tom_drafts").select("ghl_message_id").eq("contact_id", cid).eq("status", "sent");
  const tomIds = new Set((mine ?? []).map((x: any) => x.ghl_message_id));
  let lastIn: any = null, lastOut: any = null, lastRep: any = null, lastRepCall: any = null;
  for (const m of msgs ?? []) {
    const isIn = m.direction === "inbound";
    if (m.kind === "sms" && isIn && !lastIn) lastIn = m;
    if (m.kind === "sms" && !isIn && !lastOut) lastOut = m;
    const rep = !isIn && m.kind !== "activity" && !tomIds.has(m.id) && m.source !== "workflow" && m.source !== "automation" && (m.kind === "call" || m.user_id);
    if (rep && !lastRep) lastRep = m;
    if (m.kind === "call" && !lastRepCall && !isIn) lastRepCall = m;
  }
  if (lastIn) { upd.last_in_at = lastIn.at; upd.last_in_body = lastIn.body; upd.reply_hour = local(new Date(lastIn.at), tzOf(upd.state ?? lead.state)).hour; }
  if (lastOut) { upd.last_out_at = lastOut.at; upd.last_out_by = tomIds.has(lastOut.id) ? "tom" : (lastOut.source === "workflow" || lastOut.source === "automation") ? "workflow" : "rep"; }
  if (lastRep) { upd.last_rep_touch_at = lastRep.at; upd.last_rep_touch = lastRep.kind === "call" ? `call ${lastRep.duration_sec ?? 0}s ${lastRep.status ?? ""}` : `${lastRep.kind}: ${String(lastRep.body ?? "").slice(0, 80)}`; }
  if (lastRepCall) { upd.last_rep_call_at = lastRepCall.at; upd.last_rep_call_sec = lastRepCall.duration_sec ?? 0; }
  // opt-out: catch it the minute it lands
  if (lastIn && STOP_RX.test(String(lastIn.body ?? "")) && !lead.dnd_sms) {
    upd.dnd_sms = true; upd.hold_reason = "opt-out: " + String(lastIn.body).slice(0, 60);
    await sb.from("tom_drafts").update({ status: "expired", guard: "seller opted out" }).eq("contact_id", cid).eq("status", "pending");
    await log(cid, "optout", String(lastIn.body).slice(0, 100));
  }
  // undelivered = carrier block / unsubscribed
  if (lastOut && /undeliver|fail/i.test(String(lastOut.status ?? "")) && tomIds.has(lastOut.id)) upd.unsub = /unsub/i.test(String(lastOut.body ?? "")) || lead.unsub;
  // Spanish?
  const recentIn = (msgs ?? []).filter((m) => m.kind === "sms" && m.direction === "inbound").slice(0, 5).map((m) => String(m.body ?? "")).join(" ");
  if (/\b(hola|gracias|buenos|buenas|cuanto|cuánto|casa|vender|señor|si\b.*\bpuede|no hablo)\b/i.test(recentIn) || /spanish|español|no english|bad english/i.test(upd.notes_text ?? "")) upd.lang = "es";
  upd.msgs_synced_at = iso(now());
  // a seller who is waiting on us is due NOW
  // (only if Tom hasn't already looked at this text — a "wait" decision must stick, not get re-thought every sync)
  if (lastIn && (!lastOut || new Date(lastIn.at) > new Date(lastOut.at)) && !upd.dnd_sms && !(lead.facts_at && new Date(lead.facts_at) > new Date(lastIn.at))) upd.next_due_at = iso(now());
  await sb.from("tom_leads").update(upd).eq("contact_id", cid);
  return "ok";
}

async function syncJob(b: any) {
  const t0 = Date.now(); const deadline = t0 + 60_000; const budget = Number(b.budget_ms ?? 50_000);
  const out: any = {};
  if (b.opps !== false) out.opps = await syncOpps(deadline);
  // which leads to refresh: recent conversation activity first, then stalest
  const todo = new Set<string>();
  const rc = await ghl(`/conversations/search?locationId=${LOC}&sortBy=last_message_date&sort=desc&limit=100`);
  const { data: tracked } = await sb.from("tom_leads").select("contact_id,msgs_synced_at").neq("mode", "off");
  const tmap = new Map((tracked ?? []).map((x: any) => [x.contact_id, x.msgs_synced_at ? new Date(x.msgs_synced_at).getTime() : 0]));
  for (const c of rc.body?.conversations ?? []) if (tmap.has(c.contactId) && Number(c.lastMessageDate ?? 0) > (tmap.get(c.contactId) ?? 0) - 60e3) todo.add(c.contactId);
  // GHL's conversation search index can lag 10-15 min (Rose Bedwell, Oct 15): anyone we texted in the last 3h gets their thread re-read directly, every run
  const { data: hot } = await sb.from("tom_leads").select("contact_id").neq("mode", "off").gte("last_out_at", iso(new Date(Date.now() - 3 * 3600e3))).order("last_out_at", { ascending: false }).limit(Number(b.hot ?? 40));
  for (const h of hot ?? []) todo.add(h.contact_id);
  const { data: stale } = await sb.from("tom_leads").select("contact_id").neq("mode", "off").or("msgs_synced_at.is.null,msgs_synced_at.lt." + iso(new Date(Date.now() - days(1)))).order("msgs_synced_at", { ascending: true, nullsFirst: true }).limit(Number(b.refresh ?? 20));
  for (const s of stale ?? []) todo.add(s.contact_id);
  let refreshed = 0;
  for (const cid of todo) {
    if (Date.now() - t0 > budget) break;
    try { await refreshLead(cid); refreshed++; } catch (e) { await log(cid, "refresh_error", String(e)); }
    await sleep(80);
  }
  out.refreshed = refreshed; out.queued = todo.size; out.ms = Date.now() - t0;
  return out;
}

// ---------- BRAIN ----------
const DEFAULT_BRIEF = `You are "Tom" with Clear Path Property Solutions, a cash home buyer (Texas, Tennessee and nearby states). You text homeowners who asked us for an offer on their house. Nic Holliday owns the company; BT is the other rep. To sellers, YOU are Tom and Tom is the only name they ever see. Your job: dig money out of the pipeline by text, get motivated sellers back on the phone with Nic, and book calls that are worth his time. Never book an unmotivated seller.

## Identity
- "BT" does not exist. Never write BT, never "I work with BT". Every rep's past calls are "we"/"our team"/"I" (talk about any rep's call in first person: "good talking last week").
- Two senders only: Tom, or Nic. Write as Nic ONLY when the packet says the rep is Nic and he touched the lead in the last 2 days (then the text is from "Nic" so the seller isn't confused by a second person). Otherwise Tom.
- Intro only when needed: first text ever, or weeks since the last human touch -> "it's Tom with Clear Path". Inside a live recent thread -> no name, just talk. Never restate your name every text.
- Cold leads get re-anchored: who we are + what we talked about ("buying your house at 3501 Lochearn Ct") + what you're referring to ("the cash offer we made").
- Never claim to be human, never say "not a robot", never mention AI. Asked if you're a bot -> action "flag".
- Spanish speakers: run the whole process by text in simple Spanish, one question at a time. Same money rules.

## Money (hard rules)
- NEVER text a new price, number, range or "we can do X". Restating an offer a rep already made is fine ("$63,000, which covers your payoff"). Prices are full dollars: "$204,000", never "204k".
- Never repeat the seller's own number if it's above what we can pay (MAO). Don't echo their ask.
- Never write anything that invites the seller to wonder if our offer is low ("is the number the hang-up?", "we're close on the number" are both banned).
- Never remind a seller about other offers or bids they're collecting. Every text stays on OUR offer.
- Rep has room above a rejected opener? Tee it up ("took another look, I think we can do better, I'll call you with it") - never text the new number.
- Default close on any made offer: "Were you good to go with the offer we made?"
- Seller names a floor above MAO -> don't repeat it, don't argue; tie the next ask (statement/photos) to the only structure that could reach it.
- Offer type matters. Cash -> "closed in 30 days, no repairs, no fees". Novation -> "you fix it up, we handle the sale, higher number, about 90 days". Can't tell which -> promise no terms at all.

## Never say or offer
- No sale-leaseback / "sell and rent it back", ever. "Selling and moving" is the only frame.
- Never "I'll have title pull it". On creative/sub-to deals ask for A PHOTO OF THE MORTGAGE STATEMENT. Name the document, never "the info".
- Never promise repairs, cleanout, floors or anything paid BEFORE closing. (Cash as-is deal: "we handle the repairs" after closing is fine.)
- Never mention listing, agents, realtors or the market, even if the seller brought it up.
- Never narrate the seller's behavior back at them ("you said 15 minutes", "calls seem tough for you"). Never remind them of a blocker that's on them ("did you lock in the land?"). A hard date THEY face (foreclosure, auction, closing) is fair to name.
- Never discourage a call ("no need to call back"). Never lean on a personal reason as a hook ("go be with your daughter"). Don't lecture about their money.
- Never: "no rush", "just curious", "touch base", "circle back", scare tactics, "offer expires", counting attempts, corporate wording, hype, emojis, exclamation spam, em dashes (use " - ").

## How to write
- 1 to 3 short sentences. One question per text, question LAST. Plain words ("sell as-is"). Sound like a real person typing on a phone. Name the street.
- Every check-in says what it's about: buying <street> + the offer we made. "Were you good to go with the offer we made?" beats "where are you at?".
- When price is the problem, ask for the price straight ("what's the real lowest you'd take that still works for you?").
- Don't stack one-liners. Don't re-ask what the notes already answer. Read the whole packet first; if the amount isn't in the notes it's in the transcript.
- Seller said "I never got an offer" -> check the transcript; if one was made, restate it; if a rep promised an agreement and never sent it, own it and promise same-day.
- Seller says a time or window -> lock it ("Sounds good, we'll call you at 5:15 today from this number") and set book_at. "Later" -> turn it into a specific time.
- Seller asks for a price by text -> "I don't want to throw out a wrong number by text. Give me five minutes on the phone and I'll give you a real one. What time works?"
- Seller refuses calls twice -> gather by text, one question per text: occupied or empty; big repairs; when they need it sold; what they're looking to get; photos (kitchen, bathrooms, outside); then "when's a good time to call you with the number?"
- Sold / under contract elsewhere -> congrats, "has it closed or still under contract?", we're the backup offer; check in every ~2 weeks until it closes.
- No / not interested / "we're going to stop" -> ALWAYS the one question, never a goodbye: "No problem. Is it that you're not selling anymore, or just not interested in the offer we had?" A "let us know if anything changes" text with no question is a failure.
- Known event (court, probate hearing, closing, foreclosure date) -> check in right after it, ask how it went, tie the offer to their problem.
- Spouse/co-owner is the no -> every 3-4 weeks, one question: has anything changed on their end. Probate not opened -> every ~3 weeks, probate progress only.
- Elderly / distressed sellers: gentle, personal, reference what matters to them, then the price question.
- Photos received -> acknowledge within the hour. Missed inbound call or inbound text from the seller -> reply same day, never skip.

## Timing (you choose wait_until when not texting now)
- Cadence is lead by lead from the notes, never by stage. Most often 2 texts in a day; least often 1 every 3 weeks. Leads are never dropped.
- Hot lead (Contract This Month etc.): rep hasn't reached them for ~2 days -> nudge to lock a call to get everything finalized.
- Angry hang-up on the offer -> 3 to 7 days of silence first, never next day.
- Rep's open task sets the clock: text ~2 days before a repitch task so the call is lined up, not earlier.
- Horrible leads (rep says hopeless): one line every 6 weeks. Revisit-in-months: one light touch at ~6 weeks and ~3 months.
- Foreclosure / tax-sale date on file: a text every 2-3 days until the date, naming it; within 2 days after it passes, ask the outcome.
- "Wait" is not "skip": a big gap or a repitch weeks out still gets a text when due.

## When NOT to text (action "skip" or "wait")
- Rep and seller are actively texting back and forth, or a rep handled it live in the last 2 days -> wait.
- Seller opted out, DND, unsubscribed, under contract with us -> skip.
- Seller is clearly not the owner / wrong person / wants out -> one closing text only (action "closing"): "Sorry if we've been a bother. A form came in for <address>, and if that wasn't you, just reply STOP and we'll close it out for good."

## Booking
- Book a call ONLY when (a) the seller's number is within 15% of our MAO or they have clearly said they are open to our number, OR (b) they are showing a LOT of motivation (behind on payments with a date coming, foreclosure/auction/tax sale, must be out by a date, estate that has to settle, "just need it gone") - set strong_motivation true only for that and say why in reason. Ordinary interest is not motivation. No number and no strong motivation -> ask for the number, do not book. "Call me now" is not a booking: offer a specific time at least 30 minutes out, inside 9am-8pm Central Mon-Sat.
- When you set book_at, the text must confirm the time and that we'll call from this number.

## Output - JSON only
{"action":"text"|"wait"|"skip"|"flag"|"closing",
 "as_who":"tom"|"nic", "channel":"sms"|"email", "text":"the text (empty unless action is text/closing)", "subject":"email subject or null",
 "book_at":"ISO datetime in the property's local time or null",
 "wait_until":"ISO date when to look at this lead again (required for wait; also set it for text = when to check back if they go quiet)",
 "reason":"one short line why",
 "context":"ONE tight paragraph for Nic: street + city, situation, the numbers (their ask, our offer, type), what they said last, what's happened since, why this text now",
 "facts":{"offer":number|null,"offer_type":"cash"|"novation"|"subto"|"unknown","ask":number|null (the seller's CURRENT number from the thread/notes),"mao":number|null (from the rep notes),"open_to_our_number":true|false,"strong_motivation":true|false,"pressure":"...","blocker":"...","event_date":"YYYY-MM-DD"|null}}`;

async function claude(model: string, system: string, user: string, maxTokens = 3500) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST", headers: { "x-api-key": ANTHROPIC, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model, max_tokens: maxTokens, system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }], messages: [{ role: "user", content: user }] }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("anthropic " + r.status + " " + JSON.stringify(j).slice(0, 200));
  return { text: (j.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text ?? "").join(""), usage: j.usage ?? {} };
}
function parseJson(t: string): any { const m = t.match(/\{[\s\S]*\}/); if (!m) return null; try { return JSON.parse(m[0]); } catch { return null; } }

async function packet(lead: any) {
  const tz = tzOf(lead.state);
  const { data: msgs } = await sb.from("acq_lead_msgs").select("id,at,direction,kind,body,status,duration_sec,user_id,source,raw").eq("contact_id", lead.contact_id).order("at", { ascending: false }).limit(60);
  const rows = (msgs ?? []).reverse();
  const { data: mine } = await sb.from("tom_drafts").select("ghl_message_id,sent_at,text,as_who").eq("contact_id", lead.contact_id).eq("status", "sent").order("sent_at", { ascending: false }).limit(10);
  const tomIds = new Set((mine ?? []).map((x: any) => x.ghl_message_id));
  const lines: string[] = []; let transcripts = "";
  for (const m of rows) {
    const d = new Date(m.at).toLocaleString("en-US", { timeZone: tz, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    const who = m.direction === "inbound" ? "SELLER" : tomIds.has((m as any).id) ? "TOM" : (m.source === "workflow" || m.source === "automation") ? "US (old auto template)" : (REPS[m.user_id] ? "US (" + REPS[m.user_id] + ")" : "US");
    if (m.kind === "sms") lines.push(`${d} ${who}: ${String(m.body ?? "").replace(/\s+/g, " ").slice(0, 400)}${/undeliver|fail/i.test(String(m.status ?? "")) ? " [UNDELIVERED]" : ""}`);
    else if (m.kind === "call") { lines.push(`${d} CALL ${m.direction} ${m.duration_sec ?? 0}s ${m.raw?.callStatus ?? m.status ?? ""}`); if (m.raw?.transcript) transcripts += `\n--- call ${d} (${m.duration_sec}s) ---\n${String(m.raw.transcript).slice(0, 2500)}\n`; }
    else if (m.kind === "email") lines.push(`${d} EMAIL ${m.direction}: ${String(m.body ?? "").replace(/\s+/g, " ").slice(0, 200)}`);
  }
  const nowLocal = new Date().toLocaleString("en-US", { timeZone: tz, weekday: "long", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
  const ago = (t?: string | null) => t ? Math.round((Date.now() - new Date(t).getTime()) / 864e5) + "d ago" : "never";
  const header = [
    `Seller: ${lead.name ?? "unknown"} (first name: ${lead.first_name ?? "?"})`,
    `Property: ${lead.address ?? "unknown"}${lead.city ? ", " + lead.city : ""}${lead.state ? ", " + lead.state : ""}`,
    `Pipeline stage: ${lead.stage} (in this stage since ${String(lead.stage_changed_at ?? lead.form_at ?? "").slice(0, 10)}); form came in ${String(lead.form_at ?? "").slice(0, 10)}`,
    `Assigned rep: ${lead.assigned_name ?? "unassigned"}. Rep last touched: ${ago(lead.last_rep_touch_at)} (${lead.last_rep_touch ?? "-"}). Rep last call: ${ago(lead.last_rep_call_at)} ${lead.last_rep_call_sec ?? 0}s.`,
    `Seller last texted us: ${ago(lead.last_in_at)}. Our last text: ${ago(lead.last_out_at)} by ${lead.last_out_by ?? "-"}.`,
    `Tags: ${(lead.tags ?? []).join(", ") || "-"}. DND: sms=${lead.dnd_sms} call=${lead.dnd_call} email=${lead.dnd_email}. Language: ${lead.lang}.`,
    lead.open_task_title ? `Open rep task: "${lead.open_task_title}" due ${String(lead.open_task_due).slice(0, 10)}` : "Open rep task: none",
    lead.facts ? `Facts so far: ${JSON.stringify(lead.facts)}` : "",
    `Right now it is ${nowLocal} (property local time). Texts Tom already sent: ${(mine ?? []).length}.`,
  ].filter(Boolean).join("\n");
  const user = `${header}\n\n## Rep notes (oldest first)\n${lead.notes_text || "(none)"}\n\n## Tasks\n${lead.tasks_text || "(none)"}\n\n## Thread (oldest first)\n${lines.join("\n") || "(no messages)"}\n${transcripts ? "\n## Call transcripts (newest rep calls)" + transcripts : ""}\n\nDecide Tom's next move for this lead. JSON only.`;
  return { user, thread_tail: lines.slice(-8).join("\n") };
}

// offering / promising / confirming a phone call (English + Spanish)
const CALL_RX = /\b(we|i)('ll| will| can| could|'d like to| would like to) (call|ring|phone|try) you\b|\b(call|ring|phone) you (at|around|back|today|tomorrow|then|this|in)\b|\b(can|could|may|should) (i|we) (call|ring|phone) you\b|\bgive you a (quick )?(call|ring)\b|\b(hop|jump|get) on (a|the) (quick )?(call|phone)\b|\b(for|on) a (quick |short |five minute |5 minute )?(call|phone call)\b|\bminutes? on the phone\b|\b(what|which) time (works|is good|is best)\b|\btime (to|for us to|for me to) call\b|\bcall you with\b|\bte llam(o|amos|ar[ée])\b|\ble llam(o|amos|ar[ée])\b|\bllamar(te|le|lo|la)\b/i;

// code guards: the rules that must hold even if the model slips
function guard(text: string, lead: any, notesAndThread: string): string | null {
  if (!text.trim()) return "empty";
  if (/\bBT\b/.test(text)) return "said BT";
  if (/\b(realtor|agent|listing|list it|listed|MLS|the market)\b/i.test(text)) return "mentioned agents/listing/market";
  if (/rent(ing)?\s*(it\s*)?back|lease\s*-?\s*back|stay in the (house|home) after/i.test(text)) return "sale-leaseback";
  if (/\b(bot|robot|automated|AI|a real person|I'm human|not a machine)\b/i.test(text)) return "identity claim";
  if (/have title pull|\bthe info\b|no need to call|no rush|just curious|touch base|circle back|offer expires|third time/i.test(text)) return "banned phrase";
  if (/calling you (right )?now|call(ing)? you in (a|two|2|five|5|few) min|give me (a|two|2|five|5|a few) min|on my way to call|about to call|ringing you/i.test(text)) return "promised an immediate call";
  if ((lead.tags ?? []).some((t: string) => /^offer\s*-/i.test(String(t))) && /(never|haven't|havent|didn't|didnt|before I could|yet to|without) .{0,40}(number|offer|price)|(number|offer|price) .{0,30}(never|haven't|didn't) (got|gave|given|sent)/i.test(text)) return "claims no offer was made but lead is tagged offer-made";
  const REPAIRS_RX = new RegExp("\\b(pay|cover|handle|take care of|do) (the |for )?(repairs?|cleanout|clean-out|floors?|work)\\b.*\\b(before|prior to|up ?front)\\b|\\bbefore (we )?clos\\w+.*\\b(repairs?|cleanout|floors?)\\b", "i");
  if (REPAIRS_RX.test(text)) return "repairs before closing";
  // money: any dollar figure in the text must already exist in the notes/thread (restating), never new
  const nums = text.match(/\$\s?\d{1,3}(?:,\d{3})+|\$\s?\d{4,7}|\b\d{2,3}k\b/gi) ?? [];
  for (const n of nums) {
    const digits = n.replace(/[^0-9k]/gi, "").toLowerCase().replace(/k$/, "000");
    const short = digits.replace(/000$/, "");
    const rx = new RegExp("\\b" + short + "(,?000|k)?\\b", "i");
    if (!rx.test(notesAndThread)) return "new price " + n;
  }
  if (text.length > 480) return "too long";
  return null;
}

async function think(lead: any, s: any, store = true, runId = "") {
  const { user, thread_tail } = await packet(lead);
  // Nic's recent corrections are part of the brief
  const { data: tr } = await sb.from("tom_training").select("lesson").order("created_at", { ascending: false }).limit(40);
  const lessons = (tr ?? []).map((x: any) => "- " + x.lesson).filter((x: string) => x.length > 3).join("\n");
  const sys = s.brief + (lessons ? "\n\n## Nic's latest corrections (newest first, these win)\n" + lessons : "");
  const r = await claude(s.model, sys, user);
  const j = parseJson(r.text) ?? { action: "flag", reason: "model returned no JSON", text: "" };
  const cost = (r.usage.input_tokens ?? 0) * 3e-6 + (r.usage.output_tokens ?? 0) * 15e-6 + (r.usage.cache_creation_input_tokens ?? 0) * 3.75e-6 + (r.usage.cache_read_input_tokens ?? 0) * 0.3e-6;
  let text = String(j.text ?? "").replace(/—|–/g, " - ").replace(/\s{2,}/g, " ").trim();
  let action = String(j.action ?? "wait");
  let g: string | null = null;
  if (action === "text" || action === "closing") {
    g = guard(text, lead, (lead.notes_text ?? "") + " " + user);
    if (g && /new price/.test(g)) { // one retry
      const r2 = await claude(s.model, sys, user + `\n\nYour draft was rejected: it contained a number that is not already in the notes or thread (${g}). Never text a new price. Rewrite without any number, or restate only an amount that already appears above. JSON only.`);
      const j2 = parseJson(r2.text); if (j2?.text) { text = String(j2.text).replace(/—|–/g, " - ").trim(); g = guard(text, lead, (lead.notes_text ?? "") + " " + user); if (j2.reason) j.reason = j2.reason; }
    }
    // Nic only takes calls he can convert: an unqualified seller is never offered or promised a call (qualify by text first)
    const f0 = j.facts ?? lead.facts ?? {}; const ask0 = Number(f0.ask), mao0 = Number(f0.mao); const pct0 = 1 + Number(s.book_mao_pct ?? 15) / 100;
    const qualified = (ask0 > 0 && mao0 > 0 && ask0 <= mao0 * pct0) || f0.open_to_our_number === true || f0.strong_motivation === true;
    if (!g && !qualified && CALL_RX.test(text)) {
      const r3 = await claude(s.model, sys, user + `\n\nYour draft was rejected: it offers or promises a phone call, but this seller is not qualified yet (no number within 15% of MAO, not open to our number, no strong motivation). Nic only takes calls he can convert. Do NOT propose, promise or confirm a call and leave book_at null. Instead ask ONE qualifying question by text (what they are looking to get for it, or what is driving the sale and their timeline). JSON only.`);
      const j3 = parseJson(r3.text);
      if (j3?.text) { text = String(j3.text).replace(/—|–/g, " - ").replace(/\s{2,}/g, " ").trim(); g = guard(text, lead, (lead.notes_text ?? "") + " " + user); if (j3.reason) j.reason = j3.reason; if (j3.context) j.context = j3.context; }
      j.book_at = null;
      if (!g && CALL_RX.test(text)) g = "offered a call to an unqualified seller";
      await log(lead.contact_id, "call_redrafted", (g ? "blocked: " : "ok: ") + text.slice(0, 120));
    }
  }
  // sender: Nic only if Nic owns it and touched it in the last 2 days
  let asWho = String(j.as_who ?? "tom") === "nic" ? "nic" : "tom";
  if (asWho === "nic" && !(lead.assigned_to === NIC && lead.last_rep_touch_at && Date.now() - new Date(lead.last_rep_touch_at).getTime() < days(2.5))) asWho = "tom";
  let channel = String(j.channel ?? "sms") === "email" ? "email" : "sms";
  // channel rules
  if (lead.unsub || lead.dnd_sms) {
    const { count } = await sb.from("tom_drafts").select("id", { count: "exact", head: true }).eq("contact_id", lead.contact_id).eq("channel", "email").in("status", ["sent", "approved", "pending"]);
    if (lead.dnd_email || !lead.email || (count ?? 0) >= 1) { if (action === "text" || action === "closing") { action = "skip"; j.reason = "DND/unsubscribed and the one allowed email is used"; } }
    else channel = "email";
  }
  // rep stand-down in code: rep texted or had a live call in the last 2 days and the seller has not written since
  const repAt = lead.last_rep_touch_at ? new Date(lead.last_rep_touch_at).getTime() : 0;
  const inAt = lead.last_in_at ? new Date(lead.last_in_at).getTime() : 0;
  const repLive = repAt && Date.now() - repAt < days(2) && inAt < repAt && (lead.last_rep_touch?.startsWith("sms") || (lead.last_rep_call_sec ?? 0) >= 60);
  if (repLive && action === "text") { action = "wait"; j.wait_until = iso(new Date(repAt + days(3))); j.reason = "rep is live on it (" + lead.last_rep_touch + ")"; }
  // never stack texts: 30 min minimum after our last outbound unless the seller wrote back since
  const outAt = lead.last_out_at ? new Date(lead.last_out_at).getTime() : 0;
  if ((action === "text" || action === "closing") && outAt && Date.now() - outAt < 30 * 60e3 && inAt < outAt) { action = "wait"; j.wait_until = iso(new Date(outAt + 3600e3)); j.reason = "we texted them " + Math.round((Date.now() - outAt) / 60e3) + " min ago, no reply yet"; }
  // window + FL/OK cap
  let notBefore = drift(nextOpen(now(), lead.state));
  if (["FL", "OK"].includes(String(lead.state ?? "").toUpperCase())) {
    const { count } = await sb.from("tom_drafts").select("id", { count: "exact", head: true }).eq("contact_id", lead.contact_id).eq("status", "sent").gte("sent_at", iso(new Date(Date.now() - days(1))));
    if ((count ?? 0) >= 3) notBefore = drift(nextOpen(new Date(Date.now() + days(1)), lead.state));
  }
  const waitUntil = j.wait_until ? new Date(j.wait_until) : null;
  const clampWait = (d: Date | null, def: number) => { const t = d && !isNaN(d.getTime()) ? d.getTime() : Date.now() + days(def); return iso(new Date(Math.min(Math.max(t, Date.now() + days(1)), Date.now() + days(42)))); };
  const result: any = { action, as_who: asWho, channel, text, guard: g, reason: j.reason ?? null, context: j.context ?? null, book_at: j.book_at ?? null, wait_until: j.wait_until ?? null, facts: j.facts ?? null, cost, usage: r.usage, not_before: iso(notBefore) };
  if (!store) return result;
  const leadUpd: any = { facts: j.facts ?? lead.facts, facts_at: iso(now()), updated_at: iso(now()) };
  if ((action === "text" || action === "closing") && !g) {
    const kind = action === "closing" ? "closing" : (inAt && inAt > (lead.last_out_at ? new Date(lead.last_out_at).getTime() : 0)) ? "reply" : "nudge";
    let bookAt = j.book_at ? fromLocal(String(j.book_at), tzOf(lead.state)) : null;
    const f = j.facts ?? lead.facts ?? {}; const ask = Number(f.ask), mao = Number(f.mao);
    const pct = 1 + Number(s.book_mao_pct ?? 15) / 100;
    // proposing a time ("does 5:30 work?") is not a booking - book when the seller says yes to it
    if (bookAt && /\b(does|would|will|can|could|is)\b[^.?!]{0,60}\b(work|good|ok|okay|fine)\b[^.?!]{0,60}\?|\b(can|could|may) I call you (at|around)\b|te parece|le parece|está bien si|esta bien si/i.test(text)) { await log(lead.contact_id, "booking_deferred", "time proposed, not confirmed: " + text.slice(0, 100)); bookAt = null; }
    if (bookAt && !(ask > 0 && mao > 0 && ask <= mao * pct) && f.open_to_our_number !== true && f.strong_motivation !== true) { await log(lead.contact_id, "booking_refused", `ask=${f.ask} mao=${f.mao}: not within ${Math.round((pct - 1) * 100)}% of MAO and no strong motivation`); bookAt = null; }
    if (bookAt) { const l = local(bookAt, "America/Chicago"); if (l.hour < 9 || l.hour >= 20 || l.dow === 0 || bookAt.getTime() < Date.now() + 25 * 60e3) { await log(lead.contact_id, "booking_refused", "outside 9-8 CT Mon-Sat or less than 25 min out: " + iso(bookAt)); bookAt = null; } }
    const { error } = await sb.from("tom_drafts").insert({ contact_id: lead.contact_id, name: lead.name, address: lead.address, stage: lead.stage, kind, channel, as_who: asWho, text, subject: channel === "email" ? (j.subject || `Your house at ${lead.address ?? ""}`) : null, reason: j.reason ?? null, context: j.context ?? null, thread_tail, status: "pending", not_before: iso(notBefore), book_at: bookAt ? iso(bookAt) : null, book_rep: asWho === "nic" ? "nic" : "bt", model: s.model, tokens_in: r.usage.input_tokens ?? null, tokens_out: r.usage.output_tokens ?? null, cost_usd: cost, run_id: runId });
    if (error) await log(lead.contact_id, "draft_error", error.message);
    leadUpd.next_due_at = clampWait(waitUntil, 4); // re-looked at after the text goes (send moves it again)
    if (bookAt && s.ping_on_booking !== false) await pingNic(s, `Tom Bot: ${lead.name ?? "seller"} (${lead.address ?? "?"}) gave a call time - ${bookAt.toLocaleString("en-US", { timeZone: "America/Chicago", weekday: "short", hour: "numeric", minute: "2-digit" })} CT. Approve the draft in the queue to lock it.`, lead.contact_id);
    else if (kind === "reply" && s.ping_on_reply === true) await pingNic(s, `Tom Bot: ${lead.name ?? "seller"} (${lead.address ?? "?"}) texted "${String(lead.last_in_body ?? "").slice(0, 80)}". Draft is waiting for your yes.`, lead.contact_id);
  } else if ((action === "text" || action === "closing") && g) {
    await sb.from("tom_drafts").insert({ contact_id: lead.contact_id, name: lead.name, address: lead.address, stage: lead.stage, kind: "nudge", channel, as_who: asWho, text, reason: j.reason ?? null, context: j.context ?? null, thread_tail, status: "blocked", guard: g, model: s.model, cost_usd: cost, run_id: runId });
    leadUpd.next_due_at = iso(new Date(Date.now() + days(1)));
    await log(lead.contact_id, "blocked", g + " :: " + text.slice(0, 120));
  } else if (action === "flag") {
    await sb.from("tom_drafts").insert({ contact_id: lead.contact_id, name: lead.name, address: lead.address, stage: lead.stage, kind: "flag", channel, as_who: asWho, text: text || "(no text)", reason: j.reason ?? null, context: j.context ?? null, thread_tail, status: "pending", model: s.model, cost_usd: cost, run_id: runId });
    leadUpd.next_due_at = clampWait(waitUntil, 7);
  } else if (action === "skip") {
    leadUpd.next_due_at = clampWait(waitUntil, 2);
    await log(lead.contact_id, "skip", String(j.reason ?? ""));
  } else { // wait
    leadUpd.next_due_at = clampWait(waitUntil, 5);
    await log(lead.contact_id, "wait", `until ${leadUpd.next_due_at.slice(0, 10)}: ${String(j.reason ?? "")}`);
  }
  await sb.from("tom_leads").update(leadUpd).eq("contact_id", lead.contact_id);
  await bumpUsage("tom_think", 1);
  return result;
}

async function bumpUsage(service: string, n: number) {
  const month = new Date().toISOString().slice(0, 7);
  const { data } = await sb.from("api_usage").select("used,cap").eq("service", service).eq("month", month).maybeSingle();
  if (data) await sb.from("api_usage").update({ used: (data.used ?? 0) + n, updated_at: iso(now()) }).eq("service", service).eq("month", month);
  else await sb.from("api_usage").insert({ service, month, used: n, cap: service === "tom_send" ? 3000 : 6000 });
}

async function thinkJob(b: any) {
  const s = await settings();
  if (!s.drafting) return { ok: true, skipped: "drafting off" };
  const t0 = Date.now(); const runId = "run-" + iso(now()).slice(0, 16);
  const modes = s.silent_on ? ["judgment", "silent"] : ["judgment"];
  const { data: pend } = await sb.from("tom_drafts").select("contact_id").in("status", ["pending", "approved", "sending"]);
  const busy = new Set((pend ?? []).map((x: any) => x.contact_id));
  const base = () => sb.from("tom_leads").select("*").in("mode", modes).eq("under_contract", false).eq("unsub", false).not("msgs_synced_at", "is", null);
  const { data: waiting } = await sb.from("tom_leads").select("*").in("mode", ["judgment", "silent"]).eq("under_contract", false).eq("unsub", false).not("msgs_synced_at", "is", null).not("last_in_at", "is", null).eq("dnd_sms", false).gte("last_in_at", iso(new Date(Date.now() - days(14)))).order("last_in_at", { ascending: false }).limit(40);
  const { data: due } = await base().lte("next_due_at", iso(now())).order("next_due_at", { ascending: true }).limit(40);
  const { data: fresh } = await base().is("next_due_at", null).order("stage_changed_at", { ascending: false }).limit(40);
  const list: any[] = []; const seen = new Set<string>();
  // "waiting" = seller texted last AND Tom hasn't assessed that text yet (assessed-and-waiting leads come back via `due` when their wait ends)
  const unassessedReply = (l: any) => (!l.last_out_at || new Date(l.last_in_at) > new Date(l.last_out_at)) && !(l.facts_at && new Date(l.facts_at) > new Date(l.last_in_at));
  for (const l of [...(waiting ?? []).filter(unassessedReply), ...(due ?? []), ...(fresh ?? [])]) if (!seen.has(l.contact_id) && !busy.has(l.contact_id) && !(l.hold_until && new Date(l.hold_until) > now())) { seen.add(l.contact_id); list.push(l); }
  // cost control: when Nic already has 40+ drafts waiting, only seller replies get drafted
  const { count: backlog } = await sb.from("tom_drafts").select("id", { count: "exact", head: true }).eq("status", "pending").neq("kind", "reply");
  const waitingIds = new Set((waiting ?? []).filter(unassessedReply).map((l: any) => l.contact_id));
  const work = (backlog ?? 0) >= Number(s.max_backlog ?? 40) ? list.filter((l) => waitingIds.has(l.contact_id)) : list;
  const lim = Number(b.limit ?? 10); const budget = Number(b.budget_ms ?? 50_000); const out: any[] = [];
  for (const lead of work.slice(0, lim)) {
    if (Date.now() - t0 > budget) break;
    if (lead.hold_until && new Date(lead.hold_until) > now()) continue;
    // CLAIM: one thinker per lead (the 15-min and 3-min think runs overlap and used to draft the same reply twice)
    const { data: got } = await sb.from("tom_leads").update({ facts_at: iso(now()) }).eq("contact_id", lead.contact_id).or(`facts_at.is.null,facts_at.lt.${iso(new Date(Date.now() - 3 * 60e3))}`).select("contact_id");
    if (!got?.length) continue;
    try { const r = await think(lead, s, true, runId); out.push({ name: lead.name, stage: lead.stage, action: r.action, as: r.as_who, guard: r.guard, text: r.text?.slice(0, 160) }); }
    catch (e) { out.push({ name: lead.name, err: String(e).slice(0, 200) }); await log(lead.contact_id, "think_error", String(e)); await sb.from("tom_leads").update({ next_due_at: iso(new Date(Date.now() + 3600e3)) }).eq("contact_id", lead.contact_id); }
  }
  return { ok: true, run_id: runId, candidates: list.length, backlog, did: out.length, out };
}

// ---------- SEND ----------
async function ghlSend(lead: any, d: any): Promise<{ ok: boolean; id?: string; err?: string }> {
  const body: any = d.channel === "email"
    ? { type: "Email", contactId: lead.contact_id, subject: d.subject || `Your house at ${lead.address ?? ""}`, html: `<p>${String(d.text).replace(/\n/g, "<br>")}</p>` }
    : { type: "SMS", contactId: lead.contact_id, message: d.text };
  const r = await ghl(`/conversations/messages`, { method: "POST", body: JSON.stringify(body) });
  if (!r.ok) return { ok: false, err: `${r.status} ${JSON.stringify(r.body ?? "").slice(0, 300)}` };
  return { ok: true, id: r.body?.messageId ?? r.body?.msg?.id ?? r.body?.id ?? null };
}

let opFromCache: { id: string; number: string } | null = null;
async function sendText(from: string, to: string, text: string): Promise<string | null> {
  if (!OPENPHONE) return "no OPENPHONE_API_KEY";
  if (!opFromCache || opFromCache.number !== from) {
    const nR = await fetch("https://api.openphone.com/v1/phone-numbers", { headers: { Authorization: OPENPHONE } });
    const nums = ((await nR.json().catch(() => ({}))).data ?? []) as any[];
    const mine = nums.find((n) => n.number === from) || nums[0];
    if (!mine) return "no OpenPhone number";
    opFromCache = { id: mine.id, number: mine.number };
  }
  const r = await fetch("https://api.openphone.com/v1/messages", { method: "POST", headers: { Authorization: OPENPHONE, "Content-Type": "application/json" }, body: JSON.stringify({ from: opFromCache.id, to: [to], content: text }) });
  if (!r.ok) return "openphone " + r.status + " " + (await r.text()).slice(0, 200);
  return null;
}
async function pingNic(s: any, text: string, cid: string | null) {
  // at most one ping per lead per 2 hours
  if (cid) { const { data } = await sb.from("tom_log").select("id").eq("contact_id", cid).eq("event", "ping").gte("at", iso(new Date(Date.now() - 2 * 3600e3))).limit(1); if (data?.length) return; }
  const err = await sendText(s.alert_from, s.nic_cell, text);
  await log(cid, err ? "ping_error" : "ping", err ?? text.slice(0, 200));
}

async function sendDraft(d: any, s: any, by = "cron"): Promise<any> {
  // CLAIM FIRST: exactly one run may own this draft from here on (concurrent send runs used to double- and triple-text sellers)
  const { data: claimed } = await sb.from("tom_drafts").update({ status: "sending", approved_at: iso(now()), approved_by: d.approved_by ?? by }).eq("id", d.id).eq("status", d.status).select("id");
  if (!claimed?.length) return { ok: false, err: "claimed by another run" };
  const back = async (upd: any) => { await sb.from("tom_drafts").update(upd).eq("id", d.id).eq("status", "sending"); };
  const { data: lead } = await sb.from("tom_leads").select("*").eq("contact_id", d.contact_id).single();
  if (!lead) { await back({ status: "failed", error: "no lead" }); return { ok: false, err: "no lead" }; }
  if (lead.mode === "off" || lead.under_contract) { await back({ status: "expired", guard: "lead no longer worked" }); return { ok: false, err: "lead off" }; }
  if (d.channel === "sms" && (lead.dnd_sms || lead.unsub)) { await back({ status: "blocked", guard: "DND / unsubscribed" }); return { ok: false, err: "dnd" }; }
  if (!windowOpen(now(), lead.state)) { const nb = iso(drift(nextOpen(now(), lead.state))); await back({ status: "approved", not_before: nb }); return { ok: true, queued: nb }; }
  // never stack: if we texted this lead in the last 30 min and they have not replied since, push this one out
  const lo = lead.last_out_at ? new Date(lead.last_out_at).getTime() : 0, li = lead.last_in_at ? new Date(lead.last_in_at).getTime() : 0;
  if (lo && Date.now() - lo < 30 * 60e3 && li < lo && d.kind !== "closing") { const nb = iso(new Date(lo + 30 * 60e3)); await back({ status: "approved", not_before: nb }); return { ok: true, queued: nb }; }
  if (lead.hold_until && new Date(lead.hold_until) > now()) { await back({ status: "expired", guard: "lead on hold" }); return { ok: false, err: "hold" }; }
  // one text per seller per 2 minutes, whatever produced it (two thinkers drafting the same reply, or two senders)
  const { data: justSent } = await sb.from("tom_drafts").select("id").eq("contact_id", lead.contact_id).neq("id", d.id).or(`status.eq.sending,sent_at.gte.${iso(new Date(Date.now() - 2 * 60e3))}`).limit(1);
  if (justSent?.length) { await back({ status: "expired", guard: "duplicate: another text went out in the last 2 min" }); await log(lead.contact_id, "dup_blocked", d.text.slice(0, 120)); return { ok: false, err: "duplicate" }; }
  // daily cap
  const { count } = await sb.from("tom_drafts").select("id", { count: "exact", head: true }).eq("status", "sent").gte("sent_at", iso(new Date(Date.now() - days(1))));
  if ((count ?? 0) >= s.daily_cap) { await back({ status: "approved" }); return { ok: false, err: "daily cap" }; }
  const r = await ghlSend(lead, d);
  if (!r.ok) {
    const unsub = /UNSUBSCRIBED|DND_ACTIVE/i.test(r.err ?? "");
    await sb.from("tom_drafts").update({ status: "failed", error: r.err }).eq("id", d.id);
    if (unsub) await sb.from("tom_leads").update({ unsub: true, dnd_sms: true }).eq("contact_id", lead.contact_id);
    await log(lead.contact_id, "send_failed", r.err ?? "");
    return { ok: false, err: r.err };
  }
  await sb.from("tom_drafts").update({ status: "sent", sent_at: iso(now()), ghl_message_id: r.id }).eq("id", d.id);
  if (r.id) await sb.from("acq_lead_msgs").upsert({ id: r.id, contact_id: lead.contact_id, at: iso(now()), direction: "outbound", kind: d.channel === "email" ? "email" : "sms", body: d.text, status: "sent", source: "tom", fetched_at: iso(now()) }, { onConflict: "id" });
  const recheck = d.kind === "reply" ? 3 : 5;
  await sb.from("tom_leads").update({ last_out_at: iso(now()), last_out_by: "tom", next_due_at: iso(new Date(Date.now() + days(recheck))), updated_at: iso(now()) }).eq("contact_id", lead.contact_id);
  await bumpUsage("tom_send", 1);
  await log(lead.contact_id, "sent", `${d.channel} as ${d.as_who} by ${by}: ${d.text.slice(0, 160)}`);
  if (d.book_at) {
    const rep = d.book_rep === "bt" ? "bt" : "nic"; const cell = rep === "bt" ? s.bt_cell : s.nic_cell;
    await sb.from("tom_bookings").insert({ contact_id: lead.contact_id, name: lead.name, address: lead.address, phone: lead.phone, call_at: d.book_at, rep, rep_cell: cell, draft_id: d.id, alert_booked_at: iso(now()) });
    const when = new Date(d.book_at).toLocaleString("en-US", { timeZone: "America/Chicago", weekday: "short", hour: "numeric", minute: "2-digit" });
    await sendText(s.alert_from, cell, `📞 Booked: ${lead.name ?? "seller"} - ${lead.address ?? ""} - call ${when} CT (they're expecting it). ${lead.phone ?? ""}`);
  }
  return { ok: true, id: r.id };
}

async function sendJob(b: any, by: string) {
  const s = await settings();
  if (b.draft_id) {
    const { data: d } = await sb.from("tom_drafts").select("*").eq("id", b.draft_id).single();
    if (!d) return { ok: false, err: "no draft" };
    if (!["pending", "approved", "failed"].includes(d.status)) return { ok: false, err: "draft is " + d.status };
    const upd: any = { status: "approved", approved_at: iso(now()), approved_by: by };
    if (b.text && String(b.text).trim() && String(b.text).trim() !== d.text) { upd.nic_fix = String(b.text).trim(); await sb.from("tom_training").insert({ draft_id: d.id, contact_id: d.contact_id, bad: d.text, fix: upd.nic_fix, lesson: b.lesson || null }); }
    await sb.from("tom_drafts").update(upd).eq("id", d.id);
    const d2 = { ...d, ...upd, text: upd.nic_fix ?? d.text };
    return await sendDraft(d2, s, by);
  }
  // cron path
  const out: any = { auto: 0, sent: 0, queued: 0, failed: 0 };
  if (s.enabled) { // MASTER SWITCH ON: pending drafts whose window is open go out on their own
    const { data: pend } = await sb.from("tom_drafts").select("id").eq("status", "pending").in("kind", ["reply", "nudge", "seq", "closing"]).lte("not_before", iso(now())).limit(25);
    if (pend?.length) { await sb.from("tom_drafts").update({ status: "approved", approved_at: iso(now()), approved_by: "auto" }).in("id", pend.map((x: any) => x.id)); out.auto = pend.length; }
  }
  const { data: ready } = await sb.from("tom_drafts").select("*").eq("status", "approved").lte("not_before", iso(now())).order("approved_at", { ascending: true }).limit(25);
  for (const d of ready ?? []) {
    const r = await sendDraft({ ...d, text: d.nic_fix ?? d.text }, s, d.approved_by ?? "cron");
    if (r.ok && r.queued) out.queued++; else if (r.ok) out.sent++; else out.failed++;
    await sleep(200);
  }
  // a run that died mid-send leaves 'sending' behind: never resend blind, mark it so a human can look
  await sb.from("tom_drafts").update({ status: "failed", error: "lost in flight (run died after claim)" }).eq("status", "sending").lt("approved_at", iso(new Date(Date.now() - 10 * 60e3)));
  // pending drafts older than 3 days are stale: the situation has moved on
  await sb.from("tom_drafts").update({ status: "expired", guard: "not approved within 3 days" }).eq("status", "pending").lt("created_at", iso(new Date(Date.now() - days(3))));
  return out;
}

async function alertsJob() {
  const s = await settings();
  const { data: open } = await sb.from("tom_bookings").select("*").eq("status", "open").lte("call_at", iso(new Date(Date.now() + 6 * 60e3)));
  let pinged = 0;
  for (const bk of open ?? []) {
    if (!bk.alert_5min_at) {
      const when = new Date(bk.call_at).toLocaleString("en-US", { timeZone: "America/Chicago", hour: "numeric", minute: "2-digit" });
      const err = await sendText(s.alert_from, bk.rep_cell || s.nic_cell, `📞 5 min: ${bk.name ?? "seller"} - ${bk.address ?? ""} at ${when} CT. ${bk.phone ?? ""} (they're expecting your call)`);
      await sb.from("tom_bookings").update({ alert_5min_at: iso(now()) }).eq("id", bk.id); await log(bk.contact_id, err ? "alert_error" : "alert_5min", err ?? when); pinged++;
    }
    if (new Date(bk.call_at).getTime() < Date.now() - 45 * 60e3) await sb.from("tom_bookings").update({ status: "done" }).eq("id", bk.id);
  }
  return { ok: true, pinged };
}

async function lostJob(cid: string, by: string) {
  const { data: lead } = await sb.from("tom_leads").select("*").eq("contact_id", cid).single();
  if (!lead?.opp_id) return { ok: false, err: "no opp" };
  const r = await ghl(`/opportunities/${lead.opp_id}`, { method: "PUT", body: JSON.stringify({ pipelineStageId: ST.lost }) });
  if (!r.ok) return { ok: false, err: r.status + " " + JSON.stringify(r.body).slice(0, 200) };
  await sb.from("tom_leads").update({ mode: "off", stage: "❌ Good Lead, Lost", stage_id: ST.lost, updated_at: iso(now()) }).eq("contact_id", cid);
  await sb.from("tom_drafts").update({ status: "expired", guard: "moved to Lost" }).eq("contact_id", cid).eq("status", "pending");
  await log(cid, "lost", "moved to Good Lead, Lost by " + by);
  return { ok: true };
}

async function whoAmI(req: Request): Promise<string> {
  try { const t = req.headers.get("authorization")?.replace(/^Bearer /i, "") ?? ""; const p = JSON.parse(atob(t.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))); return p.role === "service_role" ? "cron" : (p.email || p.sub || "app"); } catch { return "app"; }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const b = await req.json().catch(() => ({})) as any;
  const by = await whoAmI(req);
  try {
    let r: any;
    switch (b.job) {
      case "sync": r = await syncJob(b); break;
      case "think": r = await thinkJob(b); break;
      case "send": r = await sendJob(b, by); break;
      case "skip": {
        const { data: d } = await sb.from("tom_drafts").select("*").eq("id", b.draft_id).single();
        if (!d) { r = { ok: false, err: "no draft" }; break; }
        await sb.from("tom_drafts").update({ status: "skipped", skip_reason: b.reason ?? null, approved_by: by }).eq("id", d.id);
        if (b.reason && String(b.reason).trim().length > 2) await sb.from("tom_training").insert({ draft_id: d.id, contact_id: d.contact_id, bad: d.text, fix: null, lesson: String(b.reason).trim() });
        await sb.from("tom_leads").update({ next_due_at: iso(new Date(Date.now() + days(Number(b.days ?? 3)))) }).eq("contact_id", d.contact_id);
        await log(d.contact_id, "skipped", String(b.reason ?? "") + " :: " + d.text.slice(0, 100));
        r = { ok: true }; break;
      }
      case "alerts": r = await alertsJob(); break;
      case "lost": r = await lostJob(String(b.contact_id), by); break;
      case "preview": { const s = await settings(); const { data: lead } = await sb.from("tom_leads").select("*").eq("contact_id", b.contact_id).single(); if (!lead) { r = { ok: false, err: "no lead" }; break; } if (b.refresh) await refreshLead(lead.contact_id); const { data: l2 } = await sb.from("tom_leads").select("*").eq("contact_id", b.contact_id).single(); r = await think(l2, s, false); break; }
      case "refresh": r = { ok: true, res: await refreshLead(String(b.contact_id)) }; break;
      default: r = { ok: false, err: "job?" };
    }
    return Response.json(r, { headers: CORS });
  } catch (e) {
    await log(null, "error", b.job + ": " + String(e));
    return Response.json({ ok: false, err: String(e).slice(0, 400) }, { headers: CORS });
  }
});
