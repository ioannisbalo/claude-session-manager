import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import StateDetector, { SessionState, TransitionDetail } from './state-detector';

const QUIET_DELAY_MS = 1500;

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
  vi.advanceTimersByTime(QUIET_DELAY_MS);
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
      vi.advanceTimersByTime(QUIET_DELAY_MS);
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
      vi.advanceTimersByTime(QUIET_DELAY_MS);
      expect(onStateChange).not.toHaveBeenCalled();
    });

    it('accumulates output across multiple chunks', () => {
      const { detector, stateChanges } = createDetector();
      detector.markUserInput();
      stateChanges.length = 0;

      detector.feed('(y/');
      detector.feed('n)\n');
      vi.advanceTimersByTime(QUIET_DELAY_MS);
      expect(stateChanges).toEqual(['needs-input']);
    });

    it('truncates buffer when exceeding 4096 chars', () => {
      const { detector, stateChanges } = createDetector();
      detector.markUserInput();
      stateChanges.length = 0;

      // Feed 5000 chars of junk, then the pattern at the end
      detector.feed('x'.repeat(5000));
      detector.feed('\n❯ \n');
      vi.advanceTimersByTime(QUIET_DELAY_MS);
      // Buffer should have been truncated but pattern is at the end, so it should still match
      expect(stateChanges).toEqual(['idle']);
    });

    it('resets the quiet timer on each call', () => {
      const { detector, stateChanges } = createDetector();
      detector.markUserInput();
      stateChanges.length = 0;

      detector.feed('some output');
      vi.advanceTimersByTime(1000);
      // Feed more data before timer fires
      detector.feed('\n❯ \n');
      vi.advanceTimersByTime(1000);
      // Only 1000ms since last feed — should not have classified yet
      expect(stateChanges).toEqual([]);

      vi.advanceTimersByTime(500);
      // Now 1500ms since last feed — should classify
      expect(stateChanges).toEqual(['idle']);
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

    it('does NOT detect numbered option WITHOUT permission context', () => {
      const { detector, stateChanges } = createDetector();
      feedAndClassify(detector, '1. Yes\nSome other text\n', stateChanges);
      expect(stateChanges).toEqual([]);
    });

    it('detects "Do you want to" WITH permission context', () => {
      const { detector, stateChanges } = createDetector();
      feedAndClassify(detector, 'Do you want to proceed?\nTab to amend\n', stateChanges);
      expect(stateChanges).toEqual(['needs-input']);
    });

    it('does NOT detect "Do you want to" WITHOUT permission context', () => {
      const { detector, stateChanges } = createDetector();
      feedAndClassify(detector, 'Do you want to proceed?\n', stateChanges);
      expect(stateChanges).toEqual([]);
    });

    it('detects "Would you like to proceed" WITH permission context', () => {
      const { detector, stateChanges } = createDetector();
      feedAndClassify(detector, 'Would you like to proceed?\nEsc to cancel\n', stateChanges);
      expect(stateChanges).toEqual(['needs-input']);
    });

    it('does NOT detect "Would you like to proceed" WITHOUT permission context', () => {
      const { detector, stateChanges } = createDetector();
      feedAndClassify(detector, 'Would you like to proceed?\n', stateChanges);
      expect(stateChanges).toEqual([]);
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

  describe('classify — no match', () => {
    it('stays working when output has no recognizable pattern', () => {
      const { detector, stateChanges } = createDetector();
      feedAndClassify(detector, 'Running tool: execute_bash\nSome output here\n', stateChanges);
      expect(stateChanges).toEqual([]);
    });

    it('does not classify when no feed() is called after markUserInput()', () => {
      const { detector, onStateChange } = createDetector();
      detector.markUserInput();
      vi.advanceTimersByTime(QUIET_DELAY_MS * 10);
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

  describe('ANSI stripping', () => {
    it('strips CSI color codes and still detects idle prompt', () => {
      const { detector, stateChanges } = createDetector();
      // Green-colored ❯ prompt
      feedAndClassify(detector, '\x1b[32m❯\x1b[0m \n', stateChanges);
      expect(stateChanges).toEqual(['idle']);
    });

    it('replaces CSI cursor-forward with space to preserve word boundaries', () => {
      const { detector, stateChanges } = createDetector();
      // "❯" followed by cursor-forward then space
      feedAndClassify(detector, '❯\x1b[5C \n', stateChanges);
      expect(stateChanges).toEqual(['idle']);
    });

    it('strips OSC sequences and still detects pattern', () => {
      const { detector, stateChanges } = createDetector();
      feedAndClassify(detector, '\x1b]0;window title\x07❯ \n', stateChanges);
      expect(stateChanges).toEqual(['idle']);
    });

    it('strips ANSI from needs-input patterns', () => {
      const { detector, stateChanges } = createDetector();
      feedAndClassify(detector, '\x1b[1m(y/n)\x1b[0m\n', stateChanges);
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
      vi.advanceTimersByTime(QUIET_DELAY_MS);
      // Should not throw
      expect(stateChanges).toEqual(['needs-input']);
    });
  });

  describe('buffer clearing', () => {
    it('clears buffer after successful classification', () => {
      const { detector, stateChanges } = createDetector();
      // First: classify as idle
      feedAndClassify(detector, '❯ \n', stateChanges);
      expect(stateChanges).toEqual(['idle']);

      // Second: mark input, feed unrecognizable output
      detector.markUserInput();
      stateChanges.length = 0;
      detector.feed('just some text\n');
      vi.advanceTimersByTime(QUIET_DELAY_MS);
      // Old ❯ pattern should NOT leak — should stay working
      expect(stateChanges).toEqual([]);
    });
  });

  describe('dispose', () => {
    it('prevents pending classification from firing', () => {
      const { detector, stateChanges } = createDetector();
      detector.markUserInput();
      stateChanges.length = 0;

      detector.feed('❯ \n');
      detector.dispose();
      vi.advanceTimersByTime(QUIET_DELAY_MS);
      // Timer was cleared, so no classification
      expect(stateChanges).toEqual([]);
    });
  });
});
