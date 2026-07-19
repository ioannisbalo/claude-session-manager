import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import StateDetector, { SessionState, TransitionDetail } from './state-detector';

// Enough fake time for the post-input grace delay plus the confirmation
// ticks (including the extra tick the no-match fallback needs).
const CLASSIFY_ADVANCE_MS = 6000;

function createDetector(opts?: { onTransition?: boolean }) {
  const stateChanges: SessionState[] = [];
  const transitions: TransitionDetail[] = [];
  const onStateChange = vi.fn((state: SessionState) => stateChanges.push(state));
  const onTransition = opts?.onTransition !== false
    ? vi.fn((detail: TransitionDetail) => transitions.push(detail))
    : undefined;

  const detector = new StateDetector(onStateChange, onTransition);
  return { detector, stateChanges, transitions, onStateChange, onTransition };
}

/** Helper: put detector into working state, feed data, advance timer, return state changes */
function feedAndClassify(detector: StateDetector, data: string, stateChanges: SessionState[]) {
  detector.markUserInput();
  stateChanges.length = 0; // clear the 'working' transition
  detector.feed(data);
  vi.advanceTimersByTime(CLASSIFY_ADVANCE_MS);
}

describe('StateDetector', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  describe('initial state', () => {
    it('starts as idle and does not fire callbacks', () => {
      const { onStateChange } = createDetector();
      expect(onStateChange).not.toHaveBeenCalled();
    });
  });

  describe('markUserInput', () => {
    it('transitions from idle to working', () => {
      const { detector, stateChanges } = createDetector();
      detector.markUserInput();
      expect(stateChanges).toEqual(['working']);
    });

    it('transitions from needs-input to working', () => {
      const { detector, stateChanges } = createDetector();
      detector.markUserInput();
      detector.feed('(y/n)\n');
      vi.advanceTimersByTime(CLASSIFY_ADVANCE_MS);
      stateChanges.length = 0;

      detector.markUserInput();
      expect(stateChanges).toEqual(['working']);
    });

    it('is a no-op when already working', () => {
      const { detector, onStateChange } = createDetector();
      detector.markUserInput();
      expect(onStateChange).toHaveBeenCalledTimes(1);

      detector.markUserInput();
      expect(onStateChange).toHaveBeenCalledTimes(1);
    });
  });

  describe('feed', () => {
    it('is ignored when not in working state', () => {
      const { detector, onStateChange } = createDetector();
      detector.feed('❯ \n');
      vi.advanceTimersByTime(CLASSIFY_ADVANCE_MS);
      expect(onStateChange).not.toHaveBeenCalled();
    });

    it('accumulates output across multiple chunks', () => {
      const { detector, stateChanges } = createDetector();
      detector.markUserInput();
      stateChanges.length = 0;

      detector.feed('(y/');
      detector.feed('n)\n');
      vi.advanceTimersByTime(CLASSIFY_ADVANCE_MS);
      expect(stateChanges).toEqual(['needs-input']);
    });

    it('handles output larger than the screen — old rows scroll off, prompt still detected', () => {
      const { detector, stateChanges } = createDetector();
      detector.markUserInput();
      stateChanges.length = 0;

      // Feed 5000 chars of junk (fills and scrolls the screen), then the prompt
      detector.feed('x'.repeat(5000));
      detector.feed('\n❯ \n');
      vi.advanceTimersByTime(CLASSIFY_ADVANCE_MS);
      expect(stateChanges).toEqual(['idle']);
    });

    it('classifies even when output never goes quiet (continuous repaints, regression)', () => {
      const { detector, stateChanges } = createDetector();
      detector.markUserInput();
      stateChanges.length = 0;

      // Claude Code repaints continuously while a permission dialog sits on
      // screen — output never pauses. A quiet-wait design never classifies
      // this; the polling design must.
      const frame = '\x1b[2J\x1b[H' + [
        '   touch e2e-canary.txt',
        '   Create empty e2e-canary.txt file',
        '',
        ' Do you want to proceed?',
        ' ❯ 1. Yes',
        '   2. No',
        '',
        ' Esc to cancel · Tab to amend · ctrl+e to explain',
      ].join('\r\n');
      for (let i = 0; i < 30; i++) {
        detector.feed(frame);
        vi.advanceTimersByTime(300);
      }
      expect(stateChanges).toEqual(['needs-input']);
    });
  });

  describe('classify — needs-input patterns', () => {
    it('detects (y/n) prompt', () => {
      const { detector, stateChanges } = createDetector();
      feedAndClassify(detector, 'Do something? (y/n)\n', stateChanges);
      expect(stateChanges).toEqual(['needs-input']);
    });

    it('detects (Y)es confirmation', () => {
      const { detector, stateChanges } = createDetector();
      feedAndClassify(detector, 'Proceed? (Y)es / (N)o\n', stateChanges);
      expect(stateChanges).toEqual(['needs-input']);
    });

    it('detects yes/no text', () => {
      const { detector, stateChanges } = createDetector();
      feedAndClassify(detector, 'yes / no\n', stateChanges);
      expect(stateChanges).toEqual(['needs-input']);
    });

    it('detects generic > prompt', () => {
      const { detector, stateChanges } = createDetector();
      feedAndClassify(detector, '> \n', stateChanges);
      expect(stateChanges).toEqual(['needs-input']);
    });

    it('detects numbered choice list with ❯', () => {
      const { detector, stateChanges } = createDetector();
      feedAndClassify(detector, '❯ 1. Yes\n', stateChanges);
      expect(stateChanges).toEqual(['needs-input']);
    });

    it('detects numbered choice list with ›', () => {
      const { detector, stateChanges } = createDetector();
      feedAndClassify(detector, '› 2. Allow\n', stateChanges);
      expect(stateChanges).toEqual(['needs-input']);
    });

    it('detects numbered option WITH permission context', () => {
      const { detector, stateChanges } = createDetector();
      feedAndClassify(detector, '1. Yes\nEsc to cancel\n', stateChanges);
      expect(stateChanges).toEqual(['needs-input']);
    });

    it('does NOT detect numbered option WITHOUT permission context (falls to idle)', () => {
      const { detector, stateChanges } = createDetector();
      feedAndClassify(detector, '1. Yes\nSome other text\n', stateChanges);
      expect(stateChanges).toEqual(['idle']);
    });

    it('detects "Do you want to" WITH permission context', () => {
      const { detector, stateChanges } = createDetector();
      feedAndClassify(detector, 'Do you want to proceed?\nTab to amend\n', stateChanges);
      expect(stateChanges).toEqual(['needs-input']);
    });

    it('does NOT detect "Do you want to" WITHOUT permission context (falls to idle)', () => {
      const { detector, stateChanges } = createDetector();
      feedAndClassify(detector, 'Do you want to proceed?\n', stateChanges);
      expect(stateChanges).toEqual(['idle']);
    });

    it('detects "Would you like to proceed" WITH permission context', () => {
      const { detector, stateChanges } = createDetector();
      feedAndClassify(detector, 'Would you like to proceed?\nEsc to cancel\n', stateChanges);
      expect(stateChanges).toEqual(['needs-input']);
    });

    it('does NOT detect "Would you like to proceed" WITHOUT permission context (falls to idle)', () => {
      const { detector, stateChanges } = createDetector();
      feedAndClassify(detector, 'Would you like to proceed?\n', stateChanges);
      expect(stateChanges).toEqual(['idle']);
    });

    it('detects ctrl-g Vim hint', () => {
      const { detector, stateChanges } = createDetector();
      feedAndClassify(detector, 'ctrl-g to edit in Vim\n', stateChanges);
      expect(stateChanges).toEqual(['needs-input']);
    });

    it('detects "Type here to tell Claude"', () => {
      const { detector, stateChanges } = createDetector();
      feedAndClassify(detector, 'Type here to tell Claude what to do\n', stateChanges);
      expect(stateChanges).toEqual(['needs-input']);
    });

    it('detects permission prompt with Esc+Tab', () => {
      const { detector, stateChanges } = createDetector();
      feedAndClassify(detector, 'Esc to cancel | Tab to amend\n', stateChanges);
      expect(stateChanges).toEqual(['needs-input']);
    });

    it('detects Allow/Deny prompt', () => {
      const { detector, stateChanges } = createDetector();
      feedAndClassify(detector, '  Allow this action\n', stateChanges);
      expect(stateChanges).toEqual(['needs-input']);
    });
  });

  describe('classify — idle patterns', () => {
    it('detects main prompt ❯ alone', () => {
      const { detector, stateChanges } = createDetector();
      feedAndClassify(detector, '\n❯ \n', stateChanges);
      expect(stateChanges).toEqual(['idle']);
    });

    it('detects main prompt ❯ with non-digit text', () => {
      const { detector, stateChanges } = createDetector();
      feedAndClassify(detector, '\n❯ some text\n', stateChanges);
      expect(stateChanges).toEqual(['idle']);
    });

    it('does NOT detect ❯ followed by digit as idle (it is a numbered list)', () => {
      const { detector, stateChanges } = createDetector();
      feedAndClassify(detector, '\n❯ 1. Yes\n', stateChanges);
      // Should be needs-input (numbered choice list), not idle
      expect(stateChanges).toEqual(['needs-input']);
    });

    it('detects completion status ✻', () => {
      const { detector, stateChanges } = createDetector();
      feedAndClassify(detector, '✻ Task completed for 5s\n', stateChanges);
      expect(stateChanges).toEqual(['idle']);
    });

    it('detects "Crunched for" pattern', () => {
      const { detector, stateChanges } = createDetector();
      feedAndClassify(detector, 'Crunched for 3s\n', stateChanges);
      expect(stateChanges).toEqual(['idle']);
    });

    it('detects "Cooked for" pattern', () => {
      const { detector, stateChanges } = createDetector();
      feedAndClassify(detector, 'Cooked for 2s\n', stateChanges);
      expect(stateChanges).toEqual(['idle']);
    });

    it('detects "? for shortcuts" hint', () => {
      const { detector, stateChanges } = createDetector();
      feedAndClassify(detector, '? for shortcuts\n', stateChanges);
      expect(stateChanges).toEqual(['idle']);
    });
  });

  describe('classify — working indicators on screen', () => {
    it('stays working when "esc to interrupt" is visible (even with ❯ above it)', () => {
      const { detector, stateChanges } = createDetector();
      feedAndClassify(detector, '❯\xa0 \r\r\nesc to interrupt\r\r\n', stateChanges);
      expect(stateChanges).toEqual([]);
    });

    it('stays working when "esc to interrupt" is visible below the input box', () => {
      const { detector, stateChanges } = createDetector();
      // Real-world case: while working, the ❯ input box stays visible alongside the status bar
      const data = [
        '❯\xa0 \r\r',
        '──────────────────────────────────────────────────',
        'esc to interrupt\r\r',
        '\rtabs=process_all(csv_data)\r',
        'esc to interrupt\r\r',
        '',
      ].join('\n');
      feedAndClassify(detector, data, stateChanges);
      expect(stateChanges).toEqual([]);
    });

    it('classifies as idle once the working status bar is erased from the screen', () => {
      const { detector, stateChanges } = createDetector();
      // Claude was working (esc to interrupt visible)…
      feedAndClassify(detector, '✶ Puttering… (esc to interrupt)\n', stateChanges);
      expect(stateChanges).toEqual([]);

      // …then it finishes: the working status bar is erased and the idle prompt drawn.
      // (Claude Code repaints that screen region; simulate with a clear + redraw.)
      const finalFrame = '\x1b[2J\x1b[H' + [
        'some output',
        '✻ Task completed for 5s',
        '──────────────────────────────────────────────────',
        '❯ ',
        '──────────────────────────────────────────────────',
        '? for shortcuts',
      ].join('\r\n');
      detector.feed(finalFrame);
      vi.advanceTimersByTime(CLASSIFY_ADVANCE_MS);
      expect(stateChanges).toEqual(['idle']);
    });

    it('classifies as idle when "esc to interrupt" is NOT present', () => {
      const { detector, stateChanges } = createDetector();
      feedAndClassify(detector, '❯ \n? for shortcuts\n', stateChanges);
      expect(stateChanges).toEqual(['idle']);
    });

    it('keeps re-checking while stuck on a working screen without flipping state', () => {
      const { detector, stateChanges } = createDetector();
      feedAndClassify(detector, '✶ Puttering… (esc to interrupt)\n', stateChanges);
      // No further output: the re-armed quiet timer keeps re-classifying,
      // but the screen still shows a working indicator — no transition.
      vi.advanceTimersByTime(CLASSIFY_ADVANCE_MS * 10);
      expect(stateChanges).toEqual([]);
    });
  });

  describe('classify — permission context strictness', () => {
    it('does NOT match permission context in long prose lines (falls to idle)', () => {
      const { detector, stateChanges } = createDetector();
      // Claude discussing permission prompts in its output — line is >80 chars
      const data = [
        '2. hasPermissionContext guard on idle transitions — Both settle() and settleStale() now check if permission indicators ("Esc to cancel", "Tab to amend") are present',
        'Do you want to proceed with the changes?',
      ].join('\n');
      feedAndClassify(detector, data, stateChanges);
      // "Do you want to" lacks valid short-line permission context,
      // and "permission prompt (Esc+Tab)" is on a line >80 chars — falls to idle
      expect(stateChanges).toEqual(['idle']);
    });

    it('matches permission context on short status-bar lines', () => {
      const { detector, stateChanges } = createDetector();
      const data = [
        'Do you want to proceed?',
        'Esc to cancel · Tab to amend',
      ].join('\n');
      feedAndClassify(detector, data, stateChanges);
      expect(stateChanges).toEqual(['needs-input']);
    });
  });

  describe('classify — no match fallback', () => {
    it('falls through to idle when output has no recognizable pattern and no spinner', () => {
      const { detector, stateChanges } = createDetector();
      feedAndClassify(detector, 'Running tool: execute_bash\nSome output here\n', stateChanges);
      expect(stateChanges).toEqual(['idle']);
    });

    it('stays working when spinner is present on a recent line', () => {
      const { detector, stateChanges } = createDetector();
      feedAndClassify(detector, 'some output\n· Computing…\n', stateChanges);
      expect(stateChanges).toEqual([]);
    });

    it('stays working when ✶ spinner is present', () => {
      const { detector, stateChanges } = createDetector();
      feedAndClassify(detector, 'some output\n✶ Crafting… (running stop hook)\n', stateChanges);
      expect(stateChanges).toEqual([]);
    });

    it('does not classify when no feed() is called after markUserInput()', () => {
      const { detector, onStateChange } = createDetector();
      detector.markUserInput();
      vi.advanceTimersByTime(CLASSIFY_ADVANCE_MS * 10);
      // Only the initial working transition, no classification
      expect(onStateChange).toHaveBeenCalledTimes(1);
      expect(onStateChange).toHaveBeenCalledWith('working');
    });
  });

  describe('classification priority', () => {
    it('needs-input takes priority over idle when both patterns present', () => {
      const { detector, stateChanges } = createDetector();
      feedAndClassify(detector, '(y/n)\n❯ \n', stateChanges);
      expect(stateChanges).toEqual(['needs-input']);
    });
  });

  describe('terminal emulation', () => {
    it('handles CSI color codes and still detects idle prompt', () => {
      const { detector, stateChanges } = createDetector();
      // Green-colored ❯ prompt
      feedAndClassify(detector, '\x1b[32m❯\x1b[0m \n', stateChanges);
      expect(stateChanges).toEqual(['idle']);
    });

    it('handles CSI cursor-forward without corrupting the line', () => {
      const { detector, stateChanges } = createDetector();
      // "❯" followed by cursor-forward then space
      feedAndClassify(detector, '❯\x1b[5C \n', stateChanges);
      expect(stateChanges).toEqual(['idle']);
    });

    it('ignores OSC sequences and still detects pattern', () => {
      const { detector, stateChanges } = createDetector();
      feedAndClassify(detector, '\x1b]0;window title\x07❯ \n', stateChanges);
      expect(stateChanges).toEqual(['idle']);
    });

    it('handles styled needs-input patterns', () => {
      const { detector, stateChanges } = createDetector();
      feedAndClassify(detector, '\x1b[1m(y/n)\x1b[0m\n', stateChanges);
      expect(stateChanges).toEqual(['needs-input']);
    });

    it('detects a permission prompt drawn with cursor positioning, not newlines (regression)', () => {
      const { detector, stateChanges } = createDetector();
      // Claude Code repaints its UI with absolute cursor moves — the raw byte
      // stream contains no \n between these rows. The old regex-strip approach
      // fused them into one giant line and classified "no-match fallback".
      const frame =
        '\x1b[2J' +
        '\x1b[3;1HDo you want to make this edit to poc_navigate.py?' +
        '\x1b[4;1H\x1b[36m❯\x1b[0m 1. Yes' +
        '\x1b[5;3H2. Yes, allow all edits during this session (shift+tab)' +
        '\x1b[6;3H3. No' +
        '\x1b[7;1HEsc to cancel · Tab to amend';
      feedAndClassify(detector, frame, stateChanges);
      expect(stateChanges).toEqual(['needs-input']);
    });

    it('rejoins soft-wrapped prose so it is not mistaken for a status bar', () => {
      const { detector, stateChanges } = createDetector();
      // A prose line longer than the terminal width mentioning "Tab to amend":
      // the wrapped tail lands on its own screen row and would look like a
      // short status-bar line if rows were read individually.
      const prose = 'The permission dialog normally shows options like allow and deny and hints such as '
        + '"Esc to cancel" and "Tab to amend" so users know how to respond to it quickly.';
      feedAndClassify(detector, `${prose}\r\nDo you want to proceed with the changes?\r\n`, stateChanges);
      expect(stateChanges).toEqual(['idle']);
    });

    it('still classifies correctly after a resize', () => {
      const { detector, stateChanges } = createDetector();
      detector.resize(80, 24);
      feedAndClassify(detector, 'Do you want to proceed?\r\nEsc to cancel · Tab to amend\r\n', stateChanges);
      expect(stateChanges).toEqual(['needs-input']);
    });
  });

  describe('transition details', () => {
    it('reports correct transition detail on state change', () => {
      const { detector, stateChanges, transitions } = createDetector();
      feedAndClassify(detector, '(y/n)\n', stateChanges);

      expect(transitions).toHaveLength(1);
      expect(transitions[0].from).toBe('working');
      expect(transitions[0].to).toBe('needs-input');
      expect(transitions[0].matchedPattern).toBe('y/n prompt');
      expect(transitions[0].trigger).toBe('settle');
      expect(transitions[0].linesExamined.length).toBeGreaterThan(0);
    });

    it('works without onTransition callback', () => {
      const stateChanges: SessionState[] = [];
      const detector = new StateDetector((state) => stateChanges.push(state));
      detector.markUserInput();
      stateChanges.length = 0;
      detector.feed('(y/n)\n');
      vi.advanceTimersByTime(CLASSIFY_ADVANCE_MS);
      // Should not throw
      expect(stateChanges).toEqual(['needs-input']);
    });
  });

  describe('polling outside the working state', () => {
    const dialogFrame = '\x1b[2J\x1b[H' + [
      '   touch e2e-canary.txt',
      '',
      ' Do you want to proceed?',
      ' ❯ 1. Yes',
      '   2. No',
      '',
      ' Esc to cancel · Tab to amend · ctrl+e to explain',
    ].join('\r\n');

    it('leaves needs-input when the dialog is dismissed without observable input (mouse answer, regression)', () => {
      const { detector, stateChanges } = createDetector();
      feedAndClassify(detector, dialogFrame, stateChanges);
      expect(stateChanges).toEqual(['needs-input']);

      // The user answers by clicking an option — no markUserInput fires.
      // Claude redraws the idle prompt; polling must pick it up.
      stateChanges.length = 0;
      detector.feed('\x1b[2J\x1b[H❯ \r\n? for shortcuts\r\n');
      vi.advanceTimersByTime(CLASSIFY_ADVANCE_MS);
      expect(stateChanges).toEqual(['idle']);
    });

    it('moves needs-input → working when the answer starts a tool run', () => {
      const { detector, stateChanges } = createDetector();
      feedAndClassify(detector, dialogFrame, stateChanges);
      expect(stateChanges).toEqual(['needs-input']);

      stateChanges.length = 0;
      detector.feed('\x1b[2J\x1b[H✶ Running… (esc to interrupt)\r\n');
      vi.advanceTimersByTime(CLASSIFY_ADVANCE_MS);
      expect(stateChanges).toEqual(['working']);
    });

    it('moves idle → working when work starts without local input (remote control)', () => {
      const { detector, stateChanges } = createDetector();
      // Session sits at the idle prompt; work starts via the phone
      detector.feed('❯ \r\n? for shortcuts\r\n');
      vi.advanceTimersByTime(CLASSIFY_ADVANCE_MS);
      expect(stateChanges).toEqual([]);

      detector.feed('\x1b[2J\x1b[H✢ Hashing…\r\n  ⏸ manual mode on · esc to interrupt\r\n');
      vi.advanceTimersByTime(CLASSIFY_ADVANCE_MS);
      expect(stateChanges).toEqual(['working']);
    });

    it('does not treat prose mentioning "esc to interrupt" as working while idle', () => {
      const { detector, stateChanges } = createDetector();
      // Claude's answer discusses the working status bar; the wrapped prose
      // line re-joins to well over a status row's length.
      const prose = 'The working status bar normally shows a spinner and the hint esc to interrupt so that '
        + 'the user always knows they can stop the agent at any point while it is busy running tools.';
      detector.feed(`${prose}\r\n❯ \r\n? for shortcuts\r\n`);
      vi.advanceTimersByTime(CLASSIFY_ADVANCE_MS);
      expect(stateChanges).toEqual([]);
    });
  });

  describe('screen persistence across classifications', () => {
    it('classifies from the live screen on each settle', () => {
      const { detector, stateChanges } = createDetector();
      // First: classify as idle
      feedAndClassify(detector, '❯ \n', stateChanges);
      expect(stateChanges).toEqual(['idle']);

      // Second: mark input; the new frame erases the old prompt and shows a
      // working status bar — must stay working, not re-match the stale ❯
      detector.markUserInput();
      stateChanges.length = 0;
      detector.feed('\x1b[2J\x1b[H✶ Thinking… (esc to interrupt)\r\n');
      vi.advanceTimersByTime(CLASSIFY_ADVANCE_MS);
      expect(stateChanges).toEqual([]);

      // Third: the working bar is erased and the prompt returns — idle again
      detector.feed('\x1b[2J\x1b[Hdone output\r\n❯ \r\n');
      vi.advanceTimersByTime(CLASSIFY_ADVANCE_MS);
      expect(stateChanges).toEqual(['idle']);
    });
  });

  describe('dispose', () => {
    it('prevents pending classification from firing', () => {
      const { detector, stateChanges } = createDetector();
      detector.markUserInput();
      stateChanges.length = 0;

      detector.feed('❯ \n');
      detector.dispose();
      vi.advanceTimersByTime(CLASSIFY_ADVANCE_MS);
      // Timer was cleared, so no classification
      expect(stateChanges).toEqual([]);
    });
  });
});
