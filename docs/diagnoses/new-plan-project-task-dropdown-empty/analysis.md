# 新建计划弹窗：选择「项目」后，该项目对应的下拉框建不出条目，且会创建出项目/员工错配的计划

**Bug slug**: `new-plan-project-task-dropdown-empty`
**Version**: v2（v1 = Subtask #0 定位与分析；v2 = Subtask #1 评审，含 2 处证据修正 + 3 处同源缺陷补录 + 末尾「评审结论」）
**日期**: 2026-07-30

> **下游（修复节点）阅读顺序建议**：先读末尾 **§评审结论**（含定稿代码与 4 条必测用例），
> 再回头看 §3 根因。v1 正文中被评审推翻的部分已就地标注「评审修正」，**不要照抄未标注前的旧结论**
> —— 尤其是 §4「执行面」那一行与 §6 理由 4 关于 B1 的描述。

---

## 0. 代码位置声明（下游节点必读）

本任务图的工作目录是 `M:/takoAI/JRAgentMesh/aragon-agent-core`，但**缺陷不在该子项目内**。
`aragon-agent-core` 是 CLI Agent 内核，没有任何 React / 项目下拉框代码。

用户描述的功能属于**宿主应用 AragonMesh**，源码根目录为：

```
M:/takoAI/JRAgentMesh          ← 真正要改的仓库（server/ + src/ + shared/）
```

任务提示词里给出的 `M:/takoAI/JRAgentMesh/desktop/release/win-unpacked/resources/server`
是**打包产物**（`dist.asar` + 压缩后的 server），只读、不可改。

本文所有 `path/to/file.ts:NN` 形式的引用，若无特别说明，**均以 `M:/takoAI/JRAgentMesh/` 为根**。
本报告本身按任务约束写在工作目录内。

---

## 1. 问题描述

用户原话：

> 这个项目的对应的 Agent 功能，然后在用户去点击新建 Agent 会话，然后选择对应 Agent 的关联项目的时候，
> 目前这个项目的下拉框无法正确的创建对应的项目，有问题需要进行修复

### 1.1 描述到 UI 的映射

全仓没有任何一处 UI 文案叫「新建 Agent 会话」（`grep -rn "会话" messages/zh/*.json` 只有
「自由会话」「历史会话」「新建拆解会话」等，均不匹配）。用户是在用自己的话描述流程。
按「①新建一次 Agent 运行 ②要选一个**关联项目** ③项目是**下拉框**」三个特征，全仓唯一命中的是：

**任务看板 →「新建」→ 新建计划弹窗**（`src/components/agents/task-tracker/task-tracker-form.tsx`）

该弹窗自上而下依次是：标题 / 类型 / **Agent 类型** / **项目（可选）** / **任务（可选）** /
提示词 / 启动模式 / 运行模式。「项目」与「任务（员工）」是一对联动下拉框
（`messages/zh/tasks.json:622-625` 的 `projectLabel` / `noProject` / `taskLabel` / `selectTask`）。

**旁证一（决定性）**：本次任务对应的计划卡片自身就在库里，标题是用户手填的
**「修复Agent项目下拉框」**：

```bash
node -e "const D=require('better-sqlite3');
const db=new D(process.env.APPDATA+'/AragonMesh/aragonmesh.db',{readonly:true});
console.log(db.prepare(\"SELECT title,project_id,task_id,execution_mode FROM task_tracker_plans WHERE title LIKE '%下拉框%' ORDER BY created_at DESC LIMIT 1\").get())"
```

```
{ title: '修复Agent项目下拉框',
  project_id: 'proj-208f0e8c-9735-4fbd-8e7b-934830dffa51',   // aragon-agent-core
  task_id:    'task-046c80c7-8250-417a-8411-a671d057a001',
  execution_mode: 'decomposition' }
```

「**Agent 项目下拉框**」= 新建计划弹窗里紧挨着「Agent 类型」的那个「项目（可选）」下拉框，
与本文的判定完全一致。

顺带一提，用户这次**成功**创建了这张卡片（decomposition 模式、项目 + 员工都选上了）——
因为 `aragon-agent-core` 当时 `runningCount = 1`，被会话首次 `loadProjects()` 自动展开、
顺带预取了员工列表（见 §3.2 表格第 2 行）。这不是反证，恰恰是"**换个空闲项目就不行**"这条
时灵时不灵规律的正面印证。

**旁证二**：上一轮 Bug 修复（commit `355ad611`「fix: 新建计划弹窗 Agent Type 下拉框长时间为空」）
就是同一个用户、同一个弹窗、上一个下拉框。本次报告的是紧挨着它的下一对下拉框。

### 1.2 症状（两条，同源，会叠加）

- **症状 A**：在「项目」下拉框里选中某个项目后，紧邻的「任务」下拉框**依然是空的且被禁用**
  （灰掉、点不开）。若「启动模式」是「任务模板启动」，此时「创建」按钮恒为禁用，弹窗底部
  提示「任务模板启动模式需要先选择项目和任务」，而用户**没有任何途径**去满足它 —— 计划创建不出来。
  并非所有项目都这样：**左侧项目树里展开过的项目正常，没展开过的项目必现**（见 §3.2）。
- **症状 B**：把「项目」从 A 切到 B 之后，「任务」按钮显示回「选择任务」（看起来已清空），
  但内部 `taskId` **仍然是项目 A 的员工**。此时创建按钮可用，提交后得到一张
  **`projectId = B` 而 `taskId = A 的员工`** 的计划卡片 —— 卡片归档在 B 项目下，
  实际执行却读 A 项目的运行图快照与工作目录。这就是用户说的「无法正确地创建对应的项目」。

---

## 2. 复现步骤

### 2.1 症状 A（任务下拉框建不出条目）— 必现

前置：桌面端 AragonMesh 已启动、已登录，至少有两个项目、其中一个项目下有 ≥1 个员工（任务）。

1. 让目标项目处于「未展开」状态。最干净的做法是清掉展开态缓存后重启渲染进程：
   在渲染进程 DevTools 控制台执行
   ```js
   localStorage.removeItem('jram_expanded_projects'); location.reload();
   ```
   （该 key 定义在 `src/stores/project-store.ts:81`）。
   等价的纯手工做法：在「Agent」页左侧项目树里把所有项目**折叠**，再刷新。
2. 进入「任务看板」页（`/task-board`）。**全程不要去 Agent 页展开任何项目**。
3. 点击右上角「新建」，打开「新建计划」弹窗。
4. 在「项目」下拉框选择那个有员工的项目（例如 `aragon-agent-core`）。
5. **观察**：右侧「任务」按钮显示「选择任务」，**灰色、禁用、点击无反应**，下拉不展开。
6. 把「启动模式」切到「任务模板启动」→「创建」按钮变灰，底部红字
   「任务模板启动模式需要先选择项目和任务」。**至此无路可走。**
7. 对照实验：新开一个标签/回到「Agent」页，把同一个项目在左侧树里**展开一次**（此时会触发
   `loadProjectTasks`），再回任务看板重开弹窗、重选同一项目 → 「任务」下拉框**立刻正常**。

### 2.2 症状 A 的接口级复现（不依赖 UI，直接证明数据缺口）

桌面端后端端口取自 `%APPDATA%/AragonMesh/desktop-config.json` 的 `port` 字段（本机 = 52117）：

```bash
node -e "
const http=require('http');
const get=p=>new Promise(r=>{http.request({host:'127.0.0.1',port:52117,path:p},x=>{let b='';x.on('data',d=>b+=d);x.on('end',()=>r(b))}).end()});
(async()=>{
  const projects = JSON.parse(await get('/api/projects')).projects;
  console.log('keys:', Object.keys(projects[0]).join(','));
  console.log('has tasks key?', 'tasks' in projects[0]);
  const p = projects.find(x=>x.name==='aragon-agent-core');
  const t = JSON.parse(await get('/api/projects/'+p.id+'/tasks'));
  console.log('per-project tasks:', t.tasks.length);
})();"
```

本机实测输出：

```
keys: id,name,description,workspaceDir,status,taskCount,runningCount,pinned,sortOrder,createdAt,updatedAt
has tasks key? false
per-project tasks: 4
```

即：**列表接口根本不返回 `tasks`，员工数据只存在于第二个懒加载接口里**；
而新建计划弹窗只读前者、从不调后者（§3.1）。

### 2.3 症状 B（项目/员工错配）— 必现

1. 在「Agent」页左侧树里选中项目 A 下的某个员工（这会写入 unified-context 的 `selectedTaskId`）。
2. 切到「任务看板」→「新建」。弹窗打开时「项目」已自动填 A、「任务」已自动填该员工。
3. 把「项目」下拉框改选成项目 B。
4. **观察**：「任务」按钮文案回落成「选择任务」（看上去已清空），但**内部状态未清**。
5. 填写提示词 →「创建」按钮**可用** → 点击创建。
6. 打开新卡片的详情 / 或直接查库：

```bash
node -e "
const D=require('better-sqlite3');
const db=new D(process.env.APPDATA+'/AragonMesh/aragonmesh.db',{readonly:true});
const r=db.prepare('SELECT id,title,project_id,task_id FROM task_tracker_plans ORDER BY created_at DESC LIMIT 3').all();
for(const x of r){
  const t=x.task_id?db.prepare('SELECT project_id FROM tasks WHERE id=?').get(x.task_id):null;
  console.log(x.title,'| plan.project=',x.project_id,'| task.project=',t&&t.project_id,
    '| MISMATCH=', !!(t && t.project_id!==x.project_id));
}"
```

`MISMATCH=true` 即复现成功。

---

## 3. 根因分析

### 3.1 主因（症状 A）：`project.tasks` 是懒加载字段，而新建计划弹窗只消费、从不触发加载

**证据链一 · 服务端把「项目列表」和「项目下的员工」拆成了两个接口**

`server/express-app.ts:2750`（列表，不含 tasks）：

```ts
app.get('/api/projects', (req, res) => {
  const result = projectService.listProjects({ status, search });
  res.json(result);                        // { projects: Project[], total }
});
```

`Project` 的行映射里根本没有 `tasks` 字段 —— `server/db/repositories/project-repository.ts:33-46`
的 `rowToProject()` 只映射 `id/name/description/workspaceDir/status/taskCount/runningCount/pinned/sortOrder/createdAt/updatedAt`。

员工数据在**另一个**接口 `server/express-app.ts:2853`：

```ts
app.get('/api/projects/:projectId/tasks', (req, res) => {
  const tasks = taskService.listTasks(req.params.projectId, { status });
  res.json({ tasks });
});
```

§2.2 的实测输出逐字印证了这个拆分。

**证据链二 · 前端 store 明确把 `tasks` 标注为懒加载，只为「已展开」的项目预取**

`src/stores/project-store.ts:142-146`：

```ts
const projects: ProjectWithTasks[] = (data.projects ?? []).map((p: ProjectInfo) => ({
  ...p,
  tasks: undefined, // lazy load
}));
```

`src/stores/project-store.ts:164-181` 只对 `expandedProjectIds` 命中的项目补拉：

```ts
await Promise.all(
  projects
    .filter((proj) => expanded.has(proj.id))     // ← 只有「展开过」的项目才有 tasks
    .map(async (proj) => { /* fetch /api/projects/:id/tasks */ }),
);
```

`expandedProjectIds` 持久化在 `localStorage['jram_expanded_projects']`
（`src/stores/project-store.ts:83` / `loadExpandedIds()`）。**这正是「有的项目行、有的项目不行」的开关。**

**证据链三 · 全仓 `loadProjectTasks` 的调用点里，唯独新建计划弹窗缺席**

```
src/components/agents/project-item.tsx:131                  ← 树节点展开时懒加载
src/components/agents/project-overview-panel.tsx:80         ← 项目总览面板
src/components/agents/agent-overview-panel.tsx:141,154      ← 全局总览
src/components/agents/task-tracker/kanban-card-continue-modal.tsx:158  ← 「继续」弹窗
src/components/agents/project-tree-panel.tsx:104            ← 重命名员工后刷新（评审补录）
src/stores/project-store.ts:436  (toggleProjectExpand)      ← 展开动作内联懒加载（store 内部，评审补录）
src/stores/project-store.ts:207,512 (refreshProjectTasksDebounced) ← 防抖刷新（store 内部，评审补录）
```

> **评审修正（Subtask #1）**：原文此处写「以上为全部生产调用点」并不成立，实际漏了
> `project-tree-panel.tsx:104` 与 store 内部三处。**但结论不变，反而更硬**：漏掉的三处**没有一处**
> 能完成首次装载 ——
> `project-tree-panel.tsx:102-107` 与 `refreshProjectForTask` 同构，同样被 `proj.tasks?.some(...)` 挡在门外；
> `toggleProjectExpand`（`project-store.ts:426-440`）的触发条件恰恰就是"展开"这个动作本身；
> `refreshProjectTasksDebounced` 只刷新调用方已知 id 的项目。
> 即：**全仓 7 个装载入口，无一由「在弹窗里选中一个项目」触发**。

`kanban-card-continue-modal.tsx:155-159` 的注释把这个坑写得清清楚楚 ——
**团队已经在「继续」弹窗里踩过并修过同一个坑**：

```ts
// 仅对绑定了 project + task 的 plan 拉项目任务列表（懒加载防止抽屉直接打开时空 tasks）
useEffect(() => {
  if (!planId || !plan?.taskId || !plan?.projectId) return;
  void loadProjectTasks(plan.projectId);
}, [planId, plan?.taskId, plan?.projectId, loadProjectTasks]);
```

`project-item.tsx:128-133` 是另一份同构写法：

```ts
// Lazy-load tasks when expanded and not yet loaded
useEffect(() => {
  if (expanded && !project.tasks) loadProjectTasks(project.id);
}, [expanded, project.tasks, project.id, loadProjectTasks]);
```

而 `task-tracker-form.tsx:233-235` **只读不取**：

```ts
// Get tasks for selected project
const selectedProject = projects.find((p) => p.id === projectId);
const projectTasks = selectedProject?.tasks ?? [];        // ← undefined ⇒ 恒为 []
```

于是 `task-tracker-form.tsx:452-464` 的任务下拉框被自己锁死：

```tsx
<button
  onClick={() => setTaskDropdownOpen(!taskDropdownOpen)}
  disabled={!projectId || projectTasks.length === 0}      // ← 禁用
  ...
{taskDropdownOpen && projectTasks.length > 0 && ( ... )}  // ← 面板也不渲染
```

**证据链四 · 任务看板这条路由永远不会有人替它把 tasks 灌进来**

- `task-tracker-page.tsx:28-30` 只调 `loadProjects()`，不调 `loadProjectTasks`。
- 看板自己的项目树 `task-tracker-project-panel.tsx:350-354` 直接渲染
  `project.tasks?.filter(...)`，同样**没有**懒加载 effect（因此看板左树展开一个未加载的项目
  也是空的 —— 同一根因的第二个可见症状）。
- 兜底刷新 `src/lib/event-router.ts:490-500` 的 `refreshProjectForTask()` 用
  `proj.tasks?.some(t => t.id === taskId)` 定位项目，**只能刷新已经有 tasks 的项目**，
  结构上无法完成首次装载：

```ts
for (const proj of store.projects) {
  if (proj.tasks?.some(t => t.id === taskId)) {   // tasks === undefined ⇒ 永远进不来
    store.refreshProjectTasksDebounced(proj.id);
    break;
  }
}
```

**结论（症状 A）**：`projects[].tasks` 的装载责任被完全绑定在「左侧项目树的展开动作」上；
新建计划弹窗与之无耦合，却直接消费该字段。用户只要没在本会话展开过目标项目，
「任务」下拉框就永远建不出条目；在「任务模板启动」模式下，这等于**计划无法创建**。

### 3.2 为什么"有时候又是好的"

`expandedProjectIds` 跨会话持久化，且 `loadProjects()` 首次调用时会把
`status === 'running' || runningCount > 0` 的项目自动加入展开集
（`src/stores/project-store.ts:152-159`）。所以：

| 目标项目状态 | 「任务」下拉框 |
|---|---|
| 本会话/历史会话在左树展开过（在 `localStorage` 里） | ✅ 正常 |
| 当前有 Agent 在跑（首次 `loadProjects` 自动展开） | ✅ 正常 |
| 其余（大多数空闲项目） | ❌ 空且禁用 |

这解释了用户"下拉框无法正确地创建对应的条目"这种**时灵时不灵**的表述。

**评审补充（两条，均对修复实现有强约束）**：

1. **自动展开只发生一次**。`_didInitialAutoExpand` 是模块级一次性闸门
   （`project-store.ts:106-109` + `:154-159`），注释写明"gate it to the first load of the session
   so re-mounts don't override a user's manual collapse"。所以上表第 2 行只对**本会话第一次**
   `loadProjects()` 成立；用户手动折叠后，即便该项目仍在跑，后续 `loadProjects()` 也不会再把它捞回来。
2. **`loadProjects()` 会把未展开项目的 `tasks` 重新抹成 `undefined`**。`:142-145` 无差别地对
   **全部**项目写 `tasks: undefined`，随后 `:166-178` 只给"已展开"的项目补拉。而
   `loadProjects()` 有 6 个调用点，其中
   `src/hooks/use-websocket.tsx:160`（WS 连接/重连）与
   `task-tracker-project-panel.tsx:135` **可以在弹窗已经打开时触发**。
   ⇒ 即使修复后成功拉到了员工列表，一次重连也会把它清空。
   **这条直接决定了 A1 的 effect 依赖数组必须包含 `selectedProject?.tasks`**（只依赖
   `[projectId]` 的写法会在被抹掉后不再重拉，下拉框中途静默变空）。详见 §评审结论 R-2。

### 3.3 次因（症状 B）：切换项目时 `taskId` 不复位 —— 只在「清空项目」时才复位

`src/components/agents/task-tracker/task-tracker-form.tsx:287-290`：

```ts
// Reset taskId when project changes
useEffect(() => {
  if (!projectId) setTaskId('');      // ← 只有「清空为不关联项目」才清 taskId
}, [projectId]);
```

注释写的是「project changes」，实现却只覆盖 `projectId === ''` 一种情形。
`A → B` 的切换**不清 `taskId`**。该逻辑自 `025f02a4`（2026-03-25，文件首次提交）起就是这样，
属长期潜伏缺陷、非近期回归。

后果链条（`task-tracker-form.tsx`）：

1. `:292-294` `missingTaskForDecomposition = decompositionRequiresTask && (!projectId || !taskId)`
   —— `taskId` 非空 ⇒ 判定为"已选任务" ⇒ `:307-308` `submitDisabled` 放行。
2. `:460-462` 按钮文案 `projectTasks.find(tt => tt.id === taskId)?.title ?? '选择任务'`
   —— 新项目的列表里找不到旧 `taskId` ⇒ **显示回「选择任务」，用户以为已经清空了**。
3. `:341-348` 提交体把两个字段各自独立塞进去，无任何一致性校验：

```ts
...(projectId ? { projectId } : {}),
...(taskId ? { taskId } : {}),
```

4. 服务端 `server/websocket/task-tracker-handlers.ts:1145-1157` 也**不做交叉校验**，
   原样落库：

```ts
let plan = repo.create({
  projectId: data.projectId,
  taskId: data.taskId,
  ...
});
```

**两条缺陷会叠加成最坏形态**：主因让「任务」按钮**禁用**（用户连手动清空的入口都没有），
次因让旧 `taskId` **静默存活**并被提交 —— 用户看到的是"我明明选了项目 B、任务显示未选"，
拿到的却是一张绑定 A 项目员工的卡片。**这是用户原话「无法正确的创建对应的项目」最直接的对应。**

### 3.4 附带（同 3 行代码）：mount 期反查失败会静默丢弃 draft 的 taskId

`initialProjectId`（`:76-90`）是 `useMemo(..., [])`，**只在 mount 算一次**，且依赖
`findProjectIdForTask(projects, taskId)` —— 而该函数遍历的正是懒加载的 `p.tasks`
（`:45-50`）。若弹窗在 `projects` 尚未装载 tasks 时挂载，反查失败 ⇒ `projectId = ''`
⇒ `:288-290` 的 effect 命中 `!projectId` ⇒ `setTaskId('')` ⇒ **draft 里带来的员工绑定被无声丢弃**。

> **评审修正 · 触发条件不是"冷启动"**。`formDraft` 是纯内存态（`task-tracker-store.ts:220`
> 初值 `null`，`:256-258` 关闭表单即清空，无 persist 中间件），`selectedTaskId` 同样**不落
> localStorage**（`unified-context-store.ts` 里唯一用 localStorage 的是 `jram_default_work_dir`，
> `:179` / `:320`）。冷启动时两者都是空，`initialTaskId` 直接为 `''`，**没有东西可丢**。
> 真正的触发窗口是**同会话跨入口**：`openCreateForm(draft)` 的三个调用点
> （`task-tracker-header.tsx:116`、`kanban-column.tsx:193`、`agent-tree-panel.tsx:412`）
> 拿到一个 `taskId`，而它所属项目此刻恰好没有 `tasks`。典型路径：WS 重连触发
> `loadProjects()` 抹掉 tasks（见 §3.2 评审补充 2），随后用户点「新建」。

**评审补录 · 同一根因在弹窗外还有两处，本次修复不覆盖（须知情，不建议顺手改）**：

1. **draft 构造阶段的跨项目守卫会「反向误伤」**。
   `src/components/agents/task-tracker/resolve-create-plan-draft.ts:41-48`：

   ```ts
   // 3. 跨项目守卫：projectId 来自 tracker，但 taskId 不属于该项目时，丢弃 taskId
   if (trackerFilterProject && taskId &&
       !projects.find((p) => p.id === trackerFilterProject)?.tasks?.some((t) => t.id === taskId)) {
     taskId = undefined;
   }
   ```

   `tasks` 为 `undefined` 时 `?.some(...)` 求值为 `undefined`，取反为 `true`
   ⇒ **合法的 taskId 被判为「不属于该项目」而丢弃**。
   同理 `:35-39` 的 projectId 反查、`:51-55` 的 `executionMode` 推断也都建立在 `p.tasks` 上。
   这段代码是**正面证据**：团队早已把「projectId / taskId 错配」视为必须拦截的非法态（支持 F2），
   但守卫本身被同一个懒加载缺口反向击穿。
   **注意**：draft 在 `openCreateForm()` 的**同步点**算完，早于弹窗 mount，因此
   A1（弹窗内异步补拉）**救不回**已经在这里被丢掉的 taskId ——
   修复后用户仍需在（此时已可用的）下拉框里自己选一次员工。这是可接受的降级，不是新缺陷。

2. **`executionMode` 默认值同样被静默降级为 `direct`**。
   `task-tracker-form.tsx:101-111` 的 `initialMode` 是 `useMemo(..., [])`，
   靠 `proj?.tasks?.find(...)` + `isTaskDecomposed(t)` 判定；tasks 未装载 ⇒ `t === undefined`
   ⇒ `isTaskDecomposed` 返回 `false` ⇒ 落到 `'direct'`。
   `agent-tree-panel.tsx:401-411` 有一份同构实现，缺陷相同。
   后果比症状 A 轻（用户可手动切换单选框），且 A1 **不会**修复它（memo 依赖数组为空，
   tasks 后到也不重算）。**刻意不修**的理由见 §评审结论 R-4。

---

## 4. 影响面

| 维度 | 说明 |
|---|---|
| **受影响入口** | ① 任务看板 →「新建」；② 任务看板 →「编辑计划」；③ Agent 页左侧树「新建 ▾ → 新建计划」。三者共用同一个 `TaskTrackerForm` |
| **受影响功能** | 「任务模板启动」（`executionMode='decomposition'`）**完全不可用**（创建按钮恒禁用）；「直接启动」可创建，但员工绑定可能错配 |
| **受影响用户** | 全部桌面端用户。本机实测 26 个项目中，只要没在本会话展开过就命中，覆盖面接近全量项目 |
| **数据面** | 症状 B 会**持久化**错配数据到 `task_tracker_plans.project_id / task_id`；该表参与云同步（iter3 outbox），错配会被推到云端并同步到其它设备。**实测本机存量为 0**（见下方核对命令）—— 即这是一个已具备全部触发条件、但尚未造成存量损坏的风险，属"该在爆发前修"而非"要清洗历史数据" |
| **执行面** | 见下方「评审修正 · 执行面」——**原文对工作目录的判断是反的**，但错配的实际后果**更重**（污染 A 项目员工的运行图记录 + 占用 A 的员工互斥锁 + 事后无法接管） |
| **同源第二症状** | 看板左侧项目树（`task-tracker-project-panel.tsx:351`）展开未加载项目同样看不到员工 |
| **不受影响** | 服务端、协议、DB schema 均无缺陷；`/api/projects/:id/tasks` 数据完好（§2.2 实测返回 4 条）。这是**纯渲染端缺陷** |

### 评审修正 · 执行面（原文引错了函数，结论需重写）

`resolveContextWorkDir()`（`server/services/agent-context-resolver.ts:45-72`）确实**优先按 `taskId`**
解析工作目录，但它**不在计划启动路径上**。全仓仅两个生产调用点，都是通用的「创建 Agent」入口：

```
server/express-app.ts:365          （POST /api/agents）
server/websocket/agent-handlers.ts:122  （agent.create WS）
```

计划启动走的是 `task-tracker-handlers.ts` 里的**同名局部 helper** `resolveWorkDir(plan, apm)`
（`:217-249`），优先级完全不同：

```ts
// 1. plan.agentId → 该 Agent 已有的 workDir
// 2. plan.projectId → project.workspaceDir     ← 按【项目】解析，不是按 taskId
// 3. process.cwd()                              ← 兜底
```

`executeLaunch` 在 `:1666` 调的正是它。所以错配计划的真实执行语义是
**「在项目 B 的工作目录里，跑项目 A 那个员工的运行图」**，与原文所述方向相反。

后果按模式分列（比原文更重，因为污染是**写**进 A 项目的）：

- **decomposition 模式**（`launchDecompositionPlan`，`:779-990`）
  - `:793` `taskRepo.findById(plan.taskId)` 取的是 **A 的员工快照**（运行图来自 A）。
  - `:868` `decompositionId = plan.taskId` ⇒ `:880-899` 的
    `decompositionRepo.create/update({ id: A的taskId, workspaceDir: workDir })`
    把 **A 员工的分解记录 workspaceDir 改写成 B 的目录**。
  - `:977` `taskRepo.update(plan.taskId, { graphExecutionId })` ⇒ **A 员工行被绑到这次执行**。
  - `:1653-1663` `claimEmployeeForLaunch(plan.taskId)` ⇒ **占用 A 的员工互斥锁**，
    A 项目下正常的计划会收到「该员工正被其它运行中的计划占用」。
  - ⇒ 这是**跨项目写污染**，不只是"跑错目录"。
- **direct 模式**（`:1698` 起）：Agent 在 **B 的工作目录**启动，
  但 `:1740-1743` 的 `ownership` 仍带 `taskId: A的员工` ⇒ 归属树把这个 Agent 挂在 A 项目下，
  卡片却在 B 项目下。

**旁证（强）**：`tracker.takeover` 已经把这种错配当作非法态**硬拒**
（`task-tracker-handlers.ts:1513-1516`）：

```ts
if (plan.projectId && task.projectId !== plan.projectId) {
  sendTakeoverError(ws, 'WORKDIR_UNAVAILABLE', '计划关联的任务不属于当前项目', ...);
  return;
}
```

也就是说：**创建时不拦、启动时不拦、只有接管时才拦**。用户能创建、能跑，跑完点「接管」才收到一句
莫名其妙的「计划关联的任务不属于当前项目」。这既坐实了症状 B 的危害，也证明「projectId 与
taskId 必须自洽」本来就是本仓已承认的不变量 —— F2 是**补齐**该不变量，不是新增约束。

存量错配核对命令与实测结果：

```bash
node -e "const D=require('better-sqlite3');
const db=new D(process.env.APPDATA+'/AragonMesh/aragonmesh.db',{readonly:true});
console.log('mismatched plans:', db.prepare('SELECT COUNT(*) n FROM task_tracker_plans p JOIN tasks t ON t.id=p.task_id WHERE p.project_id IS NOT NULL AND t.project_id<>p.project_id').get().n)"
# → mismatched plans: 0
```

服务端日志（`%APPDATA%/AragonMesh/logs/server.log`，最近 1.5 MB 窗口）中
**没有任何** project / task / tracker 创建相关的 ERROR，只有与本问题无关的
`AgentSummarizer ... fetch failed` 与 `CloudWsClient ... ENOTFOUND aragonmesh.com`。
这与"纯前端缺陷、后端从未被调用"的结论一致 —— 缺的那个 HTTP 请求**根本没发出去**。

---

## 5. 候选修复方案对比

修复目标拆成两项，互相独立、建议一起做：

- **F1**：选中项目后要能拿到该项目的员工列表（治症状 A）。
- **F2**：切换项目时必须复位 `taskId`（治症状 B）。

### F1 候选

| 方案 | 做法 | 侵入性 | 风险 | 工作量 | 评价 |
|---|---|---|---|---|---|
| **A1（推荐）** | 在 `task-tracker-form.tsx` 增一个懒加载 effect：`projectId` 变化且 `!selectedProject?.tasks` 时调 `loadProjectTasks(projectId)`，逐字对齐 `kanban-card-continue-modal.tsx:155-159` | 单文件 +6 行 | 低 | 极小 | 与仓库既有正确写法同构；store 的 `loadProjectTasks` 已自带幂等 set；失败静默不阻断 |
| A2 | 让 `GET /api/projects` 直接内联返回每个项目的 tasks | 服务端 + 协议 | **高** | 中 | 破坏既有懒加载契约（`tasks: undefined // lazy load` 是全仓约定）；26 项目 × N 员工的 N+1 查询进首屏关键路径；`ProjectInfo` 语义变更牵动云同步镜像字段白名单 |
| A3 | 打开看板时预取**所有**项目的 tasks | 单文件 | 中 | 小 | 26 个并发请求换 1 个可能用不到的下拉框，且项目越多越差；`loadProjects` 已有的「只预取展开项」正是刻意避免这种放大 |
| A4 | 把「任务」下拉框改成不禁用、点开时才拉取 | 单文件 | 中 | 中 | 交互多一次等待与 loading 态，需要新增加载中 UI；收益不比 A1 大 |

### F2 候选

| 方案 | 做法 | 侵入性 | 风险 | 工作量 | 评价 |
|---|---|---|---|---|---|
| **B1（推荐）** | 把 `:288-290` 改为「`projectId` 真正发生变化时清 `taskId`」，用 `useRef` 记录上一次的 `projectId`，跳过首帧以保住 `initialTaskId` | 单文件 ~8 行 | 低 | 极小 | 直接兑现原注释的意图；必须跳过首帧，否则会把 `editingPlan` / draft 带来的默认员工冲掉 |
| B2 | 提交前校验 `taskId` 属于 `projectId`，不匹配则拦截报错 | 单文件 | 低 | 小 | 只在最后一步拦人，用户仍会撞墙且不知为何；可作为 B1 之外的**附加**防线，不能替代 B1 |
| B3 | 服务端 `tracker.create` / `tracker.update` 做交叉校验 | 服务端 | 低 | 中 | 值得做（纵深防御），但错误只能以 toast 呈现，用户体验差；且不修前端的话 F1 场景下用户仍无路可走 |

---

## 6. 推荐方案

**F1 = A1，F2 = B1，两者一并落地，均在 `src/components/agents/task-tracker/task-tracker-form.tsx` 单文件内完成。**

### 理由

1. **A1 不是新发明，是把仓库里已经验证过的写法补齐到唯一漏掉的地方。**
   `project-item.tsx:128-133` 与 `kanban-card-continue-modal.tsx:155-159` 是两份现成的同构实现，
   后者的注释（「懒加载防止抽屉直接打开时空 tasks」）说明团队**已经识别过这个失效模式**，
   只是没有覆盖到新建计划弹窗。照抄既有模式的一致性风险最低。
2. **不动服务端与协议。** `/api/projects/:id/tasks` 数据完好、语义正确（§2.2 实测），
   缺的只是渲染端那一次调用。A2 会把一个纯渲染端 bug 升级成协议变更 + 云同步镜像字段问题，
   与"改动尽量小"的要求相悖。
3. **B1 修的是注释与实现的偏差，而非新增行为。** 原注释写的就是「Reset taskId when project
   changes」，实现漏了主路径。补上后，`missingTaskForDecomposition` 的既有校验立刻恢复效力：
   切到新项目 → `taskId` 归空 → decomposition 模式下按钮自动置灰 + 提示语正确出现，
   用户被明确引导去选新项目的员工，而不是拿到一张错配的卡片。
4. **B1 必须跳过首帧**，这是本方案唯一容易做错的点：`initialTaskId`（`:92-97`）来自
   `editingPlan?.taskId ?? formDraft?.taskId ?? selectedTaskId`，若不跳首帧，
   **编辑既有计划时一打开就会把已绑定的员工清掉**（比原 bug 更糟）。实现上用
   `useRef<string | null>(null)` 存 previous，首次 effect 只写 ref 不清值。
   > **评审修正（R-1）**：本条正确但**不完整** —— 除了跳首帧，还**必须保留原有的
   > `if (!projectId) setTaskId('')` 规则**。按字面把 `:288-290` 整段"改为"切换检测，会放出
   > 「`taskId` 非空而 `projectId` 为空」的新失效态，direct 模式下最终让 Agent 跑在
   > `process.cwd()`（安装目录）。**实现请直接采用 §评审结论 R-1 的定稿代码**，勿等价改写。
5. **A1 + B1 一起做才闭环**：只做 A1，症状 B 仍在（切项目留下旧 `taskId`，只是这次
   下拉框可点了，用户可能自己发现）；只做 B1，症状 A 仍在（下拉框依然空且禁用，
   而且 `taskId` 被清空后 decomposition 模式**更加**无法提交）。

### 建议的验收与回归

- **手工验收**：完整跑一遍 §2.1（步骤 5 应能点开并看到 4 个员工）、§2.3
  （步骤 4 之后「创建」按钮在 decomposition 模式下应变灰；direct 模式下提交后 `MISMATCH=false`）。
- **回归测试**：`src/components/agents/task-tracker/__tests__/` 目前**没有** `task-tracker-form`
  的用例。建议新增两条，二者在修复前都必然失败：
  1. `loads project employees when a project is picked` —— 挂载后改 `projectId`，断言
     `loadProjectTasks` 被以该 id 调用**一次**，且已有 tasks 的项目**不重复**调用。
  2. `clears the selected employee when the project is switched` —— 以
     `{projectId: A, taskId: T_A}` 挂载，断言首帧 `taskId` **保持** `T_A`（守住 B1 的首帧例外），
     切到 B 后 `taskId` 归空。
- **类型检查**：按仓库约定分别跑 `npx tsc -p tsconfig.json --noEmit` 与
  `npx tsc -p tsconfig.server.json --noEmit`（`npm run build` 绿灯不等于类型干净）。

### 明确不在本次范围

- **B3 服务端交叉校验**：值得做的纵深防御，但属独立增强，且需要定义新的拒绝码 +
  英文 fallback 文案（走 `errors.<code>` 那套），不应混进这次最小修复。
- **`task-tracker-project-panel.tsx` 左树展开不懒加载**（§3.1 证据链四）：同源第二症状，
  修法与 A1 同构。是否一并修由 Subtask #1 评审决定；若做，同样是加一个 effect。
- **存量错配数据的清洗**：本机实测存量为 **0**（§4 的核对命令），无需清洗。
  若其它设备上枚举出非零结果，是否回填属数据运维决策，不在代码修复范围。

---

## 附录 A · 次要发现（与用户描述的另一种可能读法有关，本次不修）

若用户所指的"新建 Agent 会话 + 选项目"其实是**底部终端坞「+」→ 选择项目 → 创建 PowerShell / Agent**
这条路径（`src/components/layout/bottom-terminal-dock.tsx:289-303` +
`src/components/terminal/create-dock-terminal-dialog.tsx`），那里有一个独立的、
**表现相似但成因不同**的问题：

`src/components/layout/right-terminal-project-menu.tsx:67-69,166-181` 把
**没有绑定工作目录的项目整行禁用**（灰掉、`cursor-not-allowed`、副标题显示「未绑定工作目录」），
`create-dock-terminal-dialog.tsx:88,134` 的 `confirmDisabled` 也随之为真。

本机实测 `/api/projects` 返回的 26 个项目中有 **6 个 `workspaceDir === null`**：

```
Reliance-Paper / legal-lens / Ecliptrix / advprompter_exp / city-predict / openclaude
```

对这 6 个项目，用户在该下拉菜单里**点不动、也就创建不出对应的终端 / Agent**。

判断：这是**有意为之的守卫**（spec 标注 P1-1 / C1），不是缺陷；但产品上没有给出补救入口
（菜单里无法就地绑定目录）。真正可疑的是这些行**为何**没有 `workspaceDir` ——
`ProjectService.createProject()`（`server/services/project-service.ts:60-65`）在未显式传目录时
**一定**会回填 `{dataDir}/workspaces/{projectId}`，所以这 6 行不可能来自本地创建路径，
更可能来自云端 Web 后台创建后同步下来的镜像行。**建议 Subtask #1 评审时先与用户确认症状，
若确认是这条路径，则本文 §3 的结论不适用，应另开一轮针对"云端镜像项目缺 workspaceDir"的定位。**

从三条独立线索看，正文 §1.1 的判定（新建计划弹窗）可能性显著更高：
① 用户明确说"下拉框"，而终端坞那个是弹出菜单、且**不含** Agent 类型选择；
② 上一轮同一用户报的就是同一弹窗的相邻下拉框；
③ 用户说"无法正确的创建**对应的项目**"，与 §3.3 的项目/员工错配语义严丝合缝。

---

## 附录 B · 本次定位所用的可复现取证命令

| 目的 | 命令 |
|---|---|
| 定位运行中的后端端口 | `cat "$APPDATA/AragonMesh/desktop-config.json"` → `port` |
| 确认列表接口不含 tasks | 见 §2.2 |
| 确认库中项目/工作目录分布 | `node -e "const D=require('better-sqlite3');const db=new D(process.env.APPDATA+'/AragonMesh/aragonmesh.db',{readonly:true});console.log(db.prepare('SELECT name,workspace_dir FROM projects').all())"` |
| 确认服务端无相关报错 | 扫 `%APPDATA%/AragonMesh/logs/server.log` 尾部的 ERROR / WARN |
| 确认懒加载调用点全集 | `grep -rn "loadProjectTasks" src/ \| grep -v project-store.ts` |

> 注：读取 `aragonmesh.db` 一律加 `{ readonly: true }` —— 该库正被运行中的桌面端持有
> （本机 2.7 GB + 986 MB WAL），只读打开不会干扰其写入。

---

## 评审结论

**评审人**: Subtask #1（资深评审）· 2026-07-30
**评审范围**: 本文 v1 全文的证据链、候选方案边界、推荐方案的最小性与回归风险。
**审计方式**: 对宿主仓 `M:/takoAI/JRAgentMesh/` 逐条回读被引用的源码（未依赖运行中的桌面端）。

### 一、根因判定：**成立**（主因与次因均予确认）

| 断言 | 判定 | 复核依据 |
|---|---|---|
| `GET /api/projects` 不返回 `tasks` | ✅ 成立 | `express-app.ts:2750-2760` 直接 `res.json(projectService.listProjects(...))`；`project-repository.ts::rowToProject` 的 11 个字段里确无 `tasks`。**这比 §2.2 的接口实测更强** —— 它排除了"某个中间件顺手补字段"的可能 |
| 员工数据只在 `/api/projects/:id/tasks` | ✅ 成立 | `express-app.ts:2853-2862` |
| 前端把 `tasks` 标为懒加载、只给展开项预取 | ✅ 成立 | `project-store.ts:142-145`（全部抹 `undefined`）+ `:166-178`（只补展开项） |
| `task-tracker-form.tsx` 只消费不装载 | ✅ 成立 | `:233-235` 只读 `selectedProject?.tasks`；全文件无 `loadProjectTasks` import |
| 下拉框被 `projectTasks.length === 0` 锁死 | ✅ 成立 | `:457` `disabled`、`:464` 面板渲染条件，两处都卡在同一表达式 |
| 切项目不复位 `taskId` | ✅ 成立 | `:288-290` 逐字确认；注释写 "when project changes"，实现只覆盖 `!projectId` |
| 提交与落库均无交叉校验 | ✅ 成立 | `:341-348` 两个字段独立展开；`task-tracker-handlers.ts:1145-1157` 原样 `repo.create` |
| 纯渲染端缺陷、服务端无责 | ✅ 成立 | 三条独立佐证：接口数据完好、日志无相关 ERROR、缺的 HTTP 请求根本没发出 |

**反例排查（我主动找过、没找到能推翻结论的）**：
全仓 7 个 `loadProjectTasks` 装载入口（见 §3.1 证据链三的评审补录）**无一**由「在弹窗里选中项目」
触发；`refreshProjectForTask`（`event-router.ts:490-502`）与 `project-tree-panel.tsx:102-107`
都被 `proj.tasks?.some(...)` 结构性地挡在门外，无法完成首次装载。
看板页 `task-tracker-page.tsx:28-30` 只调 `loadProjects()`。**证据链闭合。**

**但原文有两处证据错误，已就地修正**（下游若照抄会写出错误的修复或错误的验收断言）：

- **E-1（严重）**：§4「执行面」引用的 `resolveContextWorkDir()` **不在计划启动路径上**。
  计划启动用的是 `task-tracker-handlers.ts:217-249` 的同名局部 helper，
  优先级是 `agentId → projectId → process.cwd()`，**按项目而非按员工**。
  修正稿见新增小节「评审修正 · 执行面」：真实后果是「在 B 的目录里跑 A 的运行图」，
  并且会**写污染 A 员工的分解记录**（`:880-899`）、**改写 A 员工行**（`:977`）、
  **占用 A 的员工互斥锁**（`:1653-1663`）—— 比原文描述更重。
- **E-2（轻）**：§3.1 证据链三「以上为全部生产调用点」不成立（漏 3 处）；§3.4 的触发条件
  不是"冷启动"（`formDraft` / `selectedTaskId` 都不跨会话持久化）。两处均已改写，结论未变。

**另外补录了三处同源缺陷**（详见 §3.4 评审补录）：draft 构造阶段的跨项目守卫会反向误伤
（`resolve-create-plan-draft.ts:41-48`）、`initialMode` 静默降级为 `direct`
（`task-tracker-form.tsx:101-111` 与 `agent-tree-panel.tsx:401-411`）。
它们**不改变**本次修复的范围，但决定了验收时"预选员工没回来"是**已知降级**而非修复失败。

### 二、症状归属：维持原文 §1.1 判定，附录 A 不构成阻断

原文建议"先与用户确认症状"。评审不采纳该建议，理由是证据已足够定向，且等待确认会阻塞下游：
①用户卡片标题逐字为「修复 Agent 项目下拉框」，`project_id` / `task_id` 双绑、
`execution_mode='decomposition'`，与本文场景逐字吻合；②上一轮 `355ad611` 是同一用户、同一弹窗
的相邻下拉框；③附录 A 那条路径（终端坞 `workspaceDir === null` 行禁用）是**有意守卫**，
不是缺陷，且它是弹出菜单不是下拉框、也不含 Agent 类型选择。
**若后续用户澄清指的是附录 A 那条路径**，本次修复仍然是净收益（修的是另一处真实缺陷），
届时另开一轮定位「云端镜像项目缺 workspaceDir」即可。

### 三、候选方案审计

**F1**：A2（服务端内联 tasks）会把纯渲染端缺陷升级成协议 + 云同步镜像字段变更，且把 N+1 查询
放进首屏关键路径 —— 否决。A3（打开看板预取全部项目）与 `loadProjects` 刻意"只预取展开项"的
既有取舍直接冲突，项目越多越差 —— 否决。A4（点开时才拉）需要新增 loading 态 UI，收益不优于
A1 —— 否决。**A1 成立**，但原文对其实现约束描述不足，见 R-2。

**F2**：B2（提交前拦截）只在最后一步拦人，不能替代 B1 —— 同意原文，仅作附加防线。
B3（服务端交叉校验）值得做但需新增拒绝码 + `errors.<code>` 英文 fallback，属独立增强 —— 同意
排除。**B1 方向正确，但原文给出的实现描述有缺陷，见 R-1（本次评审最重要的一条）。**

#### R-1（P0）· B1 **不能**替换原有的 `!projectId → 清空` 规则，只能在其之上叠加

原文写「把 `:288-290` 改为『`projectId` 真正发生变化时清 `taskId`』」。若按字面实现为**替换**，
会引入一个**比原 bug 更糟**的新失效态：弹窗以 `projectId=''` + 继承来的 `taskId=T` 挂载时
（§3.4 的窗口），旧规则会立刻清空 `T`，新规则因"首帧跳过"而不清 ⇒ 表单进入
**`taskId` 非空但 `projectId` 为空**的状态。此时：

- `:294` `missingTaskForDecomposition = !projectId || !taskId` ⇒ `!projectId` 为真 ⇒
  decomposition 模式仍被挡住（安全）；
- 但 **direct 模式可提交**，`:347-348` 会发出 `{ taskId: T }` 且**不带** `projectId`；
- 服务端 `:1145-1157` 不校验，原样落库；
- 启动时 `resolveWorkDir` 走到第 3 分支 ⇒ **`process.cwd()`**，即服务端进程自身的工作目录
  （装机版下是安装目录里的 `resources/server`）⇒ **Agent 在 AragonMesh 自己的安装目录里干活**。

结论：`taskId ⇒ projectId` 是当前表单事实上成立的不变量（正由那 3 行代码维持），
**修复必须保留它**。定稿实现：

```ts
// Reset taskId when project changes（评审定稿：规则 1 保留 + 规则 2 新增）
const prevProjectIdRef = useRef<string | null>(null);
useEffect(() => {
  const prev = prevProjectIdRef.current;
  prevProjectIdRef.current = projectId;
  // 规则 1（原有，不可删）：不关联项目 ⇒ 不允许留下孤儿 taskId
  if (!projectId) {
    setTaskId('');
    return;
  }
  // 规则 2（新增）：项目真的换了 ⇒ 旧员工必然不属于新项目
  if (prev !== null && prev !== projectId) setTaskId('');
}, [projectId]);   // ← 依赖数组只能是 [projectId]
```

两条附加约束：

- **依赖数组只能是 `[projectId]`**。若写成 `[projectId, projects]`（或 `[selectedProject]`），
  A1 拉回 tasks 触发的 store 更新会让 effect 重跑 —— 首帧例外已被 ref 消费掉，
  于是**编辑既有计划时刚打开就把已绑定的员工清掉**，正是原文 §6 理由 4 警告的那个更糟的回归。
- **首帧例外用 `prev !== null` 判定，不能用 `prev !== ''`** —— `''` 是合法的运行期值
  （"不关联项目"），拿它当哨兵会让"从无项目切到有项目"这次真实切换被漏判。

#### R-2（P0）· A1 的 effect 依赖必须包含 `selectedProject?.tasks`

`loadProjects()` 会把**所有**非展开项目的 `tasks` 抹回 `undefined`（`project-store.ts:142-145`），
而它的 6 个调用点里 `use-websocket.tsx:160`（WS 连接 / 重连）与
`task-tracker-project-panel.tsx:135` **可以在弹窗打开期间触发**。只依赖 `[projectId]` 的写法在
被抹除后不会重拉 ⇒ 用户眼前的下拉框**中途静默变空**，且症状与原 bug 一模一样。定稿实现：

```ts
const loadProjectTasks = useProjectStore((s) => s.loadProjectTasks);
// 懒加载选中项目的员工列表（对齐 kanban-card-continue-modal.tsx:155-159 的既有写法）
useEffect(() => {
  if (!projectId) return;
  if (selectedProject?.tasks) return;      // 已加载（空数组也算已加载）⇒ 不重复请求
  void loadProjectTasks(projectId);
}, [projectId, selectedProject?.tasks, loadProjectTasks]);
```

边界逐条核过：

| 边界 | 行为 | 依据 |
|---|---|---|
| 项目**无员工** | `tasks: []`，`![]` 为 false ⇒ **不会**重复请求；下拉框仍禁用（语义正确） | `project-store.ts:194` `data.tasks ?? []` |
| 请求**失败** | `!res.ok` / catch 均**不 set** ⇒ store 无变化 ⇒ 不触发 re-render ⇒ **不会**重试风暴；代价是下拉框保持禁用且无提示（与既有 4 个调用点的静默降级一致，不新增劣化） | `:189-204` |
| A→B→A **快速切换** | `set` 按 `p.id === projectId` 定点写，晚到的 A 响应**不会**覆盖 B ⇒ 无串数据风险；无 in-flight 去重，最坏多发一次请求 | `:196-200` |
| React **StrictMode 双调用** | 同上，幂等写入，最坏多一次 GET | — |
| 与 R-1 的**交互** | A1 只改 store 的 `tasks`，不动 `projectId` ⇒ 不会误触发规则 2 | 需由 R-1 的依赖数组约束保证 |
| **加载窗口内提交** | 切到 B 后 tasks 未到时：R-1 已把 `taskId` 清空 ⇒ `missingTaskForDecomposition` 为真 ⇒ decomposition 提交被挡；direct 提交只带 `projectId=B`，不产生错配 ⇒ **fail-closed** | `:294` / `:347-348` |

最后一行是**选择"按切换清空"（B1）而不是"按成员资格清空"变体的决定性理由**：
成员资格判定必须等 `tasks` 到达，而在这个几十~几百毫秒的窗口里
`taskId=T_A` 与 `projectId=B` 同时非空 ⇒ `missingTaskForDecomposition === false` ⇒
手快的用户**恰好能在窗口内提交出一张错配卡片**。B1 没有这个窗口。

#### R-3 · 最小性核验

A1 + R-1 定稿 ≈ **+14 行、单文件**，零服务端 / 零协议 / 零 DB / 零 i18n 新键
（复用既有 `trackerForm.missingTaskError` 等文案）。没有可再削减的部分：去掉 A1 则症状 A 不解，
去掉 R-1 则症状 B 不解且 A1 让它更易触发（下拉框可用后用户会更频繁地切项目）。

### 四、最终推荐修复（单一方案）

> **在 `src/components/agents/task-tracker/task-tracker-form.tsx` 内，一并落地
> 「A1 懒加载 effect」与「R-1 定稿版的 taskId 复位 effect」；两段代码逐字采用上文 R-1 / R-2
> 给出的实现，不做等价改写。**

**理由**（按权重排序）：

1. **它是把仓库里已验证的写法补齐到唯一漏掉的地方，而不是新发明。**
   `kanban-card-continue-modal.tsx:155-159` 与 `project-item.tsx:128-133` 是两份现成同构实现，
   前者的注释（"懒加载防止抽屉直接打开时空 tasks"）证明团队**已识别过这个失效模式**，
   只是没覆盖到新建计划弹窗。一致性风险最低。
2. **它补齐的是本仓已经承认的不变量，不是新增约束。**
   `tracker.takeover` 在 `:1513-1516` 已把 projectId/taskId 错配硬拒为非法态，
   `resolve-create-plan-draft.ts:41-48` 也专门写了跨项目守卫 —— 唯独创建表单这一环缺位。
3. **它是 fail-closed 的。** 任何中间态（tasks 加载中、请求失败、项目无员工）都收敛到
   「按钮禁用 + decomposition 模式提交被挡」，不会放行错配数据（见 R-2 表格末两行）。
4. **它不动服务端与协议。** 数据侧完好（§2.2 实测 4 条），缺的只是渲染端那一次调用；
   把纯渲染端缺陷升级成协议变更（A2）与"改动尽量小"直接冲突。
5. **两段必须同时落地。** 只做 A1：症状 B 仍在，且下拉框可用后用户切项目更频繁 ⇒ 更易踩；
   只做 R-1：症状 A 仍在，且 decomposition 模式因 `taskId` 被清而**更加**提交不了。

### 五、验收与回归（对下游节点的硬要求）

- **必测 4 条**（前 3 条在修复前必须失败，第 4 条守 R-2）：
  1. `loads project employees when a project is picked` —— 改 `projectId` 后
     `loadProjectTasks` 被以该 id 调用**恰好一次**；对已有 `tasks`（含 `[]`）的项目**不调用**。
  2. `clears the selected employee when the project is switched` —— 以 `{projectId:A, taskId:T_A}`
     挂载，断言**首帧保持** `T_A`（守 R-1 的首帧例外），切到 B 后归空。
  3. `still clears the employee when no project is selected` —— 以
     `{projectId:'', taskId:T}` 挂载，断言首帧即清空（守 R-1 的规则 1 不被后人当作冗余删掉，
     否则会退化成 `process.cwd()` 那条新失效路径）。
  4. `re-fetches employees after loadProjects wipes them` —— 把 store 里该项目的 `tasks`
     改回 `undefined`，断言再次触发 `loadProjectTasks`。
  目录 `src/components/agents/task-tracker/__tests__/` 现有 33 个用例、但**没有**
  `task-tracker-form` 的；该目录同时存在真实渲染用例（如 `kanban-card-flash.test.tsx`）与
  源码静态扫描用例（如 `task-tracker-page-source.test.ts`）—— **本次必须用前者**，
  静态扫描无法覆盖首帧例外与依赖数组这两个真正的陷阱。
- **手工验收**：跑 §2.1（第 5 步应能点开并看到 4 个员工）与 §2.3（第 4 步后 decomposition 模式
  「创建」应变灰；direct 模式提交后 `MISMATCH=false`）。补一条：修复后重连 WS（断网再连）
  或触发一次 `loadProjects()`，下拉框**不应**变空（守 R-2）。
- **类型检查**：`npx tsc -p tsconfig.json --noEmit` 与 `npx tsc -p tsconfig.server.json --noEmit`
  **分别**跑（`npm run build` 绿灯不代表类型干净）。
- **不要 `git commit`**（本轮约束）；改动文件应仅 `task-tracker-form.tsx` + 新增测试文件。

### 六、明确不在本次范围（各附不做的理由）

| 项 | 不做的理由 |
|---|---|
| `initialMode` / `initialProjectId` 的 `useMemo(...,[])` 不响应后到的 tasks（§3.4 补录 2） | 让这两个 memo 变成响应式，等于允许外部 store 更新覆盖用户已改的表单值 —— 那是比当前缺陷更难查的一类回归。症状仅为"默认单选到 direct / 项目未预选"，用户可一键改。**必须在提交说明里写明是已知降级**，避免验收时被当成修复失败 |
| `resolve-create-plan-draft.ts:41-48` 守卫反向误伤（§3.4 补录 1） | draft 在 `openCreateForm()` 同步点算完，早于弹窗 mount，A1 结构上救不回来；正确修法在入口侧（打开表单前先 await 装载），属独立改动。修复后用户只需在（已可用的）下拉框里再选一次 |
| B3 服务端 `tracker.create/update` 交叉校验 | 值得做的纵深防御，但需新增拒绝码 + `errors.<code>` 英文 fallback，不应混进最小修复。**建议单开一条 follow-up**，并复用 `:1513-1516` 已有的错误语义 |
| `task-tracker-project-panel.tsx:351` 左树展开不懒加载 | 同源第二症状，修法与 A1 同构。评审裁定**本轮不做** —— 它与用户报告的入口无关，混进来会让本次改动的回归面从 1 个组件扩到 2 个。单开 follow-up |
| 存量错配数据清洗 | 本机实测存量为 0；且 `:1513-1516` 已能在接管时挡住。若他机枚举出非零，属数据运维决策 |

---

## 实施过程发现的方案缺陷

**记录人**: Subtask #2（修复实施）· 2026-07-30
**结论先行**: §评审结论 四 的**修复方案本身无缺陷**，两段代码（A1 / R-1 定稿）已逐字落地、
未做等价改写。以下两条是对 §评审结论 五「验收与回归」中**验收方法**的修正，不涉及修复内容本身。

### IF-1 · 首帧 / 复位类断言不能用「任务」按钮文案作观测点

§五 必测第 2、3 条隐含以下拉框按钮文案观测 `taskId`。该观测点**不成立**：
`task-tracker-form.tsx` 的按钮文案是

```tsx
{taskId ? projectTasks.find(tt => tt.id === taskId)?.title ?? t('selectTask') : t('selectTask')}
```

—— `taskId` 非空但**不在当前 `projectTasks` 里**时（正是症状 B 的形态，也正是 A1 尚未拉回
列表的窗口期），文案同样回落成 "Select a task"。即**「已清空」与「留着一个外来 taskId」
在 UI 文案上不可区分**，用它断言会让规则 1 / 规则 2 的用例在缺陷仍在时照样变绿。

已改用**提交体**作为观测点：以 `editingPlan` 挂载 → 点「保存更改」→ 断言 `onSubmit` 收到的
`CreateTaskTrackerPlan` 里 `taskId` / `projectId` 的实际取值（`:347-348` 的
`...(taskId ? { taskId } : {})` 让「已清空」表现为**字段缺席**）。
这同时更贴近缺陷的真实危害面 —— 落库的就是这个对象。

### IF-2 · 必测第 3 条在修复前后都通过，它是「防删除守卫」而非「修复验证」

§五 写「前 3 条在修复前必须失败」。实测（把 `task-tracker-form.tsx` 单文件 stash 掉后跑）
只有 3 条失败，且第 3 条 `still clears the employee when no project is selected` **不在其中**
—— 规则 1 本来就是既有行为，修复没有改变它。这与 §五 自己给出的立意（「守 R-1 的规则 1
不被后人当作冗余删掉」）一致，只是「修复前必失败」这句话对它不适用。

实测的修复前 / 后对照（7 条用例）：

| 用例 | 修复前 | 修复后 | 作用 |
|---|---|---|---|
| `loads project employees when a project is picked` | ❌ 失败 | ✅ | 钉 A1 |
| `re-fetches employees after loadProjects wipes them` | ❌ 失败 | ✅ | 钉 R-2（依赖数组含 `selectedProject?.tasks`） |
| `clears the selected employee when the project is switched` | ❌ 失败 | ✅ | 钉 R-1 规则 2 |
| `does not re-request employees for an already-loaded project` | ✅ | ✅ | 钉「空数组也算已加载」，防请求风暴 |
| `renders the employee options once the lazy-loaded list arrives` | ✅ | ✅ | 钉「列表到达后按钮解禁 + 选项可见」 |
| `keeps the pre-bound employee on the first frame` | ✅ | ✅ | 钉 R-1 首帧例外（防「编辑计划一打开就丢员工」的回归） |
| `still clears the employee when no project is selected` | ✅ | ✅ | 钉 R-1 规则 1 不被后人删掉 |

后 4 条按定义是**回归护栏**：它们锁定的是修复**不得破坏**的既有语义，
在修复前通过是正确的，不是用例写弱了。

### 落地清单

- `src/components/agents/task-tracker/task-tracker-form.tsx` —— +1 行 store selector、
  A1 effect、R-1 定稿 effect 替换原 3 行（净 +33 行，其中 24 行是解释「为什么」的注释）。
- `src/components/agents/task-tracker/__tests__/task-tracker-form.test.tsx` —— 新增，7 条用例。
- 类型检查：`npx tsc -p tsconfig.json --noEmit` 与 `npx tsc -p tsconfig.server.json --noEmit`
  分别跑通（后者零报错；前者仓库存量有 3 个**与本次无关**的既有报错：`outbox-pusher.test.ts` /
  `plan-runtime-context.test.ts` / `inline-auth-dialog.test.tsx`，本次新增 / 修改文件零报错）。
- 全量回归：`npx vitest run src/components/agents/task-tracker/` → 38 files / 328 tests 全绿。
- 数据面复核（本机运行中的桌面端，port 52117）：`/api/projects` 的 26 行**仍不含** `tasks` 键，
  `/api/projects/<aragon-agent-core>/tasks` 返回 4 名员工 —— 即 A1 新增的那一次请求所补的
  正是这个缺口。

### 未执行项（如实记录）

- **§2.1 / §2.3 的 UI 手工复现未跑**：需要在运行中的桌面端里真人点击，本节点无 GUI 通道。
  等价验证由上表前 3 条用例承担 —— 它们在 jsdom 里渲染**真实的** `TaskTrackerForm`，
  走的正是「选一个 tasks 未装载的项目 → 断言发起懒加载 → 列表到达后按钮解禁」与
  「A → B 切换 → 断言提交体不含 A 的 taskId」这两条复现路径。
- **`npm run build` 未跑**：两份 `tsc --noEmit` 已覆盖类型面；仓库根 `next build` 会重写
  `.next/`，与可能正在运行的 dev server / 桌面端存在争用风险（CLAUDE.md 已就并发构建立过规矩），
  故未在本节点触发。
