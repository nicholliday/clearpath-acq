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
