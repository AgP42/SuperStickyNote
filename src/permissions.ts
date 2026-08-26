/**
 * Plugin file permissions (sn-plugin-lib 0.1.65 / Chauvet plugin-preview firmware).
 *
 * On the preview firmware the host gates shared-storage access behind the new
 * plugin permission system — enforced even on raw java.io access to MyStyle,
 * Note, Document, … A read on a non-granted path throws a native
 * "no READ permission on sdcard" SecurityException.
 *
 * SuperStickyNote touches shared storage in two ways:
 *   - READ:  the lasso→OCR path (getLassoElements / recognizeElements /
 *            getCurrentFilePath / getPageSize), MyStyle/fonts listing, and the
 *            legacy-dir + .json backup reads.
 *   - WRITE: the visible exports (.txt / .json backup), the one-time legacy
 *            migration copy, and the MyStyle debug log.
 * The plugin's PRIVATE data dir (getPluginDirPath / getFilesDir) is
 * permission-free, so notes.json / settings.json never need this.
 *
 * Both permissions are declared in PluginConfig.json `uses-permissions` —
 * without the declaration requestPermission fails with code 1500. This is
 * SEPARATE from the overlay SYSTEM_ALERT_WINDOW permission the floating cards
 * use (handled natively in StickyNative.checkPermission/requestPermission).
 */
import {PluginManager} from 'sn-plugin-lib';
import {blog} from './native';

export const PERM_FILE_READ = 'plugin.permission.FILE:READ';
export const PERM_FILE_WRITE = 'plugin.permission.FILE:WRITE';

let granted = false;

/**
 * Grant one permission (idempotent per call).
 *   hasPermission → 0 = not granted, 1 = granted
 *   requestPermission → 0 = deny, 1 = allow this time, 2 = always allow
 */
async function ensure(permission: string, desc: string): Promise<boolean> {
  const has = await PluginManager.hasPermission(permission);
  blog(`[perm] hasPermission(${permission}) → ${has}`);
  if (has === 1) return true;
  const res = await PluginManager.requestPermission(permission, desc);
  blog(`[perm] requestPermission(${permission}) → ${res}`);
  return res === 1 || res === 2;
}

/**
 * Ensure FILE:READ + FILE:WRITE before touching shared storage. Call at boot
 * before the first shared-storage read, and again as a guard before the OCR
 * path and before exports. Caches success. On the OLD firmware the permission
 * APIs are absent (the native side throws); we then assume granted so a
 * 0.1.65-built plugin still runs pre-upgrade.
 * @returns whether reading AND writing shared storage is allowed.
 */
export async function ensureFilePermissions(): Promise<boolean> {
  if (granted) return true;
  try {
    const read = await ensure(
      PERM_FILE_READ,
      'SuperStickyNote reads your handwriting (for “Add to sticky”), fonts and backups.',
    );
    const write = await ensure(
      PERM_FILE_WRITE,
      'SuperStickyNote exports notes as .txt / .json backups to MyStyle.',
    );
    granted = read && write;
    return granted;
  } catch (e) {
    // Legacy host with no permission system: don't block the plugin.
    blog(`[perm] no permission host (${(e as Error)?.message}) — assuming granted`);
    granted = true;
    return true;
  }
}
