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
// Oct 26 (Nic: "why haven't my new leads been getting texted"): the model's occasional non-JSON answer used to become a textless "flag" draft that never
// sent or expired; 27 of them tripped the 40-draft cost brake and Tom stopped working new leads for two days. Now: bad JSON -> lenient parse -> one retry ->
// think_error (no draft), and flags no longer count toward the brake.
// Oct 27 (v33, Nic: Christopher Dao got "were you good with the $110,000 offer" - the May contract that died at inspection; MAO is $80k). A dollar figure in a text
// that is above the current MAO in facts is blocked: a dead contract price is not our offer. Rep delivers the new number by phone.
// Oct 27 (v32, Nic: "if they only speak Spanish I don't want to be booked a call"): lang=es leads are never booked and never offered a call - in code, not just the brief.
// Oct 27 (v31, Nic: "instant is a must"): {"job":"new_lead","contact_id":...} - a new ACQ form -> GHL workflow -> ghl-webhook -> here. Pull the
// opportunity, read the lead, draft, send, all in one call (~20-40s from form to text). First texts to a lead under an hour old skip the nudge pacing.
// Oct 26 (v30): max_tokens 3500 -> 8000. Every no_json since v28 was stop=max_tokens: the model ran out of room mid-answer on long packets.
// Oct 26 (v29): state falls back to the phone's area code when GHL and the address give nothing, so a TX lead with a blank state field
// gets TX hours (9am CT) instead of coast-to-coast hours (noon CT, no Sundays).
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
// Nov 3 (Lorri Mcminn - Nic: "it should have texted her by now today"): Nic's approved silent-lead sequence (Oct 11-12) as a clock.
// A form lead who has never replied is re-looked at on this cadence, not the 5-day nudge recheck. Day 1-2: 3/day, days 3-7: 2/day,
// days 8-14: 1/day, days 15-29: every 3 days, days 30-57: weekly, days 58-63: burst 2/day, to day 90: weekly, after: every 3 weeks.
const silentDay = (lead: any) => lead.form_at ? Math.max(1, Math.floor((Date.now() - new Date(lead.form_at).getTime()) / 864e5) + 1) : 99;
const silentGapMs = (dayN: number) => dayN <= 2 ? 4 * 3600e3 : dayN <= 7 ? 6 * 3600e3 : dayN <= 14 ? 864e5 : dayN <= 29 ? 3 * 864e5 : dayN <= 57 ? 7 * 864e5 : dayN <= 63 ? 6 * 3600e3 : dayN <= 90 ? 7 * 864e5 : 21 * 864e5;
// "never replied": no inbound at all, or the only inbound is the form itself (GHL logs the form answers as an inbound a few seconds before form_at)
const neverReplied = (lead: any) => !lead.last_in_at || (!!lead.form_at && new Date(lead.last_in_at).getTime() <= new Date(lead.form_at).getTime() + 5 * 60e3);
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

// ---------- time windows (seller state) ----------
// Oct 17 v20 (Nic: "make it flawlessly compliant"). Strictest of: federal 8-9, every state's own hours / Sunday / holiday rule
// (union of the stricter readings across published state charts - when sources disagreed, the stricter one is used),
// and Nic's own floor (9am weekdays, 10am Sat/Sun). States that span two time zones must be open in BOTH.
// Not legal advice - Nic's lawyer to confirm. Holiday list runs through Dec 2027.
const NY = "America/New_York", CH = "America/Chicago", DN = "America/Denver", LAX = "America/Los_Angeles";
const ZONES: Record<string, string[]> = {
  AL: [CH], AK: ["America/Anchorage"], AZ: ["America/Phoenix"], AR: [CH], CA: [LAX], CO: [DN], CT: [NY], DE: [NY], DC: [NY], FL: [NY, CH], GA: [NY], HI: ["Pacific/Honolulu"],
  ID: [DN, LAX], IL: [CH], IN: [NY, CH], IA: [CH], KS: [CH, DN], KY: [NY, CH], LA: [CH], ME: [NY], MD: [NY], MA: [NY], MI: [NY, CH], MN: [CH], MS: [CH], MO: [CH],
  MT: [DN], NE: [CH, DN], NV: [LAX], NH: [NY], NJ: [NY], NM: [DN], NY: [NY], NC: [NY], ND: [CH, DN], OH: [NY], OK: [CH], OR: [LAX, DN], PA: [NY], RI: [NY], SC: [NY],
  SD: [CH, DN], TN: [CH, NY], TX: [CH, DN], UT: [DN], VT: [NY], VA: [NY], WA: [LAX], WV: [NY], WI: [CH], WY: [DN],
};
const UNKNOWN_ZONES = [NY, CH, DN, LAX];   // no state on file: must be open coast to coast
const tzOf = (state?: string | null) => ZONES[String(state ?? "").toUpperCase()]?.[0] || CH;
type Hrs = [number, number] | null;   // [start hour, end hour) local; null = no texting that day
type Rule = { wk: Hrs; sat: Hrs; sun: Hrs; hol?: boolean };
const R = (wk: Hrs, sat: Hrs = wk, sun: Hrs = wk, hol = false): Rule => ({ wk, sat, sun, hol });
const STATE_RULES: Record<string, Rule> = {
  AL: R([8, 20], [8, 20], null, true), AK: R([9, 21]), CT: R([9, 20]), FL: R([8, 20]), GA: R([8, 21], [8, 21], null), IN: R([8, 21], [8, 21], null),
  KY: R([10, 21]), LA: R([8, 20], [8, 20], null, true), ME: R([9, 17], null, null), MD: R([8, 20]), MA: R([8, 20]), MI: R([9, 21], [9, 21], [9, 21], true),
  MN: R([9, 21], [9, 21], null, true), MS: R([8, 20], [8, 20], null), NV: R([9, 20]), OK: R([8, 20]), PA: R([8, 21], [8, 21], [12, 21]),
  RI: R([9, 18], [10, 17], null, true), TN: R([8, 21], [8, 21], null), TX: R([9, 21], [9, 21], [12, 21]), UT: R([8, 21], [8, 21], null, true),
  WA: R([8, 20]), WY: R([8, 20]),
};
const UNKNOWN_RULE = R([10, 20], [10, 20], null, true);
const FEDERAL = R([8, 21]);
// federal + the state holidays of the holiday-ban states (AL, LA, MI, MN, RI, UT), observed and actual dates both
const HOLIDAYS = new Set([
  "2026-11-11", "2026-11-26", "2026-11-27", "2026-12-24", "2026-12-25", "2026-12-31",
  "2027-01-01", "2027-01-18", "2027-02-09", "2027-02-15", "2027-04-26", "2027-05-31", "2027-06-07", "2027-06-18", "2027-06-19", "2027-07-04", "2027-07-05",
  "2027-07-23", "2027-07-24", "2027-08-09", "2027-09-06", "2027-10-11", "2027-11-11", "2027-11-25", "2027-11-26", "2027-12-24", "2027-12-25", "2027-12-31",
]);
const FMT = new Map<string, Intl.DateTimeFormat>();
function local(d: Date, tz: string) {
  let f = FMT.get(tz); if (!f) { f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour12: false, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }); FMT.set(tz, f); }
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  return { hour: Number(p.hour) % 24, minute: Number(p.minute), dow: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday), ymd: `${p.year}-${p.month}-${p.day}` };
}
// live = the seller texted us within the last hour: Nic's 9/10am floor drops to 8am, but never below the state's own start
function windowOpen(d: Date, state?: string | null, live = false): boolean {
  const st = String(state ?? "").toUpperCase();
  const known = !!ZONES[st];
  const rule = known ? (STATE_RULES[st] ?? FEDERAL) : UNKNOWN_RULE;
  for (const tz of known ? ZONES[st] : UNKNOWN_ZONES) {
    const l = local(d, tz);
    if (rule.hol && HOLIDAYS.has(l.ymd)) return false;
    const hrs = l.dow === 0 ? rule.sun : l.dow === 6 ? rule.sat : rule.wk;
    if (!hrs) return false;
    const own = live ? 8 : 9;
    const start = Math.max(hrs[0], own, 8), end = Math.min(hrs[1], 21);
    if (l.hour < start || l.hour >= end) return false;
  }
  return true;
}
function nextOpen(from: Date, state?: string | null, live = false): Date {
  const d = new Date(from.getTime());
  for (let i = 0; i < 7 * 24 * 4; i++) { if (windowOpen(d, state, live)) return d; d.setTime(d.getTime() + 15 * 60e3); }
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
// Nov 24 (v60, Nic: Beatrice Shahan asked for "2pm Central" on a Nevada lead and the row landed at 4pm Central; Sam Shay / heshmat / Amela on
// Texas leads landed an hour EARLY because the model wrote a -05:00 (daylight) offset after DST ended and fromLocal() trusted it).
// A booking time is now read as WALL-CLOCK digits only - any offset or Z the model appends is ignored - in the zone the seller named in the
// text ("Central", "Eastern", "CT", "PT"...) or, when no zone is named, the property's zone.
function bookInstant(str: string, tz: string): Date | null {
  const m = String(str ?? "").match(/(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/); if (!m) return null;
  return fromLocal(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}`, tz);
}
const ZONE_WORDS: [RegExp, string][] = [
  [/\b(central|cst|cdt|ct)\b/i, "America/Chicago"], [/\b(eastern|est|edt|et)\b/i, "America/New_York"],
  [/\b(mountain|mst|mdt|mt)\b/i, "America/Denver"], [/\b(pacific|pst|pdt|pt)\b/i, "America/Los_Angeles"],
];
// zone the seller/Tom named next to a time in the text (e.g. "2pm Central", "10 Eastern"), else null
function zoneFromText(text: string): string | null {
  const t = String(text ?? "");
  if (!/\b\d{1,2}(:\d{2})?\s*(am|pm|a\.m\.|p\.m\.)?\b/i.test(t)) return null;
  for (const [rx, tz] of ZONE_WORDS) if (rx.test(t)) return tz;
  return null;
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
// Oct 26: US area code -> state. Last resort for texting hours when GHL and the address carry no state. The area code is where the phone
// was issued, not where the house is, which is the right thing for "when may we text this person" anyway.
const AREA_STATES: Record<string, string> = {
  AL: "205 251 256 334 659 938", AK: "907", AZ: "480 520 602 623 928", AR: "327 479 501 870",
  CA: "209 213 279 310 323 341 350 369 408 415 424 442 510 530 559 562 619 626 628 650 657 661 669 707 714 747 760 805 818 820 831 840 858 909 916 925 949 951",
  CO: "303 719 720 970 983", CT: "203 475 860 959", DE: "302", DC: "202 771",
  FL: "239 305 321 352 386 407 448 561 645 656 689 727 754 772 786 813 850 863 904 941 954", GA: "229 404 470 478 678 706 762 770 912 943",
  HI: "808", ID: "208 986", IL: "217 224 309 312 331 447 464 618 630 708 730 773 779 815 847 872", IN: "219 260 317 463 574 765 812 930",
  IA: "319 515 563 641 712", KS: "316 620 785 913", KY: "270 364 502 606 859", LA: "225 318 337 504 985", ME: "207", MD: "240 301 410 443 667",
  MA: "339 351 413 508 617 774 781 857 978", MI: "231 248 269 313 517 586 616 679 734 810 906 947 989", MN: "218 320 507 612 651 763 952",
  MS: "228 601 662 769", MO: "314 417 557 573 636 660 816 975", MT: "406", NE: "308 402 531", NV: "702 725 775", NH: "603",
  NJ: "201 551 609 640 732 848 856 862 908 973", NM: "505 575", NY: "212 315 329 332 347 363 516 518 585 607 624 631 646 680 716 718 838 845 914 917 929 934",
  NC: "252 336 472 704 743 828 910 919 980 984", ND: "701", OH: "216 220 234 283 326 330 380 419 440 513 567 614 740 937", OK: "405 539 572 580 918",
  OR: "458 503 541 971", PA: "215 223 267 272 412 445 484 570 582 610 717 724 814 835 878", RI: "401", SC: "803 839 843 854 864", SD: "605",
  TN: "423 615 629 731 865 901 931", TX: "210 214 254 281 325 346 361 409 430 432 469 512 682 713 726 737 806 817 830 832 903 915 936 940 945 956 972 979",
  UT: "385 435 801", VT: "802", VA: "276 434 540 571 703 757 804 826 948", WA: "206 253 360 425 509 564", WV: "304 681", WI: "262 274 414 534 608 715 920", WY: "307",
};
const AREA = new Map<string, string>(); for (const [st, codes] of Object.entries(AREA_STATES)) for (const c of codes.split(" ")) AREA.set(c, st);
const stateFromPhone = (p: unknown) => { const d = String(p ?? "").replace(/\D/g, ""); const ac = d.length === 11 && d.startsWith("1") ? d.slice(1, 4) : d.length === 10 ? d.slice(0, 3) : ""; return AREA.get(ac) ?? null; };

// Oct 29 (Nic: "they should only move to In Conversation if we spoke on the phone"). A GHL-side workflow moves a seller into
// 🗣️ In Conversation the minute they text back. Every sync: a lead that just landed in In Conversation (last 30 min) from another
// stage with NO connected call (45s+, either direction, GHL or OpenPhone) goes back where it was. Logged as stage_reverted + a contact note.
async function spokeOnPhone(cid: string, phone: string | null) {
  const { data: a } = await sb.from("acq_lead_msgs").select("id").eq("contact_id", cid).eq("kind", "call").gte("duration_sec", 45).limit(1);
  if (a?.length) return true;
  const d10 = String(phone ?? "").replace(/\D/g, "").slice(-10);
  if (d10.length === 10) { const { data: c } = await sb.from("acq_calls").select("id").eq("phone", d10).gte("duration", 45).limit(1); if (c?.length) return true; }
  return false;
}
async function undoTextMoves(rows: any[], stageNames: Map<string, string>) {
  const fresh = rows.filter((r) => r.stage_id === ST.inConv && r.stage_changed_at && Date.now() - new Date(r.stage_changed_at).getTime() < 30 * 60e3);
  if (!fresh.length) return;
  const { data: prev } = await sb.from("tom_leads").select("contact_id,stage_id,stage,stage_changed_at,phone").in("contact_id", fresh.map((r) => r.contact_id));
  for (const r of fresh) {
    const p = (prev ?? []).find((x: any) => x.contact_id === r.contact_id);
    if (!p?.stage_id || p.stage_id === ST.inConv || !r.opp_id) continue;
    if (await spokeOnPhone(r.contact_id, r.phone || p.phone)) continue;
    const put = await ghl(`/opportunities/${r.opp_id}`, { method: "PUT", body: JSON.stringify({ pipelineStageId: p.stage_id }) });
    if (!put.ok) { await log(r.contact_id, "stage_revert_failed", `${put.status} ${JSON.stringify(put.body).slice(0, 160)}`); continue; }
    r.stage_id = p.stage_id; r.stage = stageNames.get(p.stage_id) ?? p.stage; r.stage_changed_at = p.stage_changed_at;
    r.mode = SILENT.has(p.stage_id) ? "silent" : JUDGMENT.has(p.stage_id) ? "judgment" : r.mode;
    await log(r.contact_id, "stage_reverted", `In Conversation -> ${r.stage}: texted us but nobody has spoken to them on the phone yet`);
    await ghl(`/contacts/${r.contact_id}/notes`, { method: "POST", body: JSON.stringify({ body: `↩️ Moved back to ${r.stage}: a text reply is not a conversation - In Conversation is for sellers we have spoken to on the phone (Nic, Oct 29).`, userId: "UvBSAHJwAJYCcaz9fc3v" }) });
  }
}

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
    await undoTextMoves(rows, stageNames);
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
    upd.city = c.city || lead.city; upd.state = (c.state && c.state.length === 2 ? c.state.toUpperCase() : STATE_NAMES[String(c.state ?? "").toLowerCase()] ?? null) || stateFromAddress(lead.address || "") || lead.state || stateFromPhone(upd.phone); upd.postal = c.postalCode || lead.postal;
    if (!lead.address && c.address1) upd.address = c.address1;
    upd.tags = c.tags ?? lead.tags;
    if (!lead.first_name && c.firstName) upd.first_name = c.firstName;
  } else if (!lead.state) upd.state = stateFromAddress(lead.address || "") || stateFromPhone(lead.phone);
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
    // Oct 28 (Woolery Allen): "last rep call" = the newest CONNECTED call (>=45s, either direction), not the newest 4s dial.
    if (m.kind === "call" && !lastRepCall && (m.duration_sec ?? 0) >= 45) lastRepCall = m;
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
- Two senders only: Tom, or Nic. Use the SENDER line in the packet - it decides who you are (when it is Nic, the text is from "Nic" so the seller isn't confused by a second person).
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
- Never say or imply our number "shifted", "changed", "moved", "came down" or that we "landed" somewhere else. The offer written in the rep notes IS our number - restate it as written, even if it is above the cash MAO (novation and creative offers often are). Only a rep changes an offer. If you believe the number on file is wrong, action "flag" - never a vague text to the seller.
- Never ask a question the seller already answered anywhere in the thread (re-asking the closing date, the price, the condition). Read the whole thread first. If you have asked three questions in a row on a hot text thread, stop questioning: tell the seller a rep will call, and flag it. A seller who says "is that AI?" or "you already asked that" is a warning: stop and flag, do not send another question.
- A seller with MORE properties, a package deal, or a firm number on several houses is a rep call, not a text exchange: flag Nic right away.
- A novation or creative-finance offer is NOT a cash offer. Never describe it, or let the seller believe it is, cash, fast, or certain: no "cash", no quick-close promises, no agreeing to a cash price or short timeline on a non-cash deal. When the seller says "cash" or a short close and our offer_type is not cash, do not confirm - set the call and let the rep explain how our offer works.
- When the seller has said yes ("sure", "ok", "sounds good") to a call time we proposed, CONFIRM that exact time with a statement ("Sounds good, talk to you at 4:15") and set book_at to it. Never move the time again or turn it into a new question - the seller has already agreed. If the time is only minutes away, still confirm it.
- Saying we are "close" is fine when we truly are (seller's price within about 10% of our offer AND we can do their timeline). Never say it, or "can get it done" / "works", when the seller's price is well above our offer or they name a closing timeline we can't meet (novation and creative-finance deals cannot close in 14 days; only cash can close fast). A seller's ask is not our offer. In that case do not agree - just set up the call with a rep ("let's get on a quick call and go over the numbers and timeline together") and let the rep handle it.
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
- EXCEPTION - a form lead who has NEVER replied (Untouched / Attempt Made / No Reply) runs on Nic's fixed sequence: days 1-2: 3 texts a day, days 3-7: 2 a day, days 8-14: 1 a day, days 15-29: every 3 days, then weekly. When it's their turn, action is "text" - never "wait" for the morning or for the next day; the sender holds every text until the seller's legal hours. Vary the slot: morning texts open "Morning <name>", later ones "Hey <name>". Days 1-14 ask for a call time; days 15-29 ask one engagement question instead (still selling? rough number? vacant or rented?).
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
- why_now (required for any call you book, offer or promise): ONE specific sentence on what is DIFFERENT from the last time a rep spoke to this seller that makes them convertible now - a number that came down into range, a new deadline/event, a yes to our offer, a blocker that cleared. Read the notes and call transcripts to know what the last conversation was. If no rep has ever spoken to them, say why a first call converts (their number vs ours + what's driving it). If nothing has changed, why_now is null and you do NOT offer, propose or confirm a call - ask the one question that would change it instead. A call where nothing changed since last time is a wasted call.

## Output - JSON only
{"action":"text"|"wait"|"skip"|"flag"|"closing",
 "as_who":"tom"|"nic", "channel":"sms"|"email", "text":"the text (empty unless action is text/closing)", "subject":"email subject or null",
 "book_at":"the call time as plain wall-clock digits, YYYY-MM-DDTHH:MM, with NO offset and no Z, or null. Write it in the property's local time - unless the seller named a time zone (\"2pm Central\", \"10 Eastern\"), then write the digits in THAT zone and repeat the zone word in the text exactly as they said it",
 "why_now":"one specific sentence: what changed since the last rep conversation that makes this a deal now (required when book_at is set or the text offers a call; else null)",
 "wait_until":"ISO date when to look at this lead again (required for wait; also set it for text = when to check back if they go quiet)",
 "reason":"one short line why",
 "context":"ONE tight paragraph for Nic: street + city, situation, the numbers (their ask, our offer, type), what they said last, what's happened since, why this text now",
 "facts":{"offer":number|null,"offer_type":"cash"|"novation"|"subto"|"unknown","ask":number|null (the seller's CURRENT number from the thread/notes),"mao":number|null (from the rep notes),"open_to_our_number":true|false,"strong_motivation":true|false,"pressure":"...","blocker":"...","event_date":"YYYY-MM-DD"|null}}`;

async function claude(model: string, system: string, user: string, maxTokens = 8000) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST", headers: { "x-api-key": ANTHROPIC, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model, max_tokens: maxTokens, system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }], messages: [{ role: "user", content: user }] }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("anthropic " + r.status + " " + JSON.stringify(j).slice(0, 200));
  return { text: (j.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text ?? "").join(""), usage: j.usage ?? {}, stop: j.stop_reason ?? null };
}
// Oct 26: lenient. Code fences, prose before/after the object, raw line breaks or tabs inside strings, and a second object or prose after the real answer all parse now.
function parseJson(t: string): any {
  const s = String(t ?? "").replace(/```(?:json)?/gi, "").trim();
  const m = s.match(/\{[\s\S]*\}/); if (!m) return null;
  const tries: string[] = [m[0], m[0].replace(/[\u0000-\u001f]+/g, " ")];
  // first balanced object
  let depth = 0, start = -1;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "{") { if (depth === 0) start = i; depth++; }
    else if (c === "}") { depth--; if (depth === 0 && start >= 0) { const o = s.slice(start, i + 1); tries.push(o, o.replace(/[\u0000-\u001f]+/g, " ")); break; } }
  }
  for (const x of tries) { try { const j = JSON.parse(x); if (j && typeof j === "object") return j; } catch { /* next */ } }
  return null;
}

// sender (Nic, Oct 21): text AS NIC when Nic owns the lead and he touched/called it in the last 7 days, or it sits in CONTRACT THIS MONTH
function isNicSender(lead: any): boolean {
  if (lead.assigned_to !== NIC) return false;
  const recent = (t?: string | null) => !!t && Date.now() - new Date(t).getTime() < days(7);
  return recent(lead.last_rep_touch_at) || recent(lead.last_rep_call_at) || /CONTRACT THIS MONTH/i.test(String(lead.stage ?? "")) || lead.stage_id === ST.contractMonth;
}

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
    isNicSender(lead) ? "SENDER: You are texting as NIC (the owner) - write as Nic, intro 'it's Nic with Clear Path' if an intro is needed, never call yourself Tom." : "SENDER: Tom.",
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
const RAISE_RX = /\b(we('| a)re|we are|that('| i)s|you('| a)re) (very |really |pretty |so )?close\b|\bget (it|this|that|the deal) done\b|\bdo (a little |a bit |some|slightly )?better (for|on|than)\b|\b(some|a little|a bit of|wiggle) room (on (our|my) end|for us|to move|to work with)\b|\bmeet (you )?(in the middle|halfway)\b|\bcome up (a little|a bit|some|to|on|from)\b|\b(bump|sweeten|raise|increase|improve) (it|that|the (offer|number|price)|our (offer|number|price))\b|\bsee what (i|we) can do\b|\bmake (it|this|that|the numbers?) work\b|\bclose the gap\b|\bwork with you on (the )?(price|number|that)\b|\b(take another|took another|another) look at the numbers\b|\bre-?run (the|our) numbers\b|\bflexib(le|ility)\b/i; // "do you have any room?" and "we are not too far apart" are Nic's own funnel lines (asking the SELLER to move) - allowed
const CALL_RX = /\b(we|i)('ll| will| can| could|'d like to| would like to) (call|ring|phone|try) you\b|\b(call|ring|phone) you (at|around|back|today|tomorrow|then|this|in)\b|\b(can|could|may|should) (i|we) (call|ring|phone) you\b|\bgive you a (quick )?(call|ring)\b|\b(hop|jump|get) on (a|the) (quick )?(call|phone)\b|\b(for|on) a (quick |short |five minute |5 minute )?(call|phone call)\b|\bminutes? on the phone\b|\b(what|which) time (works|is good|is best)\b|\btime (to|for us to|for me to) call\b|\bcall you with\b|\bte llam(o|amos|ar[ée])\b|\ble llam(o|amos|ar[ée])\b|\bllamar(te|le|lo|la)\b|\ba qu[ée] hora\b|\buna llamada\b|\bhablar por tel[ée]fono\b|\bpor tel[ée]fono\b|\bdo a (quick |short |brief )?(call|phone call)\b|\b(call|chat|talk|speak|phone)\b[^.?!]{0,30}\b(at|around) \d{1,2}(:\d{2})?(?!\d)\s?(am|pm|a\.m|p\.m|this|tonight|tomorrow|today|o'clock)?/i; // Oct 28 (Angel Rivera): "can we do a quick call at 6:15 this evening" slipped past
// offering / scheduling a walkthrough, visit or inspection (Nic, Oct 16: never before an agreed price)
const WALK_RX = /walk[- ]?thr(ough|u)|\b(come|swing|stop|drop) (by|out|over)\b|come (and )?(see|look at|take a look)|\b(see|look at|check out|view) (it|the (house|property|place)) in person\b|\b(set up|schedule|do|book) (a|an|the) (visit|showing|viewing|inspection|appointment to see)\b|\bsend (someone|our guy|a guy|my partner) (out|by|over)\b|\b(our|my) (team|guy|partner) (can )?(come|stop|swing) (by|out)\b|\binspect(ion)?\b.{0,30}\b(house|property|place)\b/i;
// "happy to come see it once we agree on a number" is the correct answer to a visit request, not an offer of one
const WALK_OK_RX = /\bonce we\b|\bafter we (agree|lock|settle)|\bwhen we (have|agree)|number we both agree|agree on (a|the) (number|price)|price (is )?(agreed|locked)/i;
// a usable why_now names a concrete change; empty, short or "nothing changed" does not count
const weakWhy = (w: any) => !w || String(w).trim().length < 20 || /^(null|none|n\/a|unknown)$|nothing (has )?changed|no change|same as (before|last)|not (sure|clear)/i.test(String(w).trim());

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
  // Nov 4 (Hope Sheree): Tom told a seller "the numbers shifted on our end" when nothing changed - it had second-guessed Nic's
  // $198k note against its own MAO math. Our number only changes when a rep says so; Tom never implies it moved.
  if (/\b(numbers?|offer|price|figure)s? (has |have |had )?(shifted|changed|moved|come down|came down|dropped|gone down|went down|adjusted|been (adjusted|revised|updated))\b|\b(shift|change|movement|adjustment) (in|on|to) (our|the) (numbers?|offer|price)\b|\bwhere (we|things|it) landed\b|\bre-?(ran|run|work(ed)?) the numbers\b/i.test(text)) return "implied our number changed";
  // Nov 5 (Jason Lewis): seller said "$350,000 and close in 14 days" (we offered $345k novation; we can't close in 14 days) and Tom texted
  // "We are very close, I think we might be able to get it done." Tom never signals agreement/closeness while the seller's price is above our
  // number or the seller names a fast close - a rep takes that on the call.
  {
    const ask = Number(lead.facts?.ask) || 0, cap = Number(lead.facts?.mao) || Number(lead.facts?.offer) || 0;
    const fastClose = /\b(\d{1,2}|one|two|three|seven|ten|fourteen)\s*-?\s*(days?|weeks?)\b|\bclose (fast|quick|asap|by)\b|\bcash\b/i.test(String(lead.last_in_body ?? ""));
    // "close" is fine when we truly are (price within 10%, and no fast close on a novation/creative deal); only block false hope
    const slow = fastClose && String(lead.facts?.offer_type ?? "") !== "cash";
    if (((ask > 0 && cap > 0 && ask > cap * 1.10) || slow) && /\b(very close|really close|pretty close|so close|getting close|close to (a )?deal|get (it|this|that) done|make (it|that|this) work|can (do|make) (that|it)|works? for us|we can do (that|it))\b/i.test(text)) return "implied agreement while seller price/timeline is beyond us";
  }
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
  const nicSender = isNicSender(lead);
  const asNic = (t: string) => nicSender ? t.replace(/\bTom\b/g, "Nic") : t; // safety: Nic's leads never say Tom
  // Nic's recent corrections are part of the brief
  const { data: tr } = await sb.from("tom_training").select("lesson").order("created_at", { ascending: false }).limit(1000);
  const lessons = (tr ?? []).map((x: any) => "- " + x.lesson).filter((x: string) => x.length > 3).join("\n");
  const sys = s.brief + (lessons ? "\n\n## Nic's latest corrections (newest first, these win)\n" + lessons : "");
  let r = await claude(s.model, sys, user);
  let j = parseJson(r.text);
  // Oct 26: a non-JSON answer is a model hiccup, not a lead that needs Nic. Log what came back, ask once more, and if it still fails
  // throw so thinkJob records think_error and re-queues the lead in an hour - never a textless "flag" draft that clogs the queue.
  if (!j) {
    await log(lead.contact_id, "no_json", `stop=${r.stop} len=${r.text.length} :: ` + r.text.slice(0, 700));
    r = await claude(s.model, sys, user + "\n\nYour previous answer was not valid JSON. Reply with ONLY the JSON object described in the brief: no prose before or after it, no code fences, no line breaks inside string values, and keep context under 120 words.", 8000);
    j = parseJson(r.text);
    if (!j) { await log(lead.contact_id, "no_json", `retry stop=${r.stop} len=${r.text.length} :: ` + r.text.slice(0, 700)); throw new Error("model returned no JSON twice"); }
  }
  const cost = (r.usage.input_tokens ?? 0) * 3e-6 + (r.usage.output_tokens ?? 0) * 15e-6 + (r.usage.cache_creation_input_tokens ?? 0) * 3.75e-6 + (r.usage.cache_read_input_tokens ?? 0) * 0.3e-6;
  let text = asNic(String(j.text ?? "").replace(/—|–/g, " - ").replace(/\s{2,}/g, " ").trim());
  let action = String(j.action ?? "wait");
  let g: string | null = null;
  if (action === "text" || action === "closing") {
    g = guard(text, lead, (lead.notes_text ?? "") + " " + user);
    // Nic Oct 27: never restate a price above what we can pay now. A contract that fell through is not our offer any more.
    const fx = j.facts ?? lead.facts ?? {}; const maoNow = Number(fx.mao);
    if (!g && maoNow > 0) {
      const amts = (text.match(/\$\s?\d{1,3}(?:,\d{3})+|\$\s?\d{4,7}|\b\d{2,3}k\b/gi) ?? []).map((n: string) => { const d = n.replace(/[^0-9k]/gi, "").toLowerCase(); return d.endsWith("k") ? Number(d.slice(0, -1)) * 1000 : Number(d); });
      // Nov 4 (Hope Sheree): the rep's CURRENT offer in the notes is always allowed, even above cash MAO (novation / creative). The dead-price
      // rule only applies to a figure that is not the current offer (Dao: a May contract price the notes had since replaced).
      const curOffer = Number(fx.offer) || 0;
      // Nov 4 (Nic: "WHY WOULD TOM TELL HER ABOVE OUR OFFER"): a note "offer" that sits above the note's MAO is a question for Nic,
      // not a number to text. Tom flags it and waits.
      if (curOffer > maoNow * 1.02 && amts.some((v: number) => Math.abs(v - curOffer) <= 500)) {
        await log(lead.contact_id, "offer_above_mao_flag", `offer $${curOffer} > MAO $${maoNow} in notes - not texted, flagged for Nic :: ` + text.slice(0, 100));
        action = "flag"; text = `Offer on file $${curOffer.toLocaleString("en-US")} is above MAO $${maoNow.toLocaleString("en-US")} in the notes. Which number do we give ${lead.first_name ?? lead.name ?? "the seller"}?`;
        j.reason = "offer in notes is above MAO - Nic to confirm the number before Tom texts it";
        j.book_at = null; j.why_now = null;
        if (s.ping_on_important !== false) await pingNic(s, `Tom Bot: ${lead.name ?? "seller"} (${lead.address ?? "?"}) - offer on file $${curOffer.toLocaleString("en-US")} is above MAO $${maoNow.toLocaleString("en-US")}. Tom won't text a number until you say which.`, lead.contact_id);
      }
      const high = action === "flag" ? undefined : amts.find((v: number) => v > maoNow * 1.02 && Math.abs(v - curOffer) > 500);
      if (high) {
        const r7 = await claude(s.model, sys, user + `\n\nYour draft was rejected: it names $${high.toLocaleString("en-US")}, which is not our current offer (${curOffer ? "$" + curOffer.toLocaleString("en-US") : "none on file"}) and is above our max (MAO $${maoNow.toLocaleString("en-US")}). That is a dead contract price or a number we can no longer pay. NEVER restate it and never text a new number. Rewrite: restate only the current offer from the notes if there is one, otherwise ask ONE plain question about their situation or timeline. Do NOT say or imply that our numbers changed, shifted or moved - only a rep says that. JSON only.`);
        const j7 = parseJson(r7.text);
        if (j7?.text) { text = asNic(String(j7.text).replace(/—|–/g, " - ").replace(/\s{2,}/g, " ").trim()); g = guard(text, lead, (lead.notes_text ?? "") + " " + user); if (j7.reason) j.reason = j7.reason; if (j7.context) j.context = j7.context; if (j7.facts) j.facts = j7.facts; j.book_at = j7.book_at ?? null; j.why_now = j7.why_now ?? null; }
        const amts2 = (text.match(/\$\s?\d{1,3}(?:,\d{3})+|\$\s?\d{4,7}|\b\d{2,3}k\b/gi) ?? []).map((n: string) => { const d = n.replace(/[^0-9k]/gi, "").toLowerCase(); return d.endsWith("k") ? Number(d.slice(0, -1)) * 1000 : Number(d); });
        if (!g && amts2.some((v: number) => v > maoNow * 1.02)) g = "restated a price above current MAO";
        await log(lead.contact_id, "mao_redrafted", (g ? "blocked: " : "ok: ") + `$${high} > MAO $${maoNow} :: ` + text.slice(0, 100));
      }
    }
    // Oct 28 (Thena Horton, Wendy Baker - Nic: "you made it sound like I could come up, I couldn't"): no hint that our number can move.
    // The funnel's ladder line ("we're very close, I think we can get it done") is only true when the seller's number is at or under MAO - i.e. the rep really can get there.
    const fr = j.facts ?? lead.facts ?? {}; const askR = Number(fr.ask), maoR = Number(fr.mao);
    const canGetThere = askR > 0 && maoR > 0 && askR <= maoR * 1.03; // within 3% = a real near-miss the rep can usually close
    if (!g && RAISE_RX.test(text) && !canGetThere) {
      const r8 = await claude(s.model, sys, user + `\n\nYour draft was rejected: it hints that we can pay more ("${(text.match(RAISE_RX) ?? [""])[0]}") but the seller's number ($${askR || "?"}) is above our MAO ($${maoR || "?"}) - we cannot get there. Tom never moves price, not even by implication - "we're close", "might be able to get it done / do better", "some room", "see what I can do", "make it work" all promise the rep will raise, and the rep then has to walk it back. Our offer in the notes is our number. Rewrite: either restate only the amount already in the notes/thread as our number and ask if it works for them, or ask one plain question about their situation. No hint of flexibility. JSON only.`);
      const j8 = parseJson(r8.text);
      if (j8?.text) { text = asNic(String(j8.text).replace(/—|–/g, " - ").replace(/\s{2,}/g, " ").trim()); g = guard(text, lead, (lead.notes_text ?? "") + " " + user); if (j8.reason) j.reason = j8.reason; if (j8.context) j.context = j8.context; if (j8.facts) j.facts = j8.facts; j.book_at = j8.book_at ?? null; j.why_now = j8.why_now ?? null; }
      if (!g && RAISE_RX.test(text)) g = "hinted that our price can move (ask above MAO)";
      await log(lead.contact_id, "raise_redrafted", (g ? "blocked: " : "ok: ") + text.slice(0, 120));
    }
    if (g && /new price/.test(g)) { // one retry
      const r2 = await claude(s.model, sys, user + `\n\nYour draft was rejected: it contained a number that is not already in the notes or thread (${g}). Never text a new price. Rewrite without any number, or restate only an amount that already appears above. JSON only.`);
      const j2 = parseJson(r2.text); if (j2?.text) { text = asNic(String(j2.text).replace(/—|–/g, " - ").trim()); g = guard(text, lead, (lead.notes_text ?? "") + " " + user); if (j2.reason) j.reason = j2.reason; }
    }
    // Oct 28 (Dustin Baker - "U tell me" sat 4.5 days because the only draft was blocked and never retried): any other guard gets one rewrite too.
    if (g && !/new price/.test(g)) {
      const r9 = await claude(s.model, sys, user + `\n\nYour draft was rejected by a hard rule: "${g}". Rewrite so it does not do that. Do not promise, propose or confirm a call unless the rules above allow booking one (then set book_at). Never text a number that is not already in the notes/thread. If you cannot say anything useful without breaking the rule, acknowledge what the seller said in one short line and ask ONE plain question about their situation or timeline. JSON only.`);
      const j9 = parseJson(r9.text);
      if (j9?.text) { text = asNic(String(j9.text).replace(/—|–/g, " - ").replace(/\s{2,}/g, " ").trim()); g = guard(text, lead, (lead.notes_text ?? "") + " " + user); if (j9.reason) j.reason = j9.reason; if (j9.context) j.context = j9.context; if (j9.facts) j.facts = j9.facts; j.book_at = j9.book_at ?? null; j.why_now = j9.why_now ?? null; }
      await log(lead.contact_id, "guard_redrafted", (g ? "still blocked (" + g + "): " : "ok: ") + text.slice(0, 120));
    }
    // Nic only takes calls he can convert: an unqualified seller is never offered or promised a call (qualify by text first)
    const f0 = j.facts ?? lead.facts ?? {}; const ask0 = Number(f0.ask), mao0 = Number(f0.mao); const pct0 = 1 + Number(s.book_mao_pct ?? 15) / 100;
    const qualified = SILENT.has(lead.stage_id) || (ask0 > 0 && mao0 > 0 && ask0 <= mao0 * pct0) || f0.open_to_our_number === true || f0.strong_motivation === true; // Nic, Oct 19: Untouched / Attempt Made / No Reply always go straight for the call (booked with BT)
    if (!g && !qualified && CALL_RX.test(text)) {
      const r3 = await claude(s.model, sys, user + `\n\nYour draft was rejected: it offers or promises a phone call, but this seller is not qualified yet (no number within 15% of MAO, not open to our number, no strong motivation). Nic only takes calls he can convert. Do NOT propose, promise or confirm a call and leave book_at null. Instead ask ONE qualifying question by text (what they are looking to get for it, or what is driving the sale and their timeline). JSON only.`);
      const j3 = parseJson(r3.text);
      if (j3?.text) { text = asNic(String(j3.text).replace(/—|–/g, " - ").replace(/\s{2,}/g, " ").trim()); g = guard(text, lead, (lead.notes_text ?? "") + " " + user); if (j3.reason) j.reason = j3.reason; if (j3.context) j.context = j3.context; }
      j.book_at = null;
      if (!g && CALL_RX.test(text)) g = "offered a call to an unqualified seller";
      await log(lead.contact_id, "call_redrafted", (g ? "blocked: " : "ok: ") + text.slice(0, 120));
    }
    // no walkthrough / visit / inspection until the seller has agreed to our number
    if (!g && WALK_RX.test(text) && !WALK_OK_RX.test(text) && f0.open_to_our_number !== true) {
      const r5 = await claude(s.model, sys, user + `\n\nYour draft was rejected: it offers, schedules or promises a walkthrough / visit / inspection, but there is no agreed price yet. We never go see a house until the seller has agreed to our number - otherwise the trip is wasted. Rewrite: if the seller asked for a visit, say we're happy to once we have a number we both agree on, and ask if they were good with the offer we already made (restate only an amount already in the notes/thread). Otherwise just drop the visit. JSON only.`);
      const j5 = parseJson(r5.text);
      if (j5?.text) { text = asNic(String(j5.text).replace(/—|–/g, " - ").replace(/\s{2,}/g, " ").trim()); g = guard(text, lead, (lead.notes_text ?? "") + " " + user); if (j5.reason) j.reason = j5.reason; if (j5.context) j.context = j5.context; if (j5.facts) j.facts = j5.facts; j.book_at = j5.book_at ?? null; j.why_now = j5.why_now ?? null; }
      if (!g && WALK_RX.test(text) && !WALK_OK_RX.test(text) && (j.facts ?? f0)?.open_to_our_number !== true) g = "offered a walkthrough before an agreed price";
      await log(lead.contact_id, "walk_redrafted", (g ? "blocked: " : "ok: ") + text.slice(0, 120));
    }
    // no appointment without a reason it converts THIS time: a call needs a concrete why_now (what changed since the last rep conversation)
    if (SILENT.has(lead.stage_id) && weakWhy(j.why_now)) j.why_now = `Seller replied from ${lead.stage ?? "an early stage"} - first real conversation, early-stage leads go straight to a call`;
    if (!g && (j.book_at || CALL_RX.test(text)) && weakWhy(j.why_now)) {
      const r4 = await claude(s.model, sys, user + `\n\nYour draft was rejected: it books, offers or promises a phone call but why_now is missing or vague ("${String(j.why_now ?? "")}"). Nic only takes a call when something concrete has changed since the last time a rep spoke to this seller (number came down into range, new deadline, yes to our offer, blocker cleared) - or, if no rep ever spoke to them, when their number and motivation make a first call worth it. Re-read the notes, transcripts and thread. If there IS such a change, keep the draft and put that ONE specific fact in why_now. If there is NOT, do NOT propose, promise or confirm a call, leave book_at and why_now null, and ask the one question that would change it. JSON only.`);
      const j4 = parseJson(r4.text);
      if (j4?.text) { text = asNic(String(j4.text).replace(/—|–/g, " - ").replace(/\s{2,}/g, " ").trim()); g = guard(text, lead, (lead.notes_text ?? "") + " " + user); j.why_now = j4.why_now ?? null; j.book_at = j4.book_at ?? null; if (j4.reason) j.reason = j4.reason; if (j4.context) j.context = j4.context; if (j4.facts) j.facts = j4.facts; }
      if (weakWhy(j.why_now)) { j.book_at = null; j.why_now = null; if (!g && CALL_RX.test(text)) g = "offered a call with no why_now (nothing changed since the last rep conversation)"; }
      await log(lead.contact_id, "why_now_check", (g ? "blocked: " : j.why_now ? "ok: " + String(j.why_now).slice(0, 100) + " | " : "no call: ") + text.slice(0, 100));
    }
    // Nic Oct 27: Spanish-only sellers are never booked and never offered a call - nobody on the team takes it. Tom works them entirely by text.
    if (lead.lang === "es") {
      j.book_at = null; j.why_now = null;
      if (!g && CALL_RX.test(text)) {
        const r6 = await claude(s.model, sys, user + `\n\nYour draft was rejected: it offers, proposes or books a phone call, but this seller speaks Spanish and nobody on our team can take that call. NEVER offer, promise or book a call with a Spanish-speaking seller. Work them entirely by text, in simple Spanish: acknowledge what they said and ask the ONE next fact question (motivation, timeline, what they are looking to get, condition, mortgage, photos). Leave book_at null. JSON only.`);
        const j6 = parseJson(r6.text);
        if (j6?.text) { text = asNic(String(j6.text).replace(/—|–/g, " - ").replace(/\s{2,}/g, " ").trim()); g = guard(text, lead, (lead.notes_text ?? "") + " " + user); if (j6.reason) j.reason = j6.reason; if (j6.context) j.context = j6.context; if (j6.facts) j.facts = j6.facts; }
        if (!g && CALL_RX.test(text)) g = "offered a call to a Spanish-speaking seller";
        await log(lead.contact_id, "es_no_call", (g ? "blocked: " : "ok: ") + text.slice(0, 120));
      }
    }
  }
  // safety net (Nic, Oct 31): a text that promises a call from us must have a booking behind it, or it is blocked (Carolyn Tanner went out with no booking)
  // Nov 3 (Viviana Mendoza): "what's a good time to call you?" is a question, not a promise - only statements are blocked
  if (!g && !j.book_at && /\b(we'?ll call|we will call|i'?ll call|i will call|(we'?ll |i'?ll )?(give you a call|call you) (at|today|tomorrow|tonight|this (morning|afternoon|evening)|saturday|sunday|monday|tuesday|wednesday|thursday|friday|at \d|in \d)|call at \d|from this number)\b/i.test(text.replace(/[^.!?]*\?/g, ""))) g = "promised a call with no booking";
  // sender (Nic, Oct 21): decided in code by isNicSender - Nic's lead + touched/called in 7 days, or CONTRACT THIS MONTH
  const asWho = nicSender ? "nic" : "tom";
  if (asWho === "nic") text = text.replace(/\bTom\b/g, "Nic");
  // booking rep (Nic, Oct 21): Untouched / Attempt Made / No Reply always book with BT; every later stage books with the lead owner (Nic -> nic, BT or unassigned -> bt)
  const bookRep: "nic" | "bt" = SILENT.has(lead.stage_id) ? "bt" : lead.assigned_to === NIC ? "nic" : "bt";
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
  // Oct 28 (Woolery Allen): a real call (>=45s) in the last 3 days stands Tom down even if the rep dialed again since (the dials used to overwrite it)
  const repCallAt = lead.last_rep_call_at ? new Date(lead.last_rep_call_at).getTime() : 0;
  const repSms = repAt && Date.now() - repAt < days(2) && inAt < repAt && lead.last_rep_touch?.startsWith("sms");
  const repCall = repCallAt && Date.now() - repCallAt < days(3) && inAt < repCallAt && (lead.last_rep_call_sec ?? 0) >= 45;
  const repLive = repSms || repCall;
  if (repLive && action === "text") { const t = Math.max(repAt, repCallAt); action = "wait"; j.wait_until = iso(new Date(t + days(3))); j.reason = "rep is live on it (" + (repCall ? `call ${lead.last_rep_call_sec}s ${Math.round((Date.now() - repCallAt) / 36e5)}h ago` : lead.last_rep_touch) + ")"; }
  // never stack texts: 30 min minimum after our last outbound unless the seller wrote back since
  const outAt = lead.last_out_at ? new Date(lead.last_out_at).getTime() : 0;
  if ((action === "text" || action === "closing") && outAt && Date.now() - outAt < 30 * 60e3 && inAt < outAt) { action = "wait"; j.wait_until = iso(new Date(outAt + 3600e3)); j.reason = "we texted them " + Math.round((Date.now() - outAt) / 60e3) + " min ago, no reply yet"; }
  // Nov 3 (Denna Morris 11:25pm form, Renell 12:57am): a brand-new lead that has NEVER been texted always gets the intro text drafted
  // now. The model used to answer "wait - outside hours, send in the morning", and clampWait then pushed it a full day. Hours are the
  // sender's job (not_before holds the draft until the seller's legal window opens), never a reason to skip the first touch.
  if (action !== "text" && action !== "flag" && SILENT.has(lead.stage_id) && !lead.last_out_at && !lead.dnd_sms && !lead.unsub && !repLive) {
    const first = String(lead.first_name || String(lead.name ?? "").split(" ")[0] || "").trim();
    const hi = first ? `Hey ${first}, ` : "Hey, ";
    const who = asWho === "nic" ? "Nic" : "Tom";
    if (!text || !/clear path/i.test(text)) {
      text = lead.lang === "es"
        ? `${hi}soy ${who} de Clear Path. Acabo de recibir su formulario${lead.address ? ` sobre ${lead.address}` : ""}. ¿Me confirma que este es el número correcto para contactarle?`
        : `${hi}this is ${who} with Clear Path. I just received your form${lead.address ? ` about ${lead.address}` : " about selling your property"}. Can you confirm this is the right number to reach you?`;
    }
    g = guard(text, lead, (lead.notes_text ?? "") + " " + user);
    j.book_at = null; j.why_now = null;
    j.reason = "first touch on a new lead - always drafted; the sender holds it until legal hours (model said: " + String(j.reason ?? "").slice(0, 120) + ")";
    action = "text";
    await log(lead.contact_id, "first_touch_forced", (g ? "blocked (" + g + "): " : "") + text.slice(0, 120));
  }
  // Nov 3 (Lorri Mcminn): a silent-stage lead who has never replied is on Nic's fixed sequence. If the model wants to wait when the
  // cadence says it's time, it gets one re-ask with the cadence spelled out; if it still won't, the lead is re-looked at in 2 hours
  // (never clamped to a day).
  let shortWait = false;
  if (action !== "text" && action !== "flag" && SILENT.has(lead.stage_id) && neverReplied(lead) && lead.last_out_at && !repLive && !lead.dnd_sms && !lead.unsub && outAt && Date.now() - outAt >= 30 * 60e3) {
    const dayN = silentDay(lead);
    const rr = await claude(s.model, sys, user + `\n\nYour answer was "${action}" (${String(j.reason ?? "").slice(0, 160)}). This seller submitted a form ${dayN} day(s) ago and has NEVER replied. Nic's rule for silent form leads is a fixed cadence - days 1-2: 3 texts a day, days 3-7: 2 a day, days 8-14: 1 a day, days 15-29: every 3 days, then weekly - and a lead is never dropped. Texting hours are not your concern: the sender holds every text until the seller's legal window. It is time for the next follow-up now. Write it: 1-3 short sentences, name the street, make clear we're the buyer for the property they're selling, one question - ask for a time to call. Do not reuse wording already in the thread. action must be "text". JSON only.`);
    const jr = parseJson(rr.text);
    if (jr?.text && String(jr.action ?? "text") === "text") {
      text = asNic(String(jr.text).replace(/—|–/g, " - ").replace(/\s{2,}/g, " ").trim()); g = guard(text, lead, (lead.notes_text ?? "") + " " + user);
      if (jr.reason) j.reason = jr.reason; if (jr.context) j.context = jr.context; if (jr.facts) j.facts = jr.facts; j.book_at = jr.book_at ?? null; j.why_now = jr.why_now ?? null;
      action = "text";
    } else shortWait = true;
    await log(lead.contact_id, "silent_cadence_redraft", `day ${dayN}: ` + (action === "text" ? (g ? "blocked (" + g + "): " : "ok: ") + text.slice(0, 120) : "model still won't text - re-look in 2h"));
  }
  // window + FL/OK cap
  const liveReply = !!inAt && Date.now() - inAt < 3600e3;   // seller texted in the last hour -> may answer from 8am
  let notBefore = drift(nextOpen(now(), lead.state, liveReply));
  if (["FL", "OK"].includes(String(lead.state ?? "").toUpperCase())) {
    const { count } = await sb.from("tom_drafts").select("id", { count: "exact", head: true }).eq("contact_id", lead.contact_id).eq("status", "sent").gte("sent_at", iso(new Date(Date.now() - days(1))));
    if ((count ?? 0) >= 3) notBefore = drift(nextOpen(new Date(Date.now() + days(1)), lead.state, false));
  }
  const waitUntil = j.wait_until ? new Date(j.wait_until) : null;
  const clampWait = (d: Date | null, def: number) => { const t = d && !isNaN(d.getTime()) ? d.getTime() : Date.now() + days(def); return iso(new Date(Math.min(Math.max(t, Date.now() + days(1)), Date.now() + days(42)))); };
  const result: any = { action, as_who: asWho, channel, text, guard: g, reason: j.reason ?? null, context: j.context ?? null, book_at: j.book_at ?? null, why_now: j.why_now ?? null, wait_until: j.wait_until ?? null, facts: j.facts ?? null, cost, usage: r.usage, not_before: iso(notBefore) };
  if (!store) return result;
  const leadUpd: any = { facts: j.facts ?? lead.facts, facts_at: iso(now()), updated_at: iso(now()) };
  if ((action === "text" || action === "closing") && !g) {
    const kind = action === "closing" ? "closing" : (inAt && inAt > (lead.last_out_at ? new Date(lead.last_out_at).getTime() : 0)) ? "reply" : "nudge";
    const bookZone = zoneFromText(text) || tzOf(lead.state);   // seller named a zone -> that zone wins over the property's
    let bookAt = j.book_at ? bookInstant(String(j.book_at), bookZone) : null;
    if (j.book_at && !bookAt) await log(lead.contact_id, "booking_refused", "unreadable book_at: " + String(j.book_at).slice(0, 40));
    const f = j.facts ?? lead.facts ?? {}; const ask = Number(f.ask), mao = Number(f.mao);
    const pct = 1 + Number(s.book_mao_pct ?? 15) / 100;
    // proposing a time ("does 5:30 work?") is not a booking - book when the seller says yes to it
    if (bookAt && /\b(does|would|will|can|could|is)\b[^.?!]{0,60}\b(work|good|ok|okay|fine)\b[^.?!]{0,60}\?|\b(can|could|may) I call you (at|around)\b|te parece|le parece|está bien si|esta bien si/i.test(text)) { await log(lead.contact_id, "booking_deferred", "time proposed, not confirmed: " + text.slice(0, 100)); bookAt = null; }
    if (bookAt && lead.lang === "es") { await log(lead.contact_id, "booking_refused", "Spanish-speaking seller - never booked (Nic, Oct 27)"); bookAt = null; }
    if (bookAt && !SILENT.has(lead.stage_id) && !(ask > 0 && mao > 0 && ask <= mao * pct) && f.open_to_our_number !== true && f.strong_motivation !== true) { await log(lead.contact_id, "booking_refused", `ask=${f.ask} mao=${f.mao}: not within ${Math.round((pct - 1) * 100)}% of MAO and no strong motivation`); bookAt = null; }
    if (bookAt) { const l = local(bookAt, "America/Chicago"); if (l.hour < 9 || l.hour >= 20 || l.dow === 0 || bookAt.getTime() < Date.now() + (liveReply ? 3 : 25) * 60e3 || !windowOpen(bookAt, lead.state, true) || !windowOpen(new Date(bookAt.getTime() + 30 * 60e3), lead.state, true)) { await log(lead.contact_id, "booking_refused", "outside 9-8 CT Mon-Sat, outside the seller's legal hours, or less than 25 min out: " + iso(bookAt)); bookAt = null; } }
    let whyNow = weakWhy(j.why_now) ? null : String(j.why_now).trim().slice(0, 300);
    if (bookAt && !whyNow) { // a call a rep moved keeps the reason it was booked on
      const { data: prev } = await sb.from("tom_bookings").select("why_now").eq("contact_id", lead.contact_id).eq("status", "cancelled").not("why_now", "is", null).gte("created_at", iso(new Date(Date.now() - days(3)))).order("created_at", { ascending: false }).limit(1);
      if (prev?.[0]?.why_now) whyNow = "(rebooked) " + prev[0].why_now;
    }
    if (bookAt && !whyNow) { await log(lead.contact_id, "booking_refused", "no why_now - nothing shown to have changed since the last rep conversation"); bookAt = null; }
    // Nov 6 (Hope Sheree): the booking for 9am was refused (window/hours) but the text still went out promising "we'll call you at 9", so no 9am
    // reminder fired and the seller was left waiting. A text that CONFIRMS a call time never goes out unless the booking was actually made.
    const proposedOnly = /\b(does|would|will|can|could|is)\b[^.?!]{0,60}\b(work|good|ok|okay|fine)\b[^.?!]{0,60}\?|\b(can|could|may) I call you (at|around)\b/i.test(text);
    const confirmsTime = !bookAt && !proposedOnly && channel === "sms" && /\b(we'?ll|we will|I'?ll|I will|i can|we can)\s+(call|ring|give you a call|reach you|get you a call)\b[^.?!]{0,60}\b(at|around)\s+\d{1,2}|\b(call|calling) (you )?(friday|monday|tuesday|wednesday|thursday|saturday|tomorrow|today|tonight)\b[^.?!]{0,30}\b(at|around)\s+\d{1,2}/i.test(text);
    if (confirmsTime) {
      await sb.from("tom_drafts").insert({ contact_id: lead.contact_id, name: lead.name, address: lead.address, stage: lead.stage, kind: "nudge", channel, as_who: asWho, text, reason: j.reason ?? null, context: j.context ?? null, thread_tail, status: "blocked", guard: "confirms a call time but the booking was refused", model: s.model, cost_usd: cost, run_id: runId });
      await log(lead.contact_id, "time_confirm_blocked", "text confirms a call time but no booking exists: " + text.slice(0, 120));
      leadUpd.next_due_at = iso(new Date(Date.now() + 2 * 3600e3));
      await pingNic(s, `Tom Bot: ${lead.name ?? "seller"} (${lead.address ?? "?"}) wants a call time Tom could not book ("${text.slice(0, 80)}"). NOT texted - please set the time yourself.`, lead.contact_id);
    } else {
    const { error } = await sb.from("tom_drafts").insert({ contact_id: lead.contact_id, name: lead.name, address: lead.address, stage: lead.stage, kind, channel, as_who: asWho, text, subject: channel === "email" ? (j.subject || `Your house at ${lead.address ?? ""}`) : null, reason: j.reason ?? null, context: j.context ?? null, thread_tail, status: "pending", not_before: iso(notBefore), book_at: bookAt ? iso(bookAt) : null, why_now: bookAt ? whyNow : null, book_rep: bookRep, model: s.model, tokens_in: r.usage.input_tokens ?? null, tokens_out: r.usage.output_tokens ?? null, cost_usd: cost, run_id: runId });
    if (error) await log(lead.contact_id, "draft_error", error.message);
    leadUpd.next_due_at = clampWait(waitUntil, 4); // re-looked at after the text goes (send moves it again)
    if (bookAt && s.ping_on_booking !== false) await pingNic(s, `Tom Bot: ${lead.name ?? "seller"} (${lead.address ?? "?"}) gave a call time - ${bookAt.toLocaleString("en-US", { timeZone: "America/Chicago", weekday: "short", hour: "numeric", minute: "2-digit" })} CT. Approve the draft in the queue to lock it.`, lead.contact_id);
    // Nov 6 (Sharon Simmons): seller texted "contact me asap ... go ahead with selling" and Tom only proposed times; no booking, no ping, Nic never knew.
    // A hot reply (asap / go ahead / call me) with no booked call always pings Nic, even with per-reply pings off.
    else if (kind === "reply" && /\b(asap|a\.s\.a\.p|go ahead|ready to sell|let'?s do it|call me|contact me|give me a call|when can you call|accept|yes or no|a yes|need an answer|your answer|final offer|best you can do|best price|too low|lowball|penny)\b/i.test(String(lead.last_in_body ?? ""))) await pingNic(s, `Tom Bot: HOT - ${lead.name ?? "seller"} (${lead.address ?? "?"}) texted "${String(lead.last_in_body ?? "").slice(0, 120)}". No call is booked - call now.`, lead.contact_id);
    else if (kind === "reply" && s.ping_on_reply === true) await pingNic(s, `Tom Bot: ${lead.name ?? "seller"} (${lead.address ?? "?"}) texted "${String(lead.last_in_body ?? "").slice(0, 80)}". Draft is waiting for your yes.`, lead.contact_id);
    }
  } else if ((action === "text" || action === "closing") && g) {
    await sb.from("tom_drafts").insert({ contact_id: lead.contact_id, name: lead.name, address: lead.address, stage: lead.stage, kind: "nudge", channel, as_who: asWho, text, reason: j.reason ?? null, context: j.context ?? null, thread_tail, status: "blocked", guard: g, model: s.model, cost_usd: cost, run_id: runId });
    // Oct 28: a blocked draft is re-looked at in 2 hours, not tomorrow, and if the seller is waiting on a reply Nic hears about it
    leadUpd.next_due_at = iso(new Date(Date.now() + 2 * 3600e3));
    await log(lead.contact_id, "blocked", g + " :: " + text.slice(0, 120));
    if (inAt && inAt > (lead.last_out_at ? new Date(lead.last_out_at).getTime() : 0) && s.ping_on_important !== false) await pingNic(s, `Tom Bot: ${lead.name ?? "seller"} (${lead.address ?? "?"}) texted "${String(lead.last_in_body ?? "").slice(0, 80)}" and Tom could not answer it (${g}). Needs you.`, lead.contact_id);
  } else if (action === "flag") {
    await sb.from("tom_drafts").insert({ contact_id: lead.contact_id, name: lead.name, address: lead.address, stage: lead.stage, kind: "flag", channel, as_who: asWho, text: text || "(no text)", reason: j.reason ?? null, context: j.context ?? null, thread_tail, status: "pending", model: s.model, cost_usd: cost, run_id: runId });
    leadUpd.next_due_at = clampWait(waitUntil, 7);
  } else if (action === "skip") {
    leadUpd.next_due_at = clampWait(waitUntil, 2);
    await log(lead.contact_id, "skip", String(j.reason ?? ""));
  } else { // wait
    // Oct 28 (Jose Lemus, Patricia Durkin - Nic: "not being texted but should"): Tom's waits ran 2-3 weeks on worked leads. Cap them:
    // hot / distressed / in-conversation stages 7 days, Offer Rejected 14, everything else 21. The model can always pick shorter.
    const weekly = new Set([ST.contractMonth, ST.inConv, ST.distressed, ST.interested, ST.competitor, ST.coldCall, ST.sTier]);
    const capDays = weekly.has(lead.stage_id) ? 7 : lead.stage_id === ST.rejected ? 14 : 21;
    const w = clampWait(waitUntil, 5); const capped = iso(new Date(Date.now() + days(capDays)));
    leadUpd.next_due_at = w < capped ? w : capped;
    if (shortWait) leadUpd.next_due_at = iso(new Date(Date.now() + 2 * 3600e3)); // Nov 3: silent lead on cadence - never a day
    else if (SILENT.has(lead.stage_id) && neverReplied(lead) && !repLive) { const c = iso(new Date(Date.now() + silentGapMs(silentDay(lead)))); if (c < leadUpd.next_due_at) leadUpd.next_due_at = c; }
    await log(lead.contact_id, "wait", `until ${leadUpd.next_due_at.slice(0, 10)}: ${String(j.reason ?? "")}`);
  }
  await sb.from("tom_leads").update(leadUpd).eq("contact_id", lead.contact_id);
  // Who hears about this reply (Nic, Oct 16):
  //  - a seller reply on a FRESH lead (Attempt Made / No Reply inbound) -> Nic AND BT, every time
  //  - otherwise only when IMPORTANT -> the rep who owns the lead (Nic's lead -> Nic, BT's or unassigned -> BT)
  //  - routine replies on worked leads -> nobody. Devon's dispo alerts are a separate system.
  if (s.ping_on_important !== false) {
    const said = String(lead.last_in_body ?? "").replace(/\s+/g, " ").slice(0, 110);
    const did = action === "text" && !g ? `Tom replied: "${text.slice(0, 110)}"` : action === "wait" ? "Tom is holding off." : action === "flag" ? "Tom flagged it for you." : "";
    const sellerWaiting = inAt && inAt > outAt && Date.now() - inAt < days(14);
    const freshStage = lead.stage_id === ST.attempt || lead.stage_id === ST.noReply;
    if (freshStage && sellerWaiting) {
      const msg = `Tom: NEW REPLY (${lead.stage}) ${lead.name ?? "seller"} - ${lead.address ?? "?"}. They said: "${said}". ${did}`.slice(0, 480);
      await pingRep(s, s.nic_cell, msg, lead.contact_id); await pingRep(s, s.bt_cell, msg, lead.contact_id);
    } else if (j.important === true) {
      // the model's "important" is only honored when the facts back it: a number in range / yes to our offer / hard date / strong motivation, or the seller wants a human, is angry, or says bot (Nic, Oct 16: "seller asked what our offer was" is not important)
      const fi = j.facts ?? lead.facts ?? {}; const askI = Number(fi.ask), maoI = Number(fi.mao); const pctI = 1 + Number(s.book_mao_pct ?? 15) / 100;
      const why = String(j.important_why ?? "");
      const backed = (askI > 0 && maoI > 0 && askI <= maoI * pctI) || fi.open_to_our_number === true || fi.strong_motivation === true
        || (fi.event_date && new Date(fi.event_date).getTime() - Date.now() < days(30) && new Date(fi.event_date).getTime() > Date.now() - days(2))
        || /\b(bot|robot|automated|real person|human|lawyer|attorney|legal|sue|harass|complain|angry|furious|scam)\b/i.test(why + " " + said);
      const cell = lead.assigned_to === NIC ? s.nic_cell : s.bt_cell;
      const { count: recent } = await sb.from("tom_log").select("id", { count: "exact", head: true }).eq("event", "ping").like("detail", cell + " Tom: %").not("detail", "like", cell + " Tom: NEW REPLY%").gte("at", iso(new Date(Date.now() - 3600e3)));
      if (!backed) await log(lead.contact_id, "ping_suppressed", "not backed by facts: " + why.slice(0, 160));
      else if ((recent ?? 0) >= 2) await log(lead.contact_id, "ping_suppressed", "rep already had 2 important pings this hour: " + why.slice(0, 120));
      else await pingRep(s, cell, `Tom: ${lead.name ?? "seller"} - ${lead.address ?? "?"} - ${why.slice(0, 120) || "needs a look"}. They said: "${said}". ${did}`.slice(0, 480), lead.contact_id);
    }
  }
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
  // Nic Oct 21: Tom owns ALL acq leads - also work the never-checked backlog, oldest first, so old leads (e.g. Jacob Dusseau, stage changed in May) aren't starved by newer ones
  const { data: stale } = await base().is("next_due_at", null).order("stage_changed_at", { ascending: true, nullsFirst: true }).limit(20);
  const mixed: any[] = []; for (let i = 0; i < Math.max((fresh ?? []).length, (stale ?? []).length); i++) { if (fresh?.[i]) mixed.push(fresh[i]); if (stale?.[i]) mixed.push(stale[i]); }
  const list: any[] = []; const seen = new Set<string>();
  // "waiting" = seller texted last AND Tom hasn't assessed that text yet (assessed-and-waiting leads come back via `due` when their wait ends)
  const unassessedReply = (l: any) => (!l.last_out_at || new Date(l.last_in_at) > new Date(l.last_out_at)) && !(l.facts_at && new Date(l.facts_at) > new Date(l.last_in_at));
  for (const l of [...(waiting ?? []).filter(unassessedReply), ...(due ?? []), ...mixed]) if (!seen.has(l.contact_id) && !busy.has(l.contact_id) && !(l.hold_until && new Date(l.hold_until) > now())) { seen.add(l.contact_id); list.push(l); }
  // cost control: when 40+ real drafts are waiting to go out, only seller replies get drafted.
  // Oct 26: flags are Nic's to read, not texts waiting to send - they never auto-send or expire, so they must not count or they strangle the queue.
  const { count: backlog } = await sb.from("tom_drafts").select("id", { count: "exact", head: true }).in("status", ["pending", "approved"]).neq("kind", "flag");
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
async function pingNic(s: any, text: string, cid: string | null) { await pingRep(s, s.nic_cell, text, cid); }
// one text to a rep's cell; at most one per lead per 2 hours
async function pingRep(s: any, cell: string, text: string, cid: string | null) {
  if (!cell) return;
  if (cid) { const { data } = await sb.from("tom_log").select("id").eq("contact_id", cid).eq("event", "ping").like("detail", cell + " %").gte("at", iso(new Date(Date.now() - 2 * 3600e3))).limit(1); if (data?.length) return; }
  const err = await sendText(s.alert_from, cell, text);
  await log(cid, err ? "ping_error" : "ping", cell + " " + (err ?? text.slice(0, 200)));
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
  const liveNow = !!lead.last_in_at && Date.now() - new Date(lead.last_in_at).getTime() < 3600e3;
  if (!windowOpen(now(), lead.state, liveNow || by !== "cron")) { const nb = iso(drift(nextOpen(now(), lead.state, liveNow))); await back({ status: "approved", not_before: nb }); return { ok: true, queued: nb }; }
  // never stack: if we texted this lead in the last 30 min and they have not replied since, push this one out
  const lo = lead.last_out_at ? new Date(lead.last_out_at).getTime() : 0, li = lead.last_in_at ? new Date(lead.last_in_at).getTime() : 0;
  if (lo && Date.now() - lo < 30 * 60e3 && li < lo && d.kind !== "closing") { const nb = iso(new Date(lo + 30 * 60e3)); await back({ status: "approved", not_before: nb }); return { ok: true, queued: nb }; }
  if (lead.hold_until && new Date(lead.hold_until) > now()) { await back({ status: "expired", guard: "lead on hold" }); return { ok: false, err: "hold" }; }
  // one text per seller per 2 minutes, whatever produced it (two thinkers drafting the same reply, or two senders)
  const { data: justSent } = await sb.from("tom_drafts").select("id").eq("contact_id", lead.contact_id).neq("id", d.id).or(`status.eq.sending,sent_at.gte.${iso(new Date(Date.now() - 2 * 60e3))}`).limit(1);
  if (justSent?.length) { await back({ status: "expired", guard: "duplicate: another text went out in the last 2 min" }); await log(lead.contact_id, "dup_blocked", d.text.slice(0, 120)); return { ok: false, err: "duplicate" }; }
  // stale: the seller wrote since this was drafted, or it has sat 2 days - the thinker will look again with fresh context
  if (li && li > new Date(d.created_at).getTime()) { await back({ status: "expired", guard: "seller texted after this was drafted" }); return { ok: false, err: "stale" }; }
  if (Date.now() - new Date(d.created_at).getTime() > days(2)) { await back({ status: "expired", guard: "drafted more than 2 days ago" }); return { ok: false, err: "stale" }; }
  const r = await ghlSend(lead, d);
  if (!r.ok) {
    const unsub = /UNSUBSCRIBED|DND_ACTIVE/i.test(r.err ?? "");
    await sb.from("tom_drafts").update({ status: "failed", error: r.err }).eq("id", d.id);
    if (unsub) await sb.from("tom_leads").update({ unsub: true, dnd_sms: true }).eq("contact_id", lead.contact_id);
    await log(lead.contact_id, "send_failed", r.err ?? "");
    return { ok: false, err: r.err };
  }
  await sb.from("tom_drafts").update({ status: "sent", sent_at: iso(now()), ghl_message_id: r.id, paced: d.paced === true }).eq("id", d.id);
  if (r.id) await sb.from("acq_lead_msgs").upsert({ id: r.id, contact_id: lead.contact_id, at: iso(now()), direction: "outbound", kind: d.channel === "email" ? "email" : "sms", body: d.text, status: "sent", source: "tom", fetched_at: iso(now()) }, { onConflict: "id" });
  // Oct 28 (James Davis, Nic: "it should be texting following up but hasn't been"): a hot lead (offer on the table, Contract This
  // Month, or a rep task due in the next 3 days) gets re-looked at 2 days after a nudge, not 5.
  const hot = lead.stage_id === ST.contractMonth || /CONTRACT THIS MONTH/i.test(String(lead.stage ?? "")) || (lead.stage_id === ST.inConv && Number(lead.facts?.offer) > 0) || (lead.open_task_due && new Date(lead.open_task_due).getTime() - Date.now() < days(3));
  const recheck = d.kind === "reply" ? (hot ? 2 : 3) : (hot ? 2 : 5);
  // Nov 3 (Lorri Mcminn): a silent form lead who has never replied comes back on Nic's sequence clock (hours on days 1-7), not in 5 days
  const gapMs = SILENT.has(lead.stage_id) && neverReplied(lead) && (d.kind !== "reply" || !lead.last_in_at) ? silentGapMs(silentDay(lead)) : days(recheck);
  await sb.from("tom_leads").update({ last_out_at: iso(now()), last_out_by: "tom", next_due_at: iso(new Date(Date.now() + gapMs)), updated_at: iso(now()) }).eq("contact_id", lead.contact_id);
  await bumpUsage("tom_send", 1);
  await log(lead.contact_id, "sent", `${d.channel} as ${d.as_who} by ${by}: ${d.text.slice(0, 160)}`);
  if (d.book_at) {
    // Nic (Oct 30): leads in Untouched / Attempt Made / No Reply book for BOTH Nic and BT; later stages keep the single owner rep
    const reps: ("nic" | "bt")[] = SILENT.has(lead.stage_id) ? ["nic", "bt"] : [d.book_rep === "bt" ? "bt" : "nic"];
    const when = new Date(d.book_at).toLocaleString("en-US", { timeZone: "America/Chicago", weekday: "short", hour: "numeric", minute: "2-digit" });
    for (const rep of reps) {
      const cell = rep === "bt" ? s.bt_cell : s.nic_cell;
      await sb.from("tom_bookings").insert({ contact_id: lead.contact_id, name: lead.name, address: lead.address, phone: lead.phone, call_at: d.book_at, rep, rep_cell: cell, draft_id: d.id, why_now: d.why_now ?? null, alert_booked_at: iso(now()) });
      await sendText(s.alert_from, cell, `🔵 Booked: ${lead.name ?? "seller"} - ${lead.address ?? ""} - call ${when} CT (they're expecting it). ${lead.phone ?? ""}\nWhy this time: ${d.why_now ?? "see notes"}`.slice(0, 600)); // Nov 5 (Nic): blue = future appointment, red = now
    }
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
  // daily cap = calendar day, Central time. Checked once per run; when hit, nothing is claimed and the queue simply waits for tomorrow.
  const ct = local(now(), "America/Chicago"); const dayStart = fromLocal(`${ct.ymd}T00:00`, "America/Chicago")!;
  const { count: sentToday } = await sb.from("tom_drafts").select("id", { count: "exact", head: true }).eq("status", "sent").gte("sent_at", iso(dayStart));
  if ((sentToday ?? 0) >= Number(s.daily_cap ?? 300)) { out.capped = sentToday; return out; }
  // pace like a person: a live reply (seller texted in the last 14 days and is waiting) goes now; everything else at most `nudge_per_hour` (default 30), spread out
  const rate = Number(s.nudge_per_hour ?? 30);
  const { count: nHour } = await sb.from("tom_drafts").select("id", { count: "exact", head: true }).eq("status", "sent").eq("paced", true).gte("sent_at", iso(new Date(Date.now() - 3600e3)));
  const { count: nTen } = await sb.from("tom_drafts").select("id", { count: "exact", head: true }).eq("status", "sent").eq("paced", true).gte("sent_at", iso(new Date(Date.now() - 600e3)));
  let nudgeRoom = ((nHour ?? 0) < rate && (nTen ?? 0) < Math.ceil(rate / 6)) ? 1 : 0;
  const { data: ready } = await sb.from("tom_drafts").select("*").eq("status", "approved").lte("not_before", iso(now())).order("approved_at", { ascending: true }).limit(200);
  const ids = [...new Set((ready ?? []).map((d: any) => d.contact_id))];
  const { data: ls } = ids.length ? await sb.from("tom_leads").select("contact_id,last_in_at,last_out_at,form_at").in("contact_id", ids) : { data: [] as any[] };
  const lmap = new Map((ls ?? []).map((l: any) => [l.contact_id, l]));
  const live = (d: any) => { const l = lmap.get(d.contact_id); const li = l?.last_in_at ? new Date(l.last_in_at).getTime() : 0; const lo = l?.last_out_at ? new Date(l.last_out_at).getTime() : 0; const fresh = !!l?.form_at && Date.now() - new Date(l.form_at).getTime() < 3600e3; return d.kind === "closing" || fresh || (li > lo && Date.now() - li < days(14)); };
  const queue = [...(ready ?? []).filter(live), ...(ready ?? []).filter((d: any) => !live(d))];
  let sentNow = 0;
  for (const d of queue) {
    if (sentNow >= 10) break;
    const paced = !live(d);
    if (paced && nudgeRoom <= 0) continue;
    const r = await sendDraft({ ...d, text: d.nic_fix ?? d.text, paced }, s, d.approved_by ?? "cron");
    if (r.ok && r.queued) out.queued++; else if (r.ok) { out.sent++; sentNow++; if (paced) nudgeRoom--; } else out.failed++;
    await sleep(200);
  }
  // a run that died mid-send leaves 'sending' behind: never resend blind, mark it so a human can look
  await sb.from("tom_drafts").update({ status: "failed", error: "lost in flight (run died after claim)" }).eq("status", "sending").lt("approved_at", iso(new Date(Date.now() - 10 * 60e3)));
  // pending drafts older than 3 days are stale: the situation has moved on
  await sb.from("tom_drafts").update({ status: "expired", guard: "not approved within 3 days" }).eq("status", "pending").lt("created_at", iso(new Date(Date.now() - days(3))));
  return out;
}

// ---------- NEW LEAD (Oct 27): form -> text in one call ----------
async function newLeadJob(b: any) {
  const cid = String(b.contact_id || ""); if (!cid) return { ok: false, err: "contact_id?" };
  const t0 = Date.now(); const s = await settings();
  const r = await ghl(`/opportunities/search?location_id=${LOC}&contact_id=${encodeURIComponent(cid)}&status=open&limit=10`);
  const opps: any[] = (r.body?.opportunities ?? []).filter((o: any) => o.pipelineId === ACQ);
  const o = opps.sort((x, y) => String(y.createdAt).localeCompare(String(x.createdAt)))[0];
  if (!o) { await log(cid, "new_lead", "no open ACQ opportunity yet"); return { ok: false, err: "no open ACQ opportunity for contact" }; }
  const sid = o.pipelineStageId;
  const stageNames = new Map<string, string>(); const pl = await ghl(`/opportunities/pipelines?locationId=${LOC}`);
  for (const p of pl.body?.pipelines ?? []) for (const st of p.stages ?? []) stageNames.set(st.id, st.name);
  const mode = SILENT.has(sid) ? "silent" : JUDGMENT.has(sid) ? "judgment" : "off";
  const { seller, address } = splitName(o.name || "");
  await sb.from("tom_leads").upsert({
    contact_id: cid, opp_id: o.id, pipeline_id: ACQ, stage_id: sid, stage: stageNames.get(sid) ?? sid,
    name: seller || o.contact?.name || null, first_name: (seller || o.contact?.name || "").split(/\s+/)[0] || null,
    address: address || null, phone: e164(o.contact?.phone) || null, email: o.contact?.email || null,
    assigned_to: o.assignedTo || null, assigned_name: REPS[o.assignedTo] ?? null,
    mode, tags: o.contact?.tags ?? [], form_at: o.createdAt, stage_changed_at: o.lastStageChangeAt || null,
    synced_at: iso(now()), updated_at: iso(now()),
  }, { onConflict: "contact_id" });
  if (mode === "off") return { ok: true, skipped: "stage not worked" };
  await refreshLead(cid);
  const { data: lead } = await sb.from("tom_leads").select("*").eq("contact_id", cid).single();
  if (!lead || lead.under_contract || lead.unsub || lead.dnd_sms) return { ok: true, skipped: "dnd/unsub/contract" };
  // the webhook can fire twice and the 5-min sync may have beaten us: one draft per lead
  const { data: recent } = await sb.from("tom_drafts").select("id,status").eq("contact_id", cid).gte("created_at", iso(new Date(Date.now() - 2 * 3600e3))).limit(1);
  if (recent?.length) return { ok: true, skipped: "already drafted", draft: recent[0] };
  if (!s.drafting) return { ok: true, skipped: "drafting off" };
  const { data: got } = await sb.from("tom_leads").update({ facts_at: iso(now()) }).eq("contact_id", cid).or(`facts_at.is.null,facts_at.lt.${iso(new Date(Date.now() - 3 * 60e3))}`).select("contact_id");
  if (!got?.length) return { ok: true, skipped: "another thinker has it" };
  const res = await think(lead, s, true, "new-lead-" + iso(now()).slice(0, 16));
  await log(cid, "new_lead", `${Math.round((Date.now() - t0) / 1000)}s form->draft: ${res.action}${res.guard ? " (blocked: " + res.guard + ")" : ""} ${String(res.text ?? "").slice(0, 100)}`);
  let sent: any = null;
  if (res.action === "text" && !res.guard) sent = await sendJob({}, "cron");
  return { ok: true, ms: Date.now() - t0, action: res.action, guard: res.guard, text: res.text, not_before: res.not_before, sent };
}

async function alertsJob() {
  const s = await settings();
  const { data: open } = await sb.from("tom_bookings").select("*").eq("status", "open").lte("call_at", iso(new Date(Date.now() + 6 * 60e3)));
  let pinged = 0;
  for (const bk of open ?? []) {
    // Nov 5 (Nic: "a red fire alarm"): red CALL IN N MIN at the 5-minute mark, then a red CALL NOW on the minute. Blue = future booking.
    const when = new Date(bk.call_at).toLocaleString("en-US", { timeZone: "America/Chicago", hour: "numeric", minute: "2-digit" });
    const minsLeft = Math.ceil((new Date(bk.call_at).getTime() - Date.now()) / 60e3);
    const who = `${bk.name ?? "seller"} - ${bk.address ?? ""} - ${bk.phone ?? ""}`;
    if (!bk.alert_5min_at && minsLeft > 1) {
      const err = await sendText(s.alert_from, bk.rep_cell || s.nic_cell, `🔴🔴🔴 CALL IN ${minsLeft} MIN 🔴🔴🔴\n${who}\n${when} CT - they're expecting your call${bk.why_now ? `\nWhy this time: ${bk.why_now}` : ""}`.slice(0, 600));
      await sb.from("tom_bookings").update({ alert_5min_at: iso(now()) }).eq("id", bk.id); await log(bk.contact_id, err ? "alert_error" : "alert_5min", err ?? when); pinged++;
    }
    if (!bk.alert_now_at && minsLeft <= 1 && minsLeft > -10) {
      const err = await sendText(s.alert_from, bk.rep_cell || s.nic_cell, `🚨🔴 CALL NOW 🔴🚨\n${who}\n${when} CT - they're expecting your call`.slice(0, 600));
      await sb.from("tom_bookings").update({ alert_now_at: iso(now()), alert_5min_at: bk.alert_5min_at ?? iso(now()) }).eq("id", bk.id); await log(bk.contact_id, err ? "alert_error" : "alert_now", err ?? when); pinged++;
    }
    if (new Date(bk.call_at).getTime() < Date.now() - 45 * 60e3) await sb.from("tom_bookings").update({ status: "done" }).eq("id", bk.id);
  }
  return { ok: true, pinged };
}

// ---------- REP INBOX: Nic/BT text the Quo alert line back ("can't make it", "push it to 3pm") ----------
const CANT_RX = /can'?t make|cannot make|can'?t do|won'?t make|not going to make|not gonna make|reschedul|cancel|push (it|the call|that)|move (it|the call|that)|running late|no show/i;
function parseNewTime(t: string): { label: string; at: Date | null } | null {
  const m = t.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)\b/i) ?? t.match(/\b(?:at|to)\s+(\d{1,2})(?::(\d{2}))?\b/i);
  if (!m) return null;
  let h = Number(m[1]); const min = Number(m[2] ?? 0); const ap = (m[3] ?? "").toLowerCase().replace(/\./g, "");
  if (ap === "pm" && h < 12) h += 12; if (ap === "am" && h === 12) h = 0;
  if (!ap && h < 8) h += 12; // "at 3" means 3pm for a 9-8 team
  const tomorrow = /tomorrow|tmrw|tmw/i.test(t);
  const ct = local(now(), "America/Chicago"); const base = fromLocal(`${ct.ymd}T00:00`, "America/Chicago")!;
  const at = new Date(base.getTime() + (tomorrow ? 864e5 : 0) + h * 3600e3 + min * 60e3);
  const label = `${((h + 11) % 12) + 1}${min ? ":" + String(min).padStart(2, "0") : ""}${h >= 12 ? "pm" : "am"}${tomorrow ? " tomorrow" : ""}`;
  return { label, at };
}
async function inboxJob() {
  const s = await settings();
  if (!OPENPHONE) return { ok: false, err: "no OPENPHONE_API_KEY" };
  if (!opFromCache || opFromCache.number !== s.alert_from) {
    const nR = await fetch("https://api.openphone.com/v1/phone-numbers", { headers: { Authorization: OPENPHONE } });
    const nums = ((await nR.json().catch(() => ({}))).data ?? []) as any[];
    const mine = nums.find((n) => n.number === s.alert_from) || nums[0]; if (!mine) return { ok: false, err: "no OpenPhone number" };
    opFromCache = { id: mine.id, number: mine.number };
  }
  const out: any[] = [];
  for (const rep of [{ rep: "nic", cell: s.nic_cell, name: "Nic" }, { rep: "bt", cell: s.bt_cell, name: "BT" }]) {
    if (!rep.cell) continue;
    const r = await fetch(`https://api.openphone.com/v1/messages?phoneNumberId=${encodeURIComponent(opFromCache.id)}&participants=${encodeURIComponent(rep.cell)}&maxResults=10`, { headers: { Authorization: OPENPHONE } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { await log(null, "inbox_error", `${rep.rep} ${r.status} ${JSON.stringify(j).slice(0, 200)}`); continue; }
    for (const m of (j.data ?? []) as any[]) {
      if (m.direction !== "incoming") continue;
      if (Date.now() - new Date(m.createdAt).getTime() > 30 * 60e3) continue;
      const { data: seen } = await sb.from("tom_log").select("id").eq("event", "rep_msg").like("detail", `${m.id} %`).limit(1);
      if (seen?.length) continue;
      const text = String(m.text ?? m.body ?? "");
      await log(null, "rep_msg", `${m.id} ${rep.rep}: ${text.slice(0, 200)}`);
      if (!CANT_RX.test(text)) { out.push({ rep: rep.rep, text, action: "ignored" }); continue; }
      // the call they mean: this rep's open booking nearest to now (3h back .. 48h ahead)
      const { data: bks } = await sb.from("tom_bookings").select("*").eq("rep", rep.rep).eq("status", "open").gte("call_at", iso(new Date(Date.now() - 3 * 3600e3))).lte("call_at", iso(new Date(Date.now() + 48 * 3600e3))).order("call_at", { ascending: true });
      const bk = (bks ?? []).sort((a: any, b: any) => Math.abs(new Date(a.call_at).getTime() - Date.now()) - Math.abs(new Date(b.call_at).getTime() - Date.now()))[0];
      if (!bk) { await sendText(s.alert_from, rep.cell, "Tom: I don't see an upcoming booked call for you to move. Nothing changed."); out.push({ rep: rep.rep, text, action: "no booking" }); continue; }
      const { data: lead } = await sb.from("tom_leads").select("*").eq("contact_id", bk.contact_id).single();
      const when = new Date(bk.call_at).toLocaleString("en-US", { timeZone: "America/Chicago", hour: "numeric", minute: "2-digit" });
      const nt = parseNewTime(text);
      const first = lead?.first_name || "there";
      const sellerText = nt
        ? `Hey ${first}, it's Tom - something came up on our end and we can't make the ${when} call. Sorry about that. Could we do ${nt.label} instead?`
        : `Hey ${first}, it's Tom - something came up on our end and we can't make the ${when} call. Sorry about that. What's another time today or tomorrow that works for you?`;
      await sb.from("tom_bookings").update({ status: "cancelled" }).eq("id", bk.id);
      await sb.from("tom_drafts").insert({ contact_id: bk.contact_id, name: lead?.name ?? bk.name, address: lead?.address ?? bk.address, stage: lead?.stage ?? null, kind: "reply", channel: "sms", as_who: "tom", text: sellerText, reason: `${rep.name} texted the alert line: "${text.slice(0, 80)}" - call moved`, context: `${rep.name} can't make the ${when} call; Tom asked the seller for a new time${nt ? " and offered " + nt.label : ""}.`, status: "approved", approved_at: iso(now()), approved_by: rep.rep, not_before: iso(now()), model: "rule", cost_usd: 0 });
      await sb.from("tom_leads").update({ next_due_at: iso(new Date(Date.now() + 3600e3)), updated_at: iso(now()) }).eq("contact_id", bk.contact_id);
      await log(bk.contact_id, "booking_moved", `${rep.rep} can't make ${when}: "${text.slice(0, 100)}"${nt ? " -> offered " + nt.label : ""}`);
      await sendText(s.alert_from, rep.cell, `Tom: got it. ${when} call with ${lead?.name ?? bk.name} is off - I'm texting them now${nt ? ` and offering ${nt.label}` : " for a new time"}. I'll ping you when it's rebooked.`);
      out.push({ rep: rep.rep, text, action: "moved", booking: bk.id });
    }
  }
  return { ok: true, out };
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
      case "new_lead": r = await newLeadJob(b); break;
      case "alerts": r = await alertsJob(); break;
      case "inbox": r = await inboxJob(); break;
      case "lost": r = await lostJob(String(b.contact_id), by); break;
      case "preview": { const s = await settings(); const { data: lead } = await sb.from("tom_leads").select("*").eq("contact_id", b.contact_id).single(); if (!lead) { r = { ok: false, err: "no lead" }; break; } if (b.refresh) await refreshLead(lead.contact_id); const { data: l2 } = await sb.from("tom_leads").select("*").eq("contact_id", b.contact_id).single(); r = await think(l2, s, false); break; }
      case "refresh": r = { ok: true, res: await refreshLead(String(b.contact_id)) }; break;
      case "move_back": { // Oct 29 one-off: {moves:[{contact_id, stage_id}]} - put wrongly-moved In Conversation leads back (only if nobody spoke to them)
        const out: any[] = [];
        for (const m of b.moves ?? []) {
          const { data: l } = await sb.from("tom_leads").select("contact_id,opp_id,phone,stage_id").eq("contact_id", m.contact_id).single();
          if (!l?.opp_id || l.stage_id !== ST.inConv) { out.push({ cid: m.contact_id, skipped: "not in In Conversation" }); continue; }
          if (await spokeOnPhone(l.contact_id, l.phone)) { out.push({ cid: m.contact_id, skipped: "has a real call" }); continue; }
          const put = await ghl(`/opportunities/${l.opp_id}`, { method: "PUT", body: JSON.stringify({ pipelineStageId: m.stage_id }) });
          if (!put.ok) { out.push({ cid: m.contact_id, err: put.status }); continue; }
          await sb.from("tom_leads").update({ stage_id: m.stage_id, stage: m.stage ?? m.stage_id, mode: SILENT.has(m.stage_id) ? "silent" : "judgment", updated_at: iso(now()) }).eq("contact_id", l.contact_id);
          await log(l.contact_id, "stage_reverted", `In Conversation -> ${m.stage ?? m.stage_id}: texted us but nobody has spoken to them on the phone yet (one-off cleanup)`);
          await ghl(`/contacts/${l.contact_id}/notes`, { method: "POST", body: JSON.stringify({ body: `↩️ Moved back to ${m.stage ?? m.stage_id}: a text reply is not a conversation - In Conversation is for sellers we have spoken to on the phone (Nic, Oct 29).`, userId: "UvBSAHJwAJYCcaz9fc3v" }) });
          out.push({ cid: m.contact_id, ok: true });
        }
        r = { ok: true, out }; break;
      }
      default: r = { ok: false, err: "job?" };
    }
    return Response.json(r, { headers: CORS });
  } catch (e) {
    await log(null, "error", b.job + ": " + String(e));
    return Response.json({ ok: false, err: String(e).slice(0, 400) }, { headers: CORS });
  }
});
