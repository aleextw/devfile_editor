// chat.js — Alpine-powered chat assistant
// Loaded as type="module" from chat.html.

document.addEventListener('alpine:init', () => {
  Alpine.data('chat', () => ({
    messages: [],
    inputText: '',
    isStreaming: false,
    logoText: window.CHAT_CONFIG?.logoText ?? 'ai',

    get canSend() {
      return this.inputText.trim().length > 0 && !this.isStreaming;
    },

    // Auto-resize the textarea
    resizeInput(el) {
      el.style.height = 'auto';
      el.style.height = Math.min(el.scrollHeight, 180) + 'px';
    },

    handleKeydown(e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (this.canSend) this.send();
      }
    },

    async send() {
      const text = this.inputText.trim();
      if (!text) return;

      // Clear empty state
      this.messages.push({ role: 'user', text, time: this._ts() });
      this.inputText = '';
      this.$nextTick(() => {
        const ta = this.$refs.inputBox;
        if (ta) { ta.style.height = 'auto'; }
        this._scrollToBottom();
      });

      this.isStreaming = true;
      // Placeholder for streaming assistant message
      const assistantIdx = this.messages.length;
      this.messages.push({ role: 'assistant', text: '', time: this._ts(), streaming: true });

      try {
        const res = await fetch('/chat/stream', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ payload: text }),
        });

        if (!res.ok) throw new Error(`Server responded ${res.status} ${res.statusText}`);

        const reader  = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop();
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            let parsed;
            try { parsed = JSON.parse(trimmed); } catch { continue; }
            const delta = parsed.delta ?? '';
            if (!delta) continue;
            this.messages[assistantIdx].text += delta;
            this.$nextTick(() => this._scrollToBottom());
          }
        }

        // Flush remaining
        if (buffer.trim()) {
          try {
            const delta = JSON.parse(buffer.trim()).delta ?? '';
            if (delta) this.messages[assistantIdx].text += delta;
          } catch { /* ignore */ }
        }

        this.messages[assistantIdx].streaming = false;

      } catch (err) {
        this.messages[assistantIdx].text  = err.message;
        this.messages[assistantIdx].error = true;
        this.messages[assistantIdx].streaming = false;
      } finally {
        this.isStreaming = false;
        this.$nextTick(() => this._scrollToBottom());
      }
    },

    useChip(text) {
      this.inputText = text;
      this.$nextTick(() => {
        const ta = this.$refs.inputBox;
        if (ta) { this.resizeInput(ta); ta.focus(); }
      });
    },

    _scrollToBottom() {
      const feed = this.$refs.messageFeed;
      if (feed) feed.scrollTop = feed.scrollHeight;
    },

    _ts() {
      return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    },

    _escape(str) {
      return (str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/\n/g, '<br>');
    },
  }));
});
