export type SessionState = 'working' | 'needs-input' | 'idle' | 'done';

export interface TransitionDetail {
  from: SessionState;
  to: SessionState;
  linesExamined: string[];
  matchedPattern: string | null;
  trigger: 'settle' | 'stale-fallback' | 'user-input' | 'exit';
}

// Wait for output to fully stop before classifying.
// If text is still arriving, it's always "working".
const QUIET_DELAY_MS = 1500;

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
 *   - While output is flowing, stays "working" — no classification attempted
 *   - Once output goes quiet (no data for QUIET_DELAY_MS), classifies based on last lines:
 *     - Permission/confirmation prompt → "needs-input"
 *     - Main prompt (❯) or completion status → "idle"
 *     - Neither → stays "working" (e.g. long tool execution with no output)
 */
class StateDetector {
  private recentOutput: string = '';
  private quietTimer: ReturnType<typeof setTimeout> | null = null;
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

    // Reset the quiet timer — output is still flowing, so we're definitely working
    if (this.quietTimer) {
      clearTimeout(this.quietTimer);
    }

    this.quietTimer = setTimeout(() => {
      this.classify();
    }, QUIET_DELAY_MS);
  }

  /** Called once output has been quiet for QUIET_DELAY_MS. Classify the final state. */
  private classify(): void {
    if (this.currentState !== 'working') return;

    const stripped = this.stripAnsi(this.recentOutput);
    const lastLines = stripped.split('\n').slice(-10);

    // 1. Check for input/permission prompts first (highest priority)
    const inputMatch = this.findInputPromptMatch(lastLines);
    if (inputMatch) {
      const prev = this.currentState;
      this.recentOutput = '';
      this.currentState = 'needs-input';
      this.onStateChange('needs-input');
      this.emitTransition(prev, 'needs-input', lastLines, inputMatch, 'settle');
      return;
    }

    // 2. Check for idle indicators
    const idleMatch = this.findIdleMatch(lastLines);
    if (idleMatch) {
      const prev = this.currentState;
      this.recentOutput = '';
      this.currentState = 'idle';
      this.onStateChange('idle');
      this.emitTransition(prev, 'idle', lastLines, idleMatch, 'settle');
      return;
    }

    // 3. No match — stay working (e.g. long-running tool with no recent output)
    // Don't clear the buffer so we can re-classify when more output arrives
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
      // Standalone numbered items: 2.Yes or 2. Yes — only matched if permission context present (checked below)
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

  /** Check if lines contain permission prompt UI elements (Esc to cancel, Tab to amend) */
  private hasPermissionContext(lines: string[]): boolean {
    return lines.some(line => {
      const trimmed = line.trim();
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
    if (this.quietTimer) {
      clearTimeout(this.quietTimer);
    }
  }
}

export default StateDetector;
