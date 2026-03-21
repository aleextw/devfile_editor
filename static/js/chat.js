// chat.js — chat assistant page logic
//
// Depends on window.CHAT_CONFIG being set by an inline <script> in chat.html:
//   window.CHAT_CONFIG = { logoText: "..." };

const { logoText: LOGO_TEXT } = window.CHAT_CONFIG;

const feed     = document.getElementById('message-feed');
const inputBox = document.getElementById('input-box');
const sendBtn  = document.getElementById('send-btn');

// ── Input ─────────────────────────────────────────────────────────────────────
inputBox.addEventListener('input', () => {
  inputBox.style.height = 'auto';
  inputBox.style.height = Math.min(inputBox.scrollHeight, 180) + 'px';
  sendBtn.disabled = inputBox.value.trim() === '';
});

inputBox.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    if (!sendBtn.disabled) sendBtn.click();
  }
});

// ── Send ──────────────────────────────────────────────────────────────────────
sendBtn.addEventListener('click', () => {
  const text = inputBox.value.trim();
  if (!text) return;
  appendUserMessage(text);
  inputBox.value = '';
  inputBox.style.height = 'auto';
  sendBtn.disabled = true;
  streamResponse(text);
});

// ── Suggestion chips ──────────────────────────────────────────────────────────
document.querySelectorAll('.chip').forEach(chip => {
  chip.addEventListener('click', () => {
    inputBox.value = chip.textContent.trim();
    inputBox.dispatchEvent(new Event('input'));
    inputBox.focus();
  });
});

// ── Streaming ─────────────────────────────────────────────────────────────────
async function streamResponse(payload) {
  showTyping();
  let assistantBubble = null;

  try {
    const res = await fetch('/chat/stream', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ payload }),
    });

    if (!res.ok) throw new Error(`Server responded ${res.status} ${res.statusText}`);

    const reader  = res.body.getReader();
    const decoder = new TextDecoder();
    let   buffer  = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      // Accumulate chunks; split on newlines to get complete NDJSON lines.
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep any incomplete trailing line

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let parsed;
        try { parsed = JSON.parse(trimmed); }
        catch { console.warn('Skipping non-JSON line:', trimmed); continue; }

        const delta = parsed.delta ?? '';
        if (!delta) continue;

        if (!assistantBubble) { hideTyping(); assistantBubble = createAssistantBubble(); }
        appendDelta(assistantBubble, delta);
      }
    }

    // Flush any remaining buffer (stream closed without trailing \n)
    if (buffer.trim()) {
      try {
        const delta = JSON.parse(buffer.trim()).delta ?? '';
        if (delta) {
          if (!assistantBubble) { hideTyping(); assistantBubble = createAssistantBubble(); }
          appendDelta(assistantBubble, delta);
        }
      } catch { /* ignore malformed trailing data */ }
    }

  } catch (err) {
    hideTyping();
    showError(err.message);
  } finally {
    sendBtn.disabled = inputBox.value.trim() === '';
    inputBox.focus();
  }
}

// ── DOM helpers ───────────────────────────────────────────────────────────────
function appendUserMessage(text) {
  feed.querySelector('.empty-state')?.remove();
  const row = document.createElement('div');
  row.className = 'message-row user';
  row.innerHTML = `
    <div class="message-avatar user">you</div>
    <div class="message-body">
      <div class="message-meta">
        <span class="message-sender">you</span>
        <span>${timestamp()}</span>
      </div>
      <div class="message-bubble">${escapeHtml(text)}</div>
    </div>`;
  feed.appendChild(row);
  scrollToBottom();
}

function createAssistantBubble() {
  const row = document.createElement('div');
  row.className = 'message-row assistant';
  row.innerHTML = `
    <div class="message-avatar assistant">${LOGO_TEXT}</div>
    <div class="message-body">
      <div class="message-meta">
        <span class="message-sender">assistant</span>
        <span>${timestamp()}</span>
      </div>
      <div class="message-bubble"></div>
    </div>`;
  feed.appendChild(row);
  scrollToBottom();
  return row.querySelector('.message-bubble');
}

function appendDelta(bubble, delta) {
  bubble.innerHTML += escapeHtml(delta);
  scrollToBottom();
}

function showTyping() {
  if (document.getElementById('typing-row')) return;
  const row = document.createElement('div');
  row.className = 'message-row assistant';
  row.id = 'typing-row';
  row.innerHTML = `
    <div class="message-avatar assistant">${LOGO_TEXT}</div>
    <div class="message-body">
      <div class="typing-indicator">
        <div class="typing-dot"></div>
        <div class="typing-dot"></div>
        <div class="typing-dot"></div>
      </div>
    </div>`;
  feed.appendChild(row);
  scrollToBottom();
}

function hideTyping() { document.getElementById('typing-row')?.remove(); }

function showError(message) {
  const row = document.createElement('div');
  row.className = 'message-row assistant';
  row.innerHTML = `
    <div class="message-avatar assistant" style="background:var(--warn)">${LOGO_TEXT}</div>
    <div class="message-body">
      <div class="message-bubble" style="border-color:rgba(249,123,79,0.35);color:var(--warn)">
        ⚠ ${escapeHtml(message)}
      </div>
    </div>`;
  feed.appendChild(row);
  scrollToBottom();
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function scrollToBottom() { feed.scrollTop = feed.scrollHeight; }

function timestamp() {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\n/g, '<br>');
}
