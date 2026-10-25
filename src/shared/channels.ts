/**
 * Single table of every `DesktopApi` method (except `platform` / `client`) and its IPC channel.
 * The preload and the phone shim are generated from it; main registers handlers by channel name (src/main/ipc.ts).
 */

/** `ipcRenderer.invoke` methods. */
export const INVOKES = {
  listSessions: 'sessions:list',
  getMessages: 'sessions:messages',
  getSessionMeta: 'sessions:meta',
  renameSession: 'sessions:rename',
  deleteSession: 'sessions:delete',
  deleteProject: 'sessions:deleteProject',
  startChat: 'chat:start',
  send: 'chat:send',
  respond: 'chat:respond',
  interrupt: 'chat:interrupt',
  setModel: 'chat:setModel',
  setEffort: 'chat:setEffort',
  setPermissionMode: 'chat:setPermissionMode',
  closeChat: 'chat:close',
  attachChat: 'chat:attach',
  liveChats: 'chat:live',
  listModels: 'chat:models',
  listAllModels: 'app:models',
  listCommands: 'chat:commands',
  listAgents: 'chat:agents',
  warmCache: 'chat:warm',
  requestContext: 'chat:context',
  getUsage: 'usage:get',
  gitChanges: 'git:changes',
  notify: 'app:notify',
  pickFolder: 'dialog:pickFolder',
  openPath: 'shell:openPath',
  homeDir: 'app:home',
  chatsDir: 'app:chatsDir',
  fileSuggestions: 'chat:files',
  taskOutput: 'chat:taskOutput',
  stopTask: 'chat:stopTask',
  backgroundTasks: 'chat:backgroundTasks',
  mcpStatus: 'chat:mcpStatus',
  mcpToggle: 'chat:mcpToggle',
  mcpReconnect: 'chat:mcpReconnect',
  worktreeAdd: 'git:worktreeAdd',
  worktreeRemove: 'git:worktreeRemove',
  gitSetStaged: 'git:setStaged',
  gitDiscardFile: 'git:discardFile',
  gitDiscardHunk: 'git:discardHunk',
  appTools: 'app:tools',
  openInEditor: 'app:openInEditor',
  openTerminal: 'app:openTerminal',
  ptyCreate: 'pty:create',
  ptyKill: 'pty:kill',
  ptyList: 'pty:list',
  ptyReplay: 'pty:replay',
  ptyIdle: 'pty:idle',
  remoteEnable: 'remote:enable',
  remoteDisable: 'remote:disable',
  mobileStatus: 'mobile:status',
  mobileSetEnabled: 'mobile:setEnabled',
  mobilePairStart: 'mobile:pairStart',
  mobileRevoke: 'mobile:revoke',
  getSharedPrefs: 'prefs:get',
  setSharedPref: 'prefs:set',
} as const

/** `ipcRenderer.send` methods (fire and forget). */
export const SENDS = {
  window: 'window:action',
  setTheme: 'app:theme',
  ptyWrite: 'pty:write',
  ptyResize: 'pty:resize',
} as const

/** Main-to-client events (`on*` subscriptions). */
export const EVENTS = {
  onAgentEvent: 'agent:event',
  onPermissionRequest: 'permission:request',
  onPermissionCancel: 'permission:cancel',
  onChatExit: 'chat:exit',
  onChatContext: 'chat:context',
  onUsage: 'usage:changed',
  onSessionsChanged: 'sessions:changed',
  onNotificationClick: 'notification:click',
  onTrayNewChat: 'tray:newChat',
  onPtyData: 'pty:data',
  onPtyExit: 'pty:exit',
  onRemoteState: 'remote:state',
  onRemoteMessage: 'chat:remoteMessage',
  onRemoteSetting: 'remote:setting',
  onLiveChanged: 'chat:liveChanged',
  onMobileChanged: 'mobile:changed',
  onSharedPrefChanged: 'prefs:changed',
} as const

/** Channels a phone client may not call. */
export const PHONE_BLOCKED: ReadonlySet<string> = new Set([
  'window:action',
  'app:theme',
  'dialog:pickFolder',
  'shell:openPath',
  'app:openInEditor',
  'app:openTerminal',
  'app:notify',
  'pty:create',
  'pty:write',
  'pty:resize',
  'pty:kill',
  'pty:list',
  'pty:replay',
  'pty:idle',
])

/** Events that never leave the desktop window. */
export const DESKTOP_ONLY_EVENTS: ReadonlySet<string> = new Set(['pty:data', 'pty:exit', 'notification:click', 'tray:newChat'])

/** Prefs that shape the sidebar; kept in the main process and synced to every client (store field name == pref key). */
export const SHARED_PREFS: readonly string[] = [
  'hiddenSessions',
  'sessionSortTime',
  'pinnedProjects',
  'projectOrder',
  'projectNames',
  'projectDefaults',
  'recentHours',
]
