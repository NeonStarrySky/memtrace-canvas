# RAM 访问模拟器 · 项目结构大纲

[index.html](index.html) 是模拟演示入口，可以直接在浏览器打开。真实轨迹查看器由本地服务启动。两个入口分别用于比较模拟布局和观察实际读取。

## 真实轨迹查看器

| 路径 | 职责 |
| --- | --- |
| [`scripts/run-trace.sh`](scripts/run-trace.sh) | `--ui` 启动程序选择页，`--trace` 启动真实采集，`--demo` 生成演示事件。直接传入程序则按普通方式启动。 |
| [`collector/dynamorio.mjs`](collector/dynamorio.mjs)、[`collector/modules.mjs`](collector/modules.mjs) | 用 DynamoRIO 在线提取读取地址、指令地址（PC）、线程和读取长度。Linux 读取 `/proc/<tid>/maps`，Windows 用 PowerShell 查询实际进程的模块加载范围。 |
| [`server/server.mjs`](server/server.mjs)、[`server/filters.mjs`](server/filters.mjs)、[`server/programs.mjs`](server/programs.mjs) | 在本机浏览可执行文件、启动目标、执行组合筛选，并用 SSE 推送轨迹与统计。 |
| [`viewer/index.html`](viewer/index.html)、[`viewer/viewer.mjs`](viewer/viewer.mjs) | 选择程序、工作目录和筛选条件。用 Canvas 绘制匹配的读取，显示所属模块及 PC。 |

数据流是「现有可执行文件 → DynamoRIO → 本地 Node.js 服务 → 浏览器」。采集目标是用户态实际读取的虚拟地址。地址以十六进制字符串传输，服务和网页用 `BigInt` 运算。模块条件用 PC 判断归属，地址范围条件匹配被读数据的地址。

多个模块之间取并集，多个线程之间也取并集。模块、线程、地址范围和跳距条件同时生效。默认按同线程实际相邻的读取计算跳距，两次读取须同时满足模块与地址条件。设置跳距上下限时，只保留能算出跳距且符合上下限的结果，图上标出最新跳转的起点和终点。也可以切换为「筛选后的同线程读取」，用跳距筛选前相邻的两条匹配读取计算。平均跳距是步长绝对值的平均数，显示到整字节。

画布使用地址偏移和当前地址跨度计算点坐标。默认用本次已观测的最小、最大地址，新地址越界时自动扩大范围。点击「适配近期」可聚焦最近 32 个点，后续事件能继续扩大这个范围。「适配全部」回到全程范围。扩大或缩小显示范围时，已保留的点用原始地址重新定位。

服务每约 33 毫秒发一批，保留最近 1024 个可发送的点。浏览器保留最近 2048 个收到的点，较旧的光点约 2.2 秒淡出。换筛选条件时，服务用最近 16,384 条读取重算匹配结果，之后继续计入新事件。启动前设置筛选可从该次采集的第一条开始统计。筛选在采集之后执行，DynamoRIO 的在线文本输出仍覆盖整个目标进程。

### 运行方式

需要 Node.js 18 或更新版本。原型在 Linux x86-64 上用 DynamoRIO 11.91.20771 验证。Windows 采用 x64 Node.js 和同架构 DynamoRIO。Windows 的实际引擎启动尚待本机验证。

```bash
node server/server.mjs
```

打开终端显示的本地地址，在「启动程序」里浏览或填写本机可执行文件、工作目录和参数。启动 NeonEngine 时，可以选择 `x64\Release\Engine.exe`，并将工作目录设置为 NeonEngine 的 `Engine` 子目录。要同时看主程序与 GLFW，在模块栏填 `Engine.exe, glfw3.dll`，也可以运行后从检测到的模块中多选。再填地址或跳距即可组合筛选。

使用演示数据可以先检查点图、缩放和统计。

```bash
./scripts/run-trace.sh --demo
```

真实采集需要安装 DynamoRIO。将 `drrun` 放入 `PATH`，或用 `RAM_TRACE_DRRUN` 指定它。

```bash
RAM_TRACE_DRRUN=/path/to/drrun ./scripts/run-trace.sh --trace ./program arg1
```

打开终端显示的本地地址，默认是 `http://127.0.0.1:8787`。第一个查看器连上后开始采集。`RAM_TRACE_PORT` 可选择端口，`RAM_TRACE_THREAD` 可按线程筛选，`RAM_TRACE_MIN` 和 `RAM_TRACE_MAX` 可指定包含端点的十六进制虚拟地址范围。结束后页面保留结果，按 `Ctrl+C` 停止本地服务。

### 面向对象粒子示例

[`examples/particles.cpp`](examples/particles.cpp) 是一个命令行 C++ 粒子系统。`ParticleSystem` 用连续数组存放 `Particle` 对象。每个粒子有三维位置、速度、加速度，以及寿命、质量、阻力、温度、颜色、大小、透明度、旋转等属性。`Particle::update()` 计算运动、碰撞反弹、降温和过期重生，结束时输出统计。

默认运行约 30 秒，分三个阶段更新 12、24、48 个粒子。开启插桩后的实录约 52 秒，末帧已记录超过 15 万次粒子对象读取。[查看动图](examples/particle-trace.gif)。

在 Linux 上可编译并快速运行 3 步。

```bash
particle_bin=/tmp/memtrace-particles-example
c++ -std=c++17 -O2 -fno-pie -no-pie examples/particles.cpp -o "$particle_bin"
"$particle_bin" 3
```

用 `nm` 找到粒子对象数组所在的 `particle_system` 符号，再把地址范围交给采集脚本。这里使用固定装载地址的示例编译参数，以便直接用 `nm` 的地址筛选。

```bash
read -r base bytes < <(nm -S --defined-only "$particle_bin" | awk '$4 == "particle_system" { print $1, $2 }')
printf -v last '0x%x' "$((16#$base + 16#$bytes - 1))"
RAM_TRACE_MIN="0x$base" RAM_TRACE_MAX="$last" ./scripts/run-trace.sh --trace "$particle_bin"
```

## 模拟演示模块与入口

| 模块 | 代码入口 | 职责 |
| --- | --- | --- |
| 模拟内存 | `memory`、`locationOf()`、`valueAt()` | 用一个 `Uint32Array` 保存 512 个 4 字节值。把下标换算成字节地址和 Bank、行、列，并按字段定义解释有符号值。 |
| 读取预设 | `presets`、`scan()`、`repeat()` | 生成混合读取、双 Bank 交错和共享热点的读取序列。 |
| 游戏与数据布局 | `createGame()`、`createBatchGame()`、`makeGameTask()` | 初始化游戏数据，计算字段下标，并把无人机分给各个任务。`game.fields` 为格子提供字段名、所属区域及有符号标记。 |
| 执行与播放 | `startReaders()`、`step()`、`advancePlayback()`、`reset()` | 启动生成器，轮流执行读写，推进游戏轮次，处理播放和重置。 |
| 内存显示 | `drawGrid()`、`cells`、`inspect()`、`appendAccess()` | 建立下标到两个 DOM 格子的对应关系，显示访问记录，并在悬停时同步标出地址。当前访问的高亮由 `step()` 直接更新。 |
| 游戏画面与统计 | `drawGame()`、`recordAccess()`、`drawTrace()`、`drawStrideChart()` | 用 Canvas 绘制无人机与步长曲线，并统计访问涉及的模拟缓存行。`drawPlaybackState()` 更新游戏画面和统计区。 |

## 一次访问如何到达画面

1. **初始化格子。** `drawGrid()` 遍历数组下标。每个 `cells[i]` 都保存两个 DOM 元素，一个在线性视图，一个在 RAM 阵列视图。`locationOf(i)` 决定阵列位置。例如下标 `32` 对应 `0x0080` 和 Bank 1 的第 0 行第 0 列。
2. **任务请求读写。** 生成器产出一个数字来请求读取该下标，产出 `{ index, value }` 来请求写入。游戏通过实体编号和字段名计算下标，简单预设直接生成下标。任务共享 `memory[0]` 到 `memory[511]`，`step()` 信任任务提交的下标。
3. **调度器执行一次访问。** `step()` 选择下一个尚未结束的任务，在 `memory` 上执行请求，再通过 `reader.next(value)` 把结果交回生成器。生成器产出的下一条指令会保存到该任务下次轮到时执行。
4. **界面更新。** `step()` 用 `cells[index]` 点亮两个格子，并调用 `appendAccess()` 和 `recordAccess()`。步长图使用这批读取下标。`drawGame()` 和悬停检查直接读取数组来展示当前状态，这些显示用的读取独立于任务记录。

## 预设对照

| 场景 | 数据与执行方式 |
| --- | --- |
| 混合读取、双 Bank 交错、共享热点 | 持续轮流读取。统计窗口为最近 32 次读取。 |
| 采集游戏 · 面向对象 / ECS | 16 架无人机，每架 5 个字段，占 `0–79` 格。地图有 128 格，占 `128–255` 格。面向对象版由 `Drone.update()` 逐架执行，ECS 版由 `movementSystem()` 和 `collectionSystem()` 分批处理。 |
| 批量移动 · 按对象 / 按字段 | 32 架无人机，每架 16 个字段，填满 512 格。两套都用 `moveBatch()` 执行 `x += 1`。布局决定 `x` 下标是 `0, 16, …, 496` 还是 `0, 1, …, 31`。 |

游戏预设在所有任务完成后进入下一轮。统计保留已完成轮次的数据，下一轮首次访问时才刷新。步长是相邻两次读取的下标差，保留方向。缓存行按每 16 格（64 字节）分组，统计范围内的读写都会计入触及的缓存行。

## 改动后可核对的结果

- 修改地址映射后，单步跨过 `31 → 32`，检查两个视图和悬停地址是否一致。
- 修改游戏布局或任务分配后，从同样的初始状态完成一轮，检查两个采集游戏的位置、速度和得分是否一致。
- 修改批量移动或统计后，完成一轮。两套应各有 32 读、32 写，步长分别为 `+16` 和 `+1`，最常见步长占比都为 100%，触及的模拟缓存行分别为 32 和 2。
