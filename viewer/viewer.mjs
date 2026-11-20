const $ = id => document.getElementById(id);
const plot = $('plot');
const context = plot.getContext('2d');
const historyLimit = 2048;
const recentFitCount = 32;
const fadeMs = 2200;
const subpixel = 1024n;
const maxZoom = 32;
const zoomStep = 1.25;
const integerFormat = new Intl.NumberFormat('zh-CN');
const hex = value => `0x${value.toString(16)}`;
const asBytes = value => `${integerFormat.format(value)} B`;
const filterForm = $('filter-form');

let history = [];
let visible = [];
let allBounds = null;
let viewBounds = null;
let recentMode = false;
let camera = null;
let viewport = { width: 0, height: 0 };
const pointers = new Map();
let frame = null;
let pixelRatio = 1;
let hovered = false;
let hoverPosition = null;
let epoch = null;
let captureState = 'ready';
let starting = false;
let stopping = false;
let moduleList = [];
let moduleCaseInsensitive = false;
let mainModule = '';
let activeProgram = null;

function include(bounds, address) {
  if (!bounds) return { min: address, max: address };
  if (address < bounds.min) bounds.min = address;
  if (address > bounds.max) bounds.max = address;
  return bounds;
}

function includeRead(bounds, event) {
  const next = include(bounds, event.addressValue);
  return event.fromValue === null ? next : include(next, event.fromValue);
}

function layoutFor(bounds) {
  const padding = Math.min(Math.ceil(8 * pixelRatio), Math.floor((Math.min(plot.width, plot.height) - 1) / 2));
  const rowWidth = BigInt(plot.width - 2 * padding) * subpixel;
  return {
    ...bounds, ...viewport, padding, rowWidth,
    end: rowWidth * BigInt(plot.height - 2 * padding) - subpixel,
    unitsX: viewport.width / plot.width, unitsY: viewport.height / plot.height,
  };
}

function coordinates(address, view) {
  const { min, max, width, height, padding, rowWidth, end, unitsX, unitsY } = view.layout;
  if (address < min || address > max) return null;
  if (min === max) return [view.x + width * view.scale / 2, view.y + height * view.scale / 2];
  const offset = (address - min) * end / (max - min);
  const x = (padding + Number(offset % rowWidth) / Number(subpixel)) * unitsX;
  const y = (padding + Number(offset / rowWidth) + 0.5) * unitsY;
  return [view.x + x * view.scale, view.y + y * view.scale];
}

function drawPoint(event, opacity, latest, view) {
  const point = coordinates(event.addressValue, view);
  if (!point) return;
  const [x, y] = point;
  const radius = latest ? 3.5 : 1.6;
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
  if (x >= 0 && x < viewport.width && y >= 0 && y < viewport.height) visible.push({ x, y, event });
}

function drawJump(event, view) {
  if (event.fromValue === null) return;
  const from = coordinates(event.fromValue, view);
  const to = coordinates(event.addressValue, view);
  if (!from || !to) return;
  context.globalAlpha = 0.65;
  context.strokeStyle = '#66efd8';
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(...from);
  context.lineTo(...to);
  context.stroke();
  context.beginPath();
  context.arc(...from, 3, 0, Math.PI * 2);
  context.stroke();
}

function draw(now) {
  frame = null;
  context.setTransform(plot.width / viewport.width, 0, 0, plot.height / viewport.height, 0, 0);
  context.clearRect(0, 0, viewport.width, viewport.height);
  visible = [];
  if (!viewBounds || history.length === 0) return;
  const view = camera ?? { layout: layoutFor(viewBounds), scale: 1, x: 0, y: 0 };
  const latest = history.at(-1);
  drawJump(latest, view);
  let fading = false;
  for (let index = history.length - 2; index >= 0; index--) {
    const event = history[index];
    const fraction = 1 - Math.max(0, now - event.seenAt) / fadeMs;
    if (fraction <= 0) break;
    fading = true;
    drawPoint(event, fraction * 0.6, false, view);
  }
  drawPoint(latest, 1, true, view);
  context.globalAlpha = 1;
  updateHover();
  if (fading) requestDraw();
}

function requestDraw() {
  if (frame === null) frame = requestAnimationFrame(draw);
}

function updateBounds() {
  const scale = camera?.scale ?? 1;
  $('zoom-level').textContent = `${Math.round(scale * 100)}%`;
  $('zoom-in').disabled = !viewBounds || scale >= maxZoom;
  $('zoom-out').disabled = !viewBounds || scale <= 1;
  $('range-kind').textContent = camera ? '基准范围' : '地址范围';
  $('span-label').textContent = camera ? '基准跨度' : '显示跨度';
  plot.dataset.interactive = String(Boolean(viewBounds));
  plot.dataset.pannable = String(Boolean(camera && (camera.layout.width * scale > viewport.width || camera.layout.height * scale > viewport.height)));
  requestDraw();
  if (!viewBounds) return;
  $('range-start').textContent = hex(viewBounds.min);
  $('range-end').textContent = hex(viewBounds.max);
  $('span').textContent = asBytes(viewBounds.max - viewBounds.min + 1n);
}

function showPoint(event, prefix) {
  if (!event) return;
  const owner = event.module ?? '模块未知';
  const location = event.fromAddress ? `${event.fromAddress} → ${event.address}` : event.address;
  $('point').textContent = `${prefix} ${location} · ${event.bytes} B · 线程 ${event.thread} · ${owner}${event.pc ? ` · PC ${event.pc}` : ''}`;
  $('point').title = event.modulePath ?? '';
}

function clampPan(offset, size, length) {
  if (size <= length) return (length - size) / 2;
  return Math.max(length - size, Math.min(0, offset));
}

function moveCamera(previous, next, factor = 1) {
  if (!viewBounds) return;
  const view = camera ?? { layout: layoutFor(viewBounds), scale: 1, x: 0, y: 0 };
  const scale = Math.max(1, Math.min(maxZoom, view.scale * factor));
  const ratio = scale / view.scale;
  const x = clampPan(next.x - (previous.x - view.x) * ratio, view.layout.width * scale, viewport.width);
  const y = clampPan(next.y - (previous.y - view.y) * ratio, view.layout.height * scale, viewport.height);
  if (scale === view.scale && x === view.x && y === view.y) return;
  camera = { layout: view.layout, scale, x, y };
  updateBounds();
}

function resize() {
  const width = Math.max(1, plot.clientWidth);
  const height = Math.max(1, plot.clientHeight);
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  if (width === viewport.width && height === viewport.height && ratio === pixelRatio) return;
  if (camera) {
    camera.x = clampPan(camera.x + (width - viewport.width) / 2, camera.layout.width * camera.scale, width);
    camera.y = clampPan(camera.y + (height - viewport.height) / 2, camera.layout.height * camera.scale, height);
  }
  clearPointers();
  hoverPosition = null;
  viewport = { width, height };
  pixelRatio = ratio;
  plot.width = Math.max(1, Math.round(width * ratio));
  plot.height = Math.max(1, Math.round(height * ratio));
  updateBounds();
}
new ResizeObserver(resize).observe(plot);
resize();

function positionOf(event) {
  const box = plot.getBoundingClientRect();
  return { x: event.clientX - box.left, y: event.clientY - box.top };
}

function updateHover() {
  if (pointers.size) return;
  const wasHovered = hovered;
  let nearest = null;
  if (hoverPosition) {
    let distance = 8;
    for (const point of visible) {
      const candidate = Math.hypot(hoverPosition.x - point.x, hoverPosition.y - point.y);
      if (candidate <= distance) {
        nearest = point.event;
        distance = candidate;
      }
    }
  }
  hovered = nearest !== null;
  if (hovered || wasHovered) showPoint(nearest ?? history.at(-1), hovered ? '指向' : '最新');
}

function gesture() {
  const [first, second] = pointers.values();
  if (!second) return { ...first, distance: 0 };
  return { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2,
    distance: Math.hypot(first.x - second.x, first.y - second.y) };
}

function clearPointers() {
  const ids = [...pointers.keys()];
  pointers.clear();
  delete plot.dataset.dragging;
  for (const id of ids) {
    if (plot.hasPointerCapture(id)) plot.releasePointerCapture(id);
  }
}

plot.addEventListener('pointerdown', event => {
  if (!viewBounds || event.button !== 0 || pointers.size >= 2) return;
  if (pointers.size && (event.pointerType !== 'touch' || pointers.values().next().value.type !== 'touch')) return;
  pointers.set(event.pointerId, { ...positionOf(event), type: event.pointerType });
  plot.setPointerCapture(event.pointerId);
  plot.dataset.dragging = 'true';
  hoverPosition = null;
  hovered = false;
  showPoint(history.at(-1), '最新');
});

plot.addEventListener('pointermove', event => {
  const point = positionOf(event);
  if (pointers.has(event.pointerId)) {
    const previous = gesture();
    pointers.set(event.pointerId, { ...point, type: event.pointerType });
    const next = gesture();
    const factor = previous.distance >= 1 && next.distance >= 1 ? next.distance / previous.distance : 1;
    moveCamera(previous, next, factor);
  } else if (!pointers.size && event.pointerType !== 'touch') {
    hoverPosition = point;
    updateHover();
  }
});

for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
  plot.addEventListener(type, event => {
    if (!pointers.delete(event.pointerId) || pointers.size) return;
    delete plot.dataset.dragging;
    if (type === 'pointerup' && event.pointerType !== 'touch') {
      const point = positionOf(event);
      if (point.x >= 0 && point.y >= 0 && point.x < viewport.width && point.y < viewport.height) hoverPosition = point;
    }
    requestDraw();
  });
}

plot.addEventListener('pointerleave', () => {
  hoverPosition = null;
  updateHover();
});

plot.addEventListener('wheel', event => {
  if (!viewBounds || !event.deltaY) return;
  event.preventDefault();
  const point = positionOf(event);
  const units = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.height : 1;
  moveCamera(point, point, Math.exp(-event.deltaY * units * 0.002));
}, { passive: false });

for (const [id, factor] of [['zoom-in', zoomStep], ['zoom-out', 1 / zoomStep]]) {
  $(id).addEventListener('click', () => {
    const center = { x: viewport.width / 2, y: viewport.height / 2 };
    moveCamera(center, center, factor);
  });
}

$('fit-all').addEventListener('click', () => {
  camera = null;
  clearPointers();
  recentMode = false;
  viewBounds = { ...allBounds };
  updateBounds();
});
$('fit-recent').addEventListener('click', () => {
  camera = null;
  clearPointers();
  recentMode = true;
  viewBounds = history.slice(-recentFitCount).reduce(includeRead, null);
  updateBounds();
});

function showStatus(batch) {
  const source = batch.source === 'demo' ? '演示数据' : 'DynamoRIO';
  const status = $('status');
  status.dataset.state = batch.state;
  const labels = { ready: '等待启动', running: '实时采集', stopping: '正在停止', stopped: '已停止', complete: '采集结束' };
  const message = `${source} · ${batch.state === 'error' ? batch.failure : labels[batch.state]}`;
  if (status.textContent !== message) status.textContent = message;
}

async function api(path, data) {
  const response = await fetch(path, data === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '操作失败');
  return result;
}

function filterValues() {
  return Object.fromEntries(new FormData(filterForm));
}

function showControls() {
  const busy = captureState === 'running' || captureState === 'stopping';
  $('start').disabled = starting || busy;
  $('stop').disabled = stopping || captureState !== 'running';
  $('only-main').disabled = !pickedMain();
}

function pickedMain() {
  return $('program').value.trim().split(/[\\/]/).at(-1) || mainModule;
}

const splitSelection = value => value.split(/[,;\n]/).map(item => item.trim()).filter(Boolean);
const moduleKey = value => moduleCaseInsensitive ? value.replaceAll('\\', '/').toLowerCase() : value;
const matchesChoice = (choice, value) => moduleKey(value) === moduleKey(choice.value) || moduleKey(value) === moduleKey(choice.dataset.path);

function syncModuleChecks() {
  const selected = splitSelection($('modules').value);
  for (const choice of $('detected-modules').querySelectorAll('input')) choice.checked = selected.some(value => matchesChoice(choice, value));
}

function showModules() {
  const list = $('detected-modules');
  list.replaceChildren();
  const names = new Map(moduleList.map(module => [module.name, module.path]));
  for (const [name, path] of [...names].sort(([a], [b]) => a.localeCompare(b))) {
    const label = document.createElement('label');
    const choice = document.createElement('input');
    choice.type = 'checkbox';
    choice.value = name;
    choice.dataset.path = path;
    label.title = path;
    label.append(choice, name);
    list.append(label);
  }
  $('module-choices').hidden = names.size === 0;
  syncModuleChecks();
}

$('detected-modules').addEventListener('change', event => {
  const choice = event.target;
  const selected = splitSelection($('modules').value).filter(value => !matchesChoice(choice, value));
  if (choice.checked) selected.push(choice.value);
  $('modules').value = selected.join(', ');
});
$('modules').addEventListener('input', syncModuleChecks);
$('only-main').addEventListener('click', () => {
  $('modules').value = pickedMain();
  syncModuleChecks();
});
$('program').addEventListener('input', showControls);

async function applyFilter() {
  $('filter-error').textContent = '';
  try {
    await api('/api/filters', filterValues());
  } catch (error) {
    $('filter-error').textContent = error.message;
  }
}

filterForm.addEventListener('submit', event => {
  event.preventDefault();
  void applyFilter();
});
$('clear-filter').addEventListener('click', () => {
  filterForm.reset();
  syncModuleChecks();
  void applyFilter();
});

$('launch-form').addEventListener('submit', async event => {
  event.preventDefault();
  $('launch-error').textContent = '';
  starting = true;
  showControls();
  try {
    await api('/api/start', {
      program: $('program').value.trim(), cwd: $('cwd').value.trim(),
      args: $('args').value.split(/\r?\n/).filter(Boolean), filter: filterValues(),
    });
  } catch (error) {
    $('launch-error').textContent = error.message;
  } finally {
    starting = false;
    showControls();
  }
});
$('stop').addEventListener('click', async () => {
  $('launch-error').textContent = '';
  stopping = true;
  showControls();
  try {
    await api('/api/stop', {});
  } catch (error) {
    $('launch-error').textContent = error.message;
  } finally {
    stopping = false;
    showControls();
  }
});

const chooser = $('file-dialog');
let browseMode = 'program';
let folder;
let browseRequest = 0;

async function openFolder(path) {
  const request = ++browseRequest;
  const field = $('folder-path');
  const typedPath = field.value;
  $('folder-error').textContent = '';
  try {
    const listing = await api(`/api/files?directory=${encodeURIComponent(path ?? '')}`);
    if (request !== browseRequest || !chooser.open) return;
    folder = listing;
    field.placeholder = folder.path;
    if (field.value === typedPath && document.activeElement !== field) field.value = folder.path;
    $('folder-parent').disabled = folder.path === folder.parent;
    $('folder-home').disabled = folder.path === folder.home;
    $('folder-select').disabled = false;
    const children = folder.entries.filter(entry => browseMode === 'program' || entry.directory).map(entry => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = entry.directory ? `${entry.name}/` : entry.name;
      button.addEventListener('click', () => {
        if (entry.directory) void openFolder(entry.path);
        else {
          $('program').value = entry.path;
          chooser.close();
          showControls();
        }
      });
      return button;
    });
    $('folder-items').replaceChildren(...children);
  } catch (error) {
    if (request === browseRequest && chooser.open) $('folder-error').textContent = error.message;
  }
}

function browse(mode) {
  browseMode = mode;
  folder = null;
  $('folder-items').replaceChildren();
  $('folder-path').value = $('cwd').value;
  $('file-title').textContent = mode === 'program' ? '选择可执行文件' : '选择工作目录';
  $('folder-select').hidden = mode === 'program';
  for (const id of ['folder-parent', 'folder-home', 'folder-select']) $(id).disabled = true;
  chooser.showModal();
  void openFolder($('folder-path').value);
}

$('browse').addEventListener('click', () => browse('program'));
$('browse-cwd').addEventListener('click', () => browse('cwd'));
$('file-close').addEventListener('click', () => chooser.close());
$('folder-form').addEventListener('submit', event => { event.preventDefault(); void openFolder($('folder-path').value); });
$('folder-parent').addEventListener('click', () => { if (folder) void openFolder(folder.parent); });
$('folder-home').addEventListener('click', () => { if (folder) void openFolder(folder.home); });
$('folder-select').addEventListener('click', () => {
  if (!folder) return;
  $('cwd').value = folder.path;
  chooser.close();
});

function resetView() {
  history = [];
  allBounds = viewBounds = null;
  camera = hoverPosition = null;
  clearPointers();
  recentMode = hovered = false;
  for (const id of ['range-start', 'range-end', 'span', 'stride']) $(id).textContent = '—';
  $('point').title = '';
  $('fit-all').disabled = $('fit-recent').disabled = true;
  updateBounds();
}

const stream = new EventSource('/events');
stream.onmessage = message => {
  const batch = JSON.parse(message.data);
  captureState = batch.state;
  showStatus(batch);
  if (batch.target && activeProgram !== batch.target.program) {
    activeProgram = batch.target.program;
    $('program').value = activeProgram;
    $('cwd').value = batch.target.cwd;
    $('args').value = batch.target.args.join('\n');
  }
  if (batch.target) $('active-target').textContent = `采集目标 ${batch.target.program}`;
  mainModule = batch.mainModule;
  showControls();
  if (epoch !== batch.epoch) {
    epoch = batch.epoch;
    moduleCaseInsensitive = batch.moduleCaseInsensitive;
    resetView();
    for (const [name, value] of Object.entries(batch.filter)) filterForm.elements.namedItem(name).value = value;
  }
  if (batch.moduleList) {
    moduleList = batch.moduleList;
    showModules();
  }
  $('raw-total').textContent = integerFormat.format(batch.rawTotal);
  $('total').textContent = integerFormat.format(batch.total);
  $('mean').textContent = batch.meanStride === null ? '—' : asBytes(BigInt(batch.meanStride));
  if (batch.min === null) {
    $('point').textContent = batch.rawTotal ? '当前条件下没有匹配读取' : '等待第一次读取';
    return;
  }

  if (batch.total < (history.at(-1)?.seq ?? 0)) resetView();
  allBounds = { min: BigInt(batch.min), max: BigInt(batch.max) };
  if (!camera && !recentMode) viewBounds = { ...allBounds };
  const seenAt = performance.now();
  const previousSequence = history.at(-1)?.seq ?? 0;
  for (const point of batch.points) {
    if (point.seq <= previousSequence) continue;
    const event = { ...point, addressValue: BigInt(point.address),
      fromValue: point.fromAddress ? BigInt(point.fromAddress) : null, seenAt };
    history.push(event);
    if (!camera && recentMode) viewBounds = includeRead(viewBounds, event);
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
