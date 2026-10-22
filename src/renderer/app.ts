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
      if (hasPersistableState()) {
        await window.api.saveState(buildSavedState(paneManager));
      }
    }, 500);
  });

  window.api.onSaveAndQuit(async () => {
    if (hasPersistableState()) {
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

  initSidebarResizer();

  // Attempt to restore previous state on startup
  restoreState(paneManager).then((restored) => {
    // Always render: the sections and their `+` buttons are the only way to
    // create a first task, so a fresh start must not leave the sidebar blank.
    renderSidebar();
    if (restored) {
      if (!paneManager.isEmpty()) {
        terminalPanel.classList.add('visible');
        emptyState.style.display = 'none';
      } else {
        const firstId = getVisibleSessionOrder()[0];
        if (firstId) switchToSession(firstId);
      }
    }
  }).catch(() => {
    // A failed restore must still leave a usable sidebar rather than a blank one.
    renderSidebar();
  });

document.getElementById('new-session-btn')!.addEventListener('click', createNewSession);
  document.getElementById('rename-session-btn')!.addEventListener('click', () => {
    if (!activeSessionId) return;
    // The active session's row may be hidden inside a collapsed task or the
    // collapsed Backlog, in which case the query below finds nothing and the
    // button looks dead. Reveal it first.
    const owner = getTaskForSession(activeSessionId);
    if (owner) {
      if (owner.collapsed) owner.collapsed = false;
      if (owner.status === 'backlog') expandBacklog();
      renderSidebar();
    }
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
      if (!renameInProgress) return;   // blur after Enter must not run twice
      setRenameInProgress(false);
      const newName = input.value.trim();
      if (newName && newName !== currentName) onCommit(newName);
      renderSidebar();
    };

    input.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      else if (e.key === 'Escape') { e.preventDefault(); setRenameInProgress(false); renderSidebar(); }
    });
    input.addEventListener('blur', commit);

    setRenameInProgress(true);
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
    list.querySelectorAll('.drop-target-merge').forEach(el => {
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
      <span class="session-name"></span>
      <button class="session-close" title="Close session">&times;</button>
    `;

    // Via textContent, never the template: a name containing '<' would
    // otherwise swallow the rest of the row and the querySelectors below
    // would return null.
    const nameEl = li.querySelector('.session-name') as HTMLSpanElement;
    nameEl.textContent = session.name;
    nameEl.title = session.cwd;

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

  // --- Task detail modal ---

  const modal = document.getElementById('task-modal')!;
  const modalHeading = document.getElementById('task-modal-heading')!;
  const modalTitle = document.getElementById('task-modal-title') as HTMLInputElement;
  const modalDescription = document.getElementById('task-modal-description') as HTMLTextAreaElement;
  const modalType = document.getElementById('task-modal-type') as HTMLSelectElement;
  const modalSave = document.getElementById('task-modal-save') as HTMLButtonElement;
  const modalCancel = document.getElementById('task-modal-cancel') as HTMLButtonElement;

  const modalRepoList = document.getElementById('task-modal-repos') as HTMLUListElement;
  const modalLinkList = document.getElementById('task-modal-links') as HTMLUListElement;
  const modalLinkInput = document.getElementById('task-modal-link-input') as HTMLInputElement;

  let modalRepos: string[] = [];
  let modalLinks: string[] = [];

  let modalMode: 'create' | 'edit' = 'create';
  let modalCreateStatus: TaskStatus = 'backlog';
  let modalEditTarget: Task | null = null;

  /** Final path segment, tolerating a trailing slash. Falls back to the path. */
  function directoryName(fullPath: string): string {
    return fullPath.split('/').filter(Boolean).pop() ?? fullPath;
  }

  function renderModalList(kind: 'repos' | 'links'): void {
    const list = kind === 'repos' ? modalRepoList : modalLinkList;
    const values = kind === 'repos' ? modalRepos : modalLinks;
    list.innerHTML = '';

    values.forEach((value, index) => {
      const li = document.createElement('li');

      const text = document.createElement('span');
      text.className = kind === 'links' ? 'entry-value clickable' : 'entry-value';
      // A repo row shows the directory name; the full path is the tooltip.
      text.textContent = kind === 'repos' ? directoryName(value) : value;
      text.title = value;
      if (kind === 'links') {
        text.addEventListener('click', () => { window.api.openUrl(value); });
      }

      const remove = document.createElement('button');
      remove.className = 'entry-remove';
      remove.type = 'button';
      remove.title = 'Remove';
      remove.textContent = '×';
      remove.addEventListener('click', (e: MouseEvent) => {
        e.stopPropagation();   // must not open the link
        values.splice(index, 1);
        renderModalList(kind);
      });

      li.append(text, remove);
      list.appendChild(li);
    });
  }

  function syncModalSaveEnabled(): void {
    modalSave.disabled = modalTitle.value.trim() === '';
  }

  function fillModalFields(task: Task | null): void {
    modalTitle.value = task?.title ?? '';
    modalDescription.value = task?.description ?? '';
    modalType.value = task?.type ?? '';
    // Absent means empty: a task saved before these fields existed has neither.
    modalRepos = [...(task?.repos ?? [])];
    modalLinks = [...(task?.links ?? [])];
    modalLinkInput.hidden = true;
    modalLinkInput.value = '';
    modalLinkInput.classList.remove('invalid');
    renderModalList('repos');
    renderModalList('links');
    syncModalSaveEnabled();
  }

  function openTaskModal(mode: 'create' | 'edit', context: TaskStatus | Task): void {
    modalMode = mode;
    modalEditTarget = null;
    if (mode === 'create') {
      modalCreateStatus = context as TaskStatus;
      modalHeading.textContent = 'New task';
      fillModalFields(null);
    } else {
      modalEditTarget = context as Task;
      modalHeading.textContent = 'Edit task';
      fillModalFields(modalEditTarget);
    }
    modal.hidden = false;
    modalTitle.focus();
  }

  function closeTaskModal(): void {
    modal.hidden = true;
    // Otherwise activeElement is <body> and keystrokes go nowhere until the
    // user clicks a pane — on the routine path of every create and edit.
    const focused = paneManager.getFocusedPaneId();
    if (focused) paneManager.setFocus(focused);
  }

  /** Writes the modal's values. Returns false when the title is blank. */
  /**
   * Commit a link typed but not yet entered. Returns false when the pending
   * text is present and unusable — saving would otherwise discard a URL that
   * is visible on screen at the moment Save is pressed.
   */
  function commitPendingLink(): boolean {
    if (modalLinkInput.hidden) return true;
    const value = modalLinkInput.value.trim();
    if (value === '') return true;
    if (!isOpenableUrl(value)) {
      modalLinkInput.classList.add('invalid');
      modalLinkInput.focus();
      return false;
    }
    modalLinks.push(value);
    modalLinkInput.value = '';
    modalLinkInput.classList.remove('invalid');
    renderModalList('links');
    return true;
  }

  function isOpenableUrl(value: string): boolean {
    return value.startsWith('https://') || value.startsWith('http://');
  }

  function saveTaskModal(): boolean {
    if (!commitPendingLink()) return false;
    const title = modalTitle.value.trim();
    if (title === '') return false;

    const description = modalDescription.value.trim();
    const type = modalType.value as TaskType | '';

    if (modalMode === 'create') {
      createTaskFromModal(title, modalCreateStatus, {
        ...(description !== '' ? { description } : {}),
        ...(type !== '' ? { type } : {}),
        ...(modalRepos.length > 0 ? { repos: [...modalRepos] } : {}),
        ...(modalLinks.length > 0 ? { links: [...modalLinks] } : {}),
      });
      if (modalCreateStatus === 'backlog') expandBacklog();
    } else {
      if (!modalEditTarget) return false;   // never silently report a save that wrote nothing
      updateTaskFromModal(modalEditTarget, title, {
        ...(description !== '' ? { description } : {}),
        ...(type !== '' ? { type } : {}),
        ...(modalRepos.length > 0 ? { repos: [...modalRepos] } : {}),
        ...(modalLinks.length > 0 ? { links: [...modalLinks] } : {}),
      });
    }

    renderSidebar();
    scheduleSave();
    return true;
  }

  document.getElementById('task-modal-add-repo')!.addEventListener('click', async () => {
    const dir = await window.api.pickDirectory();
    if (!dir) return;   // cancelled
    modalRepos.push(dir);
    renderModalList('repos');
  });

  document.getElementById('task-modal-add-link')!.addEventListener('click', () => {
    modalLinkInput.hidden = false;
    modalLinkInput.focus();
  });

  modalLinkInput.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();   // cancel the input, not the modal
      modalLinkInput.hidden = true;
      modalLinkInput.value = '';
      modalLinkInput.classList.remove('invalid');
      return;
    }
    if (e.key !== 'Enter' || e.metaKey) return;   // Cmd+Enter saves from any field
    e.preventDefault();
    e.stopPropagation();

    const value = modalLinkInput.value.trim();
    // open-url silently ignores anything else, so a stored ftp:// row would
    // look saved and do nothing. Refuse it here instead.
    if (!isOpenableUrl(value)) {
      modalLinkInput.classList.add('invalid');
      return;
    }
    modalLinks.push(value);
    modalLinkInput.value = '';
    modalLinkInput.classList.remove('invalid');
    renderModalList('links');
  });

  modalSave.addEventListener('click', () => {
    if (saveTaskModal()) closeTaskModal();
  });
  modalCancel.addEventListener('click', closeTaskModal);
  document.getElementById('task-modal-backdrop')!.addEventListener('click', closeTaskModal);

  modalTitle.addEventListener('input', syncModalSaveEnabled);

  // Enter is bound to the title field only: in the description it must insert a
  // newline, which a document-level submit handler would steal.
  modalTitle.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key !== 'Enter' || e.metaKey) return;
    e.preventDefault();
    if (!saveTaskModal()) return;
    if (modalMode === 'edit') {
      closeTaskModal();
      return;
    }
    // Create mode stays open, cleared, for the next capture.
    fillModalFields(null);
    modalTitle.focus();
  });

  // Bound to document, not the modal: hiding the link input and re-rendering a
  // list both remove the focused element, dropping activeElement to <body>, and
  // a subtree listener would then never fire. Only Escape and Cmd+Enter match,
  // so a plain Enter in the description is still native.
  document.addEventListener('keydown', (e: KeyboardEvent) => {
    if (modal.hidden) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      closeTaskModal();
    } else if (e.key === 'Enter' && e.metaKey) {
      e.preventDefault();
      if (saveTaskModal()) closeTaskModal();
    }
  });

  const STATUS_BUTTON: Record<TaskStatus, { glyph: string; title: string }> = {
    backlog: { glyph: '▶', title: 'Pick up' },
    doing: { glyph: '✓', title: 'Mark done' },
    done: { glyph: '↩', title: 'Reopen' },
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
        openTaskModal('create', createIn);
      });
      li.appendChild(add);
    }
    return li;
  }

  function createTaskHeaderLi(task: Task): HTMLLIElement {
    const header = document.createElement('li');
    header.className = 'session-group-header';
    header.dataset.taskId = task.id;
    if (task.type) header.dataset.taskType = task.type;

    const btn = STATUS_BUTTON[task.status];
    header.innerHTML = `
      <span class="group-collapse-icon">${task.collapsed ? '▸' : '▾'}</span>
      <span class="group-name"></span>
      <button class="task-status-btn" title="${btn.title}">${btn.glyph}</button>
      <button class="task-session-btn" title="New session for this task">+</button>
      <button class="group-rename-btn" title="Rename task">✎</button>
      <button class="task-delete-btn" title="Delete task (sessions are kept)">&times;</button>
      <span class="group-count">${task.sessionIds.length || ''}</span>
    `;

    // Same reason as the session name: titles are user-typed and persisted, so
    // one containing '<' would break every render from then on.
    (header.querySelector('.group-name') as HTMLSpanElement).textContent = task.title;

    (header.querySelector('.task-status-btn') as HTMLElement).addEventListener('click', (e: MouseEvent) => {
      e.stopPropagation();
      advanceTaskStatus(task);
      renderSidebar();
      scheduleSave();
    });

    (header.querySelector('.group-rename-btn') as HTMLElement).addEventListener('click', (e: MouseEvent) => {
      e.stopPropagation();
      openTaskModal('edit', task);
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
      renderSidebar();
      scheduleSave();
    });

    return header;
  }

  function appendSection(
    list: HTMLElement,
    label: string,
    tasks: Task[],
    createIn: TaskStatus | null,
    collapsed: boolean,
  ): void {
    const header = sectionHeader(label, tasks.length, createIn);
    if (createIn === 'backlog') {
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
    if (dragInProgress || renameInProgress) return;

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
