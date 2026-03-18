export type SessionState = 'working' | 'needs-input' | 'idle' | 'done';

export interface TransitionDetail {
  from: SessionState;
  to: SessionState;
  linesExamined: string[];
  matchedPattern: string | null;
  trigger: 'settle' | 'stale-fallback' | 'user-input' | 'exit';
}

const SETTLE_DELAY_MS = 200;
const STALE_WORKING_MS = 3000;

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
 *   - Starts as "idle"
 *   - Flips to "working" when user sends input (markUserInput)
 *   - After output settles, checks for prompt type:
 *     - Main prompt (❯) → "idle"
 *     - Confirmation/question prompt → "needs-input"
 */
class StateDetector {
  private recentOutput: string = '';
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  private staleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly onStateChange: (state: SessionState) => void;
  private readonly onTransition: ((detail: TransitionDetail) => void) | null;
  private currentState: SessionState = 'idle';

  constructor(
    onStateChange: (state: SessionState) => void,
    onTransition?: (detail: TransitionDetail) => void,
  ) {
    this.onStateChange = onStateChange;
    this.onTransition = onTransition || null;
  }

  markUserInput(): void {
    if (this.currentState !== 'working') {
      const prev = this.currentState;
      this.currentState = 'working';
      this.onStateChange('working');
      // Don't log working transitions per user request
    }
  }

  feed(data: string): void {
    if (this.currentState !== 'working') return;

    this.recentOutput += data;
    if (this.recentOutput.length > 4096) {
      this.recentOutput = this.recentOutput.slice(-2048);
    }

    if (this.settleTimer) {
      clearTimeout(this.settleTimer);
    }
    if (this.staleTimer) {
      clearTimeout(this.staleTimer);
    }

    this.settleTimer = setTimeout(() => {
      this.settle();
    }, SETTLE_DELAY_MS);

    this.staleTimer = setTimeout(() => {
      this.settleStale();
    }, STALE_WORKING_MS);
  }

  private settle(): void {
    const stripped = this.stripAnsi(this.recentOutput);
    const lastLines = stripped.split('\n').slice(-10);

    const inputMatch = this.findInputPromptMatch(lastLines);
    if (inputMatch) {
      const prev = this.currentState;
      this.recentOutput = '';
      this.currentState = 'needs-input';
      this.onStateChange('needs-input');
      this.emitTransition(prev, 'needs-input', lastLines, inputMatch, 'settle');
      return;
    }

    const idleMatch = this.findIdleMatch(lastLines);
    if (idleMatch) {
      const prev = this.currentState;
      this.recentOutput = '';
      this.currentState = 'idle';
      this.onStateChange('idle');
      this.emitTransition(prev, 'idle', lastLines, idleMatch, 'settle');
      return;
    }

    if (lastLines.some(line => this.isWorkingHint(line))) {
      // Confirmed still working — don't change state, just clear buffer
      this.recentOutput = '';
    }
  }

  /** Find which input prompt pattern matched, return its name or null */
  private findInputPromptMatch(lines: string[]): string | null {
    // Space-tolerant patterns: ANSI stripping can collapse spaces,
    // so we match with \s* where spaces may be missing
    const patterns: [string, RegExp][] = [
      ['y/n prompt', /\(y\/n\)\s*$/i],
      ['(Y)es confirmation', /\(Y\)es\b/],
      ['yes/no text', /yes\s*\/\s*no/i],
      ['generic > prompt', /^>\s*$/],
      // Numbered choice: ❯1.Yes or ❯ 1. Yes or › 1. Yes
      ['numbered choice list', /^[›❯>]\s*\d+\.\s*/],
      // Standalone numbered items: 2.Yes or 2. Yes
      ['numbered option', /^\d+\.\s*(Yes|No|Allow|Deny|Skip|Accept|Reject)\b/i],
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
          return name;
        }
      }
    }
    return null;
  }

  /** Find which idle pattern matched, return its name or null */
  private findIdleMatch(lines: string[]): string | null {
    for (const line of lines) {
      const trimmed = line.trim();
      // Main prompt: ❯ alone on the line (not followed by a digit = numbered list)
      if (/^❯\s*$/.test(trimmed)) {
        return 'main prompt ❯ (empty)';
      }
      // ❯ followed by non-digit text (user typing) — but NOT ❯1. or ❯ 1.
      if (/^❯\s+\S/.test(trimmed) && !/^❯\s*\d+\./.test(trimmed)) {
        return 'main prompt ❯ (with text)';
      }
      if (/^✻\s*\S+.*for\s*\d/.test(trimmed) || /Crunched?\s*for\s*\d/i.test(trimmed) || /Cooked?\s*for\s*\d/i.test(trimmed)) {
        return 'completion status ✻';
      }
      if (/\?\s*for\s*shortcuts/i.test(trimmed)) {
        return 'shortcuts hint';
      }
    }
    return null;
  }

  /** Claude Code working hints — appear while Claude is generating */
  private isWorkingHint(line: string): boolean {
    const trimmed = line.trim();
    return /Esc\s*to\s*(cancel|interrupt)/i.test(trimmed)
      && !/Tab\s*to\s*amend/i.test(trimmed); // If "Tab to amend" is also present, it's a permission prompt, not working
  }

  /** Aggressively check for idle when output has been stale for a while */
  private settleStale(): void {
    if (this.currentState !== 'working') return;

    const stripped = this.stripAnsi(this.recentOutput);
    const lastLines = stripped.split('\n').slice(-10);

    // First check for input prompts — they take priority even in stale mode
    const inputMatch = this.findInputPromptMatch(lastLines);
    if (inputMatch) {
      const prev = this.currentState;
      this.recentOutput = '';
      this.currentState = 'needs-input';
      this.onStateChange('needs-input');
      this.emitTransition(prev, 'needs-input', lastLines, inputMatch, 'stale-fallback');
      return;
    }

    // Only match ❯ as idle if it's genuinely the main prompt (alone on a line),
    // not part of a numbered choice list like ❯ 1. Yes
    const mainPromptRegex = /^❯\s*$/m;
    if (mainPromptRegex.test(stripped)) {
      const prev = this.currentState;
      this.recentOutput = '';
      this.currentState = 'idle';
      this.onStateChange('idle');
      this.emitTransition(prev, 'idle', lastLines, 'stale ❯ (standalone)', 'stale-fallback');
    }
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

  private stripAnsi(str: string): string {
    return str
      // CSI cursor-forward sequences: replace with a space to preserve word boundaries
      .replace(/\x1b\[\d*C/g, ' ')
      // CSI sequences: \x1b[ with optional intermediate bytes (?, !, >) then params then final byte
      .replace(/\x1b\[[?!>]*[0-9;]*[a-zA-Z~@`]/g, '')
      // OSC sequences: \x1b] ... BEL or ST
      .replace(/\x1b\].*?(\x07|\x1b\\)/g, '')
      // Charset/designate sequences: \x1b( \x1b) \x1b# etc.
      .replace(/\x1b[()#][0-9A-Za-z]/g, '')
      // Other single-char escape sequences: \x1bM, \x1b=, \x1b>, etc.
      .replace(/\x1b[A-Za-z=<>]/g, '');
  }

  dispose(): void {
    if (this.settleTimer) {
      clearTimeout(this.settleTimer);
    }
    if (this.staleTimer) {
      clearTimeout(this.staleTimer);
    }
  }
}

export default StateDetector;
