import { lstat, mkdir, readdir, readFile, readlink, realpath, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createConnection } from 'node:net';

export async function ownedPath(path: string, kind: 'socket' | 'directory' | 'file'): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || resolve(path) !== await realpath(path)) {
    throw new Error(`Refusing a symlinked ${kind}: ${path}`);
  }
  if (process.getuid && info.uid !== process.getuid()) throw new Error(`Path is not owned by this user: ${path}`);
  if ((info.mode & 0o022) !== 0) throw new Error(`Path is writable by another user: ${path}`);
  if (kind === 'socket' && !info.isSocket()) throw new Error(`Not a Unix socket: ${path}`);
  if (kind === 'directory' && !info.isDirectory()) throw new Error(`Not a directory: ${path}`);
  if (kind === 'file' && (!info.isFile() || info.size > 64 * 1024)) throw new Error(`Not a small regular file: ${path}`);
}

export async function ownedSocket(path: string): Promise<void> {
  await ownedPath(dirname(path), 'directory');
  await ownedPath(path, 'socket');
}

export async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await ownedPath(path, 'directory');
}

/** A refused connection confirms there is no listener across PID namespaces. */
function connectionRefused(path: string, timeoutMs: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = createConnection(path);
    let settled = false;
    const finish = (refused: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(refused);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.once('connect', () => finish(false));
    socket.once('error', (error: NodeJS.ErrnoException) => finish(error.code === 'ECONNREFUSED'));
    socket.once('close', () => finish(false));
  });
}

/** Remove only owned sockets with both an absent PID and a refused connection. */
export async function pruneStaleReplySockets(dir: string, timeoutMs: number): Promise<void> {
  await ownedPath(dir, 'directory');
  for (const name of await readdir(dir)) {
    const match = /^r-([1-9]\d*)-.+\.sock$/.exec(name);
    if (!match) continue;
    const pid = Number(match[1]);
    if (!Number.isSafeInteger(pid)) continue;
    const path = join(dir, name);
    try {
      await ownedSocket(path);
      try {
        process.kill(pid, 0);
      } catch (error) {
        // EPERM and other inspection failures do not establish that it exited.
        if ((error as NodeJS.ErrnoException).code === 'ESRCH' && await connectionRefused(path, timeoutMs)) {
          await ownedSocket(path);
          await unlink(path);
        }
      }
    } catch { /* Preserve unsafe paths; concurrent cleanup may remove a socket. */ }
  }
}

export async function readLocalJson(path: string): Promise<unknown> {
  await ownedPath(path, 'file');
  return JSON.parse(await readFile(path, 'utf8'));
}

export async function processMatches(pid: number, expectedStart?: string, pidDomain?: string): Promise<boolean> {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    if (pidDomain?.startsWith('linux:')) {
      const domain = `linux:${(await readFile('/etc/machine-id', 'utf8')).trim()}:${await readlink('/proc/self/ns/pid')}`;
      if (domain !== pidDomain) return false;
    }
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    // The command field may contain spaces or parentheses. Field 22 is starttime.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return !expectedStart || fields[19] === expectedStart;
  } catch {
    return false;
  }
}
