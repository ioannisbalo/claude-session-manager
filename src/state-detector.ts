import { Terminal } from '@xterm/headless';

export type SessionState = 'working' | 'needs-input' | 'idle' | 'done';

export interface TransitionDetail {
  from: SessionState;
  to: SessionState;
  linesExamined: string[];
  matchedPattern: string | null;
  trigger: 'settle' | 'user-input' | 'exit';
}

// How often to look at the screen. Claude Code repaints continuously (even
// while sitting at a permission prompt), so waiting for output to go quiet
// would never classify — we poll instead. Polling runs in every state, not
// just "working": prompts can be answered through inputs we can't observe
// as keystrokes (mouse clicks, shift+tab, remote control), so the screen is
// the only reliable signal that a dialog was dismissed or work started.
const CLASSIFY_INTERVAL_MS = 1000;

// Grace period after user input before the first look — gives Claude Code
// time to repaint, so we don't classify the previous (stale) screen.
const FIRST_CLASSIFY_DELAY_MS = 1500;

// Don't read a screen mid-repaint: if data arrived very recently, retry shortly…
const MIN_SETTLE_MS = 200;
// …but never starve when repaints have no pauses at all.
const MAX_SETTLE_SKIPS = 3;

// Consecutive agreeing reads required before leaving "working".
const CONFIRM_TICKS = 2;
// The no-match fallback is weaker evidence — require one more.
const FALLBACK_CONFIRM_TICKS = 3;

// How many screen rows (from the bottom, after trimming trailing blanks) to classify.
const ROWS_EXAMINED = 10;

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 30;

/**
 * Detects Claude Code session state.
 *
 * States:
 *   - "idle"         — main prompt (❯), waiting for a new task
 *   - "working"      — agent is generating or executing tools
 *   - "needs-input"  — mid-task prompt (y/n, permission, accept edit, etc.)
 *   - "done"         — session exited (handled externally via onExit)
 *
 * Strategy:
 *   - All PTY output is fed into a headless xterm instance, so classification
 *     reads the rendered screen — the same thing the user sees. Claude Code
 *     redraws its UI with cursor positioning rather than newlines, so line
 *     structure only exists after terminal emulation; regexing the raw byte
 *     stream cannot recover it.
 *   - Starts as "idle"
 *   - Flips to "working" instantly when user sends input (markUserInput)
 *   - Polls the bottom screen rows every CLASSIFY_INTERVAL_MS in EVERY state
 *     (output flow can't be used as a signal — Claude Code repaints
 *     continuously even when waiting at a prompt; and prompts can be answered
 *     via inputs invisible to us, like mouse clicks or remote control):
 *     - Working indicator ("esc to interrupt", active spinner) → "working"
 *     - Permission/confirmation prompt → "needs-input"
 *     - Main prompt (❯) or completion status → "idle"
 *     - None of the above → "idle" (no-match fallback)
 *   - Any polled transition needs consecutive agreeing reads, so a single
 *     half-drawn frame can't flip the state.
 */
class StateDetector {
  private terminal: Terminal;
  private tickTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly onStateChange: (state: SessionState) => void;
  private readonly onTransition: ((detail: TransitionDetail) => void) | null;
  private currentState: SessionState = 'idle';
  private disposed = false;
  private lastDataAt = 0;
  private settleSkips = 0;
  private pendingState: SessionState | null = null;
  private pendingCount = 0;

  constructor(
    onStateChange: (state: SessionState) => void,
    onTransition?: (detail: TransitionDetail) => void,
    dims?: { cols: number; rows: number },
  ) {
    this.onStateChange = onStateChange;
    this.onTransition = onTransition || null;
    this.terminal = new Terminal({
      cols: dims?.cols ?? DEFAULT_COLS,
      rows: dims?.rows ?? DEFAULT_ROWS,
      scrollback: 0,
      // The buffer read API is behind this flag in headless builds
      allowProposedApi: true,
    });
    this.scheduleTick(CLASSIFY_INTERVAL_MS);
  }

  markUserInput(): void {
    if (this.disposed) return;
    if (this.currentState !== 'working') {
      this.currentState = 'working';
      this.onStateChange('working');
      // Don't log working transitions per user request
    }
    // New input means the screen is about to change — restart the
    // confirmation streak and give Claude Code time to repaint.
    this.pendingState = null;
    this.pendingCount = 0;
    this.settleSkips = 0;
    this.scheduleTick(FIRST_CLASSIFY_DELAY_MS);
  }

  feed(data: string): void {
    if (this.disposed) return;

    // Always keep the screen current, even outside "working" — otherwise
    // later classifications would see a stale or half-drawn frame.
    this.terminal.write(data);
    this.lastDataAt = Date.now();
  }

  resize(cols: number, rows: number): void {
    if (this.disposed) return;
    this.terminal.resize(cols, rows);
  }

  private scheduleTick(delay: number): void {
    if (this.tickTimer) {
      clearTimeout(this.tickTimer);
    }
    this.tickTimer = setTimeout(() => {
      this.tick();
    }, delay);
  }

  private tick(): void {
    if (this.disposed) return;

    // A repaint may be in progress — look again in a moment rather than
    // reading a half-drawn frame. Never skip forever, though: Claude Code
    // can repaint with no pauses at all.
    const sinceData = Date.now() - this.lastDataAt;
    if (sinceData < MIN_SETTLE_MS && this.settleSkips < MAX_SETTLE_SKIPS) {
      this.settleSkips++;
      this.scheduleTick(MIN_SETTLE_MS);
      return;
    }
    this.settleSkips = 0;

    this.classifyOnce();
    this.scheduleTick(CLASSIFY_INTERVAL_MS);
  }

  /** One read of the screen; transitions only after enough agreeing reads. */
  private classifyOnce(): void {
    const lastLines = this.screenLines();

    // Blank screen carries no information (e.g. just cleared) — wait.
    if (lastLines.length === 0) {
      this.pendingState = null;
      this.pendingCount = 0;
      return;
    }

    // 1. Working indicators visible on the rendered screen mean Claude is
    // active — Claude Code erases them when it finishes. This can also move
    // us INTO working (e.g. a prompt answered via mouse, or remote control).
    const workingMatch = this.findWorkingIndicator(lastLines);
    if (workingMatch) {
      this.propose('working', lastLines, workingMatch, CONFIRM_TICKS);
      return;
    }

    // 2. Check for input/permission prompts (highest priority)
    const inputMatch = this.findInputPromptMatch(lastLines);
    if (inputMatch) {
      this.propose('needs-input', lastLines, inputMatch, CONFIRM_TICKS);
      return;
    }

    // 3. Check for idle indicators
    const idleMatch = this.findIdleMatch(lastLines);
    if (idleMatch) {
      this.propose('idle', lastLines, idleMatch, CONFIRM_TICKS);
      return;
    }

    // 4. No match and no working indicators — probably idle, but weak evidence
    this.propose('idle', lastLines, 'no-match fallback', FALLBACK_CONFIRM_TICKS);
  }

  private propose(state: SessionState, lines: string[], pattern: string, needed: number): void {
    // Screen agrees with what we already report — nothing to do. (Also keeps
    // us from fighting a manual correction while the screen is unchanged.)
    if (state === this.currentState) {
      this.pendingState = null;
      this.pendingCount = 0;
      return;
    }
    if (this.pendingState === state) {
      this.pendingCount++;
    } else {
      this.pendingState = state;
      this.pendingCount = 1;
    }
    if (this.pendingCount >= needed) {
      this.pendingState = null;
      this.pendingCount = 0;
      this.transitionTo(state, lines, pattern);
    }
  }

  /**
   * Read the visible screen, joining soft-wrapped rows back into logical lines
   * (so prose wrapped at the terminal width isn't mistaken for short status-bar
   * lines). Drops trailing blank lines, returns the last few.
   */
  private screenLines(): string[] {
    const buffer = this.terminal.buffer.active;
    const lines: string[] = [];
    for (let y = 0; y < buffer.length; y++) {
      const line = buffer.getLine(y);
      if (!line) continue;
      // Keep right padding while joining — wrapped rows are full-width and a
      // trailing space at the wrap point is real content.
      const text = line.translateToString(false);
      if (line.isWrapped && lines.length > 0) {
        lines[lines.length - 1] += text;
      } else {
        lines.push(text);
      }
    }
    for (let i = 0; i < lines.length; i++) {
      lines[i] = lines[i].replace(/\s+$/, '');
    }
    while (lines.length > 0 && lines[lines.length - 1] === '') {
      lines.pop();
    }
    return lines.slice(-ROWS_EXAMINED);
  }

  private transitionTo(to: SessionState, lines: string[], matchedPattern: string): void {
    const prev = this.currentState;
    this.currentState = to;
    this.onStateChange(to);
    this.emitTransition(prev, to, lines, matchedPattern, 'settle');
  }

  /** Return the working indicator visible on screen, or null */
  private findWorkingIndicator(lines: string[]): string | null {
    for (const line of lines) {
      const trimmed = line.trim();
      // Status bar shown while the agent runs: "✶ Puttering… (esc to interrupt …)".
      // Length guard: prose merely mentioning the phrase re-joins into lines
      // longer than a status row after wrap merging.
      if (trimmed.length <= 100 && /esc\s*to\s*interrupt/i.test(trimmed)) {
        return 'esc to interrupt';
      }
      // Active progress spinner: · Verbing… / ✶ Verbing… / ✻ Verbing… etc.
      if (/^[·✢✳✶✻✽*+]\s+\S+…/.test(trimmed)) return 'spinner';
    }
    return null;
  }

  /** Find which input prompt pattern matched, return its name or null */
  private findInputPromptMatch(lines: string[]): string | null {
    const patterns: [string, RegExp][] = [
      ['y/n prompt', /\(y\/n\)\s*$/i],
      ['(Y)es confirmation', /\(Y\)es\b/],
      ['yes/no text', /yes\s*\/\s*no/i],
      ['generic > prompt', /^>\s*$/],
      // Numbered choice: ❯ 1. Yes or › 1. Yes
      ['numbered choice list', /^[›❯>]\s*\d+\.\s*/],
      // Standalone numbered items: 2. Yes — only matched if permission context present (checked below)
      ['numbered option', /^\d+\.\s*(Yes|No|Allow|Deny|Accept|Reject)\b/i],
      ['Do you want to', /Do\s*you\s*want\s*to/i],
      ['Would you like to proceed', /Would\s*you\s*like\s*to\s*proceed/i],
      ['ctrl-g Vim hint', /ctrl-g\s*to\s*edit\s*in\s*Vim/i],
      ['Type here to tell Claude', /Type\s*here\s*to\s*tell\s*Claude/i],
      // "Esc to cancel" combined with "Tab to amend" = permission prompt
      ['permission prompt (Esc+Tab)', /Esc\s*to\s*cancel.*Tab\s*to\s*amend/i],
      // Bash tool permission: "Allow" / "Deny" patterns
      ['allow/deny prompt', /^\s*(Allow|Deny)\s/i],
    ];

    for (const line of lines) {
      const trimmed = line.trim();
      for (const [name, pattern] of patterns) {
        if (pattern.test(trimmed)) {
          // These patterns can appear in Claude's output text, not just prompts.
          // Only count them if permission context (Esc to cancel, Tab to amend) is also present.
          const needsContext = ['numbered option', 'Do you want to', 'Would you like to proceed'];
          if (needsContext.includes(name) && !this.hasPermissionContext(lines)) {
            continue;
          }
          // "Esc to cancel · Tab to amend" on a long prose line is Claude discussing
          // prompts, not an actual status bar — reject lines over 80 chars
          if (name === 'permission prompt (Esc+Tab)' && trimmed.length > 80) {
            continue;
          }
          return name;
        }
      }
    }
    return null;
  }

  /** Find which idle pattern matched, return its name or null */
  private findIdleMatch(lines: string[]): string | null {
    let idleMatchName: string | null = null;

    for (const line of lines) {
      const trimmed = line.trim();
      // Main prompt: ❯ alone on the line (not followed by a digit = numbered list)
      if (/^❯\s*$/.test(trimmed)) {
        idleMatchName = 'main prompt ❯ (empty)';
      }
      // ❯ followed by non-digit text (user typing) — but NOT ❯ 1.
      else if (/^❯\s+\S/.test(trimmed) && !/^❯\s*\d+\./.test(trimmed)) {
        idleMatchName = 'main prompt ❯ (with text)';
      }
      else if (/^✻\s*\S+.*for\s*\d/.test(trimmed) || /Crunched?\s*for\s*\d/i.test(trimmed) || /Cooked?\s*for\s*\d/i.test(trimmed)) {
        idleMatchName = 'completion status ✻';
      }
      else if (/\?\s*for\s*shortcuts/i.test(trimmed)) {
        idleMatchName = 'shortcuts hint';
      }
    }

    return idleMatchName;
  }

  /** Check if lines contain permission prompt UI elements (Esc to cancel, Tab to amend) */
  private hasPermissionContext(lines: string[]): boolean {
    return lines.some(line => {
      const trimmed = line.trim();
      // Only match short status-bar lines — long lines are Claude's prose discussing prompts
      if (trimmed.length > 80) return false;
      return /Esc\s*to\s*cancel/i.test(trimmed)
        || /Tab\s*to\s*amend/i.test(trimmed);
    });
  }

  private emitTransition(
    from: SessionState,
    to: SessionState,
    lines: string[],
    matchedPattern: string | null,
    trigger: TransitionDetail['trigger'],
  ): void {
    if (this.onTransition) {
      this.onTransition({ from, to, linesExamined: lines, matchedPattern, trigger });
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.tickTimer) {
      clearTimeout(this.tickTimer);
    }
    this.terminal.dispose();
  }
}

export default StateDetector;
