import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { captureReads } from '../collector/dynamorio.mjs';
import { moduleName } from '../collector/modules.mjs';
import { matchesJump, matchesRead, moduleKey, parseFilters } from './filters.mjs';
import { listPrograms, validateProgram } from './programs.mjs';

const [mode = '--ui', ...command] = process.argv.slice(2);
if (!((mode === '--ui' || mode === '--demo') && !command.length || mode === '--capture' && command.length)) {
  console.error('使用 node server/server.mjs 或 scripts/run-trace.sh --trace ./program [参数]');
  process.exit(1);
}

const port = Number(process.env.RAM_TRACE_PORT ?? 8787);
const hex = value => `0x${value.toString(16)}`;
const clients = new Set();
const capacity = 1024;
const historyCapacity = 16384;
const recent = new Array(capacity);
const history = new Array(historyCapacity);
const lastByThread = new Map();
const matchedByThread = new Map();
const modules = new Map();
let filter = parseFilters({
  threads: process.env.RAM_TRACE_THREAD, minAddress: process.env.RAM_TRACE_MIN,
  maxAddress: process.env.RAM_TRACE_MAX,
  basis: mode === '--capture' && (process.env.RAM_TRACE_MIN || process.env.RAM_TRACE_MAX) ? 'filtered' : 'adjacent',
});
let epoch = randomUUID();
let total = 0;
let rawTotal = 0;
let strideCount = 0n;
let totalDistance = 0n;
let min = null;
let max = null;
let state = 'ready';
let failure = '';
let abort;
let source = mode === '--demo' ? 'demo' : 'native';
let target = command.length ? { program: command[0], args: command.slice(1), cwd: process.cwd() } : null;
let autostart = mode !== '--ui';

function project({ current, previous, bytes, pc, module }) {
  if (!matchesRead(filter, current)) return;
  const { thread, value } = current;
  if (filter.basis === 'filtered') {
    previous = matchedByThread.get(thread);
    matchedByThread.set(thread, current);
  }
  const stride = previous && matchesRead(filter, previous) ? value - previous.value : null;
  if (!matchesJump(filter, stride)) return;

  if (stride !== null) {
    strideCount++;
    totalDistance += stride < 0n ? -stride : stride;
  }
  const from = stride !== null && (filter.minJump !== null || filter.maxJump !== null) ? previous.value : null;
  const first = from !== null && from < value ? from : value;
  const last = from !== null && from > value ? from : value;
  if (min === null || first < min) min = first;
  if (max === null || last > max) max = last;
  total++;
  recent[(total - 1) % capacity] = {
    seq: total, address: hex(value), bytes, thread, pc,
    fromAddress: from === null ? null : hex(from),
    module: module?.name ?? null, modulePath: module?.path ?? null, stride: stride?.toString() ?? null,
  };
}

function observe({ thread, address, bytes, pc, module }) {
  const current = { thread, value: BigInt(address) };
  if (module) {
    current.moduleName = moduleKey(module.name);
    current.modulePath = moduleKey(module.path);
    if (!modules.has(current.modulePath)) modules.set(current.modulePath, { name: module.name, path: module.path });
  }
  const event = { current, previous: lastByThread.get(thread), bytes, pc, module };
  lastByThread.set(thread, current);
  history[rawTotal++ % historyCapacity] = event;
  project(event);
}

function reapply(next) {
  filter = next;
  epoch = randomUUID();
  matchedByThread.clear();
  total = 0;
  strideCount = 0n;
  totalDistance = 0n;
  min = max = null;
  for (let i = Math.max(0, rawTotal - historyCapacity); i < rawTotal; i++) project(history[i % historyCapacity]);
}

async function runDemo(signal) {
  const base = 0x4000000000000000n;
  for (let index = 0; index < 56; index++) {
    const offset = index < 20 ? index % 10 : 1_000_000 + ((index - 20) * 7) % 40;
    const name = index % 4 === 2 ? 'demo-library.dll' : 'demo.exe';
    observe({ address: hex(base + BigInt(offset)), bytes: 4, thread: '1', pc: '0x400000', module: { name, path: name } });
    await sleep(85, undefined, { signal });
  }
}

async function startCapture(nextSource, nextTarget, nextFilter) {
  const controller = new AbortController();
  abort = controller;
  source = nextSource;
  target = nextTarget;
  state = 'running';
  failure = '';
  rawTotal = 0;
  lastByThread.clear();
  modules.clear();
  recent.fill(undefined);
  history.fill(undefined);
  reapply(nextFilter);
  try {
    if (source === 'demo') await runDemo(controller.signal);
    else await captureReads([target.program, ...target.args], observe, controller.signal, target.cwd);
    state = controller.signal.aborted ? 'stopped' : 'complete';
  } catch (error) {
    state = controller.signal.aborted ? 'stopped' : 'error';
    if (state === 'error') {
      failure = error.message;
      console.error(failure);
    }
  }
}

function sendBatch(client) {
  const fresh = client.epoch !== epoch;
  if (client.response.writableNeedDrain || (!fresh && client.raw === rawTotal && client.state === state)) return;
  const points = [];
  const sent = fresh ? 0 : client.sent;
  for (let seq = Math.max(sent + 1, total - capacity + 1, 1); seq <= total; seq++) {
    points.push(recent[(seq - 1) % capacity]);
  }
  client.response.write(`data: ${JSON.stringify({
    epoch, state, failure, total, rawTotal, points, source, target, mainModule: target ? moduleName(target.program) : source === 'demo' ? 'demo.exe' : '',
    moduleList: fresh || client.moduleCount !== modules.size ? [...modules.values()] : undefined,
    moduleCaseInsensitive: fresh ? process.platform === 'win32' : undefined,
    filter: fresh ? filter.form : undefined,
    min: min === null ? null : hex(min), max: max === null ? null : hex(max),
    meanStride: strideCount ? (totalDistance / strideCount).toString() : null,
  })}\n\n`);
  Object.assign(client, { sent: total, raw: rawTotal, epoch, state, moduleCount: modules.size });
}

const files = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/viewer.mjs': ['viewer.mjs', 'text/javascript; charset=utf-8'],
};

function sendJSON(response, value, status = 200) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }).end(JSON.stringify(value));
}

async function bodyJSON(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size <= 32768) chunks.push(chunk);
  }
  if (size > 32768) throw new Error('提交内容过长');
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const busy = () => state === 'running' || state === 'stopping';

async function handleApi(request, response, url, origin) {
  if (request.method === 'GET' && url.pathname === '/api/files') {
    sendJSON(response, await listPrograms(url.searchParams.get('directory')));
    return;
  }
  // Only this local viewer can launch a program or change an active capture.
  if (request.method !== 'POST' || request.headers.origin !== origin ||
      !/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) {
    sendJSON(response, { error: '请在本地查看器里操作' }, 403);
    return;
  }
  if (url.pathname === '/api/start') {
    if (busy()) return sendJSON(response, { error: '已有程序正在采集' }, 409);
    const input = await bodyJSON(request);
    const selected = await validateProgram(input);
    const next = parseFilters(input.filter ?? {});
    if (busy()) return sendJSON(response, { error: '已有程序正在采集' }, 409);
    void startCapture('native', selected, next);
  } else if (url.pathname === '/api/stop') {
    if (state === 'running') {
      state = 'stopping';
      abort.abort();
    }
  } else if (url.pathname === '/api/filters') {
    reapply(parseFilters(await bodyJSON(request)));
  } else {
    return sendJSON(response, { error: '接口不存在' }, 404);
  }
  return sendJSON(response, { ok: true });
}

const server = createServer(async (request, response) => {
  const currentPort = server.address()?.port;
  const host = request.headers.host;
  if (![ `127.0.0.1:${currentPort}`, `localhost:${currentPort}` ].includes(host)) {
    response.writeHead(403).end();
    return;
  }
  const origin = `http://${host}`;
  try {
    const url = new URL(request.url, origin);
    const site = request.headers['sec-fetch-site'];
    if ((url.pathname.startsWith('/api/') || url.pathname === '/events') &&
        (site && site !== 'same-origin' && site !== 'none' || request.headers.origin && request.headers.origin !== origin)) {
      sendJSON(response, { error: '请在本地查看器里操作' }, 403);
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      await handleApi(request, response, url, origin);
      return;
    }
    if (request.method !== 'GET') {
      response.writeHead(405, { Allow: 'GET' }).end();
      return;
    }
    if (url.pathname === '/events') {
      response.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no',
      });
      response.flushHeaders();
      const client = { response };
      clients.add(client);
      response.on('close', () => clients.delete(client));
      if (autostart && state === 'ready') {
        autostart = false;
        void startCapture(source, target, filter);
      }
      sendBatch(client);
      return;
    }

    const file = Object.hasOwn(files, url.pathname) ? files[url.pathname] : null;
    if (!file) return response.writeHead(404).end();
    const body = await readFile(new URL(`../viewer/${file[0]}`, import.meta.url));
    response.writeHead(200, { 'Content-Type': file[1], 'Cache-Control': 'no-store' }).end(body);
  } catch (error) {
    sendJSON(response, { error: error.message }, 400);
  }
});

const timer = setInterval(() => {
  for (const client of clients) sendBatch(client);
}, 33);
server.listen(port, '127.0.0.1', () => {
  console.log(`打开 http://127.0.0.1:${server.address().port} 选择程序或观察采集`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    abort?.abort();
    clearInterval(timer);
    for (const { response } of clients) response.end();
    server.close();
  });
}
