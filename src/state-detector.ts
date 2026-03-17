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

    if (lastLines.some(line => this.isMainPrompt(line))) {
      this.recentOutput = '';
      this.currentState = 'idle';
      this.onStateChange('idle');
    } else if (lastLines.some(line => this.isInputPrompt(line))) {
      this.recentOutput = '';
      this.currentState = 'needs-input';
      this.onStateChange('needs-input');
    }
  }

  /** Main idle prompt — Claude is waiting for a new task */
  private isMainPrompt(line: string): boolean {
    const trimmed = line.trim();
    return /^[❯]\s*$/.test(trimmed) || /^[❯]\s+\S/.test(trimmed);
  }

  /** Mid-task prompt — Claude needs confirmation/selection */
  private isInputPrompt(line: string): boolean {
    const trimmed = line.trim();
    const patterns: RegExp[] = [
      /\(y\/n\)\s*$/i,           // yes/no prompt
      /\(Y\)es\b/,               // Yes/No confirmation
      /\byes\/no\b/i,            // yes/no text
      /\baccept\b/i,             // accept edit prompts
      /\breject\b/i,             // reject edit prompts
      /\ballow\b/i,              // permission prompts
      /\bdeny\b/i,               // permission prompts
      /^>\s*$/,                  // generic > prompt (not ❯)
      /\?\s*$/,                  // ends with ?
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