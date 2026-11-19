const $ = id => document.getElementById(id);
const plot = $('plot');
const context = plot.getContext('2d');
const historyLimit = 2048;
const recentFitCount = 32;
const fadeMs = 2200;
const subpixel = 1024n;
const integerFormat = new Intl.NumberFormat('zh-CN');
const hex = value => `0x${value.toString(16)}`;
const asBytes = value => `${integerFormat.format(value)} B`;

let history = [];
let visible = [];
let allBounds = null;
let viewBounds = null;
let recentMode = false;
let frame = null;
let pixelRatio = 1;
let hovered = false;

function include(bounds, address) {
  if (!bounds) return { min: address, max: address };
  if (address < bounds.min) bounds.min = address;
  if (address > bounds.max) bounds.max = address;
  return bounds;
}

function coordinates(address) {
  const { min, max } = viewBounds;
  if (address < min || address > max) return null;
  if (min === max) return [plot.width / 2, plot.height / 2];

  const padding = Math.min(Math.ceil(8 * pixelRatio), Math.floor((Math.min(plot.width, plot.height) - 1) / 2));
  const rowWidth = BigInt(plot.width - 2 * padding) * subpixel;
  const end = rowWidth * BigInt(plot.height - 2 * padding) - subpixel;
  const offset = (address - min) * end / (max - min);
  return [padding + Number(offset % rowWidth) / Number(subpixel), padding + Number(offset / rowWidth) + 0.5];
}

function drawPoint(event, opacity, latest) {
  const point = coordinates(event.addressValue);
  if (!point) return;
  const [x, y] = point;
  const radius = (latest ? 3.5 : 1.6) * pixelRatio;
  context.globalAlpha = opacity;
  context.fillStyle = latest ? '#dcfff8' : '#66efd8';
  if (latest) {
    context.shadowColor = '#66efd8';
    context.shadowBlur = 9 * pixelRatio;
    context.beginPath();
    context.arc(x, y, radius, 0, Math.PI * 2);
    context.fill();
    context.shadowBlur = 0;
  } else {
    context.fillRect(x - radius, y - radius, radius * 2, radius * 2);
  }
  visible.push({ x, y, event });
}

function draw(now) {
  frame = null;
  context.clearRect(0, 0, plot.width, plot.height);
  visible = [];
  if (!viewBounds || history.length === 0) return;
  const latest = history.at(-1);
  let fading = false;
  for (let index = history.length - 2; index >= 0; index--) {
    const event = history[index];
    const fraction = 1 - Math.max(0, now - event.seenAt) / fadeMs;
    if (fraction <= 0) break;
    fading = true;
    drawPoint(event, fraction * 0.6, false);
  }
  drawPoint(latest, 1, true);
  context.globalAlpha = 1;
  if (fading) requestDraw();
}

function requestDraw() {
  if (frame === null) frame = requestAnimationFrame(draw);
}

function updateBounds() {
  if (!viewBounds) return;
  $('range-start').textContent = hex(viewBounds.min);
  $('range-end').textContent = hex(viewBounds.max);
  $('span').textContent = asBytes(viewBounds.max - viewBounds.min + 1n);
  requestDraw();
}

function showPoint(event, prefix) {
  if (!event) return;
  $('point').textContent = `${prefix} ${event.address} · ${event.bytes} B · 线程 ${event.thread}`;
}

function resize() {
  pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  plot.width = Math.max(1, Math.round(plot.clientWidth * pixelRatio));
  plot.height = Math.max(1, Math.round(plot.clientHeight * pixelRatio));
  requestDraw();
}
new ResizeObserver(resize).observe(plot);
resize();

plot.addEventListener('pointermove', event => {
  const box = plot.getBoundingClientRect();
  const x = (event.clientX - box.left) * plot.width / box.width;
  const y = (event.clientY - box.top) * plot.height / box.height;
  let distance = 8 * pixelRatio;
  let nearest = null;
  for (const point of visible) {
    const candidate = Math.hypot(x - point.x, y - point.y);
    if (candidate <= distance) {
      nearest = point.event;
      distance = candidate;
    }
  }
  hovered = nearest !== null;
  showPoint(nearest || history.at(-1), hovered ? '指向' : '最新');
});
plot.addEventListener('pointerleave', () => {
  hovered = false;
  showPoint(history.at(-1), '最新');
});

$('fit-all').addEventListener('click', () => {
  recentMode = false;
  viewBounds = { ...allBounds };
  updateBounds();
});
$('fit-recent').addEventListener('click', () => {
  recentMode = true;
  viewBounds = history.slice(-recentFitCount).reduce((bounds, event) => include(bounds, event.addressValue), null);
  updateBounds();
});

function showStatus(batch) {
  const source = batch.source === 'demo' ? '演示数据' : 'DynamoRIO';
  const status = $('status');
  status.dataset.state = batch.state;
  if (batch.state === 'error') status.textContent = `${source} · ${batch.failure}`;
  else if (batch.state === 'complete') status.textContent = `${source} · ${batch.total ? '采集结束' : '采集结束，本次范围内没有读取'}`;
  else status.textContent = `${source} · 实时采集`;
}

const stream = new EventSource('/events');
stream.onmessage = message => {
  const batch = JSON.parse(message.data);
  showStatus(batch);
  $('total').textContent = integerFormat.format(batch.total);
  $('mean').textContent = batch.meanStride === null ? '—' : asBytes(BigInt(batch.meanStride));
  if (batch.min === null) return;

  allBounds = { min: BigInt(batch.min), max: BigInt(batch.max) };
  if (batch.total < (history.at(-1)?.seq ?? 0)) {
    history = [];
    recentMode = false;
    hovered = false;
  }
  if (!recentMode) viewBounds = { ...allBounds };
  const seenAt = performance.now();
  const previousSequence = history.at(-1)?.seq ?? 0;
  for (const point of batch.points) {
    if (point.seq <= previousSequence) continue;
    const addressValue = BigInt(point.address);
    history.push({ ...point, addressValue, seenAt });
    if (recentMode) viewBounds = include(viewBounds, addressValue);
  }
  if (history.length > historyLimit) history = history.slice(-historyLimit);
  const latest = history.at(-1);
  if (latest) {
    if (!hovered) showPoint(latest, '最新');
    const stride = latest.stride === null ? null : BigInt(latest.stride);
    $('stride').textContent = stride === null ? '—' : `${stride > 0n ? '+' : ''}${asBytes(stride)}`;
    $('fit-all').disabled = false;
    $('fit-recent').disabled = false;
  }
  updateBounds();
};
stream.onerror = () => {
  $('status').dataset.state = 'error';
  $('status').textContent = '采集连接中断，正在重连';
};
