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
const filterForm = $('filter-form');

let history = [];
let visible = [];
let allBounds = null;
let viewBounds = null;
let recentMode = false;
let frame = null;
let pixelRatio = 1;
let hovered = false;
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

function drawJump(event) {
  if (event.fromValue === null) return;
  const from = coordinates(event.fromValue);
  const to = coordinates(event.addressValue);
  if (!from || !to) return;
  context.globalAlpha = 0.65;
  context.strokeStyle = '#66efd8';
  context.lineWidth = pixelRatio;
  context.beginPath();
  context.moveTo(...from);
  context.lineTo(...to);
  context.stroke();
  context.beginPath();
  context.arc(...from, 3 * pixelRatio, 0, Math.PI * 2);
  context.stroke();
}

function draw(now) {
  frame = null;
  context.clearRect(0, 0, plot.width, plot.height);
  visible = [];
  if (!viewBounds || history.length === 0) return;
  const latest = history.at(-1);
  drawJump(latest);
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
  const owner = event.module ?? '模块未知';
  const location = event.fromAddress ? `${event.fromAddress} → ${event.address}` : event.address;
  $('point').textContent = `${prefix} ${location} · ${event.bytes} B · 线程 ${event.thread} · ${owner}${event.pc ? ` · PC ${event.pc}` : ''}`;
  $('point').title = event.modulePath ?? '';
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
  recentMode = hovered = false;
  for (const id of ['range-start', 'range-end', 'span', 'stride']) $(id).textContent = '—';
  $('point').title = '';
  $('fit-all').disabled = $('fit-recent').disabled = true;
  requestDraw();
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
    const event = { ...point, addressValue: BigInt(point.address),
      fromValue: point.fromAddress ? BigInt(point.fromAddress) : null, seenAt };
    history.push(event);
    if (recentMode) viewBounds = includeRead(viewBounds, event);
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
