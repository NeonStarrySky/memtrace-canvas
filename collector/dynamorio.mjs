import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { createModuleMap } from './modules.mjs';

const tracePrefix = /^\s*\d+\s+\d+:\s+(?:W\d+\.T)?(\d+)\s+/;
const readDetails = /^read\s+(\d+) byte\(s\)\s+@\s+(0x[0-9a-f]+)\b(?:\s+by PC\s+(0x[0-9a-f]+)\b)?/i;

// The DynamoRIO view tool prints its online trace to stderr.
export async function captureReads(command, onRead, signal, cwd) {
  const directory = await mkdtemp(join(tmpdir(), 'ram-trace-'));
  try {
    if (signal.aborted) return;
    const drrun = process.env.RAM_TRACE_DRRUN || 'drrun';
    const windows = process.platform === 'win32';
    const pipe = windows ? `ram-trace-${randomUUID()}` : join(directory, 'reads');
    const modules = createModuleMap(signal);
    const child = spawn(drrun, [
      '-no_follow_children', '-t', 'drcachesim', '-tool', 'view',
      '-ipc_name', pipe, '--', ...command,
    ], { cwd, stdio: ['inherit', 'inherit', 'pipe'], detached: !windows });
    const stop = () => {
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
      if (windows) {
        const taskkill = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
        taskkill.on('error', () => child.kill());
        taskkill.on('exit', code => { if (code !== 0 && child.exitCode === null) child.kill(); });
        return;
      }
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch (error) {
        if (error.code !== 'ESRCH') console.error(error.message);
      }
    };
    signal.addEventListener('abort', stop, { once: true });

    let launchError;
    child.on('error', error => { launchError = error; });
    const closed = new Promise(resolve => child.once('close', (code, signalName) => {
      resolve({ code, signalName });
    }));
    const lines = createInterface({ input: child.stderr, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        const prefix = tracePrefix.exec(line);
        if (prefix) {
          const read = readDetails.exec(line.slice(prefix[0].length));
          if (read) {
            const thread = prefix[1];
            const pc = read[3] ?? null;
            let module = modules.find(pc);
            if (pc && modules.shouldRefresh(Date.now(), module)) {
              await modules.refresh(thread);
              module = modules.find(pc);
            }
            onRead({ thread, bytes: Number(read[1]), address: read[2], pc, module });
          }
        } else if (line && !/^-+$/.test(line)) {
          process.stderr.write(`${line}\n`);
        }
      }

      const { code, signalName } = await closed;
      if (launchError?.code === 'ENOENT') {
        throw new Error('找不到 drrun。请安装 DynamoRIO，或用 RAM_TRACE_DRRUN 指定其路径。');
      }
      if (launchError) throw launchError;
      if (code !== 0) throw new Error(`DynamoRIO 或目标程序退出（${signalName || code}）`);
    } finally {
      signal.removeEventListener('abort', stop);
      if (child.exitCode === null && child.signalCode === null) stop();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
