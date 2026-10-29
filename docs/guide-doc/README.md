# AragonAgent 文档站（`docs/guide-doc`）

面向浏览器阅读的 **API 参考与使用指南**，覆盖 `aragon` 交互式 TUI 的日常用法、`aragon exec` 的机器契约，
以及 `@aragon-agent/core` 的引擎 API。

零依赖、零联网：不需要 `npm install`，不加载任何字体 / CDN / 统计脚本，离线可读。
产物是纯静态文件，托管时不需要 Node 运行时。

---

## 三句话读完

1. **站点以「预构建产物」形式发布。** `dist/` 里的 65 个文件就是全部站点，直接托管即可，
   本仓库没有任何构建步骤，部署平台也不要配 build command。
2. **本仓库重建不了站点，这是设计而不是故障。** 准确性门禁从私有引擎源码
   （`packages/core`、`packages/cli`）提取 9 组 truth set，这两个包不开源、不在本仓库里。
   维护者在内部 monorepo 构建，再把 `dist/` 原样同步过来。详见
   [为什么这里建不了](#为什么这里建不了)。
3. **`dist/` 不许手改。** `build.mjs` 是唯一写盘者（渲染到 `dist.tmp`，校验全绿后整体原子 rename 成 `dist`），
   手改的文件会在下一次同步时整目录被替换，还会让 `check.mjs --dist` 的产物断言失真。
   要改内容就改 `src/content/**`，在内部 monorepo 重建。
   唯一例外是**按渲染层规则做的同构替换**：2026-10-29 为了摘掉 219 条指向闭源包的死链，
   把已交付 `dist/` 里那 219 个 `<a class="source-ref">` 就地降级成不可点的行内代码
   （规则与 `src/render/page.mjs` 的 `renderSourceItem()` 逐字节一致，其余字节未动）。
   不以「反正要发布」为由手改文案或结构。

| 在哪里 | 能做什么 |
|---|---|
| **本仓库（公开）** | 托管 / 预览 `dist/`；`check.mjs --dist` 产物侧门禁；读生成器源码；`node --check` 语法自检；8 个纯函数测试套件 |
| **内部 monorepo（私有）** | `node build.mjs --phase all` 重建；`check.mjs --model/--dist` 过门禁；`node --test tests/*.test.mjs` 跑 12 个套件 |

---

## 目录结构

```
docs/guide-doc/
├─ dist/                      ← 已交付的静态站点（故意提交，见 .gitignore 里的反选）
│  ├─ index.html              首页（22,597 B）
│  ├─ 404/index.html          错误页
│  ├─ assets/                 app.6fc44229.css（39,909 B）· app.6fc44229.js（10,050 B）· LATEST
│  ├─ start/ guide/ tools/ cli/ exec/ config/ api/ troubleshoot/ appendix/
│  │                          9 个分组共 55 个页面目录（每个 /<id>/index.html）
│  ├─ search-index.json       客户端搜索索引（166,183 B）
│  ├─ sitemap.xml · robots.txt
│  ├─ _meta.json              构建元数据（版本 / 页数 / 资产指纹 / 警告数）
│  └─ .nojekyll               让 GitHub Pages 跳过 Jekyll（点开头文件必须随产物一起发布）
├─ build.mjs                 构建入口（唯一写盘者，13 步）
├─ check.mjs                 门禁 CLI（参数 / 退出码 / 末行摘要）
├─ serve.mjs                 本地预览服务器（GET/HEAD，零依赖，只读 dist）
├─ package.json              private，不进仓库 workspaces，不需要 install
├─ .nojekyll                 GitHub Pages 开关（发布时真正生效的是 dist/.nojekyll）
├─ src/
│  ├─ site.config.mjs        站点元信息、base/origin、版本注入
│  ├─ content/
│  │  ├─ nav.mjs             导航真源（9 组 56 页；`--phase` 决定页集合）
│  │  ├─ pages/*.mjs         9 个分组的内容（每页 20–60 行数据）
│  │  └─ data/*.mjs          11 个参考数据集（参数 / 事件 / 退出码 / 工具 / 配置键 / …，含 undocumented 白名单）
│  ├─ render/                9 个纯函数模块（无 fs、无时间、无随机）
│  ├─ extract/
│  │  ├─ sources.mjs         9 个 truth set 的提取器（纯函数）
│  │  ├─ truth-sets.mjs      源文件清单 + 装载（少扫一个文件就会被断言抓到）
│  │  ├─ gate.mjs            门禁的判定实现（--model / --dist）
│  │  └─ repo-root.mjs       仓库根的唯一定义
│  └─ assets/                tokens/layout/components/print.css + app.js
└─ tests/                    12 个 node:test 套件 + fixtures（负向素材）
```

`dist/` 里的页数、版本、资产指纹都可以用 `dist/_meta.json` 复核，不要靠记忆。

---

## 部署

产物是静态文件，三条路径给具体动作，结果完全一样（**都不需要构建**）：

1. **GitHub Pages**：发布目录是 `docs/guide-doc/dist/`，不是 `docs/`（`docs/` 根下只有说明文档，
   没有 `index.html`）。两条可用做法：用 Actions 把 `docs/guide-doc/dist/` 作为 Pages artifact 上传；
   或把该目录的内容推到 `gh-pages` 分支根目录。
   `.nojekyll` 已在产物里，所以点开头文件与下划线文件不会被吞。
   项目页路径带前缀时，站点必须是带着 `--base /<repo>/` 构建出的那一份——本仓库交付的是 `--base /` 的版本。
   自定义域放 `CNAME`（本项目不预置）。
2. **nginx**：

   ```nginx
   root /srv/aragon-docs/dist;
   try_files $uri $uri/ $uri/index.html =404;
   error_page 404 /404/index.html;
   location /assets/ { add_header Cache-Control "public, max-age=31536000, immutable"; }
   location /       { add_header Cache-Control "public, max-age=600, must-revalidate"; }
   ```

3. **Vercel / Netlify / 任意静态托管**：build command **留空**，output/publish dir 指向
   `docs/guide-doc/dist`。任何 `node docs/guide-doc/build.mjs` 之类的构建命令在这里都会失败
   —— 那份源码需要私有引擎，见下一节。

本地预览（本仓库就能跑，只读 `dist/`，不碰源码）：

```bash
node docs/guide-doc/serve.mjs            # http://127.0.0.1:4173
node docs/guide-doc/serve.mjs --port 4174 --dir docs/guide-doc/dist
```

`serve.mjs` 不做 SPA 回退、gzip 协商与端口重试：端口被占用会直接报错，而不是悄悄换一个。

### 部署前清单

**本仓库可执行：**

- [ ] `dist/` 与内部 monorepo 的 `docs/guide-doc/dist` 逐字节一致（`sha256` 逐个文件比对，不靠肉眼）
- [ ] `node docs/guide-doc/check.mjs --dist --phase all` → exit 0（产物侧门禁可在本仓库跑）
- [ ] `node docs/guide-doc/serve.mjs` 手点：首页 / 搜索 / 主题 / 375 px 窄屏 / 打印预览
- [ ] 抽查深链与错误页：`/`、`/tools/`、`/exec/events/`、`/nope/` → 200 / 200 / 200 / 404，再抽 3 个页内锚点
- [ ] `dist/_meta.json` 的 `pages === 56`、`phaseCounts = {A:29,B:27}`、`warnCount === 0`

**只能在内部 monorepo 执行：**

- [ ] `node docs/guide-doc/build.mjs --phase all --strict` → exit 0
- [ ] `node docs/guide-doc/check.mjs --model --phase all --strict` → exit 0，末行 `9 truth sets, 0 error, 0 warn`
- [ ] `node docs/guide-doc/check.mjs --dist --phase all` → exit 0
- [ ] `node --test docs/guide-doc/tests/*.test.mjs` → 全绿

> `build` 内部已经跑过 `--model`（写盘前）与 `--dist`（在 `dist.tmp` 上），清单里为什么还要单独跑一次
> `check.mjs`？因为**只有它会打印 9 个 truth set 的规模** —— 一个 0 文件的 truth set 也能让 build 通过，
> 而这一行不会。

---

## 为什么这里建不了

`gate.mjs` 把 `src/content/**` 里的说法与真实源码逐项对账，而它对账的对象不在本仓库：

| # | truth set | 提取自（私有 / 不在本仓库） | 文档口径 |
|---|---|---|---|
| S-1 | CLI 参数 | `packages/cli/src/cli.tsx` | 声明 101 处 · 不同长名 92 个 · 合并 `--no-*` 后 80 条（root 55 + 子命令 25） |
| S-2 | `exec` 参数 | `packages/cli/src/exec/cli-commands.ts` | 29 条 |
| S-3 | 斜杠命令 | `commands/builtins.ts` + 7 个命令族模块 | 30 + 7 = 37 |
| S-4 | 内置工具 | `tools/*.ts`、`todo_write`、`task`、技能 4（Core 2） | 19 |
| S-5 | `ExecEvent` | `packages/cli/src/exec/events.ts` | 29 种 |
| S-6 | 退出码 | `exec/runner.ts`、`exec/index.ts` | 5 档 |
| S-7 | 配置顶层键 | `packages/cli/src/config/schema.ts` | 46 个 |
| S-8 | Core 值导出 | `packages/core/src/index.ts` | 86 个 |
| S-9 | 版本号 | 两个 `package.json` | 构建时读取，不手写 |

除了提取器，`gate.mjs` 的路径唯一性判定还固定遍历 `roots = ['packages/cli/src', 'packages/core/src', 'scripts', 'docs']`，
`truth-sets.mjs` 的源文件清单里 12 个工具文件、2 个 Core 技能文件同样指向这两个包。

于是 `node docs/guide-doc/build.mjs` 在这里的结果是可预期的失败，而且失败信息很直白：

```
$ node docs/guide-doc/check.mjs --model --phase all
ERROR [exception] 源文件不存在：packages/cli/src/cli.tsx（仓库根 M:\...\AragonAgent 解析）
9 truth sets, 1 error, 0 warn, 0 info
```

**不是因为站点坏了，而是因为这个仓库没有它要对账的那一半。**
把它改成「跳过检查」是错的——门禁是这座站点唯一的准确性凭据，绕过它等于把文档变成自由发挥。

**正确的同步方式**（维护者）：在内部 monorepo 构建 → 全绿 → 把 `docs/guide-doc/dist/` 整目录覆盖到本仓库 →
用 `sha256` 逐文件确认一致 → 提交。不要在这里手工补文件。

---

## 「本页依据」与不开源的源码树

每页结尾的「本页依据」（`<section class="sources">`）不是参考书目，而是**门禁凭据**：
它逐条写出这一页对账过的源码位置 `path:lines`，让读者能自己去核对「这句话凭什么成立」。

| 条目 | 指向 | 在本仓库里 | 站点里的形态 |
|---|---|---|---|
| 141 条 | `packages/cli/**` | **不存在**（`@aragon-agent/cli` 闭源，只发 npm） | 行内代码，不可点 |
| 78 条 | `packages/core/**` | **不存在**（`@aragon-agent/core` 闭源，只发 npm） | 行内代码，不可点 |
| 8 条 | `docs/guide-doc/src/**`、根 `README.md` | 存在 | GitHub blob 链接，可点 |

这 219 条是**出处记录（provenance）**，不是「点开就能读的文件」：它们渲染成
`<code class="source-ref-private" title="…">`，没有 `href`，因此不会 404，也不会让人以为
仓库里少了什么。要核对引擎/CLI 的真实行为，读 npm 上的包与页面正文。

规则写在渲染层，不在文案里：

- `src/render/page.mjs` 的 `PRIVATE_SOURCE_ROOTS = ['packages/core/', 'packages/cli/']`
  是「源码不在本仓库」的唯一定义；
- `isPrivateSourcePath(path)` 判定一条来源是否落在其中；
- `renderSourceItem(ref, site)` 产出 `<li>`：私有来源 → 不可点行内代码；其余 → blob 链接。

已交付的 `dist/` 曾带着**旧的**形态（219 个 `<a class="source-ref" href="…/blob/main/packages/…">`，
在公开仓库上一律 404）。2026-10-29 这次发布准备按上表规则就地降级：只替换这 219 个 `<li>`
（55 个页面），其余字节未动，`check.mjs --dist --phase all` 仍 exit 0。
逐页比对过：`dist/` 里 227 个 `source-ref` `<li>` **全部**与 `renderSourceItem()` 今天的输出逐字节一致
——所以「改了渲染层却没重建」不会留下两套口径。

**留给内部 monorepo 的后续动作**（本仓库无法执行，做了就会与已交付 `dist/` 脱节）：

1. 下一次 `build.mjs --phase all` 会由渲染层自动产出同样形态，不需要再手工替换；同步 `dist/` 时
   逐文件 `sha256` 会显示这些页面按预期变化。
2. **正文里有两句话现在说过头了**，因为它们把「本页依据」一律描述成可点：
   `src/content/pages/start.mjs:201`「所以那些行号值得直接点开看」、
   `src/content/pages/cli.mjs:99`「第 5 列可以直接点开看那一行」。
   建议改成「本仓库里存在的那几条可以直接点开，引擎与 CLI 的行号只能按 `path:lines` 自己去包里核对」。
   改这两句必须重建，所以本仓库不改 —— 改了就会让 `src/content` 与 `dist/` 各说一套。
3. **可以给「本页依据」加一行页内说明**：在 `renderSources()` 的 `<ul>` 之后插一句
   `<p class="sources-note">`（例如「带 <code>packages/core</code> / <code>packages/cli</code>
   的条目指向未开源的私有源码树：是出处记录，不是可点开的文件」）。这同样需要重建才能进 `dist/`；
   本仓库这次只做了「与渲染层逐字节一致」的降级，没有额外加句，以免源码与产物脱节。
4. `.source-ref-private` 目前**没有专属 CSS**（`src/assets/components.css` 里只有 `.source-ref`）：
   它沿用默认的行内代码样式，语义清楚但视觉上不突出。加样式要改 CSS 并换资产指纹，只能随重建一起做。

---

## 三层结构与一条纪律

```
src/content/**   纯数据（ESM，无副作用）
      │ 被读取
      ▼
src/render/**    纯函数：render*(data, ctx) → string（无 fs / 无 Date.now）
      │ 被调用
      ▼
build.mjs        唯一写盘者：渲染 → 校验 → 写 dist.tmp → 原子 rename 为 dist
check.mjs        唯一判定者：源码 truth set ⇄ 文档数据对账
serve.mjs        唯一读服务：本地预览
```

纪律：`src/render/**` 与 `src/content/**` 里**不得出现** `node:fs`、`node:path`、`node:http`、
`process.cwd`、`Date.now`、`new Date()`。时间与路径只允许出现在入口文件与 `src/extract/`
的基础设施里。这条纪律让渲染可以被 100% 单测覆盖，也让构建天然确定。

---

## 维护者工作流（在内部 monorepo 执行）

### 一分钟上手

```bash
# 1. 构建（阶段 A：29 页；--phase all 出 56 页，本仓库交付的就是 all）
node docs/guide-doc/build.mjs --phase all

# 2. 本地预览
node docs/guide-doc/serve.mjs          # http://127.0.0.1:4173

# 3. 门禁
node docs/guide-doc/check.mjs --model --phase all --strict
node docs/guide-doc/check.mjs --dist  --phase all

# 4. 单测
node --test docs/guide-doc/tests/*.test.mjs
```

> `node --test` 的**目录参数**需要 Node ≥ 18.13；`engines` 只保证 `>=18`，
> 所以文档与 CI 一律用显式文件通配（`tests/*.test.mjs`），不用目录。

### 新增一页（5 步，约 10 分钟）

1. **选组并登记导航**：在 `src/content/nav.mjs` 对应分组里加一行
   `{ id: 'guide/foo', title: '标题', order: 90, phase: 'A' }`。
2. **写一页数据**：在 `src/content/pages/<组>.mjs` 的 `pages` 数组里加一个对象。
   必填：`id`/`title`/`group`/`order`/`phase`/`template`/`summary`/`blocks`/`sourceRefs`，
   `id`/`title`/`order`/`phase`/`group` 必须与 `nav.mjs` 一致（门禁会逐项比对）。
   正文用 18 种 block（见 `src/render/blocks.mjs` 的 `BLOCK_TYPES`），**不要写 HTML**。
3. **给依据**：`sourceRefs` 至少 1 条，`path` 是**仓库根相对全路径**，
   `snippet` 必须是该行范围里**真实存在**的稳定子串。
4. **跑门禁**：`node docs/guide-doc/check.mjs --model --phase A --strict`。
   红就改，别加白名单（白名单每条都要写理由，且总数 ≤ 6）。
5. **补一条测试**：如果新页引入了新行为（新模板段位、新数据集），在对应
   `tests/*.test.mjs` 里加一条断言。

页面结构的最低要求：`summary` 60–120 字、H2 ≥ 2、标题不跳级、无占位符。

### 什么时候该改数据集而不是改页面

参考页（参数 / 事件 / 退出码 / 工具 / 配置键）**不吃散装文本**：它们的表格由
`src/content/data/*.mjs` 生成。改一条参数的说明就改数据集，全站同步生效；
手抄到页面里等于给下一次漂移埋雷。

---

## 准确性门禁怎么判定

`check.mjs` 有两种**互不重叠**的模式：

| 模式 | 输入 | 负责 |
|---|---|---|
| `--model` | `src/content/**` | 9 个 truth set 对账；页面结构；链接与越阶段占位；占位符；品牌词；文件规模；对比度旁证 |
| `--dist` | 产物目录 | 每页恰好 1 个内联脚本且命中指纹；`href` 无反斜杠；外链白名单；体积；锚点唯一且 TOC 命中；`_meta.json` 与实际产物一致 |

判定三种严重度：**ERROR** 让构建 `exit 3`；**WARN** 默认放行、`--strict` 时也 `exit 3`；
**INFO** 只统计（页面字数、搜索索引体积、越阶段链接计数）。末行固定打印
`N truth sets, E error, W warn, I info`，CI 按这一行判断。

`--dist` 模式只读产物目录，所以**本仓库能跑**（实测 `node docs/guide-doc/check.mjs --dist --phase all` → exit 0：
每页一个内联脚本、锚点唯一、`_meta.json` 与产物一致、体积达标）。但它断言的是产物自身的一致性，
**不**证明内容与当前源码一致——后者的凭据只有 `--model`，而 `--model` 需要私有源码。

### 为什么凭据是「提取器」而不是「人工承诺」

`src/extract/sources.mjs` 里的每个提取器都是 `sourceText → Set`，规则穷尽于源码里真实写出来的声明：

- 参数声明只认**行首锚定的 `.option(`**（注释里的不算），并支持跨行写法；
- `--no-x` 与同作用域的 `--x` 合并成一条；没有正名的 `--no-*` 保留原名单独成行；
- 事件的 `type` 取对应接口里的字面量，而不是猜；
- 工具名要求 `name: '<snake>'` 在行首，且 **Core 的两个技能工具文件必须在源清单里**
  —— 只扫 CLI 会数到 17 个并静默报绿，这正是需要第二来源（`HOST_TOOL_NAMES`）求差集的原因。

---

## 本仓库交付的快照

`dist/` 是内部 monorepo 在 **2026-10-22** 用 `--phase all` 打出的一次完整构建，元数据记录在
`dist/_meta.json`：

| 字段 | 值 |
|---|---|
| `pages` | 56（`phaseCounts` A:29 / B:27）+ 404 |
| `versions` | `cli 0.6.39` · `core 0.2.51` |
| `assetHash` | `6fc44229` |
| `warnCount` | 0 |
| `builtAt` | `2026-10-22T09:45:07.658Z` |

这是一个**快照**，不是「当前源码的实时镜像」。判断站点是否过期看 `builtAt` 与 `versions`，
不要看本文件的提交时间：本文件的修改（例如文案修订）不代表站点重建。

---

## 已知限制

1. **219 条「本页依据」引用指向不开源的路径。** 全站 227 条 `source-ref` 里，141 条指向
   `packages/cli/**`、78 条指向 `packages/core/**`——这两个包不在本仓库，源码也不公开。
   这 219 条**不渲染成链接**（渲染层按 `PRIVATE_SOURCE_ROOTS` 判定，见
   [「本页依据」与不开源的源码树](#本页依据与不开源的源码树)），只是出处记录（行内代码 `path:lines`），
   因此不会 404；已交付的 `dist/` 也按同一规则就地降级过（55 页 219 处，其余字节未动）。
   剩下 8 条指向本仓库确实存在的文件（`docs/guide-doc/src/**`、`docs/guide-doc/check.mjs`、根 `README.md`），
   仍是 blob 链接；其中 3 条带行号锚点的 `README.md` 链接，行号对应内部仓库的旧 README，
   在改写后的 README 里会落到别的段落（链接有效，锚点未必）。
2. **12 个测试套件里有 4 个在本仓库必然失败**：`sources`、`drift`、`phase`、`determinism` 要么读
   `REPO_ROOT` 下的私有源码，要么真跑两次 `build.mjs`。
   其余 8 个（`blocks`、`contrast`、`href`、`highlight`、`inline`、`search`、`slug`、`templates`）
   只 import `src/render/**` 的纯函数，在本仓库实测 **109 / 109 通过**。
   但请不要把 `node --test` 当成本仓库的验收路径——真正的验收路径在内部 monorepo。
3. **站点是中文单语**（`lang="zh-CN"`）。`site.config.mjs` 的 `lang` 是为英文镜像预留的结构位，
   目前没有英文版页面。
4. **`--base` 是构建期常量。** 交付的这份是 `base: "/"`；部署到子路径（如 GitHub 项目页 `/AragonAgent/`）
   需要带 `--base` 重建，不能靠托管平台的 rewrite 补出来。

---

## 常见问题

**`check.mjs` 报「源码有、文档无」**：源码新增了参数/事件/键。改数据集，别把它加进白名单
（白名单要写理由，且 ≤ 6 条）。

**构建报 `ref-out-of-range`**：`sourceRefs.lines` 超出了文件行数。行号会漂，`snippet` 不会 ——
补上 `snippet` 就能把「只是移动」和「代码被删」区分开。

**构建报 `ref-ambiguous`**：`path` 用的是裸基名（如 `README.md`），而仓库里同名文件有多份。
写全路径（`packages/cli/README.md`）或补 `snippet`。

**`serve.mjs` 报端口被占用**：它不会自动换端口。确认不是上一次没停的服务，再用 `--port 4174`。

**页面在 `file://` 下搜不到**：搜索要 `fetch('search-index.json')`，`file://` 会被浏览器拦住。
用 `serve.mjs`，或直接读页面（正文、导航、目录在无 JS 时依然完整）。

**在本仓库跑 `node build.mjs` 报找不到源文件**：预期行为，见 [为什么这里建不了](#为什么这里建不了)。
不要为了让命令退出 0 而删除检查或伪造源文件。

---

## 验收记录

**内部 monorepo 实测（构建这次快照时记录）：**

| 项 | 命令 | 结果 |
|---|---|---|
| 构建（阶段 A） | `node docs/guide-doc/build.mjs --phase A --strict` | exit 0 · 29 页 + 404 · 资产 `6fc44229` |
| 构建（全量） | `node docs/guide-doc/build.mjs --phase all --strict` | exit 0 · 56 页 + 404 |
| 门禁（模型侧） | `check.mjs --model --phase all --strict` | `9 truth sets, 0 error, 0 warn, 1 info` |
| 门禁（产物侧） | `check.mjs --dist --phase all` | exit 0 |
| 单测 | `node --test docs/guide-doc/tests/*.test.mjs` | **174 / 174** 通过（12 个套件） |
| 体积 | 单页最大 72 KB / gzip 8 KB（上限 90 KB / 26 KB）· CSS 39,909 B（上限 40,960）· JS 10,050 B（上限 10,240）· 索引 166,183 B（上限 430,080） | 全部在预算内 |
| 对比度 | `tests/contrast.test.mjs` | 72 组比值全部 ≥ 4.5，最低 4.75 |
| 确定性 | `tests/determinism.test.mjs` | 两次构建除 `_meta.json.builtAt` 外逐字节相同 |

**本仓库实测（对交付的 `dist/`）：**

| 项 | 命令 | 结果 |
|---|---|---|
| 产物侧门禁 | `node docs/guide-doc/check.mjs --dist --phase all` | exit 0 · `9 truth sets, 0 error, 0 warn, 0 info` |
| 模型侧门禁 | `node docs/guide-doc/check.mjs --model --phase all` | 预期失败 · `源文件不存在：packages/cli/src/cli.tsx` · `9 truth sets, 1 error` |
| 可托管 | `node docs/guide-doc/serve.mjs` + HTTP 探测 | `/` 200 · `/tools/` 200 · `/exec/events/` 200 · `/nope/` 404 · `/search-index.json` 200 · `/.nojekyll` 200 |
| 纯函数套件 | `node --test tests/{blocks,contrast,href,highlight,inline,search,slug,templates}.test.mjs` | **109 / 109** 通过（`# pass 109` / `# fail 0`） |
| 语法 | `node --check` 全部 90 个 `.mjs` | 全部通过 |
| 可被 git 跟踪 | `git check-ignore -v docs/guide-doc/dist/index.html` | 命中的是反选规则 `!docs/guide-doc/dist/**`（未被忽略）；根 `.gitignore` 里有完整说明 |

---

## 许可

随仓库根 `LICENSE`（MIT）。站点内容与生成器源码同许可。
