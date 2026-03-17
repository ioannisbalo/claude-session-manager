export type SessionState = 'working' | 'needs-input' | 'idle' | 'done';

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
  private currentState: SessionState = 'idle';

  constructor(onStateChange: (state: SessionState) => void) {
    this.onStateChange = onStateChange;
  }

  markUserInput(): void {
    if (this.currentState !== 'working') {
      this.currentState = 'working';
      this.onStateChange('working');
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
    const lastLines = stripped.split('\n').slice(-6);

    const hasInputPrompt = lastLines.some(line => this.isInputPrompt(line));

    if (hasInputPrompt) {
      // Input prompts take highest priority — numbered choices, y/n, etc.
      this.recentOutput = '';
      this.currentState = 'needs-input';
      this.onStateChange('needs-input');
    } else if (lastLines.some(line => this.isMainPrompt(line) || this.isCompletionStatus(line) || this.isIdleHint(line))) {
      this.recentOutput = '';
      this.currentState = 'idle';
      this.onStateChange('idle');
    } else if (lastLines.some(line => this.isWorkingHint(line))) {
      // Confirmed still working — don't change state, just clear buffer
      this.recentOutput = '';
    }
  }

  /** Main idle prompt — Claude is waiting for a new task */
  private isMainPrompt(line: string): boolean {
    const trimmed = line.trim();
    return /^[❯]\s*$/.test(trimmed) || /^[❯]\s+\S/.test(trimmed);
  }

  /** Claude Code status line indicating task completion (e.g. "✻ Crunched for 55s") */
  private isCompletionStatus(line: string): boolean {
    const trimmed = line.trim();
    return /^✻\s+\S+.*\bfor\b\s+\d/.test(trimmed);
  }

  /** Claude Code idle hints — appear when Claude is at the main prompt */
  private isIdleHint(line: string): boolean {
    const trimmed = line.trim();
    return /\?\s+for shortcuts\b/.test(trimmed)
      || /\bTab to amend\b/.test(trimmed)
      || /\bctrl\+e to explain\b/.test(trimmed)
      || /\bplan mode\b/i.test(trimmed);
  }

  /** Claude Code working hints — appear while Claude is generating */
  private isWorkingHint(line: string): boolean {
    const trimmed = line.trim();
    return /\bEsc to (cancel|interrupt)\b/.test(trimmed);
  }

  /** Mid-task prompt — Claude needs confirmation/selection */
  private isInputPrompt(line: string): boolean {
    const trimmed = line.trim();
    const patterns: RegExp[] = [
      /\(y\/n\)\s*$/i,           // yes/no prompt
      /\(Y\)es\b/,               // Yes/No confirmation
      /\byes\/no\b/i,            // yes/no text
      /^>\s*$/,                  // generic > prompt (not ❯)
      /^[›❯>]\s*\d+\.\s/,       // numbered choice list (› 1. Yes)
      /^\d+\.\s+(Yes|No)\b/,    // numbered Yes/No options
      /Do you want to/i,         // "Do you want to make this edit..."
      /Would you like to proceed/i,  // plan execution confirmation
      /ctrl-g to edit in Vim/i,      // plan confirmation hint line
      /Type here to tell Claude/i,   // plan revision option
    ];

    return patterns.some(pattern => pattern.test(trimmed));
  }

  /** Aggressively check for idle when output has been stale for a while */
  private settleStale(): void {
    if (this.currentState !== 'working') return;

    const stripped = this.stripAnsi(this.recentOutput);
    // Search the entire accumulated output for the prompt, not just last 6 lines
    if (stripped.includes('❯')) {
      this.recentOutput = '';
      this.currentState = 'idle';
      this.onStateChange('idle');
    }
  }

  private stripAnsi(str: string): string {
    return str
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