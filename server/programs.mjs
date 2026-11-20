import { constants } from 'node:fs';
import { access, readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';

const windows = process.platform === 'win32';

function absolute(value, label) {
  if (typeof value !== 'string' || value.includes('\0') || !isAbsolute(value)) {
    throw new Error(`${label}须使用本机绝对路径`);
  }
  return value;
}

async function directory(path) {
  const resolved = await realpath(absolute(path, '目录'));
  if (!(await stat(resolved)).isDirectory()) throw new Error('请选择一个目录');
  return resolved;
}

export async function validateProgram(input) {
  const program = await realpath(absolute(input?.program, '程序'));
  if (!(await stat(program)).isFile() || (windows && !/\.exe$/i.test(program))) {
    throw new Error(windows ? '请选择一个 .exe 程序' : '请选择一个可执行文件');
  }
  if (!windows) await access(program, constants.X_OK);
  const cwd = await directory(input.cwd || dirname(program));
  const args = input.args ?? [];
  if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) {
    throw new Error('程序参数须按行填写');
  }
  return { program, cwd, args };
}

export async function listPrograms(location) {
  const path = await directory(location || process.cwd());
  const entries = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    const info = entry.isSymbolicLink() ? await stat(child).catch(() => null) : entry;
    if (info?.isDirectory()) {
      entries.push({ name: entry.name, path: child, directory: true });
    } else if (info?.isFile() && (windows ? /\.exe$/i.test(entry.name) : await access(child, constants.X_OK).then(() => true, () => false))) {
      entries.push({ name: entry.name, path: child, directory: false });
    }
  }
  entries.sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
  return { path, parent: dirname(path), home: homedir(), entries };
}
