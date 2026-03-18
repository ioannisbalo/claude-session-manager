let terminalWrapper: TerminalWrapper;
let activeSessionId: string | null = null;
const sessions = new Map<string, SessionInfo>();

document.addEventListener('DOMContentLoaded', () => {
  const terminalPanel = document.getElementById('terminal-panel')!;
  const emptyState = document.getElementById('empty-state')!;

  terminalWrapper = new TerminalWrapper(terminalPanel);

  terminalWrapper.onInput((sessionId: string, data: string) => {
    window.api.sendInput(sessionId, data);
  });

  async function createNewSession(): Promise<void> {
    const session = await window.api.createSession();
    if (!session) return;

    sessions.set(session.id, session);
    renderSidebar();
    switchToSession(session.id);
  }

  document.getElementById('new-session-btn')!.addEventListener('click', createNewSession);
  document.getElementById('rename-session-btn')!.addEventListener('click', () => {
    if (!activeSessionId) return;
    const nameSpan = document.querySelector(`#session-list li.active .session-name`) as HTMLSpanElement | null;
    if (nameSpan) startRename(activeSessionId, nameSpan);
  });
  window.api.onNewSession(createNewSession);
  window.api.onSwitchSession((sessionId: string) => {
    if (sessions.has(sessionId)) switchToSession(sessionId);
  });

  window.api.onOutput((sessionId: string, data: string) => {
    if (sessionId === activeSessionId) {
      terminalWrapper.write(data);
    }
  });

  window.api.onStateChange((sessionId: string, state: SessionStatus) => {
    const session = sessions.get(sessionId);
    if (session) {
      session.status = state;
      renderSidebar();
    }
  });

  window.api.onExit((sessionId: string) => {
    const session = sessions.get(sessionId);
    if (session) {
      session.status = 'done';
      renderSidebar();
    }
  });

  document.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.metaKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      const ids = Array.from(sessions.keys());
      if (ids.length < 2) return;
      const currentIndex = ids.indexOf(activeSessionId!);
      const next = e.key === 'ArrowDown'
        ? (currentIndex + 1) % ids.length
        : (currentIndex - 1 + ids.length) % ids.length;
      switchToSession(ids[next]);
    }
  });

  function switchToSession(sessionId: string): void {
    activeSessionId = sessionId;
    window.api.setActiveSession(sessionId);

    terminalPanel.classList.add('visible');
    emptyState.style.display = 'none';

    window.api.getBuffer(sessionId).then((buffer: string) => {
      terminalWrapper.switchTo(sessionId, buffer);

      const { cols, rows } = terminalWrapper.getDimensions();
      window.api.resizeSession(sessionId, cols, rows);
    });

    renderSidebar();
  }

  function startRename(sessionId: string, nameSpan: HTMLSpanElement): void {
    const session = sessions.get(sessionId);
    if (!session) return;

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'session-rename-input';
    input.value = session.name;

    const commit = () => {
      const newName = input.value.trim();
      if (newName && newName !== session.name) {
        session.name = newName;
      }
      renderSidebar();
    };

    input.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        renderSidebar();
      }
    });

    input.addEventListener('blur', commit);

    nameSpan.textContent = '';
    nameSpan.appendChild(input);
    input.focus();
    input.select();
  }

  function showCorrectionDropdown(dot: HTMLElement, sessionId: string, currentStatus: SessionStatus): void {
    // Remove any existing dropdown
    document.querySelector('.correction-dropdown')?.remove();

    const allStates: SessionStatus[] = ['idle', 'working', 'needs-input', 'done'];
    const options = allStates.filter(s => s !== currentStatus);

    const dropdown = document.createElement('div');
    dropdown.className = 'correction-dropdown';

    const label = document.createElement('div');
    label.className = 'correction-label';
    label.textContent = `Showing: ${currentStatus}`;
    dropdown.appendChild(label);

    for (const state of options) {
      const btn = document.createElement('button');
      btn.className = `correction-option ${state}`;
      btn.textContent = state;
      btn.addEventListener('click', (e: MouseEvent) => {
        e.stopPropagation();
        window.api.correctState(sessionId, state);
        const session = sessions.get(sessionId);
        if (session) session.status = state;
        dropdown.remove();
        renderSidebar();
      });
      dropdown.appendChild(btn);
    }

    // Position relative to the dot
    const rect = dot.getBoundingClientRect();
    dropdown.style.left = `${rect.right + 8}px`;
    dropdown.style.top = `${rect.top - 4}px`;
    document.body.appendChild(dropdown);

    // Close on outside click
    const close = (e: MouseEvent) => {
      if (!dropdown.contains(e.target as Node)) {
        dropdown.remove();
        document.removeEventListener('click', close);
      }
    };
    setTimeout(() => document.addEventListener('click', close), 0);
  }

  function renderSidebar(): void {
    const renameBtn = document.getElementById('rename-session-btn')!;
    renameBtn.style.display = activeSessionId ? 'inline-block' : 'none';

    const list = document.getElementById('session-list')!;
    list.innerHTML = '';

    for (const [id, session] of sessions) {
      const li = document.createElement('li');
      li.className = id === activeSessionId ? 'active' : '';
      li.innerHTML = `
        <span class="status-dot ${session.status}"></span>
        <span class="session-name" title="${session.cwd}">${session.name}</span>
        <button class="session-close" title="Close session">&times;</button>
      `;

      const statusDot = li.querySelector('.status-dot') as HTMLElement;
      statusDot.addEventListener('click', (e: MouseEvent) => {
        e.stopPropagation();
        showCorrectionDropdown(e.target as HTMLElement, id, session.status);
      });

      li.addEventListener('click', (e: MouseEvent) => {
        if ((e.target as HTMLElement).classList.contains('session-close')) return;
        if ((e.target as HTMLElement).classList.contains('session-rename-input')) return;
        if ((e.target as HTMLElement).classList.contains('status-dot')) return;
        switchToSession(id);
      });

      li.querySelector('.session-close')!.addEventListener('click', async () => {
        await window.api.killSession(id);
        sessions.delete(id);

        if (activeSessionId === id) {
          activeSessionId = null;
          terminalPanel.classList.remove('visible');
          emptyState.style.display = '';
          const remaining = Array.from(sessions.keys());
          if (remaining.length > 0) switchToSession(remaining[0]);
        }

        renderSidebar();
      });

      list.appendChild(li);
    }
  }
});
