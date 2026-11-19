import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { captureReads } from '../collector/dynamorio.mjs';

const [mode, ...command] = process.argv.slice(2);
if (!((mode === '--demo' && command.length === 0) || (mode === '--capture' && command.length > 0))) {
  console.error('使用 scripts/run-trace.sh --demo 或 scripts/run-trace.sh --trace ./program [参数]');
  process.exit(1);
}

const port = Number(process.env.RAM_TRACE_PORT ?? 8787);
const threadFilter = process.env.RAM_TRACE_THREAD;
const minFilter = readAddress('RAM_TRACE_MIN');
const maxFilter = readAddress('RAM_TRACE_MAX');
if (minFilter !== null && maxFilter !== null && minFilter > maxFilter) {
  throw new Error('RAM_TRACE_MIN 必须小于或等于 RAM_TRACE_MAX');
}

function readAddress(name) {
  const value = process.env[name];
  if (!value) return null;
  if (!/^0x[\da-f]{1,16}$/i.test(value)) throw new Error(`${name} 必须是 64 位十六进制地址`);
  return BigInt(value);
}

const hex = value => `0x${value.toString(16)}`;
const clients = new Set();
const capacity = 1024;
const recent = new Array(capacity);
const lastByThread = new Map();
const abort = new AbortController();
let total = 0;
let strideCount = 0n;
let totalDistance = 0n;
let min = null;
let max = null;
let state = 'ready';
let failure = '';

function observe({ thread, address, bytes }) {
  const value = BigInt(address);
  if (threadFilter && thread !== threadFilter) return;
  if (minFilter !== null && value < minFilter || maxFilter !== null && value > maxFilter) return;

  const previous = lastByThread.get(thread);
  const stride = previous === undefined ? null : value - previous;
  lastByThread.set(thread, value);
  if (stride !== null) {
    strideCount++;
    totalDistance += stride < 0n ? -stride : stride;
  }
  if (min === null || value < min) min = value;
  if (max === null || value > max) max = value;
  total++;
  recent[(total - 1) % capacity] = { seq: total, address: hex(value), bytes, thread, stride: stride?.toString() ?? null };
}

async function runDemo() {
  const base = 0x4000000000000000n;
  for (let index = 0; index < 56; index++) {
    const offset = index < 20 ? index % 10 : 1_000_000 + ((index - 20) * 7) % 40;
    observe({ address: hex(base + BigInt(offset)), bytes: 4, thread: '1' });
    await sleep(85, undefined, { signal: abort.signal });
  }
}

async function startCapture() {
  state = 'running';
  try {
    if (mode === '--demo') await runDemo();
    else await captureReads(command, observe, abort.signal);
    state = 'complete';
  } catch (error) {
    if (abort.signal.aborted) return;
    failure = error.message;
    state = 'error';
    console.error(failure);
  }
}

function sendBatch(client) {
  if (client.response.writableNeedDrain || (client.sent === total && client.state === state)) return;
  const points = [];
  for (let seq = Math.max(client.sent + 1, total - capacity + 1, 1); seq <= total; seq++) {
    points.push(recent[(seq - 1) % capacity]);
  }
  client.response.write(`data: ${JSON.stringify({
    state, failure, total, points, source: mode === '--demo' ? 'demo' : 'native',
    min: min === null ? null : hex(min), max: max === null ? null : hex(max),
    meanStride: strideCount ? (totalDistance / strideCount).toString() : null,
  })}\n\n`);
  client.sent = total;
  client.state = state;
}

const files = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/viewer.mjs': ['viewer.mjs', 'text/javascript; charset=utf-8'],
};

const server = createServer(async (request, response) => {
  const pathname = request.url.split('?', 1)[0];
  if (request.method !== 'GET') {
    response.writeHead(405, { Allow: 'GET' }).end();
    return;
  }
  if (pathname === '/events') {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    });
    response.flushHeaders();
    const client = { response, sent: 0, state: null };
    clients.add(client);
    response.on('close', () => clients.delete(client));
    if (state === 'ready') void startCapture();
    sendBatch(client);
    return;
  }

  const file = Object.hasOwn(files, pathname) ? files[pathname] : null;
  if (!file) {
    response.writeHead(404).end();
    return;
  }
  try {
    const body = await readFile(new URL(`../viewer/${file[0]}`, import.meta.url));
    response.writeHead(200, { 'Content-Type': file[1], 'Cache-Control': 'no-store' }).end(body);
  } catch (error) {
    console.error(error.message);
    response.writeHead(500).end('读取页面失败');
  }
});

const timer = setInterval(() => {
  for (const client of clients) sendBatch(client);
}, 33);
server.listen(port, '127.0.0.1', () => {
  console.log(`打开 http://127.0.0.1:${server.address().port} 开始观察`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    abort.abort();
    clearInterval(timer);
    for (const { response } of clients) response.end();
    server.close();
  });
}
