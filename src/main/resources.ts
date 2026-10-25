import { app } from 'electron'
import { join } from 'node:path'

/** A file from the repo's `resources/` dir (packaging copies that dir to `<resourcesPath>/resources`). */
export function resourceFile(name: string): string {
  return app.isPackaged ? join(process.resourcesPath, 'resources', name) : join(app.getAppPath(), 'resources', name)
}
