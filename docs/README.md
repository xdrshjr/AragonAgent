# 文档（`docs/`）

本目录只有一件事：**开发者文档站**。它不是内部工程记录的存放处。

```
docs/
├─ README.md       ← 本文件：这目录里有什么、从哪开始读
└─ guide-doc/      ← 文档站：预构建的静态站点 + 可复现它的生成器源码
   ├─ dist/        ← 站点本体（56 页 + 404 + 搜索索引 + sitemap + robots + .nojekyll），直接托管
   ├─ src/         ← 内容（content）、渲染（render）、truth set 提取（extract）与样式资产
   ├─ tests/       ← 12 个 node:test 套件 + 负向 fixture
   └─ build.mjs · check.mjs · serve.mjs · README.md
```

## 从哪开始读

| 你想做什么 | 先读 |
|---|---|
| 在浏览器里看文档 | `docs/guide-doc/dist/index.html`（本站入口），或 `node docs/guide-doc/serve.mjs` 本地预览 |
| 改文档内容 | `docs/guide-doc/README.md` → 再看 `docs/guide-doc/src/content/nav.mjs` |
| 把站点部署出去 | `docs/guide-doc/README.md` 的「部署」一节 |
| 了解这些说明凭什么可信 | `docs/guide-doc/README.md` 的「准确性门禁怎么判定」一节 |

## 两条规矩

1. **`docs/guide-doc/dist/` 是交付物，不许手改。** 它是内部 monorepo 构建后整目录同步过来的产物，
   由 `build.mjs` 唯一生成（渲染到 `dist.tmp`，校验全绿后原子 rename）。手改会在下一次同步时丢失，
   也会让产物侧断言失真。根 `.gitignore` 对它做了反选——它被故意提交。
   唯一的例外是「把死链降级成文本」这类同构替换：2026-10-29 为了摘掉 219 条指向闭源包的
   死链做过一次，规则来自渲染层而不是手写（见下节）。
2. **本目录不收录内部工程记录。** 路线图（内部 `plans/`）与缺陷复盘（内部 `diagnoses/`）
   属于内部工程资产，不随本仓库发布，因此在本目录里**不存在**——站点正文里也没有指向它们的链接
   （已逐页检索确认为 0 处）。如果你在这里看到这类路径，那就是一个需要修掉的缺陷。

站点在本仓库**不能重建**：准确性门禁从私有引擎源码（`packages/core`、`packages/cli`）提取 truth set，
而这两个包不开源。原因、替代流程与已知限制都写在 `docs/guide-doc/README.md`。
产物侧的那一半门禁在这里仍然可跑：`node docs/guide-doc/check.mjs --dist --phase all`。

## 「本页依据」指向哪里

每页结尾的「本页依据」是准确性门禁的凭据：它逐条列出这一页对账过的源码位置（`路径:行号`）。
全站 227 条里有 219 条落在 `packages/core/**` 与 `packages/cli/**`——引擎 `@aragon-agent/core`
与 CLI `@aragon-agent/cli` 是**闭源**的：源码留在内部 monorepo，这里只有 npm 上的包。

于是这些条目的性质要说清：

| 条目 | 指向 | 在站点里的形态 |
|---|---|---|
| 219 条 | `packages/core/**`、`packages/cli/**`（不在本仓库） | 行内代码 `path:lines`，**不可点**，不会 404 |
| 8 条 | `docs/guide-doc/src/**`、根 `README.md`（本仓库确有） | GitHub blob 链接，可点 |

它们是**出处记录 / 可核对的位置说明**，不是「点开就能读的源码」。想核对引擎或 CLI 的真实行为，
读 npm 上的包与本站页面正文；那两个目录在本仓库里不存在，也不需要存在。

这条规则由渲染层定义：`docs/guide-doc/src/render/page.mjs` 的 `PRIVATE_SOURCE_ROOTS` 列出
「源码不在本仓库」的包根，渲染时把它们降级成不可点文本。已交付的 `dist/` 也按同一条规则就地
降级过（55 个页面、219 处，其余字节未动）——因为本仓库重建不了站点，不降级就只能发布 404 链接。

