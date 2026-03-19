import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

// --- Mock node-pty ---

type DataCallback = (data: string) => void;
type ExitCallback = (e: { exitCode: number }) => void;

class MockPty {
  onDataCb: DataCallback | null = null;
  onExitCb: ExitCallback | null = null;
  written: string[] = [];
  killed = false;
  lastCols = 0;
  lastRows = 0;
  pid = 12345;

  onData(cb: DataCallback) { this.onDataCb = cb; }
  onExit(cb: ExitCallback) { this.onExitCb = cb; }
  write(data: string) { this.written.push(data); }
  kill() { this.killed = true; }
  resize(cols: number, rows: number) { this.lastCols = cols; this.lastRows = rows; }

  // Test helpers
  simulateData(data: string) { this.onDataCb?.(data); }
  simulateExit(exitCode: number) { this.onExitCb?.({ exitCode }); }
}

let lastSpawnedPty: MockPty;
let lastSpawnArgs: { command: string; args: string[]; opts: Record<string, unknown> };

vi.mock('node-pty', () => ({
  spawn: (command: string, args: string[], opts: Record<string, unknown>) => {
    lastSpawnedPty = new MockPty();
    lastSpawnArgs = { command, args, opts };
    return lastSpawnedPty;
  },
}));

// --- Mock TransitionLogger ---

const loggedEntries: unknown[] = [];
const loggedCorrections: unknown[] = [];

vi.mock('./transition-logger', () => {
  return {
    default: class MockTransitionLogger {
      log(entry: unknown) { loggedEntries.push(entry); }
      logCorrection(...args: unknown[]) { loggedCorrections.push(args); }
      getLogPath() { return '/mock/log/path'; }
    },
  };
});

// --- Import after mocks ---

import SessionManager from './session-manager';

describe('SessionManager', () => {
  let sm: SessionManager;

  beforeEach(() => {
    vi.useFakeTimers();
    loggedEntries.length = 0;
    loggedCorrections.length = 0;
    sm = new SessionManager('/mock/userData');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createTestSession(cwd = '/projects/test', options?: { continue?: boolean }) {
    const session = sm.createSession(cwd, options);
    return { session, pty: lastSpawnedPty };
  }

  describe('createSession', () => {
    it('spawns claude with correct cwd', () => {
      createTestSession('/projects/myapp');
      expect(lastSpawnArgs.command).toBe('claude');
      expect(lastSpawnArgs.opts.cwd).toBe('/projects/myapp');
    });

    it('passes --continue flag when requested', () => {
      createTestSession('/projects/myapp', { continue: true });
      expect(lastSpawnArgs.args).toEqual(['--continue']);
    });

    it('passes no args by default', () => {
      createTestSession('/projects/myapp');
      expect(lastSpawnArgs.args).toEqual([]);
    });

    it('sets session name from path basename', () => {
      const { session } = createTestSession('/projects/myapp');
      expect(session.name).toBe('myapp');
    });

    it('starts with idle status and empty buffer', () => {
      const { session } = createTestSession();
      expect(session.status).toBe('idle');
      expect(session.buffer).toBe('');
    });

    it('assigns unique incrementing IDs', () => {
      const { session: s1 } = createTestSession();
      const { session: s2 } = createTestSession();
      expect(s1.id).not.toBe(s2.id);
      expect(Number(s2.id)).toBeGreaterThan(Number(s1.id));
    });

    it('stores session in sessions map', () => {
      const { session } = createTestSession();
      expect(sm.sessions.get(session.id)).toBe(session);
    });
  });

  describe('PTY data handling', () => {
    it('accumulates output in session buffer', () => {
      const { session, pty } = createTestSession();
      pty.simulateData('hello ');
      pty.simulateData('world');
      expect(session.buffer).toBe('hello world');
    });

    it('emits output event with session id and data', () => {
      const { session, pty } = createTestSession();
      const outputs: [string, string][] = [];
      sm.on('output', (id, data) => outputs.push([id, data]));

      pty.simulateData('chunk1');
      pty.simulateData('chunk2');
      expect(outputs).toEqual([
        [session.id, 'chunk1'],
        [session.id, 'chunk2'],
      ]);
    });

    it('caps buffer at 1MB, keeping last 512KB', () => {
      const { session, pty } = createTestSession();
      // Feed just over 1MB
      const chunk = 'x'.repeat(600 * 1024);
      pty.simulateData(chunk);
      pty.simulateData(chunk);
      expect(session.buffer.length).toBe(512 * 1024);
    });

    it('preserves recent data when buffer overflows', () => {
      const { session, pty } = createTestSession();
      // Fill with 'a' then overflow with 'b'
      pty.simulateData('a'.repeat(1024 * 1024));
      pty.simulateData('MARKER');
      // Buffer should have been sliced, MARKER should be at the end
      expect(session.buffer.endsWith('MARKER')).toBe(true);
    });
  });

  describe('PTY exit handling', () => {
    it('sets status to done on exit', () => {
      const { session, pty } = createTestSession();
      pty.simulateExit(0);
      expect(session.status).toBe('done');
    });

    it('emits state-change and exit events', () => {
      const { session, pty } = createTestSession();
      const stateChanges: [string, string][] = [];
      const exits: [string, number][] = [];
      sm.on('state-change', (id, state) => stateChanges.push([id, state]));
      sm.on('exit', (id, code) => exits.push([id, code]));

      pty.simulateExit(1);
      expect(stateChanges).toEqual([[session.id, 'done']]);
      expect(exits).toEqual([[session.id, 1]]);
    });
  });

  describe('write', () => {
    it('forwards data to PTY', () => {
      const { session, pty } = createTestSession();
      sm.write(session.id, 'hello');
      expect(pty.written).toEqual(['hello']);
    });

    it('calls markUserInput on state detector when data contains newline', () => {
      const { session, pty } = createTestSession();
      const spy = vi.spyOn(session.stateDetector, 'markUserInput');
      sm.write(session.id, 'some command\r');
      expect(spy).toHaveBeenCalled();
      expect(pty.written).toEqual(['some command\r']);
    });

    it('does not call markUserInput for data without newline', () => {
      const { session } = createTestSession();
      const spy = vi.spyOn(session.stateDetector, 'markUserInput');
      sm.write(session.id, 'partial');
      expect(spy).not.toHaveBeenCalled();
    });

    it('is a no-op when session status is done', () => {
      const { session, pty } = createTestSession();
      session.status = 'done';
      sm.write(session.id, 'should not arrive');
      expect(pty.written).toEqual([]);
    });

    it('is a no-op for non-existent session', () => {
      // Should not throw
      sm.write('nonexistent', 'data');
    });
  });

  describe('resize', () => {
    it('forwards resize to PTY', () => {
      const { session, pty } = createTestSession();
      sm.resize(session.id, 200, 50);
      expect(pty.lastCols).toBe(200);
      expect(pty.lastRows).toBe(50);
    });

    it('is a no-op when session status is done', () => {
      const { session, pty } = createTestSession();
      session.status = 'done';
      sm.resize(session.id, 200, 50);
      expect(pty.lastCols).toBe(0);
    });

    it('is a no-op for non-existent session', () => {
      sm.resize('nonexistent', 200, 50);
    });
  });

  describe('getBuffer', () => {
    it('returns session buffer', () => {
      const { session, pty } = createTestSession();
      pty.simulateData('hello');
      expect(sm.getBuffer(session.id)).toBe('hello');
    });

    it('returns empty string for non-existent session', () => {
      expect(sm.getBuffer('nonexistent')).toBe('');
    });
  });

  describe('getSessions', () => {
    it('returns all sessions as an array', () => {
      createTestSession('/a');
      createTestSession('/b');
      expect(sm.getSessions()).toHaveLength(2);
    });

    it('returns empty array when no sessions', () => {
      expect(sm.getSessions()).toEqual([]);
    });
  });

  describe('correctState', () => {
    it('updates session status and emits state-change', () => {
      const { session } = createTestSession();
      const stateChanges: [string, string][] = [];
      sm.on('state-change', (id, state) => stateChanges.push([id, state]));

      sm.correctState(session.id, 'needs-input');
      expect(session.status).toBe('needs-input');
      expect(stateChanges).toEqual([[session.id, 'needs-input']]);
    });

    it('logs correction via transition logger', () => {
      const { session } = createTestSession();
      sm.correctState(session.id, 'working');
      expect(loggedCorrections).toHaveLength(1);
      expect(loggedCorrections[0]).toEqual([session.id, session.name, 'idle', 'working']);
    });

    it('is a no-op for non-existent session', () => {
      sm.correctState('nonexistent', 'idle');
      expect(loggedCorrections).toHaveLength(0);
    });
  });

  describe('getTransitionLogPath', () => {
    it('returns the log path from transition logger', () => {
      expect(sm.getTransitionLogPath()).toBe('/mock/log/path');
    });
  });

  describe('killSession', () => {
    it('disposes state detector, kills PTY, and removes from map', () => {
      const { session, pty } = createTestSession();
      const disposeSpy = vi.spyOn(session.stateDetector, 'dispose');

      sm.killSession(session.id);
      expect(disposeSpy).toHaveBeenCalled();
      expect(pty.killed).toBe(true);
      expect(sm.sessions.has(session.id)).toBe(false);
    });

    it('is a no-op for non-existent session', () => {
      sm.killSession('nonexistent');
    });
  });

  describe('killAll', () => {
    it('kills all sessions and clears the map', () => {
      const { pty: pty1 } = createTestSession('/a');
      const { pty: pty2 } = createTestSession('/b');

      sm.killAll();
      expect(pty1.killed).toBe(true);
      expect(pty2.killed).toBe(true);
      expect(sm.sessions.size).toBe(0);
    });

    it('disposes all state detectors', () => {
      const { session: s1 } = createTestSession('/a');
      const { session: s2 } = createTestSession('/b');
      const spy1 = vi.spyOn(s1.stateDetector, 'dispose');
      const spy2 = vi.spyOn(s2.stateDetector, 'dispose');

      sm.killAll();
      expect(spy1).toHaveBeenCalled();
      expect(spy2).toHaveBeenCalled();
    });
  });

  describe('state detection integration', () => {
    it('emits state-change when PTY output triggers state detection', () => {
      const { session, pty } = createTestSession();
      const stateChanges: [string, string][] = [];
      sm.on('state-change', (id, state) => stateChanges.push([id, state]));

      // Simulate user input → working, then idle prompt after quiet period
      sm.write(session.id, 'do something\r');
      expect(stateChanges).toEqual([[session.id, 'working']]);

      stateChanges.length = 0;
      pty.simulateData('❯ \n');
      vi.advanceTimersByTime(1500);
      expect(stateChanges).toEqual([[session.id, 'idle']]);
    });

    it('logs transitions via transition logger', () => {
      const { session, pty } = createTestSession();
      sm.write(session.id, 'command\r');
      pty.simulateData('(y/n)\n');
      vi.advanceTimersByTime(1500);

      expect(loggedEntries.length).toBeGreaterThan(0);
      const entry = loggedEntries[loggedEntries.length - 1] as Record<string, unknown>;
      expect(entry.sessionId).toBe(session.id);
      expect(entry.to).toBe('needs-input');
    });
  });
});
