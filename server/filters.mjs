const maxAddress = 0xffffffffffffffffn;

export function moduleKey(value) {
  return process.platform === 'win32' ? value.replaceAll('\\', '/').toLowerCase() : value;
}

function tokens(value, label) {
  if (typeof value !== 'string') throw new Error(`${label}格式无效`);
  return [...new Set(value.split(/[,;\n]/).map(item => item.trim()).filter(Boolean))];
}

function numeric(value, label, address = false) {
  if (typeof value !== 'string') throw new Error(`${label}格式无效`);
  value = value.trim();
  if (!value) return null;
  const pattern = address ? /^0x[\da-f]{1,16}$/i : /^(?:0x[\da-f]{1,16}|\d{1,20})$/i;
  if (!pattern.test(value) || BigInt(value) > maxAddress) {
    throw new Error(`${label}须为${address ? '十六进制地址' : '非负字节数'}`);
  }
  return BigInt(value);
}

export function parseFilters(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('筛选条件格式无效');
  const modules = tokens(input.modules ?? '', '模块');
  const threads = tokens(input.threads ?? '', '线程');
  if (threads.some(thread => !/^\d+$/.test(thread))) throw new Error('线程 ID 须为数字，多个用逗号分隔');
  const minAddress = numeric(input.minAddress ?? '', '起始地址', true);
  const maxAddress = numeric(input.maxAddress ?? '', '结束地址', true);
  const minJump = numeric(input.minJump ?? '', '最小跳距');
  const maxJump = numeric(input.maxJump ?? '', '最大跳距');
  if (minAddress !== null && maxAddress !== null && minAddress > maxAddress) throw new Error('起始地址须小于或等于结束地址');
  if (minJump !== null && maxJump !== null && minJump > maxJump) throw new Error('最小跳距须小于或等于最大跳距');
  const basis = input.basis ?? 'adjacent';
  if (basis !== 'adjacent' && basis !== 'filtered') throw new Error('跳距计算方式无效');
  return {
    modules: new Set(modules.map(moduleKey)), threads: new Set(threads), minAddress, maxAddress, minJump, maxJump, basis,
    form: {
      modules: modules.join(', '), threads: threads.join(', '), basis,
      minAddress: minAddress === null ? '' : `0x${minAddress.toString(16)}`,
      maxAddress: maxAddress === null ? '' : `0x${maxAddress.toString(16)}`,
      minJump: minJump?.toString() ?? '', maxJump: maxJump?.toString() ?? '',
    },
  };
}

export function matchesRead(filter, event) {
  return (!filter.threads.size || filter.threads.has(event.thread)) &&
    (!filter.modules.size || filter.modules.has(event.moduleName) || filter.modules.has(event.modulePath)) &&
    (filter.minAddress === null || event.value >= filter.minAddress) &&
    (filter.maxAddress === null || event.value <= filter.maxAddress);
}

export function matchesJump(filter, stride) {
  if (filter.minJump === null && filter.maxJump === null) return true;
  if (stride === null) return false;
  const distance = stride < 0n ? -stride : stride;
  return (filter.minJump === null || distance >= filter.minJump) &&
    (filter.maxJump === null || distance <= filter.maxJump);
}
