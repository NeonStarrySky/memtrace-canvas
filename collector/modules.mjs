import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);
export const moduleName = path => path.split(/[\\/]/).at(-1);

function range(start, end, path) {
  return { start: BigInt(start), end: BigInt(end), name: moduleName(path), path };
}

async function linuxModules(thread) {
  const maps = await readFile(`/proc/${thread}/maps`, 'utf8');
  const modules = [];
  for (const line of maps.split('\n')) {
    const match = /^([0-9a-f]+)-([0-9a-f]+)\s+\S*x\S*\s+\S+\s+\S+\s+\d+\s+(.+)$/i.exec(line);
    if (!match) continue;
    const path = match[3].replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
    if (path.startsWith('/') || /^\[(vdso|vsyscall)\]$/.test(path)) {
      modules.push(range(`0x${match[1]}`, `0x${match[2]}`, path.replace(/ \(deleted\)$/, '')));
    }
  }
  return modules;
}

async function windowsModules(thread, pid, signal) {
  const target = pid ? `$targetPid = ${pid}` : `
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class TraceThread {
  [DllImport("kernel32.dll")] public static extern IntPtr OpenThread(uint access, bool inherit, uint id);
  [DllImport("kernel32.dll")] public static extern uint GetProcessIdOfThread(IntPtr thread);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
}
'@
    $handle = [TraceThread]::OpenThread(0x0800, $false, ${thread})
    if ($handle -eq [IntPtr]::Zero) { throw 'Cannot open traced thread' }
    try { $targetPid = [TraceThread]::GetProcessIdOfThread($handle) }
    finally { [void][TraceThread]::CloseHandle($handle) }
  `;
  const script = `
    $ErrorActionPreference = 'Stop'
    [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
    ${target}
    $process = [Diagnostics.Process]::GetProcessById($targetPid)
    $modules = @($process.Modules | ForEach-Object {
      $start = $_.BaseAddress.ToInt64()
      @{ start = ('0x{0:x}' -f $start); end = ('0x{0:x}' -f ($start + $_.ModuleMemorySize)); path = $_.FileName }
    })
    @{ pid = $targetPid; modules = $modules } | ConvertTo-Json -Compress -Depth 4
  `;
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true, timeout: 5000, signal,
  });
  const result = JSON.parse(stdout);
  return { pid: result.pid, modules: result.modules.map(({ start, end, path }) => range(start, end, path)) };
}

// The trace TID identifies the traced process even when drrun launches it indirectly.
export function createModuleMap(signal) {
  let ranges = [];
  let pid = null;
  let refreshAt = 0;
  let retryAt = 0;
  const windows = process.platform === 'win32';
  const interval = windows ? 2000 : 250;
  return {
    shouldRefresh(now, hit) { return now >= refreshAt || !hit && now >= retryAt; },
    async refresh(thread) {
      try {
        if (!/^\d+$/.test(thread) || signal.aborted) return;
        let snapshot = [];
        if (windows) {
          const result = await windowsModules(thread, pid, signal);
          pid = result.pid;
          snapshot = result.modules;
        } else if (process.platform === 'linux') {
          snapshot = await linuxModules(thread);
        }
        // The process can exit before DynamoRIO drains its final read records.
        if (snapshot.length) ranges = snapshot.sort((a, b) => a.start < b.start ? -1 : a.start > b.start ? 1 : 0);
      } catch {
        // A short-lived thread or unavailable module list leaves prior mappings usable.
      } finally {
        const now = Date.now();
        refreshAt = now + interval;
        retryAt = now + (windows ? interval : 30);
      }
    },
    find(pc) {
      if (!pc) return null;
      const address = BigInt(pc);
      let low = 0;
      let high = ranges.length;
      while (low < high) {
        const mid = Math.floor((low + high) / 2);
        if (address < ranges[mid].start) high = mid;
        else if (address >= ranges[mid].end) low = mid + 1;
        else return ranges[mid];
      }
      return null;
    },
  };
}
