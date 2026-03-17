import { app, BrowserWindow, Menu, ipcMain, dialog, shell, globalShortcut, IpcMainInvokeEvent, IpcMainEvent } from 'electron';
import os from 'os';
import path from 'path';
import SessionManager from './src/session-manager';
import NotificationService from './src/notification';

app.name = 'Claude Session Manager';

let mainWindow: BrowserWindow | null = null;
let sessionManager: SessionManager | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 500,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 12, y: 12 },
  });

  const appName = 'Claude Session Manager';
  const menuTemplate: Electron.MenuItemConstructorOptions[] = [
    {
      label: appName,
      submenu: [
        { role: 'about', label: `About ${appName}` },
        { type: 'separator' },
        { role: 'hide', label: `Hide ${appName}` },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit', label: `Quit ${appName}` },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { role: 'close' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate));

  mainWindow.loadFile(path.join(__dirname, 'src', 'renderer', 'index.html'));

  const win = mainWindow;

  sessionManager = new SessionManager();
  const notificationService = new NotificationService(sessionManager, win);

  sessionManager.on('output', (sessionId: string, data: string) => {
    win.webContents.send('session:output', sessionId, data);
  });

  sessionManager.on('state-change', (sessionId: string, state: string) => {
    win.webContents.send('session:state', sessionId, state);
  });

  sessionManager.on('exit', (sessionId: string, exitCode: number) => {
    win.webContents.send('session:exit', sessionId, exitCode);
  });

  // Cmd+N shortcut to create new session
  win.webContents.on('before-input-event', (_event, input) => {
    if (input.meta && input.key === 'n' && input.type === 'keyDown') {
      win.webContents.send('new-session');
    }
  });

  ipcMain.handle('session:create', async () => {
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory'],
      title: 'Choose working directory for Claude session',
    });
    if (result.canceled || result.filePaths.length === 0) return null;

    const cwd = path.resolve(result.filePaths[0]);
    const home = os.homedir();
    const riskyPaths = ['/', '/tmp', '/var', '/etc', '/usr', '/System', '/Applications', home];
    if (riskyPaths.includes(cwd)) {
      dialog.showErrorBox(
        'Invalid directory',
        `"${cwd}" is too broad to use as a working directory. Please choose a specific project folder.`,
      );
      return null;
    }

    const session = sessionManager!.createSession(cwd);
    return { id: session.id, name: session.name, cwd: session.cwd, status: session.status };
  });

  ipcMain.on('session:active', (_event: IpcMainEvent, sessionId: string) => {
    notificationService.setActiveSession(sessionId, win.isFocused());
  });

  win.on('focus', () => {
    notificationService.setWindowFocused(true);
  });

  win.on('blur', () => {
    notificationService.setWindowFocused(false);
  });

  ipcMain.on('session:input', (_event: IpcMainEvent, sessionId: string, data: string) => {
    sessionManager?.write(sessionId, data);
  });

  ipcMain.on('session:resize', (_event: IpcMainEvent, sessionId: string, cols: number, rows: number) => {
    sessionManager?.resize(sessionId, cols, rows);
  });

  ipcMain.handle('session:kill', (_event: IpcMainInvokeEvent, sessionId: string) => {
    sessionManager?.killSession(sessionId);
  });

  ipcMain.handle('session:list', () => {
    return sessionManager!.getSessions().map(s => ({
      id: s.id, name: s.name, cwd: s.cwd, status: s.status,
    }));
  });

  ipcMain.handle('session:buffer', (_event: IpcMainInvokeEvent, sessionId: string) => {
    return sessionManager!.getBuffer(sessionId);
  });

  ipcMain.handle('open-url', (_event: IpcMainInvokeEvent, url: string) => {
    if (url.startsWith('https://') || url.startsWith('http://')) {
      shell.openExternal(url);
    }
  });
}

app.whenReady().then(() => {
  if (process.platform === 'darwin') {
    app.dock?.setIcon(path.join(__dirname, '..', 'assets', 'icon.png'));
  }
  createWindow();
});

app.on('window-all-closed', () => {
  if (sessionManager) sessionManager.killAll();
  app.quit();
});
