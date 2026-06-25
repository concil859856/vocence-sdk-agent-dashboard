/* Vocence SDK dashboard.
 *   • REST: account, agents CRUD, models, tools (builtin + custom), voices
 *   • Live call: WebSocket bridge to the hosted agent (client.agents.session)
 * Mic → PCM16@16k → server.send_pcm ; agent PCM16@24k → speakers.
 */
const $ = (s) => document.querySelector(s);
async function api(path, opts) {
  const r = await fetch(path, opts);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw body;
  return body;
}

let voices = [], models = [], builtinTools = [], customTools = [];
let currentId = null;            // selected agent id (null = new/unsaved)
let inCall = false;
let ws = null, captureCtx = null, playerCtx = null, playerNode = null, playerGain = null, micStream = null, agentBubble = null;
let outputRate = 24000;          // actual AudioContext rate (browser may not honor 24k)
const TTS_RATE = 24000;          // the agent's PCM16 sample rate
const PREBUFFER_MS = 500;        // jitter cushion before playback — kills inter-burst underrun crackle

// Client-side barge-in (armed by real playback, see player-worklet.js).
let agentSpeaking = false;       // agent audio is actually playing (set by the player worklet)
let barged = false;              // user barged in → drop the stale buffered reply
let bargeTimer = null, voiceFrames = 0;
const BARGE_RMS = 0.06;          // mic loudness that counts as speech
const BARGE_FRAMES = 12;         // ~100 ms of sustained speech before we cut the agent off

// ───────────────────────── REST: catalogs ───────────────────────────────
async function loadAccount() {
  try {
    const a = await api('/api/account');
    $('#accEmail').textContent = a.email || '';
    $('#accPlan').textContent = a.plan_code || a.plan || '';
    $('#accCredits').textContent = (a.credits ?? 0).toLocaleString() + ' credits';
  } catch { $('#accEmail').textContent = 'account error'; }
}
async function loadVoices() {
  voices = await api('/api/voices').catch(() => []);
  $('#f_voice').innerHTML = '<option value="">(agent default)</option>' +
    voices.map((v) => `<option value="${v.id}">${v.name} — ${v.description || ''}</option>`).join('');
}
async function loadModels() {
  models = await api('/api/models').catch(() => []);
  $('#f_llm_model').innerHTML = '<option value="">(agent default)</option>' +
    models.map((m) => `<option value="${m.id}">${m.label || m.id}</option>`).join('');
}
async function loadTools() {
  const t = await api('/api/tools').catch(() => ({ builtin: [], custom: [] }));
  builtinTools = t.builtin || []; customTools = t.custom || [];
  renderTools();
}
function toolRow(id, name, desc, disabled) {
  return `<label class="tool ${disabled ? 'off' : ''}">
    <input type="checkbox" data-tool="${id}" ${disabled ? 'disabled' : ''} />
    <span class="tool-name">${name}${disabled ? ' <em>(needs server config)</em>' : ''}</span>
    <span class="tool-desc">${(desc || '').slice(0, 120)}</span>
  </label>`;
}
function renderTools(enabled = [], boundCustom = []) {
  $('#toolsBuiltin').innerHTML = builtinTools
    .map((t) => toolRow(t.id, t.name, t.description, t.available === false)).join('');
  $('#toolsCustomWrap').hidden = customTools.length === 0;
  $('#toolsCustom').innerHTML = customTools.map((t) => toolRow(t.id, t.name, t.description, false)).join('');
  setChecked('#toolsBuiltin', enabled);
  setChecked('#toolsCustom', boundCustom);
}
function setChecked(scope, ids) {
  const set = new Set(ids || []);
  document.querySelectorAll(`${scope} input[data-tool]`).forEach((c) => (c.checked = set.has(c.dataset.tool)));
}
function checkedTools(scope) {
  return [...document.querySelectorAll(`${scope} input[data-tool]:checked`)].map((c) => c.dataset.tool);
}

// ───────────────────────── Agents list ──────────────────────────────────
async function loadAgents() {
  const list = await api('/api/agents').catch(() => []);
  const box = $('#agentList');
  box.innerHTML = list.length
    ? list.map((a) => `<button class="agent-item ${a.id === currentId ? 'active' : ''}" data-id="${a.id}">${a.name}</button>`).join('')
    : '<div class="muted">No agents yet — click <b>+ New</b>.</div>';
  box.querySelectorAll('.agent-item').forEach((b) => (b.onclick = () => selectAgent(b.dataset.id)));
}

// ───────────────────────── Editor ───────────────────────────────────────
function toggleGoal() {
  const goal = $('#f_type').value === 'goal';
  $('#goalSection').hidden = !goal; $('#goalFields').hidden = !goal;
}
async function selectAgent(id) {
  const a = await api('/api/agents/' + id);
  const c = a.config || a;
  currentId = id;
  $('#f_name').value = a.name || '';
  $('#f_type').value = a.type || 'knowledge';
  $('#f_status').value = a.status || 'draft';
  $('#f_record_enabled').value = String(!!c.record_enabled);
  $('#f_voice').value = c.voice || '';
  $('#f_language').value = c.language || '';
  $('#f_first_message').value = c.first_message || '';
  $('#f_llm_model').value = c.llm_model || '';
  $('#f_temperature').value = c.temperature ?? 0.6; $('#tempVal').textContent = (+$('#f_temperature').value).toFixed(1);
  $('#f_purpose').value = c.purpose || '';
  $('#f_system_prompt').value = c.system_prompt || '';
  $('#f_knowledge').value = c.knowledge || '';
  $('#f_goal').value = c.goal || '';
  $('#f_success_metric').value = c.success_metric || '';
  $('#f_max_iterations').value = c.max_iterations ?? '';
  $('#f_turn_decider').value = c.turn_decider || 'ultravad';
  $('#f_denoise_enabled').value = String(!!c.denoise_enabled);
  $('#f_ultravad_threshold').value = c.ultravad_threshold ?? 0.5; $('#vadVal').textContent = (+$('#f_ultravad_threshold').value).toFixed(2);
  $('#f_min_delay_ms').value = c.min_delay_ms ?? '';
  const boundCustom = (a.custom_tools || []).map((t) => (typeof t === 'string' ? t : t.id));
  renderTools(c.enabled_tools || [], boundCustom);
  toggleGoal();
  $('#editorTitle').textContent = a.name;
  $('#deleteAgent').hidden = false; $('#callsBtn').hidden = false;
  const chip = $('#statusChip'); chip.hidden = false; chip.textContent = a.status; chip.dataset.status = a.status;
  $('#chatHint') && ($('#chatHint').innerHTML = `Click <b>Call</b> to talk to “${a.name}”.`);
  enableCall(); loadAgents();
}
function newAgent() {
  currentId = null;
  $('#agentForm').reset();
  $('#f_type').value = 'knowledge'; $('#f_status').value = 'draft'; $('#f_record_enabled').value = 'false';
  $('#f_denoise_enabled').value = 'false'; $('#f_turn_decider').value = 'ultravad';
  $('#f_temperature').value = 0.6; $('#tempVal').textContent = '0.6';
  $('#f_ultravad_threshold').value = 0.5; $('#vadVal').textContent = '0.50';
  renderTools([], []); toggleGoal();
  $('#editorTitle').textContent = 'New agent';
  $('#deleteAgent').hidden = true; $('#callsBtn').hidden = true; $('#statusChip').hidden = true;
  enableCall(); loadAgents();
}
function numOrNull(sel) { const v = parseFloat($(sel).value); return isNaN(v) ? null : v; }
function formBody() {
  const goal = $('#f_type').value === 'goal';
  const b = {
    name: $('#f_name').value.trim(),
    type: $('#f_type').value,
    status: $('#f_status').value,
    voice: $('#f_voice').value || null,
    language: $('#f_language').value.trim() || null,
    first_message: $('#f_first_message').value.trim() || null,
    llm_model: $('#f_llm_model').value || null,
    temperature: numOrNull('#f_temperature'),
    purpose: $('#f_purpose').value.trim() || null,
    system_prompt: $('#f_system_prompt').value,
    knowledge: $('#f_knowledge').value,
    record_enabled: $('#f_record_enabled').value === 'true',
    enabled_tools: checkedTools('#toolsBuiltin'),
    bound_tools: checkedTools('#toolsCustom'),
    turn_decider: $('#f_turn_decider').value,
    denoise_enabled: $('#f_denoise_enabled').value === 'true',
    ultravad_threshold: numOrNull('#f_ultravad_threshold'),
    min_delay_ms: numOrNull('#f_min_delay_ms'),
    goal: goal ? ($('#f_goal').value.trim() || null) : null,
    success_metric: goal ? ($('#f_success_metric').value.trim() || null) : null,
    max_iterations: goal ? numOrNull('#f_max_iterations') : null,
  };
  return b;
}
async function saveAgent() {
  const b = formBody();
  if (!b.name) return msg('Name is required', 'err');
  try {
    let a;
    if (currentId) a = await api('/api/agents/' + currentId, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
    else { a = await api('/api/agents', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }); currentId = a.id; }
    msg('Saved ✓', 'ok');
    await loadAgents(); await selectAgent(currentId);
  } catch (e) { msg('Save failed: ' + (e.detail || e.message || JSON.stringify(e)), 'err'); }
}
async function deleteAgent() {
  if (!currentId || !confirm('Delete this agent? This cannot be undone.')) return;
  await api('/api/agents/' + currentId, { method: 'DELETE' });
  msg('Deleted', 'ok'); newAgent(); loadAgents();
}
function msg(t, k) {
  const m = $('#saveMsg'); m.textContent = t; m.className = 'save-msg ' + (k || '');
  setTimeout(() => { if (m.textContent === t) m.textContent = ''; }, 3500);
}

// ───────────────────────── Custom-tool modal ────────────────────────────
function openToolModal() { $('#toolModal').hidden = false; $('#ctMsg').textContent = ''; }
function closeToolModal() { $('#toolModal').hidden = true; }
async function createCustomTool() {
  let parameters;
  try { parameters = JSON.parse($('#ct_parameters').value); }
  catch { $('#ctMsg').textContent = 'Parameters must be valid JSON'; $('#ctMsg').className = 'save-msg err'; return; }
  const body = {
    name: $('#ct_name').value.trim(), description: $('#ct_description').value.trim(),
    endpoint_url: $('#ct_endpoint_url').value.trim(), method: $('#ct_method').value,
    parameters, auth_type: $('#ct_auth_type').value, timeout_ms: parseInt($('#ct_timeout_ms').value) || 5000,
  };
  if (!body.name || !body.description || !body.endpoint_url) { $('#ctMsg').textContent = 'Name, description, endpoint required'; $('#ctMsg').className = 'save-msg err'; return; }
  if (body.auth_type !== 'none') { body.auth_header_name = $('#ct_auth_header_name').value.trim() || null; body.auth_secret = $('#ct_auth_secret').value || null; }
  try {
    await api('/api/custom-tools', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const checked = checkedTools('#toolsBuiltin'), checkedC = checkedTools('#toolsCustom');
    await loadTools(); renderTools(checked, checkedC);     // re-render, keep selections
    closeToolModal();
  } catch (e) { $('#ctMsg').textContent = 'Failed: ' + (e.detail || JSON.stringify(e)); $('#ctMsg').className = 'save-msg err'; }
}

// ───────────────────────── Call history / recordings ────────────────────
function fmtDur(ms) { const s = Math.round((ms || 0) / 1000); return `${Math.floor(s / 60)}m ${s % 60}s`; }
function fmtWhen(iso) { try { return new Date(iso).toLocaleString(); } catch { return iso || ''; } }
async function openCalls() {
  if (!currentId) { alert('Select an agent first.'); return; }
  const modal = $('#callsModal'), body = $('#callsBody');
  if (!modal || !body) { alert('Calls UI not found — the page is stale. Hard-reload (Ctrl-Shift-R).'); return; }
  modal.hidden = false;
  modal.style.display = 'grid';                 // belt-and-suspenders in case of stale CSS
  body.innerHTML = '<div class="muted">Loading…</div>';
  try {
    const calls = await api(`/api/agents/${currentId}/calls?ui=1`);
    if (!Array.isArray(calls)) { body.innerHTML = '<div class="muted">Unexpected response: ' + JSON.stringify(calls).slice(0, 200) + '</div>'; return; }
    if (!calls.length) { body.innerHTML = '<div class="muted">No calls yet for this agent.</div>'; return; }
    body.innerHTML = calls.map(callRow).join('');
    document.querySelectorAll('.call-item .call-head').forEach((h) => (h.onclick = () => loadCall(h.parentElement)));
  } catch (e) {
    body.innerHTML = '<div class="muted">Error loading calls: ' + ((e && (e.detail || e.message)) || JSON.stringify(e)) + '</div>';
  }
}
function callRow(c) {
  const rec = c.has_recording ? '🎙 recording' : 'transcript only';
  return `<div class="call-item" data-sid="${c.session_id}" data-rec="${c.has_recording ? 1 : 0}">
    <div class="call-head">
      <span class="call-when">${fmtWhen(c.started_at)}</span>
      <span class="call-meta">${fmtDur(c.duration_ms)} · ${c.turn_count || 0} turns · ${rec}</span>
    </div>
    <div class="call-detail" hidden></div>
  </div>`;
}
async function loadCall(el) {
  const det = el.querySelector('.call-detail');
  if (!det.hidden) { det.hidden = true; return; }          // collapse on second click
  det.hidden = false; det.innerHTML = '<div class="muted">Loading…</div>';
  const sid = el.dataset.sid; let html = '';
  if (el.dataset.rec === '1') {
    try {
      const r = await api(`/api/agents/${currentId}/calls/${sid}/recording`);
      if (r.url) html += `<audio class="rec" controls preload="none" src="${r.url}"></audio>
        <a class="dl" href="${r.url}" download>⬇ Download WAV (stereo — left: you, right: agent)</a>`;
    } catch { html += '<div class="muted">Recording unavailable (retention sweep or record was off).</div>'; }
  }
  try {
    const turns = await api(`/api/agents/${currentId}/calls/${sid}/transcript`);
    html += '<div class="turns">' + (turns.length
      ? turns.map((t) => `<div class="turn ${t.role}"><b>${t.role}</b><span>${t.text || ''}</span></div>`).join('')
      : '<div class="muted">No transcript.</div>') + '</div>';
  } catch { html += '<div class="muted">No transcript.</div>'; }
  det.innerHTML = html;
}

// ───────────────────────── Live voice chat ──────────────────────────────
function enableCall() { $('#callBtn').disabled = !currentId; }
function setState(s) {
  $('#state').textContent = { idle: 'Idle', connecting: 'Connecting…', listening: 'Listening…', thinking: 'Thinking…', speaking: 'Speaking', error: 'Error' }[s] || s;
  $('#dot').dataset.state = s;
}
function addBubble(role, text = '') {
  const row = document.createElement('div'); row.className = `row ${role}`;
  const b = document.createElement('div'); b.className = 'bubble'; b.textContent = text;
  row.appendChild(b); const chat = $('#chat'); chat.appendChild(row); chat.scrollTop = chat.scrollHeight; return b;
}
function appendAgent(t) { if (!agentBubble) agentBubble = addBubble('agent'); agentBubble.textContent += t; $('#chat').scrollTop = $('#chat').scrollHeight; }
function sendCtl(type) { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type })); }
// Stop playback with a short gain fade (no click), then drop the queue.
function flushPlayer() {
  if (!playerNode) return;
  if (playerCtx && playerGain) {
    const now = playerCtx.currentTime, g = playerGain.gain;
    try { g.cancelScheduledValues(now); g.setValueAtTime(g.value, now); } catch {}
    g.linearRampToValueAtTime(0.0001, now + 0.12);
    setTimeout(() => {
      if (playerNode) playerNode.port.postMessage('flush');
      if (playerCtx && playerGain) {
        const t = playerCtx.currentTime;
        try { playerGain.gain.cancelScheduledValues(t); playerGain.gain.setValueAtTime(0.0001, t); } catch {}
        playerGain.gain.linearRampToValueAtTime(1, t + 0.01);
      }
    }, 120);
  } else {
    playerNode.port.postMessage('flush');
  }
}
// `cancel` is sent ONLY for typed interrupts (intentional, can't mis-fire).
// For VOICE we never send cancel — the mic VAD can mis-trigger on the agent's
// own audio leaking through speakers, and a cancel would kill the turn. Voice
// barge just flushes playback locally; the server's own VAD handles the turn.
function doBarge(failsafeMs = 2500, sendCancel = false) {
  if (barged) return;
  barged = true; voiceFrames = 0; agentSpeaking = false; agentBubble = null;
  flushPlayer();                                          // smooth fade-out, no click
  if (sendCancel) sendCtl('cancel');                      // text only → clean server abort (→ {cancelled})
  setState('listening');
  clearTimeout(bargeTimer); bargeTimer = setTimeout(() => { barged = false; }, failsafeMs);
}
function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws?agent_id=${currentId}`);
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => setState('listening');
  ws.onclose = () => { setState('idle'); if (inCall) stopCall(); };  // server ended (idle timeout etc.) → reset Call button
  ws.onerror = () => setState('error');
  ws.onmessage = (ev) => {
    if (ev.data instanceof ArrayBuffer) {
      if (barged || !playerNode) return;
      const i16 = new Int16Array(ev.data);
      let f;
      if (outputRate === TTS_RATE) {                      // common path — no resample
        f = new Float32Array(i16.length);
        for (let i = 0; i < i16.length; i++) f[i] = i16[i] / 0x8000;
      } else {                                            // browser forced a different rate → linear resample
        const ratio = outputRate / TTS_RATE, outLen = Math.floor(i16.length * ratio);
        f = new Float32Array(outLen);
        for (let i = 0; i < outLen; i++) {
          const s = i / ratio, a = i16[Math.floor(s)] || 0, b = i16[Math.min(i16.length - 1, Math.ceil(s))] || 0, t = s - Math.floor(s);
          f[i] = ((1 - t) * a + t * b) / 0x8000;
        }
      }
      playerNode.port.postMessage(f, [f.buffer]);
      return;
    }
    const m = JSON.parse(ev.data);
    switch (m.type) {
      case 'transcript': barged = false; clearTimeout(bargeTimer); $('#caption').textContent = ''; addBubble('user', m.text); agentBubble = null; break;
      case 'partial_transcript': $('#caption').textContent = m.text || ''; break;
      case 'token': if (barged) break; setState('speaking'); appendAgent(m.text); break;
      case 'turn_end': agentBubble = null; setState('listening'); break;
      case 'cancelled': case 'interrupt':      // server confirmed the abort → the clean barge boundary
        flushPlayer();
        agentBubble = null; barged = false; clearTimeout(bargeTimer); break;
      case 'session_timeout': addBubble('agent', '(session ended: ' + (m.code || '') + ')'); break;
    }
  };
}
async function startCall() {
  if (!currentId) return;
  setState('connecting');
  try { playerCtx = new AudioContext({ sampleRate: TTS_RATE }); } catch { playerCtx = new AudioContext(); }
  outputRate = playerCtx.sampleRate;                      // what the browser actually gave us
  await playerCtx.audioWorklet.addModule('/static/player-worklet.js?v=2');
  playerNode = new AudioWorkletNode(playerCtx, 'player');
  playerGain = playerCtx.createGain(); playerGain.gain.value = 1;   // for click-free fade on barge
  playerNode.connect(playerGain); playerGain.connect(playerCtx.destination);
  playerNode.port.postMessage({ prebuffer: Math.round((PREBUFFER_MS / 1000) * outputRate) });
  playerNode.port.onmessage = (e) => { agentSpeaking = e.data === 'playing'; if (!agentSpeaking) voiceFrames = 0; };
  captureCtx = new AudioContext({ sampleRate: 16000 });
  await captureCtx.audioWorklet.addModule('/static/capture-worklet.js');
  micStream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  const src = captureCtx.createMediaStreamSource(micStream);
  const cap = new AudioWorkletNode(captureCtx, 'capture'); src.connect(cap);
  agentSpeaking = false; barged = false; voiceFrames = 0;
  cap.port.onmessage = (e) => {
    const buf = e.data;
    if (agentSpeaking && !barged) {
      const i16 = new Int16Array(buf); let sum = 0;
      for (let i = 0; i < i16.length; i++) { const v = i16[i] / 0x8000; sum += v * v; }
      if (Math.sqrt(sum / i16.length) > BARGE_RMS) { if (++voiceFrames >= BARGE_FRAMES) doBarge(); } else voiceFrames = 0;
    }
    if (ws && ws.readyState === 1) ws.send(buf);
  };
  connect();
  inCall = true; $('#callBtn').classList.add('active'); $('#callBtn .label').textContent = 'End';
}
async function stopCall() {
  inCall = false; $('#callBtn').classList.remove('active'); $('#callBtn .label').textContent = 'Call'; setState('idle');
  clearTimeout(bargeTimer); agentSpeaking = false; barged = false;
  if (micStream) micStream.getTracks().forEach((t) => t.stop());
  if (ws) ws.close();
  for (const c of [captureCtx, playerCtx]) { try { await c?.close(); } catch {} }
  captureCtx = playerCtx = playerNode = micStream = ws = null;
}

// ───────────────────────── Wire up ──────────────────────────────────────
$('#newAgent').onclick = newAgent;
$('#saveAgent').onclick = saveAgent;
$('#deleteAgent').onclick = deleteAgent;
$('#callsBtn').onclick = openCalls;
$('#callsModalClose').onclick = () => ($('#callsModal').hidden = true);
$('#agentForm').onsubmit = (e) => { e.preventDefault(); saveAgent(); };
$('#f_type').onchange = toggleGoal;
$('#f_temperature').oninput = (e) => ($('#tempVal').textContent = (+e.target.value).toFixed(1));
$('#f_ultravad_threshold').oninput = (e) => ($('#vadVal').textContent = (+e.target.value).toFixed(2));
$('#registerTool').onclick = openToolModal;
$('#toolModalClose').onclick = closeToolModal;
$('#ct_cancel').onclick = closeToolModal;
$('#ct_create').onclick = createCustomTool;
$('#ct_auth_type').onchange = (e) => ($('#ct_authRow').hidden = e.target.value === 'none');
$('#callBtn').onclick = () => (inCall ? stopCall() : startCall());
$('#composer').onsubmit = (e) => {
  e.preventDefault();
  const t = $('#textInput').value.trim();
  if (!t || !currentId) return;
  if (!ws || ws.readyState !== 1) connect();
  const send = () => {                              // Studio order: {cancel} THEN {text}
    doBarge(1500, true);                            // typed interrupt → safe to cancel; server replies to the text next
    ws.send(JSON.stringify({ type: 'text', text: t }));
  };
  ws.readyState === 1 ? send() : ws.addEventListener('open', send, { once: true });
  addBubble('user', t); agentBubble = null; $('#textInput').value = '';
};

(async () => {
  await loadAccount();
  await Promise.all([loadVoices(), loadModels(), loadTools()]);
  await loadAgents();
  toggleGoal(); setState('idle');
})();
