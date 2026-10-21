let paneManager: PaneManager;
let activeSessionId: string | null = null;
const sessions = new Map<string, SessionInfo>();

document.addEventListener('DOMContentLoaded', () => {
  const terminalPanel = document.getElementById('terminal-panel')!;
  const emptyState = document.getElementById('empty-state')!;

  paneManager = new PaneManager(terminalPanel, {
    getBuffer: (sessionId: string) => window.api.getBuffer(sessionId),
    getSessionName: (sessionId: string) => sessions.get(sessionId)?.name ?? sessionId,
    onInput: (sessionId: string, data: string) => window.api.sendInput(sessionId, data),
    onResize: (sessionId: string, cols: number, rows: number) => window.api.resizeSession(sessionId, cols, rows),
    onFocusChange: (sessionId: string) => {
      activeSessionId = sessionId;
      window.api.setActiveSession(sessionId);
      renderSidebar();
    },
    onLayoutEmpty: () => {
      activeSessionId = null;
      terminalPanel.classList.remove('visible');
      emptyState.style.display = '';
    },
    onSplitRequest: (paneId: string, direction: SplitDirection) => {
      splitNewSession(paneId, direction);
    },
  });

  initScheduleSave(() => {
    if (saveTimeout !== undefined) clearTimeout(saveTimeout);
    saveTimeout = window.setTimeout(async () => {
      if (sessions.size > 0) {
        await window.api.saveState(buildSavedState(paneManager));
      }
    }, 500);
  });

  window.api.onSaveAndQuit(async () => {
    if (sessions.size > 0) {
      await window.api.saveState(buildSavedState(paneManager));
    }
  });

  async function createNewSession(): Promise<void> {
    const session = await window.api.createSession();
    if (!session) return;

    sessions.set(session.id, session);
    renderSidebar();
    switchToSession(session.id);
    scheduleSave();
  }

  // Attempt to restore previous state on startup
  restoreState(paneManager).then((restored) => {
    if (restored) {
      renderSidebar();
      if (!paneManager.isEmpty()) {
        terminalPanel.classList.add('visible');
        emptyState.style.display = 'none';
      } else {
        const firstId = getVisibleSessionOrder()[0];
        if (firstId) switchToSession(firstId);
      }
    }
  });

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
    paneManager.routeOutput(sessionId, data);
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

  window.api.onSplitSession((direction: SplitDirection) => {
    const paneId = paneManager.getFocusedPaneId();
    if (paneId) splitNewSession(paneId, direction);
  });

  window.api.onNavSession((direction: 'next' | 'prev') => {
    const ids = getVisibleSessionOrder();
    if (ids.length < 2) return;
    const currentIndex = ids.indexOf(activeSessionId!);
    const next = direction === 'next'
      ? (currentIndex + 1) % ids.length
      : (currentIndex - 1 + ids.length) % ids.length;
    switchToSession(ids[next]);
  });

  function switchToSession(sessionId: string): void {
    terminalPanel.classList.add('visible');
    emptyState.style.display = 'none';
    // PaneManager focuses (or opens) the pane and fires onFocusChange, which
    // updates activeSessionId, the active-session IPC, and the sidebar.
    paneManager.showSession(sessionId);
  }

  async function splitNewSession(paneId: string, direction: SplitDirection): Promise<void> {
    const session = await window.api.createSession();
    if (!session) return;
    sessions.set(session.id, session);
    terminalPanel.classList.add('visible');
    emptyState.style.display = 'none';
    paneManager.splitPane(paneId, direction, session.id, false);
    renderSidebar();
    scheduleSave();
  }

  function startRenameInput(
    nameSpan: HTMLSpanElement,
    currentName: string,
    onCommit: (newName: string) => void,
  ): void {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'session-rename-input';
    input.value = currentName;

    const commit = () => {
      const newName = input.value.trim();
      if (newName && newName !== currentName) onCommit(newName);
      renderSidebar();
    };

    input.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      else if (e.key === 'Escape') { e.preventDefault(); renderSidebar(); }
    });
    input.addEventListener('blur', commit);

    nameSpan.textContent = '';
    nameSpan.appendChild(input);
    input.focus();
    input.select();
  }

  function startRename(sessionId: string, nameSpan: HTMLSpanElement): void {
    const session = sessions.get(sessionId);
    if (!session) return;
    startRenameInput(nameSpan, session.name, (newName) => {
      session.name = newName;
      paneManager.updateHeaders();
      scheduleSave();
    });
  }

  function startTaskRename(task: Task, titleSpan: HTMLSpanElement): void {
    startRenameInput(titleSpan, task.title, (newTitle) => {
      task.title = newTitle;
      scheduleSave();
    });
  }

  function showCorrectionDropdown(dot: HTMLElement, sessionId: string, currentStatus: SessionStatus): void {
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

    const rect = dot.getBoundingClientRect();
    dropdown.style.left = `${rect.right + 8}px`;
    dropdown.style.top = `${rect.top - 4}px`;
    document.body.appendChild(dropdown);

    const close = (e: MouseEvent) => {
      if (!dropdown.contains(e.target as Node)) {
        dropdown.remove();
        document.removeEventListener('click', close);
      }
    };
    setTimeout(() => document.addEventListener('click', close), 0);
  }

  // --- Drag-and-drop helpers ---

  function clearDropIndicators(): void {
    const list = document.getElementById('session-list')!;
    list.querySelectorAll('.drop-target-merge, .drop-target-above, .drop-target-below').forEach(el => {
      el.classList.remove('drop-target-merge');
    });
  }

  // --- Session <li> creation ---

  function createSessionLi(id: string, session: SessionInfo, indented: boolean): HTMLLIElement {
    const li = document.createElement('li');
    li.className = (id === activeSessionId ? 'active' : '') + (indented ? ' grouped-session' : '');
    li.setAttribute('draggable', 'true');
    li.dataset.sessionId = id;
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
      detachSession(id);
      pruneDeadSessions();

      // Remove the killed session from any pane (collapses its split).
      paneManager.removeSession(id);

      if (paneManager.isEmpty()) {
        activeSessionId = null;
        terminalPanel.classList.remove('visible');
        emptyState.style.display = '';
        // Open another session in the freed space if any remain.
        const remaining = getVisibleSessionOrder();
        if (remaining.length > 0) switchToSession(remaining[0]);
      }

      renderSidebar();
      scheduleSave();
    });

    // Drag events
    li.addEventListener('dragstart', (e: DragEvent) => {
      e.dataTransfer!.setData('text/plain', id);
      e.dataTransfer!.setData('application/x-session-id', id);
      e.dataTransfer!.effectAllowed = 'move';
      dragInProgress = true;
      li.classList.add('dragging');
    });

    li.addEventListener('dragend', () => {
      dragInProgress = false;
      li.classList.remove('dragging');
      clearDropIndicators();
      renderSidebar();
    });

    li.addEventListener('dragover', (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      clearDropIndicators();
      // Only a session that belongs to a task can receive a drop: dropping onto
      // a loose session has no task to join, and tasks are created explicitly.
      if (getTaskForSession(id)) li.classList.add('drop-target-merge');
    });

    li.addEventListener('dragleave', () => {
      li.classList.remove('drop-target-merge');
    });

    li.addEventListener('drop', (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      clearDropIndicators();
      const draggedId = e.dataTransfer!.getData('text/plain');
      if (!draggedId || !sessions.has(draggedId)) return;
      const target = getTaskForSession(id);
      if (!target) return;
      attachSessionToTask(draggedId, target.id);
      renderSidebar();
      scheduleSave();
    });

    return li;
  }

  // --- Render ---

  const STATUS_BUTTON: Record<TaskStatus, { glyph: string; title: string }> = {
    backlog: { glyph: '▶', title: 'Pick up' },
    doing: { glyph: '✓', title: 'Mark done' },
    done: { glyph: '↺', title: 'Reopen' },
  };

  /** Section header row. `createIn` is the status a `+` here would create. */
  function sectionHeader(label: string, count: number, createIn: TaskStatus | null): HTMLLIElement {
    const li = document.createElement('li');
    li.className = 'sidebar-section-header';
    li.innerHTML = `
      <span class="section-label">${label}</span>
      <span class="section-count">${count > 0 ? count : ''}</span>
    `;
    if (createIn) {
      const add = document.createElement('button');
      add.className = 'section-add-btn';
      add.title = `New ${label.toLowerCase()} task`;
      add.textContent = '+';
      add.addEventListener('click', (e: MouseEvent) => {
        e.stopPropagation();
        const task = addTask(createIn);
        if (createIn === 'backlog') backlogCollapsed = false;
        renderSidebar();
        // Open the new row's title straight away, so creating a task is:
        // click +, type, Enter.
        const row = document.querySelector(`[data-task-id="${task.id}"] .group-name`) as HTMLSpanElement | null;
        if (row) startTaskRename(task, row);
        scheduleSave();
      });
      li.appendChild(add);
    }
    return li;
  }

  function createTaskHeaderLi(task: Task): HTMLLIElement {
    const header = document.createElement('li');
    header.className = 'session-group-header';
    header.dataset.taskId = task.id;

    const btn = STATUS_BUTTON[task.status];
    header.innerHTML = `
      <span class="group-collapse-icon">${task.collapsed ? '▸' : '▾'}</span>
      <span class="group-name">${task.title}</span>
      <button class="task-status-btn" title="${btn.title}">${btn.glyph}</button>
      <button class="task-session-btn" title="New session for this task">⊞</button>
      <button class="group-rename-btn" title="Rename task">✎</button>
      <button class="task-delete-btn" title="Delete task (sessions are kept)">&times;</button>
      <span class="group-count">${task.sessionIds.length || ''}</span>
    `;

    (header.querySelector('.task-status-btn') as HTMLElement).addEventListener('click', (e: MouseEvent) => {
      e.stopPropagation();
      advanceTaskStatus(task);
      renderSidebar();
      scheduleSave();
    });

    (header.querySelector('.group-rename-btn') as HTMLElement).addEventListener('click', (e: MouseEvent) => {
      e.stopPropagation();
      startTaskRename(task, header.querySelector('.group-name') as HTMLSpanElement);
    });

    (header.querySelector('.task-delete-btn') as HTMLElement).addEventListener('click', (e: MouseEvent) => {
      e.stopPropagation();
      removeTask(task.id);
      renderSidebar();
      scheduleSave();
    });

    (header.querySelector('.task-session-btn') as HTMLElement).addEventListener('click', async (e: MouseEvent) => {
      e.stopPropagation();
      const session = await window.api.createSession();
      if (!session) return;
      sessions.set(session.id, session);
      attachSessionToTask(session.id, task.id);
      renderSidebar();
      scheduleSave();
      switchToSession(session.id);
    });

    header.addEventListener('click', (e: MouseEvent) => {
      const cls = (e.target as HTMLElement).classList;
      if (cls.contains('group-rename-btn') || cls.contains('task-status-btn')) return;
      if (cls.contains('task-delete-btn') || cls.contains('task-session-btn')) return;
      if (cls.contains('session-rename-input')) return;
      task.collapsed = !task.collapsed;
      renderSidebar();
      scheduleSave();
    });

    // Dropping a session on a task attaches it. There are no above/below zones:
    // order is derived, so position is not something a drop can express.
    header.addEventListener('dragover', (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      clearDropIndicators();
      header.classList.add('drop-target-merge');
    });

    header.addEventListener('dragleave', () => {
      header.classList.remove('drop-target-merge');
    });

    header.addEventListener('drop', (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      clearDropIndicators();
      const draggedId = e.dataTransfer!.getData('text/plain');
      if (!draggedId || !sessions.has(draggedId)) return;
      attachSessionToTask(draggedId, task.id);
    });

    return header;
  }

  function appendSection(
    list: HTMLElement,
    label: string,
    tasks: Task[],
    status: TaskStatus,
    collapsed: boolean,
  ): void {
    const header = sectionHeader(label, tasks.length, status);
    if (status === 'backlog') {
      header.classList.add('collapsible');
      header.addEventListener('click', (e: MouseEvent) => {
        if ((e.target as HTMLElement).classList.contains('section-add-btn')) return;
        toggleBacklogCollapsed();
        renderSidebar();
      });
    }
    list.appendChild(header);
    if (collapsed) return;

    for (const task of tasks) {
      list.appendChild(createTaskHeaderLi(task));
      if (task.collapsed) continue;
      for (const sid of task.sessionIds) {
        const session = sessions.get(sid);
        if (session) list.appendChild(createSessionLi(sid, session, true));
      }
    }
  }

  function renderSidebar(): void {
    if (dragInProgress) return;

    const renameBtn = document.getElementById('rename-session-btn')!;
    renameBtn.style.display = activeSessionId ? 'inline-block' : 'none';

    const list = document.getElementById('session-list')!;
    list.innerHTML = '';

    const sections = sidebarSections();

    appendSection(list, 'Doing', sections.doing, 'doing', false);
    appendSection(list, 'Backlog', sections.backlog, 'backlog', backlogCollapsed);
    if (sections.done.length > 0) appendSection(list, 'Done', sections.done, 'done', false);

    if (sections.loose.length > 0) {
      list.appendChild(sectionHeader('Loose sessions', sections.loose.length, null));
      for (const id of sections.loose) {
        const session = sessions.get(id);
        if (session) list.appendChild(createSessionLi(id, session, false));
      }
    }

    // Drop onto empty list area detaches a session from its task. Looseness is
    // derived from "belongs to no task", so detaching is the whole operation.
    list.ondragover = (e: DragEvent) => {
      if (e.target === list) e.preventDefault();
    };

    list.ondrop = (e: DragEvent) => {
      if (e.target !== list) return;
      e.preventDefault();
      clearDropIndicators();
      const draggedId = e.dataTransfer!.getData('text/plain');
      if (!draggedId || !sessions.has(draggedId)) return;
      detachSession(draggedId);
      renderSidebar();
      scheduleSave();
    };
  }
});
