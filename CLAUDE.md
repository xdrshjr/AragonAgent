## Project Index

This project has a pre-generated index for quick codebase understanding.

- **Location:** `.claude-index/index.md`
- **Last Updated:** 2026-10-06
- **Contents:** Project overview, feature map, file index, exported symbols, module dependencies

**Usage:** Read `.claude-index/index.md` to quickly understand the project structure before making changes. The index provides a navigation map of the codebase without needing to explore every file.

**Regenerate:** Say "regenerate index" or "更新索引" to update the index after major changes.

## Clean Code Guidelines

<!-- project-indexer:cleancode:begin v1.2.0 -->
<!--
  cleancode-template.md — rendered into CLAUDE.md by project-indexer (Step 5b).
  Authoring rules:
    - Chinese character body must measure 1,400–1,700 characters
      (matched by regex `[一-鿿]`).
    - Verify after editing with:
        python -c "import re,pathlib; b=pathlib.Path('project-indexer/templates/cleancode-template.md').read_text(encoding='utf-8'); print(len(re.findall(r'[一-鿿]', b)))"
    - Placeholders: 1000 60
      5 10 100
      4 TypeScript - TypeScript: Prefer `interface` over `type` for public APIs.
    - At runtime the skill must ensure no template placeholder leaks into
      the rendered output. Numeric character counting at runtime is NOT
      required.
-->

> 本节由 `project-indexer` 自动维护，灵感取自谷歌风格，并按本项目主要语言收敛阈值。请勿手工编辑 markers 之间的内容，需要刷新时请运行「regenerate index」。

### 一、概述

本节是本项目在使用 AI 辅助开发时必须遵守的代码规范。在写或改动任何代码之前，先把下列条目读完一遍，再动键盘。规则的目的不是束缚发挥，而是让人类与 agent 写出的代码在阈值上保持可比的下限，避免出现千行文件与几百行方法，避免命名混乱、错误吞咽、测试缺失这些会在后续维护中迅速发酵的问题。所有阈值都允许根据项目实际情况调整，但调整必须在 `.claude-index/config.md` 中显式记录，并在评审中说明理由，不要靠默认值偷偷放宽。

### 二、文件与函数尺寸

- 单文件不超过 **1000** 行，超过即按职责拆分到新模块。
- 单方法不超过 **60** 行，写到一半感觉膨胀就先抽函数。
- 函数形参不超过 **5** 个，多了请改用配置对象、命名参数或聚合结构体，禁止靠位置堆参数。
- 圈复杂度不超过 **10**，分支累积过多必须拆函数或引入查找表。
- 单行长度不超过 **100** 列，超长就换行或抽变量名。判定标准很简单：阈值超了就是技术债，提交前自查并修正。

### 三、命名

- 函数以动词开头表达动作，例如 `loadConfig`、`parseToken`；查询类用名词或 `get` / `find`。
- 返回布尔值的函数与变量以 `is`、`has`、`should`、`can` 起头，便于阅读条件表达式。
- 常量使用大写蛇形，模块名短小且语义化，避免堆叠首字母缩写。
- 不缩写领域词，宁可名字长五个字母也要让读者一眼看懂含义。
- 类与接口使用大驼峰命名，方法与变量使用小驼峰或语言推荐的蛇形写法，保持整个仓库风格一致。
- 避免使用 `data`、`info`、`temp`、`obj` 这类无信息量的名字；给出具体的领域名词。

### 四、注释与文档

- 注释只解释「为什么」，不复述「做什么」，代码本身就是「做什么」的真相。
- 所有公开 API 必须写 docstring，标注参数、返回值与可能抛出的异常。
- 删除一切僵尸注释与被注释掉的旧代码；保留 `TODO` 必须带责任人与日期。
- 行级注释稀缺即珍贵，不要在每行上方堆一句无信息量的话。
- 复杂业务规则、踩坑记录、临时性 workaround 必须在注释中写清楚原因与可回退条件。

### 五、错误处理

- 错误显式传播，不要默默吞异常或返回 `null` 假装一切正常。
- 外部输入在边界处一次性校验，进入内部后信任内部数据，禁止层层重复校验。
- 不要为「理论上不会发生」的分支写防御性 `try/except`，那只是噪音。
- 错误信息必须包含定位线索：发生在哪、关键参数是什么、下游应如何处理。
- 在 IO、网络、子进程等不可控边界，使用带超时与重试的结构化封装，而非裸调用。
- 捕获异常时尽量缩小作用域，只处理你确实有办法应对的错误类型，其他原样向上抛出。
- 对外暴露的错误码或异常类必须稳定，更名等同于破坏性变更，需要在变更日志中显式标注。

### 六、复杂度与嵌套

- 嵌套深度不超过 **4** 层，深嵌套是函数过长的前兆。
- 优先使用早返回（guard clause）取代 `else` 阶梯。
- 单个表达式里出现超过三个布尔条件，立刻抽成命名清晰的辅助函数。
- 循环里若出现复杂条件分支，改写为查找表或策略对象往往更易读。
- 一个函数只做一件事；当解释函数职责时需要用「并」「同时」「再」这类连词，就是应该拆分的信号。

### 七、测试

- 修 bug 必须先写一个能稳定复现该 bug 的测试用例，再动业务代码。
- 公开行为都要有单元测试覆盖正常路径与至少一条异常路径。
- 测试名描述被验证的行为而非实现细节，例如 `rejects_expired_token`。
- 不允许 mock 数据库迁移、鉴权签名等高风险路径，必须使用真实集成测试。
- 单测应快速且可重复运行；外部依赖通过桩或本地容器隔离，禁止依赖共享环境状态。
- 任何被发现的回归 bug 都要补上对应的测试，把过去的坑变成未来的护栏。

### 八、代码评审清单

提交前对照以下 8 条自查，任何一条不满足都视为未完成：

1. 命名是否自解释，是否避免无意义缩写。
2. 文件、方法、参数、嵌套、圈复杂度是否都在阈值内。
3. 错误是否显式传播，边界校验是否到位。
4. 注释是否只解释「为什么」，是否还有僵尸代码或孤儿 TODO。
5. 测试是否覆盖正常路径与异常路径，是否能稳定复现已修复的 bug。
6. 是否引入新依赖，依赖是否必要、是否有安全或许可证风险。
7. 是否泄露密钥、个人数据、内部链接等敏感信息。
8. 是否与现有架构与命名风格一致，是否制造新的孤岛。

### 九、语言特有提示

当前项目主要语言：**TypeScript**。

- TypeScript: Prefer `interface` over `type` for public APIs.

### 十、元信息

模板版本与上方 markers 中的版本一致。说「regenerate index」或「更新索引」可重新生成本节内容；说「disable cleancode」可移除本节。
<!-- project-indexer:cleancode:end -->
