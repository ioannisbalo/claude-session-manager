import fs from 'fs';
import path from 'path';
import { SessionState } from './state-detector';

export interface TransitionEntry {
  timestamp: string;
  sessionId: string;
  sessionName: string;
  from: SessionState;
  to: SessionState;
  linesExamined: string[];
  matchedPattern: string | null;
  trigger: 'settle' | 'user-input' | 'exit' | 'correction';
  correctedTo?: SessionState;
}

class TransitionLogger {
  private logPath: string;

  constructor(userDataPath: string) {
    const dir = path.join(userDataPath, 'logs');
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.logPath = path.join(dir, 'state-transitions.jsonl');
  }

  log(entry: TransitionEntry): void {
    const line = JSON.stringify(entry) + '\n';
    fs.appendFileSync(this.logPath, line, 'utf-8');
  }

  logCorrection(sessionId: string, sessionName: string, wrongState: SessionState, correctState: SessionState): void {
    this.log({
      timestamp: new Date().toISOString(),
      sessionId,
      sessionName,
      from: wrongState,
      to: correctState,
      linesExamined: [],
      matchedPattern: null,
      trigger: 'correction',
      correctedTo: correctState,
    });
  }

  getLogPath(): string {
    return this.logPath;
  }
}

export default TransitionLogger;
