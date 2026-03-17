import { BrowserWindow, Notification } from 'electron';
import SessionManager from './session-manager';

class NotificationService {
  private activeSessionId: string | null = null;
  private windowFocused: boolean = true;

  constructor(sessionManager: SessionManager, window: BrowserWindow) {
    sessionManager.on('state-change', (sessionId: string, state: string) => {
      // Skip if this is the active session and the window is focused
      if (sessionId === this.activeSessionId && this.windowFocused) return;

      const session = sessionManager.sessions.get(sessionId);
      if (!session) return;

      let body: string | null = null;
      if (state === 'needs-input') {
        body = `Session "${session.name}" needs your input`;
      } else if (state === 'idle') {
        body = `Session "${session.name}" finished working`;
      } else if (state === 'done') {
        body = `Session "${session.name}" exited`;
      }

      if (body) {
        const notification = new Notification({
          silent: true,
          title: 'Claude Session Manager',
          body,
        });

        notification.on('click', () => {
          window.show();
          window.focus();
          window.webContents.send('switch-session', sessionId);
        });

        notification.show();
      }
    });
  }

  setActiveSession(sessionId: string | null, windowFocused: boolean): void {
    this.activeSessionId = sessionId;
    this.windowFocused = windowFocused;
  }

  setWindowFocused(focused: boolean): void {
    this.windowFocused = focused;
  }
}

export default NotificationService;