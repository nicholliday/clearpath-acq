// 3-Line Dialer tab for the acq app (Nic, Oct 22 2026). BT + Nic.
// Works GHL stage 🚫 No Reply (Inbound). Server side = edge function `acq-dialer` (Telnyx Call Control).
// The browser is just the rep's headset: the server rings it once at Start, it auto-answers, and every
// seller who picks up is bridged straight in. Voicemails/no-answers never reach the rep.
(function () {
  var FN = 'https://voitbqpvynbvlibuzxbz.supabase.co/functions/v1/acq-dialer';
  var client = null, agentCall = null, micStream = null, poll = null, lastLive = null, st = null, vmRec = null;
  var MIC_KEY = 'acq_dialer_mic';

  async function call(action, extra) {
    var s = await db.auth.getSession(); var tok = s && s.data && s.data.session && s.data.session.access_token;
    var r = await fetch(FN, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (tok || '') }, body: JSON.stringify(Object.assign({ action: action }, extra || {})) });
    var j = {}; try { j = await r.json(); } catch (e) { }
    if (!r.ok && !j.error) j.error = 'Server error ' + r.status;
    return j;
  }
  function el(id) { return document.getElementById(id); }
  function e(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'); }
  function pretty(p) { var d = String(p || '').replace(/\D/g, '').slice(-10); return d.length === 10 ? '(' + d.slice(0, 3) + ') ' + d.slice(3, 6) + '-' + d.slice(6) : p; }
  function savedMic() { try { return localStorage.getItem(MIC_KEY) || ''; } catch (x) { return ''; } }
  async function mics() { try { return (await navigator.mediaDevices.enumerateDevices()).filter(function (d) { return d.kind === 'audioinput'; }); } catch (x) { return []; } }
  async function openMic() {
    var list = await mics(); var want = savedMic();
    var m = list.find(function (d) { return d.deviceId === want; }) || list.find(function (d) { return d.deviceId === 'default'; }) || list[0];
    var base = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    // before the first permission, device ids are blank -> ask plainly; if a saved mic is gone, fall back to the default
    if (!m || !m.deviceId) return navigator.mediaDevices.getUserMedia({ audio: base });
    try { return await navigator.mediaDevices.getUserMedia({ audio: Object.assign({}, base, { deviceId: { exact: m.deviceId } }) }); }
    catch (err) { if (err && err.name === 'NotAllowedError') throw err; return navigator.mediaDevices.getUserMedia({ audio: base }); }
  }

  async function phone() {
    if (client) return client;
    var t = await call('token'); if (!t.token) throw new Error(t.error || 'No phone token');
    if (t.wait_ms) await new Promise(function (r) { setTimeout(r, t.wait_ms); });
    var c = new TelnyxWebRTC.TelnyxRTC({ login_token: t.token });
    c.remoteElement = 'dlr_audio';
    c.on('telnyx.notification', async function (n) {
      if (n.type !== 'callUpdate' || !n.call) return;
      var cl = n.call;
      if (cl.direction === 'inbound' && cl.state === 'ringing') {
        // the dialer ringing this browser -> pick up with the chosen mic
        try { micStream = micStream || await openMic(); } catch (x) { msg('Microphone blocked — click the icon left of the web address → Microphone → Allow.'); return; }
        agentCall = cl; try { cl.options.localStream = micStream; var tr = micStream.getAudioTracks()[0]; if (tr && tr.getSettings) cl.options.micId = tr.getSettings().deviceId; } catch (x) { } cl.answer();
      }
      if (cl === agentCall && (cl.state === 'hangup' || cl.state === 'destroy')) { agentCall = null; }
    });
    c.on('telnyx.socket.close', function () { client = null; });
    c.on('telnyx.error', function () { client = null; });
    await new Promise(function (res, rej) { var to = setTimeout(function () { rej(new Error('Phone took too long to connect')); }, 15000); c.on('telnyx.ready', function () { clearTimeout(to); res(); }); c.connect(); });
    client = c; return c;
  }
  function msg(t) { var m = el('dlr_msg'); if (m) m.textContent = t || ''; }

  var starting = false;
  async function start(test) {
    if (starting) return; starting = true; setTimeout(function () { starting = false; }, 8000);
    msg('Connecting your headset…');
    try { micStream = await openMic(); fillMics(); } catch (x) { msg(x && x.name === 'NotAllowedError' ? 'Microphone blocked — click the icon left of the web address → Microphone → Allow, then try again.' : 'Could not open the microphone (' + ((x && x.name) || 'error') + '). Pick another mic below and try again.'); return; }
    try { await phone(); } catch (x) { msg(x.message); return; }
    var r = await call('start', { lines: 3, test: !!test });
    if (r.error) { msg(r.error); return; }
    msg('Dialing ' + r.leads + ' No Reply leads…'); tick(); startPoll();
  }
  async function act(a) {
    if (a === 'hangup_live') { var hb = el('dlr_hang'); if (hb) { hb.disabled = true; hb.textContent = 'Hanging up…'; } el('dlr_status').textContent = 'Hanging up…'; }
    var r = await call(a); if (r.error) msg(r.error);
    var hb2 = el('dlr_hang'); if (hb2) { hb2.disabled = false; hb2.textContent = 'Hang up'; }
    tick();
  }
  function startPoll() { if (poll) return; poll = setInterval(tick, 1500); }
  function stopPoll() { if (poll) { clearInterval(poll); poll = null; } }

  async function tick() {
    var s = await call('state'); st = s; render(s);
    if (!s || ['none', 'stopped', 'done'].indexOf(s.status) >= 0) stopPoll(); else startPoll();
    var liveId = s && s.live && s.live.ccid;
    if (liveId && liveId !== lastLive) { lastLive = liveId; loadLead(); }
    if (!liveId) lastLive = null;
  }
  async function loadLead() {
    var box = el('dlr_lead'); if (!box) return; box.innerHTML = '<div class="sm mut">Loading seller…</div>';
    var i = await call('lead_info'); if (!i || !i.contact) { box.innerHTML = ''; return; }
    var c = i.contact;
    box.innerHTML = '<div style="font-size:13px;margin:6px 0">' + e([c.address, c.city, c.state].filter(Boolean).join(', ')) + '</div>'
      + '<a class="btn g" target="_blank" rel="noreferrer" href="' + e(i.ghl) + '" style="display:inline-block;text-decoration:none;margin:4px 0 8px">Open in GHL</a>'
      + (i.notes && i.notes.length ? '<div class="sm" style="max-height:220px;overflow:auto;border-top:1px solid var(--line);padding-top:6px">' + i.notes.map(function (n) { return '<div style="margin-bottom:8px"><b class="mut">' + e(String(n.at || '').slice(0, 10)) + '</b><br>' + e(n.body).replace(/\n/g, '<br>') + '</div>'; }).join('') + '</div>' : '<div class="sm mut">No GHL notes yet.</div>');
  }

  var LABEL = { dialing: 'ringing…', answered: 'answered…', machine: 'voicemail…', voicemail: 'leaving voicemail', bridged: 'LIVE', done: '', dropped: 'dropped' };
  var RES = { talked: '✅ talked', voicemail_left: '📼 voicemail left', machine_redial: '📼 machine → redial', machine_no_vm: '📼 machine', no_answer: 'no answer', busy: 'busy', hung_up: 'hung up', cut_for_live: 'cut (you went live)', rep_busy: 'dropped (you were on a call)', rep_not_ready: 'dropped (paused)' };

  function render(s) {
    var v = el('v_dialer'); if (!v) return;
    if (!el('dlr_root')) v.innerHTML = shell();
    var status = (s && s.status) || 'none';
    // only hear the line while you're actually on a call (no hiss between calls)
    var au = el('dlr_audio'); if (au) au.muted = status !== 'connected';
    var on = ['starting', 'ready', 'connected', 'wrapup', 'paused'].indexOf(status) >= 0;
    el('dlr_start').style.display = on ? 'none' : ''; el('dlr_test').style.display = (on || ROLE !== 'owner') ? 'none' : '';
    el('dlr_stop').style.display = on ? '' : 'none';
    el('dlr_pause').style.display = status === 'ready' ? '' : 'none';
    el('dlr_next').style.display = (status === 'wrapup' || status === 'paused') ? '' : 'none';
    el('dlr_hang').style.display = status === 'connected' ? '' : 'none';
    var head = { none: 'Ready when you are', starting: 'Ringing your headset…', ready: '📞 Dialing 3 lines…', connected: '🟢 LIVE', wrapup: '☎️ Call ended — add your notes in GHL, then tap Next', paused: '⏸ Paused', stopped: 'Stopped', done: '✅ Every No Reply lead has been dialed today' }[status] || status;
    el('dlr_status').textContent = head;
    var live = el('dlr_live');
    if (s && s.live && (status === 'connected' || status === 'wrapup')) { live.style.display = ''; el('dlr_lname').textContent = (s.live.name || '').split(' - ')[0]; el('dlr_lphone').textContent = pretty(s.live.phone) + (s.live.name && s.live.name.indexOf(' - ') > 0 ? ' · ' + s.live.name.split(' - ').slice(1).join(' - ') : ''); }
    else { live.style.display = 'none'; }
    var stx = (s && s.stats) || {};
    el('dlr_stats').innerHTML = s && s.id ? ('<b>' + (stx.dials || 0) + '</b> dials · <b>' + (stx.talked || 0) + '</b> pickups · <b>' + (stx.convos || 0) + '</b> convos (45s+) · <b>' + (stx.voicemails || 0) + '</b> voicemails · <b>' + (s.left || 0) + '</b> of ' + (s.total || 0) + ' leads left') : '';
    el('dlr_lines').innerHTML = (s && s.lines || []).map(function (l) {
      var tag = l.state === 'done' || l.state === 'dropped' ? (RES[l.result] || l.result || '') : (LABEL[l.state] || l.state);
      return '<div class="row" style="padding:5px 0;border-bottom:1px solid var(--line);font-size:13px"><span>' + e((l.name || '').split(' - ')[0]) + ' <span class="mut">' + pretty(l.phone) + (l.attempt === 2 ? ' · 2nd' : '') + '</span></span><span class="mut">' + e(tag) + '</span></div>';
    }).join('');
    el('dlr_vm').innerHTML = s && s.has_vm ? '📼 Voicemail recorded ✓ <a href="#" onclick="dlrRecord();return false">re-record</a>' : '⚠️ No voicemail recorded yet — machines get hung up on. <a href="#" onclick="dlrRecord();return false">Record one</a>';
  }

  function shell() {
    return '<div id="dlr_root"><audio id="dlr_audio" autoplay></audio>'
      + '<div class="card"><h2>📞 3-Line Dialer</h2><div class="sm mut">Calls your 🚫 No Reply leads 3 at a time. Each lead gets a double dial once a day. Voicemails are left for you; only real people are put through.</div>'
      + '<div id="dlr_status" style="font-size:20px;font-weight:800;margin:12px 0 6px">…</div><div id="dlr_stats" class="sm"></div>'
      + '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">'
      + '<button id="dlr_start" class="btn gr" style="font-size:17px;padding:12px 22px" onclick="dlrStart()">▶ Start dialing</button>'
      + '<button id="dlr_test" class="btn mut" onclick="dlrStart(true)">🧪 Test (calls your cell)</button>'
      + '<button id="dlr_pause" class="btn" onclick="dlrAct(\'pause\')">⏸ Pause</button>'
      + '<button id="dlr_next" class="btn gr" style="font-size:17px;padding:12px 22px" onclick="dlrAct(\'next\')">▶ Next</button>'
      + '<button id="dlr_hang" class="btn d" style="font-size:17px;padding:12px 22px" onclick="dlrAct(\'hangup_live\')">Hang up</button>'
      + '<button id="dlr_stop" class="btn d" onclick="dlrAct(\'stop\')">■ Stop</button>'
      + '</div><div id="dlr_msg" class="sm" style="color:#e11d48;margin-top:8px"></div>'
      + '<div class="sm" style="margin-top:10px">🎤 <select id="dlr_mic" onchange="dlrMic(this.value)" style="max-width:260px"></select></div>'
      + '<div id="dlr_vm" class="sm" style="margin-top:8px"></div></div>'
      + '<div id="dlr_live" class="card" style="display:none;border:2px solid #16A34A"><div class="sm mut">ON THE PHONE WITH</div><div id="dlr_lname" style="font-size:22px;font-weight:800"></div><div id="dlr_lphone" class="sm"></div><div id="dlr_lead"></div></div>'
      + '<div class="card"><h2>Lines</h2><div id="dlr_lines"></div></div></div>';
  }

  async function fillMics() {
    var sel = el('dlr_mic'); if (!sel) return; var list = await mics(); var cur = savedMic() || 'default';
    sel.innerHTML = list.map(function (m) { return '<option value="' + e(m.deviceId) + '"' + (m.deviceId === cur ? ' selected' : '') + '>' + e(m.label || 'Microphone') + '</option>'; }).join('') || '<option>Allow the microphone first</option>';
  }

  // ---- voicemail recording -> WAV (Telnyx plays wav/mp3) ----
  function toWav(buf) {
    var rate = 16000, src = buf.getChannelData(0), ratio = buf.sampleRate / rate, n = Math.floor(src.length / ratio);
    var out = new DataView(new ArrayBuffer(44 + n * 2));
    function str(o, s) { for (var i = 0; i < s.length; i++) out.setUint8(o + i, s.charCodeAt(i)); }
    str(0, 'RIFF'); out.setUint32(4, 36 + n * 2, true); str(8, 'WAVE'); str(12, 'fmt '); out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 1, true);
    out.setUint32(24, rate, true); out.setUint32(28, rate * 2, true); out.setUint16(32, 2, true); out.setUint16(34, 16, true); str(36, 'data'); out.setUint32(40, n * 2, true);
    for (var i = 0; i < n; i++) { var x = Math.max(-1, Math.min(1, src[Math.floor(i * ratio)])); out.setInt16(44 + i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true); }
    return new Uint8Array(out.buffer);
  }
  window.dlrRecord = async function () {
    var box = el('dlr_vm');
    if (vmRec) { vmRec.stop(); return; }
    var stream; try { stream = await openMic(); } catch (x) { msg('Microphone blocked.'); return; }
    var chunks = []; vmRec = new MediaRecorder(stream);
    vmRec.ondataavailable = function (ev) { chunks.push(ev.data); };
    vmRec.onstop = async function () {
      stream.getTracks().forEach(function (t) { t.stop(); }); vmRec = null; box.textContent = 'Saving…';
      try {
        var ab = await new Blob(chunks).arrayBuffer(); var ctx = new AudioContext(); var buf = await ctx.decodeAudioData(ab); ctx.close();
        var wav = toWav(buf); var bin = ''; for (var i = 0; i < wav.length; i += 0x8000) bin += String.fromCharCode.apply(null, wav.subarray(i, i + 0x8000));
        var r = await call('save_vm', { audio: btoa(bin), mime: 'audio/wav' });
        if (r.error) msg(r.error); else { new Audio(r.url).play().catch(function () { }); }
      } catch (x) { msg('Could not save the recording.'); }
      tick();
    };
    vmRec.start(); box.innerHTML = '🔴 Recording… say your voicemail, then <a href="#" onclick="dlrRecord();return false"><b>tap here to stop</b></a>';
  };

  window.dlrStart = start;
  window.dlrAct = act;
  window.dlrMic = function (v) { try { localStorage.setItem(MIC_KEY, v); } catch (x) { } micStream = null; };
  window.dlrOpen = function () { var v = el('v_dialer'); if (v && !el('dlr_root')) v.innerHTML = shell(); fillMics(); tick(); };
})();
