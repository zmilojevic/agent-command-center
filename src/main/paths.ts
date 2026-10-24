import { homedir } from 'node:os'
import { join } from 'node:path'

/** Working folder of the general (non-project) chats; a session's cwd equal to this marks it as one. */
export const CHATS_DIR = join(homedir(), '.local', 'share', 'agent-command-center', 'chats')
