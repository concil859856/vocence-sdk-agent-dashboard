/* Vocence SDK dashboard.
 *   • REST: account, agents CRUD, voices  (all via the server → vocence SDK)
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

let voices = [];
let currentId = null;            // selected agent id (null = new/unsaved)
let inCall = false;
let ws = null, captureCtx = null, playerCtx = null, playerNode = null, micStream = null, agentBubble = null;

// ───────────────────────── REST: account / voices / agents ──────────────
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
async function loadAgents() {
  const list = await api('/api/agents').catch(() => []);
  const box = $('#agentList');
  box.innerHTML = list.length
    ? list.map((a) => `<button class="agent-item ${a.id === currentId ? 'active' : ''}" data-id="${a.id}">${a.name}</button>`).join('')
    : '<div class="muted">No agents yet — click <b>+ New</b>.</div>';
  box.querySelectorAll('.agent-item').forEach((b) => (b.onclick = () => selectAgent(b.dataset.id)));
}

// ───────────────────────── Editor: load / new / save / delete ───────────
async function selectAgent(id) {
  const a = await api('/api/agents/' + id);
  const c = a.config || a;
  currentId = id;
  $('#f_name').value = a.name || '';
  $('#f_type').value = a.type || 'knowledge';
  $('#f_status').value = a.status || 'draft';
  $('#f_voice').value = c.voice || '';
  $('#f_language').value = c.language || '';
  $('#f_llm_model').value = c.llm_model || '';
  $('#f_temperature').value = c.temperature ?? '';
  $('#f_first_message').value = c.first_message || '';
  $('#f_purpose').value = c.purpose || '';
  $('#f_system_prompt').value = c.system_prompt || '';
  $('#f_knowledge').value = c.knowledge || '';
  $('#f_record_enabled').value = String(!!c.record_enabled);
  $('#editorTitle').textContent = a.name;
  $('#deleteAgent').hidden = false;
  const chip = $('#statusChip'); chip.hidden = false; chip.textContent = a.status; chip.dataset.status = a.status;
  $('#chatHint') && ($('#chatHint').innerHTML = `Click <b>Call</b> to talk to “${a.name}”.`);
  enableCall();
  loadAgents();
}
function newAgent() {
  currentId = null;
  $('#agentForm').reset();
  $('#f_type').value = 'knowledge'; $('#f_status').value = 'draft'; $('#f_record_enabled').value = 'false';
  $('#editorTitle').textContent = 'New agent';
  $('#deleteAgent').hidden = true; $('#statusChip').hidden = true;
  enableCall(); loadAgents();
}
function formBody() {
  const b = {
    name: $('#f_name').value.trim(),
    type: $('#f_type').value,
    status: $('#f_status').value,
    voice: $('#f_voice').value || null,
    language: $('#f_language').value.trim() || null,
    llm_model: $('#f_llm_model').value.trim() || null,
    first_message: $('#f_first_message').value.trim() || null,
    purpose: $('#f_purpose').value.trim() || null,
    system_prompt: $('#f_system_prompt').value,
    knowledge: $('#f_knowledge').value,
    record_enabled: $('#f_record_enabled').value === 'true',
  };
  const t = parseFloat($('#f_temperature').value);
  if (!isNaN(t)) b.temperature = t;
  return b;
}
async function saveAgent() {
  const b = formBody();
  if (!b.name) return msg('Name is required', 'err');
  try {
    let a;
    if (currentId) {
      a = await api('/api/agents/' + currentId, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
    } else {
      a = await api('/api/agents', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
      currentId = a.id;
    }
    msg('Saved ✓', 'ok');
    await loadAgents();
    await selectAgent(currentId);
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

// ───────────────────────── Live voice chat ──────────────────────────────
function enableCall() { $('#callBtn').disabled = !currentId; }
function setState(s) {
  $('#state').textContent = { idle: 'Idle', connecting: 'Connecting…', listening: 'Listening…',
    thinking: 'Thinking…', speaking: 'Speaking', error: 'Error' }[s] || s;
  $('#dot').dataset.state = s;
}
function addBubble(role, text = '') {
  const row = document.createElement('div'); row.className = `row ${role}`;
  const b = document.createElement('div'); b.className = 'bubble'; b.textContent = text;
  row.appendChild(b); const chat = $('#chat'); chat.appendChild(row); chat.scrollTop = chat.scrollHeight; return b;
}
function appendAgent(t) { if (!agentBubble) agentBubble = addBubble('agent'); agentBubble.textContent += t; $('#chat').scrollTop = $('#chat').scrollHeight; }

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws?agent_id=${currentId}`);
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => setState('listening');
  ws.onclose = () => setState('idle');
  ws.onerror = () => setState('error');
  ws.onmessage = (ev) => {
    if (ev.data instanceof ArrayBuffer) {                 // agent speech PCM16@24k
      if (!playerNode) return;
      const i16 = new Int16Array(ev.data), f = new Float32Array(i16.length);
      for (let i = 0; i < i16.length; i++) f[i] = i16[i] / 0x8000;
      playerNode.port.postMessage(f, [f.buffer]);
      return;
    }
    const m = JSON.parse(ev.data);
    switch (m.type) {
      case 'transcript': $('#caption').textContent = ''; addBubble('user', m.text); agentBubble = null; break;
      case 'partial_transcript': $('#caption').textContent = m.text || ''; break;
      case 'token': setState('speaking'); appendAgent(m.text); break;
      case 'turn_end': agentBubble = null; setState('listening'); break;
      case 'cancelled': if (playerNode) playerNode.port.postMessage('flush'); agentBubble = null; break;
      case 'session_timeout': addBubble('agent', '(session ended: ' + (m.code || '') + ')'); break;
    }
  };
}
async function startCall() {
  if (!currentId) return;
  setState('connecting');
  playerCtx = new AudioContext({ sampleRate: 24000 });
  await playerCtx.audioWorklet.addModule('/static/player-worklet.js');
  playerNode = new AudioWorkletNode(playerCtx, 'player'); playerNode.connect(playerCtx.destination);
  captureCtx = new AudioContext({ sampleRate: 16000 });
  await captureCtx.audioWorklet.addModule('/static/capture-worklet.js');
  micStream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  const src = captureCtx.createMediaStreamSource(micStream);
  const cap = new AudioWorkletNode(captureCtx, 'capture'); src.connect(cap);
  cap.port.onmessage = (e) => { if (ws && ws.readyState === 1) ws.send(e.data); };
  connect();
  inCall = true; $('#callBtn').classList.add('active'); $('#callBtn .label').textContent = 'End';
}
async function stopCall() {
  inCall = false; $('#callBtn').classList.remove('active'); $('#callBtn .label').textContent = 'Call'; setState('idle');
  if (micStream) micStream.getTracks().forEach((t) => t.stop());
  if (ws) ws.close();
  for (const c of [captureCtx, playerCtx]) { try { await c?.close(); } catch {} }
  captureCtx = playerCtx = playerNode = micStream = ws = null;
}

// ───────────────────────── Wire up ──────────────────────────────────────
$('#newAgent').onclick = newAgent;
$('#saveAgent').onclick = saveAgent;
$('#deleteAgent').onclick = deleteAgent;
$('#agentForm').onsubmit = (e) => { e.preventDefault(); saveAgent(); };
$('#callBtn').onclick = () => (inCall ? stopCall() : startCall());
$('#composer').onsubmit = (e) => {
  e.preventDefault();
  const t = $('#textInput').value.trim();
  if (!t || !currentId) return;
  if (!ws || ws.readyState !== 1) connect();
  const send = () => ws.send(JSON.stringify({ type: 'text', text: t }));
  ws.readyState === 1 ? send() : ws.addEventListener('open', send, { once: true });
  addBubble('user', t); agentBubble = null; $('#textInput').value = '';
};

(async () => { await loadAccount(); await loadVoices(); await loadAgents(); setState('idle'); })();
