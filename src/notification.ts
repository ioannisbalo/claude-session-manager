import path from 'path';
import { BrowserWindow, Notification, nativeImage } from 'electron';
import SessionManager from './session-manager';

class NotificationService {
  private activeSessionId: string | null = null;
  private windowFocused: boolean = true;
  private readonly icon: Electron.NativeImage;

  constructor(sessionManager: SessionManager, window: BrowserWindow) {
    this.icon = nativeImage.createFromPath(
      path.join(__dirname, '..', 'assets', 'icon.png'),
    );
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
          icon: this.icon,
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