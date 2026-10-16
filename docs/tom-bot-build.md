# Tom Bot — how it's built (Oct 15 2026)

Rulebook: `claude/acq-texter-tom-lessons.md` (v2). This file is the wiring. **Master switch is OFF. Claude never flips it.**

## Where things live (Supabase project `voitbqpvynbvlibuzxbz`)
- Edge function **`tom-bot`** (source in repo `functions/tom-bot/index.ts`). Jobs by POST body:
  - `{"job":"sync"}` — pages the open ACQ pipeline (2,640 opps → 2,104 in stages Tom works), CONTRACTS pipeline (under contract = off), then refreshes leads: contact (phone/email/DND/state), notes, tasks, full thread into `acq_lead_msgs`, transcripts for the 2 newest rep calls ≥45s. Derives last seller text, last rep touch/call, open task, Spanish, opt-outs (STOP regex → dnd_sms + pending drafts expired).
  - `{"job":"think","limit":5}` — seller-waiting leads first, then `next_due_at` due, then never-assessed. Claude (model in `tom_settings.model`, default claude-sonnet-5) reads the full packet + the brief + `tom_training` lessons → JSON: text / wait / skip / flag / closing. Code guards after the model: no BT, no agents/listing/market, no rent-back, no identity claims, banned phrases, no repairs-before-closing, **no dollar figure that isn't already in the notes/thread** (one retry), as-Nic only if Nic owns it and touched it ≤2.5 days ago, DND → one email max, rep live in last 2 days → wait, property-state send window (TX 9–9 / Sun noon–9, else 8–9 local), FL/OK 3 per 24h, drifted minutes. When 40+ non-reply drafts are pending (`max_backlog`), only seller replies get drafted (cost control).
  - `{"job":"send"}` (cron, every minute) — sends `approved` drafts whose window is open via GHL `POST /conversations/messages`. **If `tom_settings.enabled` is true, pending drafts auto-approve** — that is the master switch. Pending drafts expire after 3 days.
  - `{"job":"send","draft_id":N,"text":"edited"}` — Nic's yes from the page; an edited text is saved to `tom_training` (bad → fix).
  - `{"job":"skip","draft_id":N,"reason":"..."}` — Nic's no; reason becomes a lesson in the brief.
  - `{"job":"alerts"}` (cron, every minute) — 5-min-before text to the rep from the Quo Dallas line for `tom_bookings`; booking alert also fires at send time.
  - `{"job":"lost","contact_id"}` — the one stage move Tom may do (opt-out → Good Lead, Lost). `{"job":"preview","contact_id"}` — dry draft, nothing stored.
- Tables: `tom_settings` (id=1: enabled=false, drafting, silent_on=false, model, caps, cells, brief, ping_on_booking=true, ping_on_reply=false, max_backlog), `tom_leads`, `tom_drafts` (status pending/approved/sent/skipped/blocked/failed/expired), `tom_bookings`, `tom_log`, `tom_training`. `acq_lead_msgs` holds threads (shared with the Oct 6 study pull; `raw.transcript` on calls).
- Cron: `tom-sync-10min` (:01,:11,…), `tom-think-15min` (:06,:21,:36,:51, limit 5), `tom-send-1min`, `tom-alerts-1min`. All gated on `drafting` / pending work.
- Page: **https://nicholliday.github.io/clearpath-acq/tom.html** (owner passcode, same login as the owner app). Tabs: Queue (Send / edit / Skip with reason / Later), Sent (+ month AI cost), Calls, Switch (master switch with confirm, drafting, pings, daily cap).

## Behaviour notes
- Silent-lead sequence (Attempt Made / No Reply scripted texts) is built as a mode but **`silent_on=false`** — GHL templates still own those until release day. A seller *reply* in Attempt Made still gets drafted.
- Cost: ~5¢ per decision (sonnet thinking ~1k tokens). 5 leads / 15 min max → ≤ ~$24/day worst case; the backlog cap keeps it near what Nic actually approves.
- Pings to Nic: only when a seller gives a call time (so he can approve + lock it) and 5 min before each booked call. Per-reply pings were turned off Oct 15 at 1:53pm after 4 texts in a minute ("too many notifications").
- Booking times: the model writes property-local time; `fromLocal()` converts with the property's tz (bug found + fixed on the first real booking, Carolyn Tanner 8pm MT).
- First four live drafts (Oct 15): Carolyn Tanner (booked 8pm MT), Michael Cabrera ($400k ask → call ask), Patricia Deil (first draft was a goodbye with no question → skipped by Claude, lesson added, redrafted), Marilynn Tisdale (as Nic, POA/mortgage statement).

## Still to do
- GHL templates for Attempt Made / No Reply off + `silent_on=true` on release day (Nic's call).
- CRM cleanup list from the rulebook (old automations, dupe opps, task spam).
- Under-contract check only uses the CONTRACTS pipeline contactIds (found 1); add `dispo_deals.seller_phone` match.
- Opt-out → Lost is a button on flag cards, not automatic, while the switch is off.

## Oct 15-16 changes (v7-v14) — the day-two fixes
- **Duplicates (41 sellers, 55 extra texts, Oct 15):** pg_net runs its queue in batches and waits for the slowest request, so several 1-min `send` calls fired at once after a long `think`. Fix: `sendDraft` claims the row first (`approved -> sending`, conditional update), `thinkJob` claims the lead via `facts_at`, and no seller gets two texts inside 2 minutes whatever produced them. Budgets: every run ≤50-70s (`budget_ms`), crons every 5 min instead of 10/15.
- **Replies seen late (Rose Bedwell, 17 min):** GHL's conversation search index lags. Every 3-min sync now re-reads the thread of anyone Tom texted in the last 3h (`hot`).
- **Went silent overnight:** rolling-24h cap of 150 was eaten by the duplicates. Cap is now 300 per CT calendar day; live replies always go first; nudges paced ~30/hr (`nudge_per_hour`, `paced` flag); drafts expire if the seller texted after they were made or after 2 days; backlog cap counts approved too.
- **Qualification:** an unqualified seller (not within 15% of MAO, not open to our number, no strong motivation) is never *offered* a call either — `CALL_RX` triggers one redraft, else blocked. "Does 5:30 work?" defers the booking until the seller says yes.
- **Pings (Quo, from +14695183652):** fresh-lead replies (Attempt Made / No Reply inbound) -> Nic and BT; otherwise only `important=true` -> owning rep (Nic's -> Nic, else BT); 1 per lead per 2h per recipient. GHL's own pushes: "all new conversations" off for Nic/BT/Devon, own-conversation pushes off for Nic/BT (kept for Devon = dispo), per-task reminders and task summaries off (204 tasks due 8:00 were the morning blast). Gmail filter archives Spark's "[ALERT] New Message" emails for Nic; the source workflow is Spark-locked and cannot be drafted from this account.
- **Rep inbox (`job: inbox`, every minute):** Nic or BT text the alert line "can't make it" / "push it to 3pm" -> nearest open booking cancelled, seller gets a polite reschedule text (offering the time if one was given), rep gets a confirmation; Tom rebooks when the seller answers.

## Oct 16 afternoon (v15-v17)
- **why_now gate (v15/16).** No booking without a concrete "what changed since the last rep conversation". Model must return `why_now`; one retry if missing; if still weak, `book_at` nulled and a draft that still offers a call is blocked (`why_now_check`, `booking_refused: no why_now`). Stored on `tom_drafts.why_now` / `tom_bookings.why_now`; shown in the "📞 Booked" text and 5-min ping as "Why this time: …". Rebooked calls reuse the cancelled booking's why_now.
- **Important pings gated (v17).** `important=true` only pings when facts back it (ask ≤ MAO×1.15, open_to_our_number, strong_motivation, event_date inside 30d) or seller wants a human / says bot / angry / legal; max 2 per rep per hour; else `ping_suppressed`.
- **Then Nic turned all pings off** (`ping_on_important=false`, `ping_on_reply=false`, `ping_on_booking=false`). Reps now get only "📞 Booked" + "📞 5 min". Rep inbox ("can't make it") still works.
- **Devon** was owner/follower on acq contacts → GHL pushed him every seller reply. Turned off his in-app "conversation I own" + "conversation I follow" pushes. Dispo-app pushes untouched.
- **Spark-locked workflow** `[Lead Replied SMS] Notification` (1a0a1c67…, 10,265 fires) is what still pushes Nic/BT in the GHL app; menu greyed out for everyone. Emailed support@freedomleads.com (cc jacob) Oct 16 asking to pause/unlock. Interim: mute LeadConnector app.
- tom_settings.brief update to add the why_now lines was cancelled twice (tool-side); rule is enforced in code + tom_training lesson, DEFAULT_BRIEF in code has it. Re-run if the brief is ever reset.
