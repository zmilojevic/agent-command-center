import { app } from 'electron'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Working folder of the general (non-project) chats; a session's cwd equal to this marks it as one. */
export const CHATS_DIR =
  process.platform === 'linux'
    ? join(homedir(), '.local', 'share', 'hearth', 'chats')
    : join(app.getPath('appData'), 'hearth', 'chats')
