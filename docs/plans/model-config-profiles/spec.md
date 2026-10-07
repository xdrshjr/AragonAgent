# TUI 多套模型配置方案

版本：v2
日期：2026-10-07
状态：已实现并完成最终代码审查，验证结果见 `code-review.md`
功能目录：`docs/plans/model-config-profiles/`

## 评审记录

评审日期：2026-10-07。按可行性、完整性、一致性和范围适度逐节核对本文、`CLAUDE.md` 及当前源码。下表记录原方案的全部评审关注点；“已修订”表示设计正文已消除歧义，不表示源码已实现或运行测试已通过。未发现 P0；8 项 P1、2 项 P2 均已在正文处理，无未解决的 P0 / P1。

| 编号 | 级别 | 关注点与依据 | 正文处理与验收 |
| --- | --- | --- | --- |
| R-01 | P1 | 凭据作用域不完整：`load.ts::makeGetApiKey` 只按当前 provider 使用启动密钥；切换同 provider 网关或恢复会话时仍可能沿用旧账户。编辑 URL 也未规定旧专属 key 的处置。 | 5.1、5.2、6.1 增加启动凭据目标快照、显式角色操作与地址修改确认语义；AC-29。已修订。 |
| R-02 | P1 | 草稿缺少用户操作标记：`App.tsx::handleSettingsSave` 总是提交主快连接；只改普通设置也可能解绑、移除启动覆盖或回写有效值。 | 4.3、5.3、5.5、6.3 区分磁盘基线、live 基线和显式连接操作；AC-30。已修订。 |
| R-03 | P1 | 只保护新段损坏，未保护整个文件解析/读取失败；`store.ts::loadPersistedConfig` 会用默认值替代不可读文件，后续保存可能覆盖唯一副本。JSON 解析异常还可能含凭据片段。 | 4.2、5.3、5.5 增加严格读取、禁止覆盖和安全诊断；AC-31。已修订。 |
| R-04 | P1 | 压缩回退仍有模型 ID 比较陷阱：`compactor.ts::runLadder` 同名时不换目标；仅增加 role 类型不足以保证重试账户正确。 | 5.2 明确首次请求、传输重试与失败阶梯回退的不同快照；AC-32。已修订。 |
| R-05 | P1 | 原子保存后“应用绝不失败”缺少可实现的边界；普通设置重配置和通知回调仍可抛错，且 busy 检查未覆盖结束后仍在收尾的 fast review。 | 5.3、6.3 增加预构建、后台收尾检查、已提交但待重启的结果；AC-33、AC-34。已修订。 |
| R-06 | P1 | 旧字段不能表达所有绑定语义：快 profile 的默认地址在解绑后可能变成继承主网关；“有公共 key 就可解绑”还可能静默换账户。 | 5.5 增加有损转换拒绝规则和命令错误传播；AC-35。已修订。 |
| R-07 | P1 | 指定路径脱敏未覆盖损坏/未来版本新段；`maskConfig` 的顶层 spread 会原样输出它，注册密钥也不能依赖有效 schema。 | 4.2、6.3 增加无效段整体隐藏和输出白名单；AC-36。已修订。 |
| R-08 | P1 | 接口和文件清单不闭合：正文误称 `ChildContextRequest`，实际为 `ChildContextManagerRequest`；CLI 连接 set 的入口是 `cli.tsx`，现有 `persistConfig` 返回 void。 | 5.2、5.5、6.3、7 明确实际类型、controller 事务入口、CLI 错误适配和模块依赖方向。已修订。 |
| R-09 | P2 | 80 字名称上限与 256 字模型默认名称、复制后缀冲突；随机 ID 前 8 位不保证区分，`[Edit]` 也没有明确按键。 | 4.2、6.1 明确截断、完整 ID 兜底和动作行；AC-37。已修订。 |
| R-10 | P2 | 风险边界有过度承诺：`config edit` 已有备份；短 key 不进入现有 secret registry，且日志脱敏可关闭。交付检查还引用上游 index=0。 | 6.3、10、11 区分本功能输出与用户主动诊断风险、保留既有备份并修正本节点 index=1。已修订。 |

逐节结论：第 1–3 节的共享库、CLI/Core 分层与独立绑定可行；第 4 节按 R-03/R-07/R-09 补齐边界；第 5 节按 R-01 至 R-06/R-08 修订解析和事务；第 6–7 节补齐输入动作、接口和入口清单；第 8–9 节保留分阶段实现并扩展验收；第 10–11 节修正风险与交付范围。继续采用无依赖、无启动迁移、无跨进程锁的方案；首次启用 fast 需重启是已说明的产品边界，不扩大为工具 schema 热重建。

## 1. 概述

Aragon 的设置界面目前直接编辑一套主模型连接参数，以及一套快速模型参数。用户切换服务商、兼容网关或账户时，需要重新输入模型、地址和密钥。新增可命名的模型配置库，把这些连接参数保存为稳定的配置条目，并让主任务模型与快速模型分别引用条目。默认名称取模型 ID，也允许用户命名为“日常编码”“公司网关”等用途名称；名称与模型 ID 分开存储，重命名不会改变模型请求。

交互围绕“选择已有配置”和“管理配置”展开。设置顶部展示主模型配置、快速模型配置和快速模型开关，进入选择器即可复用配置；新增、编辑、复制、删除在同一设置流程内完成。选择、编辑先进入草稿，明确保存后一起写入磁盘并应用到当前空闲会话。关闭或取消不会产生隐藏写入。配置库由两种角色共享，两个角色的选择相互独立，也允许共同使用同一条配置。

本设计沿用 CLI 的 TypeScript、React 18、Ink 5、npm workspaces 和 Vitest，不改变零耦合 Core 引擎，不新增网络接口、数据库或依赖。本节点只交付本设计文档。下游实现范围包括配置存储、角色凭据解析、设置交互、现有命令兼容及测试；不扩展模型发现、自动探测、云同步或操作系统密钥链。配置条目只保存连接身份：provider、model、baseUrl、凭据；thinking、maxTokens、contextWindow 仍是现有角色或会话策略，切换条目不覆盖它们。快速模型的评审频率、预算、委派开关同样独立保留。

## 2. 已核实的项目现状与约束

已阅读根目录 `README.md`、`CLAUDE.md`、项目索引，并核对下列源码；索引仅用于导航，行为以源码为准。

| 现有路径与符号 | 当前职责及本次影响 |
| --- | --- |
| `config/schema.ts::PersistedConfig / CliConfig` | 持久化与运行时类型分离，当前 `CONFIG_VERSION = 1`。新类型放独立模块，避免继续堆积大文件。 |
| `config/store.ts::loadPersistedConfig / updatePersistedConfig` | 合并默认值、清理历史状态字段，对各已有嵌套段显式合并。新增配置库必须有专门合并规则。 |
| `config/store.ts::writeConfigFile` | 同目录临时文件再 rename；POSIX 使用 0600。复用该写入路径。 |
| `config/load.ts::loadConfig` | 普通字段按 flags、环境、文件、默认值解析；密钥则优先文件 `apiKeys`，其次 provider 环境变量。 |
| `config/load.ts::makeGetApiKey` | 当前仅以 provider 区分密钥，`--api-key` 对当前主 provider 优先。不能区分同 provider 的两个网关账户。 |
| `ui/overlays/SettingsScreen.tsx::SettingsScreen` | 上下选字段，左右改枚举，Enter 保存，输入先移除粘贴和 Enter 帧；密钥输入框不回填已解析密钥。 |
| `ui/App.tsx::handleSettingsSave / persistConfig` | 当前先调用多个运行时 setter 再持久化；持久化失败被内部捕获，后续仍可显示成功并关闭。新保存路径必须消除这一不一致。 |
| `agent/controller.ts::setModel / setFastConfig / setApiKey` | 参数改变后通知 fast、compaction；模型改变还通知 contextMeter。新增统一应用入口保留这些通知。 |
| `fast/resolve.ts::resolveFastTier` | 快速模型 provider 为空继承主模型；同 provider 且地址为空时也继承主地址。绑定独立配置后必须关闭这种地址继承。 |
| `team/subagent.ts::createSubagent` | 子任务按 tier 选模型，但仍共用 provider 密钥闭包，需要把实际角色传到凭据选择。 |
| `compaction/compactor.ts::resolveSummarizer` | 压缩可选快速模型，失败时回退自身模型；凭据必须跟随实际选中的模型角色。 |
| `commands/builtins.ts` | `/model` 打开模型选择器；`/fast` 修改快速层；`/reload` 当前只应用部分配置，不能直接用于完整 profile 刷新。 |
| `config/cli-commands.ts::maskConfig` | 目前只脱敏顶层 `apiKeys`，新增嵌套凭据必须显式覆盖。 |

所有上述代码路径均相对于 `packages/cli/src/`。用户配置位于 `getConfigPath()` 指向的 `~/.aragon-agent/config.json`，受 `ARAGON_HOME` 控制。配置方案是用户主动保存的偏好，属于 config，不属于 `state.json`、会话记录或 prompt history。

遵循 `CLAUDE.md` 的公开接口优先 interface、单方法不超过 60 行和单文件不超过 1000 行等约定。现有超长文件只添加薄接线；本次新增逻辑拆到专用模块，不顺带重构整个 controller、App 或 schema。当前工作区已有包版本及锁文件等修改，后续开发、提交只能精确处理本功能文件，不能覆盖他人工作。

## 3. 方案取舍与不变量

考虑过三种方式：仅保存模型 ID 无法复用地址和账户；主、快各维护完全独立数组会重复录入且容易更新不一致；采用一个配置库、两个独立 ID 引用，能兼顾复用与角色隔离。选第三种。编辑被两个角色共同引用的条目会同时影响两者，编辑页明确显示使用者，并提供复制动作以便分离。

必须始终成立的不变量：

1. 稳定 ID 是引用依据，名称不是主键；同名、同模型、不同网关都合法。
2. 两个角色可选同一条目；切换主模型不能重绑快速模型或覆盖其独立地址、密钥。
3. profile 的空地址表示 provider 默认地址；只有旧式快速配置才允许继承主地址。
4. 未编辑的密钥永不从环境、启动参数或运行时反写磁盘；不会把 profile 专属密钥塞进 provider 公共 key map。
5. 一次设置保存只有一个原子配置写入；写入失败不改变 live config，不关闭编辑器，不显示成功。
6. 运行、团队分发或手动压缩进行中，连接配置不得变更；检查既在 UI，也在 controller 入口。
7. Core、会话 JSON、日志和 exec 事件不携带配置库或明文凭据。
8. 快速层关闭时，选择候选配置不自动启用评审或委派，不触发网络验证和额外费用。

## 4. 数据模型

### 4.1 持久化结构

在 `PersistedConfig` 增加可选 `modelProfiles?: ModelProfilesConfig`，在 `DEFAULT_CONFIG` 中不主动生成该字段。保留顶层版本 1；新段有自己的版本。已有顶层 provider/model/baseUrl/apiKeys 和 fast 段保留为旧式配置，不能删除或当成实时镜像反复覆盖。

以下为接口契约，供下游实现，不是本节点提交的实现代码：

```ts
export type ModelRole = 'main' | 'fast';

export interface ModelProfile {
  id: string;
  name: string;
  provider: string;
  model: string;
  baseUrl: string | null;
  apiKey: string | null;
}

export interface ModelProfilesConfig {
  version: 1;
  entries: ModelProfile[];
  mainId: string | null;
  fastId: string | null;
}

export interface ProfileBindingState {
  selectedId: string | null;
  appliedId: string | null;
  overriddenFields: Array<'provider' | 'model' | 'baseUrl'>;
  invalid: boolean;
}

export interface ModelProfilesRuntime {
  main: ProfileBindingState;
  fast: ProfileBindingState;
}
```

`CliConfig` 增加可选 `modelProfiles` 与 `modelProfileState`，均保持可选以兼容现有测试构造器；读取统一通过 helper 返回默认空库和空绑定。`apiKey: null` 表示采用既有 provider 级配置密钥或 provider 环境变量，非“清空整个账户”。非空字符串是该配置的专属凭据。UI 用“共享 / 环境凭据”“配置专属密钥”区分两种模式，专属输入为空时不得提交；编辑现有专属凭据允许“保持原值”。切回共享模式必须显式选择，不能用空输入隐式删除。

配置示例，密钥均为占位符：

```json
{
  "version": 1,
  "modelProfiles": {
    "version": 1,
    "entries": [
      {
        "id": "b2fb6f61-0d63-49b7-82dc-d70cf8db1abe",
        "name": "日常编码",
        "provider": "openai",
        "model": "coding-model",
        "baseUrl": "https://gateway.example/v1",
        "apiKey": "EXAMPLE_MAIN_KEY"
      },
      {
        "id": "624ef941-b959-4bc2-951b-df1c15d596dc",
        "name": "快速检查",
        "provider": "openai",
        "model": "small-model",
        "baseUrl": null,
        "apiKey": null
      }
    ],
    "mainId": "b2fb6f61-0d63-49b7-82dc-d70cf8db1abe",
    "fastId": "624ef941-b959-4bc2-951b-df1c15d596dc"
  }
}
```

### 4.2 校验与缺省

- ID 新建时用 `crypto.randomUUID()`，编辑不变，复制重新生成；不允许重复 ID。
- name trim 后为空则使用 trim 后的 model；上限 80 个 Unicode 码点，允许同名。默认名称在创建时固化，后续改 model 不自动重命名。拒绝控制字符，展示按终端列宽裁剪。
- 自动名称超过 80 码点时截取前 80 码点；用户手填超限则显示校验错误，不静默截断。复制时先为 ` (copy)` 后缀预留码点再截取原名称。截取不得拆开代理对；终端显示另按列宽处理。ID 读取要求非空字符串、无控制字符、最多 128 码点，新建仍使用 UUID。
- provider 必须属于 `ADAPTER_PROVIDERS`；model 必须非空、无控制字符、至多 256 个码点。允许注册表未知的自定义模型，不能把 provider 支持与模型目录混为一谈。
- baseUrl trim 后空字符串归一化为 null，否则必须是绝对 http/https URL；拒绝 userinfo、query、fragment 以防 URL 携带凭据；保留路径及尾斜杠，地址补全继续由现有 adapter 负责。允许 http 本地网关，不做可达性请求。
- API key trim 后保存；拒绝控制字符，长度上限 8192，不规定厂商前缀。最多保存 200 条配置。超限时阻止新增并给出可操作提示。
- `entries` 是完整数组替换，绝不按数组索引 deep merge。`mainId`、`fastId` 必须是现有 ID 或 null。更新某个条目使用 ID 定位并生成新数组。
- 读取时校验 unknown 输入。不存在新段等同旧配置；不支持的段版本、重复 ID、损坏数组或悬空绑定使整个新段不可应用，并产生一条无敏感值诊断；会话退回旧式字段。不得静默删掉坏条目后覆盖原文件。
- 新段无效时设置仅显示错误和“重新读取”，禁用该段写入；提示通过 `aragon config edit` 修复。无关的 `config set theme` 必须原样保留坏段；触及连接字段的写入返回配置错误。这样读取可降级，而写入不会把唯一副本洗掉。
- 区分文件不存在、文件可解析但新段无效、整个 JSON 无效或 I/O 读取失败。只有不存在可用默认值建立文件；后两种整文件失败必须禁止所有配置写入，不能把 `loadPersistedConfig()` 的默认回退当作可保存基线。严格 reader 返回原始字节、解析结果及错误种类；hash 对同一份原始字节计算，文件不存在采用独立 sentinel。根值为数组也属于整文件无效。
- 读取/解析错误只输出固定错误类型、配置路径和可安全提取的行列号，不输出原文、JSON 异常 message/stack 或对象 dump。可解析但无效的新段在 config get/list 中整体显示 `{ invalid: true }`；未来版本同样处理。有效段仅输出白名单字段，apiKey 固定显示 `Configured`/`Missing`，不暴露前后缀或长度。未知字段不进入显示对象；无关写入仍保留其原始值。

### 4.3 旧配置采用策略

不在启动时做磁盘迁移。打开设置时显示两个“当前自定义配置”虚拟选项，主角色读取持久化主连接，快角色读取持久化 fast 连接。只有用户选择“保存当前配置为方案”才创建实体条目并在草稿中绑定；新条目在最终保存前不写磁盘。快角色创建时把旧的继承关系解析成明确 provider、model、baseUrl，后续不再随主模型变化。空 fast.model 不生成条目，直接进入新增表单。

采用过程只读取持久化字段及其默认值，不复制有效运行时 key；已有磁盘 provider key 可以复制为专属 key，环境或 `--api-key` 提供的 key 只能保持共享模式。若 CLI/env 覆盖了连接，表单展示“当前会话存在启动覆盖”，默认仍采用磁盘配置。旧式配置保留为可随时选择的虚拟候选，切回时将对应 ID 设为 null。

草稿必须同时持有磁盘基线和 live 基线。未操作的字段保持基线，不能仅因渲染时显示了有效值就加入 patch；普通设置只提交用户实际修改的字段。选择同一条配置也算显式激活，允许用户主动消除该角色的启动覆盖；只浏览列表、改名称或修改未绑定条目不算激活。复制以当前已合入的设置草稿条目为准，包含用户本轮明确替换的专属 key，不能回读磁盘丢掉刚完成的编辑。

## 5. 技术设计与关键顺序

### 5.1 配置解析流水线

新增 `config/model-profiles.ts` 处理类型、校验、命名、纯数组操作；`config/model-profile-resolution.ts` 处理绑定投影与凭据选择；`config/model-profile-store.ts` 处理草稿事务；`agent/model-profile-settings.ts` 负责 controller 调用的应用编排。各层不 import React。

启动时依次：读取原始配置并注册其中专属密钥；验证新段；将有效绑定的连接字段投影到文件层副本；调用现有 `loadConfig` 的 flags/env/default 合并；最后构造 `modelProfileState`。`loadPersistedConfig` 返回的是磁盘偏好，不能返回投影后的副本，否则下次无关保存会覆盖旧式候选。

连接参数优先级为：明确 CLI 参数 > 环境连接字段 > 选中 profile > 旧式文件字段 > 默认值。新段未绑定时完全保留既有优先级。快角色先投影 `fast.provider/model/baseUrl`，再运行既有 `resolveFastConfig` 的覆盖逻辑；有有效快绑定时，即使 baseUrl 为 null，也必须使用 provider 默认地址，不进入主地址继承分支。

profile 的 provider 或 baseUrl 被更高层覆盖且值不同时，该角色本次禁用专属 key、`appliedId = null`，保持 `selectedId` 并记录覆盖字段，防止把网关 A 的凭据发给网关 B。只有 model 改变时仍可使用同连接凭据，显示模型覆盖标记。独立绑定被覆盖也不恢复主地址继承。TUI 用户明确切换配置后，以这次选择更新当前内存连接并移除相应角色的连接覆盖标记；重新启动仍遵守 CLI/env 优先级，界面在保存前说明这一点。

启动 `--api-key` 在 profile 模式下绑定启动解析后的 main `{provider, baseUrl}` 目标快照，不能随当前 provider 自动迁移。显式激活/修改主角色连接或凭据时清除本会话的启动 key override，使新 profile 的凭据生效；只改名称或普通设置不清除它。session 恢复只有目标与启动快照一致才可用该 override；不同目标禁用它。空地址比较遵循 5.5 的严格规则。完全未绑定的旧式模式保留旧行为；从旧式模式首次进入绑定模式时必须清除主启动 key 或固定其原目标，不能重新把它绑定到新目标。运行时增加可选 `apiKeyOverrideTarget` 元数据，不写入磁盘。

### 5.2 角色凭据解析

`makeGetApiKey(config, role = 'main')` 保留原单参数调用兼容性。新增纯 helper `resolveModelRoleKey({config, role, providerId})`，所有新路径经过它：

| 情形 | 解析顺序 |
| --- | --- |
| 新段不存在，或两个角色都未绑定 | 保持原 `--api-key` 对当前主 provider 的行为，随后公共 apiKeys。 |
| profile 模式的主角色 | 目标快照匹配且未被显式激活清除的 `--api-key` > 当前有效主 profile 专属 key > 公共 apiKeys。 |
| profile 模式的快角色 | 当前有效快 profile 专属 key > 公共 apiKeys；不使用主角色 `--api-key`。 |
| 请求 provider 与该角色实际 provider 不同 | 只查公共 apiKeys，不使用该角色专属 key。 |

公共 apiKeys 继续由 `loadConfig` 合并“文件 key > provider 环境 key”。空值不成为覆盖。UI 不显示实际 key，所有 summary 只显示 configured/missing 及来源。`hasApiKey(provider?, role = 'main')` 与真实请求使用相同 helper。

调用点必须成对处理：主 Agent 用 main；`resolveFastTier` 的 hasKey、`FastTierWiring` 及 reviewer 用 fast；team 子任务使用 `resolveTier` 实际返回的角色；压缩使用最终 summarizer 的角色。不能根据 providerId 或 modelId 比较来推测角色，因为两个角色可能完全同名却使用不同账户。

为此把 tier resolution 的结果扩展为 `{ ref, thinkingLevel, role }`，在 `team/runtime.ts`、`team/subagent.ts` 的依赖中传入可选角色参数。子 Agent 的 Core 接口仍为 `(providerId) => key`，CLI 闭包固定捕获实际 role。若快速委派回退主模型，结果必须返回 role=main，不能继续捕获原请求 tier=fast。

`SummarizerChoice` 增加 role；`Compactor` 的 hasKey/getApiKey 依赖接受可选 role，另外增加可选 `mainRole: ModelRole`，缺省 main，表示此 compactor 自身模型的角色。`compaction/child.ts::ChildContextManagerRequest` 携带子任务实际 role，创建子 compactor 时把它赋给 mainRole；压缩回退子任务自身模型时沿用该 role，选择快 summarizer 时为 fast。`childConfig` 显式覆盖 baseUrl，包括 undefined，避免 spread 遗留主网关地址。角色凭据闭包读取 lead 的完整绑定配置，而不是 provider 已被覆写的 childConfig，防止主凭据作用域被误改。子 compactor 的 fast 候选也必须从 lead 配置解析，不能因 childConfig 覆写主字段而改变旧式 fast 的继承目标；通过可选 `resolveFastCandidate` 依赖注入，缺省才沿用自身配置解析。

请求开始时同时快照 ref、role、key；同一请求的传输重试复用这个组合。压缩失败阶梯的“快模型回退自身模型”是新请求：`runLadder` 必须把完整的 `SummarizerChoice` 传给 `callOnce`，不能只传 ref，也不能再以 modelId 是否相同决定回退。首次选中 fast 且失败时，第二次选择自身 ref 与 mainRole 并重新取得该目标的 key；即使模型名相同、只地址或账户不同也必须回退。两次实际目标完全相同时仍按现有最多两次阶梯处理，不增加第三次调用。自身目标缺 key 时返回缺钥结果，不借用首轮快角色的 key。

### 5.3 保存事务与运行时应用

设置打开时取得磁盘原文的 SHA-256 revision 和内存设置 revision，草稿独立深拷贝。UI 草稿中的 key 编辑必须使用 keep/replace/shared 三种动作，而不是将已解析的 key 填回表单。replace 的内容输入后立即调用 `registerSecret`，保存日志只记录动作和字段名。

草稿记录 `activateRoles` 与连接/凭据变更的 dirty 状态。保存以当前 live config 为起点，仅对显式激活或已绑定条目连接/凭据发生变化的角色重新投影；编辑共享条目影响所有引用者。普通设置、未绑定条目管理、仅重命名不得重新运行全部启动解析、清除任一角色覆盖或写回环境值。磁盘合并始终以严格 reader 的持久化结果为起点。liveRevision 覆盖本事务可能替换的所有设置字段与凭据，普通设置 setter、session 恢复及 reload 也递增；从此不是仅连接 revision，避免完整 snapshot 覆盖外部的普通设置更改。

保存的严格顺序如下：

1. 收集普通设置和 profile 草稿，完成字段校验；错误定位到具体行，保留所有输入。
2. controller 检查 `isRunning()`、`isTeamBusy()`、`getCompactionSnapshot().inFlight` 与 fast status 的 `snapshot.inFlight`，任一忙则返回 `busy`，不排队、不取消任务、不写盘。主运行结束/取消但 review Promise 尚未收尾也属于忙；review 完成后用户可重试。队列中尚未启动的任务不算正在运行，将使用保存后的配置。
3. 比较内存设置 revision；若打开后发生 `/reload`、模型/凭据修改或其它相关设置修改，返回 `conflict`。同进程保存过程采用同步校验和同步磁盘写入，避免交错。
4. 严格读取当前文件；不可读或整文件解析失败返回 `read_failed`，不进入 writer；再比较原文 hash，不一致则返回 `conflict` 并显示“配置已在其他位置修改，请重新读取”。用户选择重新读取若将丢弃草稿，先使用既有 Discard/Continue 确认流程；不能自动覆盖外部变更。
5. 从最新持久化值合并 dirty 普通 patch 与完整 profile 新段，生成候选运行时快照并预校验，提前构建需要的模型引用和系统提示。专属 key 在任何潜在错误日志前注册。缺 key 只形成可见 warning，不阻止保存候选或激活；结构错误才返回 invalid，不进行联网认证。
6. 调用现有原子 writer 写入一次。失败返回 `write_failed`，内存不变、草稿保留；临时文件仅清理本次 writer 创建的路径，不能删除其它进程临时文件。
7. 写入成功后执行同步 `applyModelSettingsSnapshot`：先整体替换相关 config 字段、绑定和 credential 元数据，再同步更新 agent 模型；最后各一次通知 fast、compaction、contextMeter，安装预构建系统提示并触发显示刷新。核心应用不得再读写磁盘、发网络请求或做输入校验；通知不得重复触发 prompt 构建，可使用内部静默更新后统一通知。
8. 普通设置按已有 live/persist-only 语义应用。日志重配置等可能失败的副作用与关键连接应用隔离。正常结果为 applied；若用户启用尚未注册的快速层，结果为 restart_required 并说明限制，保持关闭时不因未注册显示重启提示。若提交后的应用/副作用意外抛错，返回 saved_apply_failed，明确“已保存，当前会话未完整应用，请重启”，不显示完整成功、不重试写盘、不伪装成 write_failed。关键连接应用失败时 controller 标记需重启并阻止新请求及队列 drain，防止使用部分应用的状态；不能自动回滚磁盘覆盖外部新修改。错误信息须脱敏。

不要继续使用 App 中捕获异常后返回 void 的 `persistConfig` 完成本事务。新事务返回结构化结果，只有 ok 才关闭界面。模型应用不重建整个 controller，不清空消息、TODO、队列、usage 或评审累计预算。切到较小上下文模型后触发 `contextMeter.onWindowChanged()`，既有 compaction 在下一次运行按新窗口处理历史。

saved_apply_failed 的界面显示已提交状态并禁用重复 Save，仅允许关闭/退出并重启，保留磁盘已保存信息；未提交的失败仍保留可编辑草稿。这一区分用于避免把已经生效的磁盘写入误报为失败并重复提交。

跨进程 hash 检查是乐观冲突检测，不能承诺消除检查与 rename 之间极小竞态。本期不引入全局锁；同一文件多进程同时保存仍是最后成功写入者生效，必须在风险说明和测试边界中保留这个限制。

### 5.4 快速层生命周期边界

现有 `isFastRegistered()` 由 controller 构造时确定，不能在本需求内悄悄重建工具 schema。已注册快速层的配置切换在保存后立即作用于下一次请求；快速层关闭时可保存和切换候选，保持关闭。首次从未注册状态启用时保存偏好并明确提示“快速模型将在重启后启用”，展示“已保存，待重启”，不能显示正在使用。主模型仍立即生效。该限制来自现有架构，属于本版明确接受的兼容边界；动态首次启用属于后续独立功能。

若候选缺模型或密钥，优先显示具体缺项，并说明补齐后还需重启；不能承诺仅重启即可使用。

### 5.5 现有命令与旧字段写入

统一采用“编辑连接字段会解除该角色绑定，并回到自定义配置”的兼容语义，避免既有命令悄悄修改复用中的 profile。解除绑定时，将该角色当前选中 profile 的 provider/model/baseUrl 投影为新的旧式连接，再叠加显式 patch；原条目完整保留。**专属凭据不复制到公共 apiKeys**：条目使用专属 key 时拒绝隐式解绑，即使另有公共 key 也不静默换账户，提示到 `/settings` 编辑或复制。用户在 settings 明确选择 Current custom 则允许，先展示目的配置和凭据来源/缺钥状态。

转换还必须可无损表达地址语义：快 profile 使用默认地址、旧式空地址却会继承主网关时，拒绝旧命令隐式解绑，返回 `legacy_conversion_unsupported` 并引导继续使用 profile；不硬编码 provider 默认 URL 填入旧字段。若 patch 已给出可明确表达的完整目标，则正常适配。TUI 同 provider 的单纯 model 更改保留原地址；provider 改变且未给地址时清为空地址，不能把旧厂商网关拼到新厂商模型上。每次失败都发生在写盘与 setter 之前。

`updatePersistedConfig` 在文件合并前调用 `adaptLegacyConnectionPatch`：patch 含顶层 provider/model/baseUrl 时处理 mainId；含 fast.provider/model/baseUrl 时处理 fastId；未涉及连接的 patch 不解除绑定。profile 草稿事务明确传入新段时跳过这一适配，因为它已完整表达用户意图。CLI `config set`、App 模型选择器、`/fast model/provider/same` 都复用此规则，错误时不调用 live setter。provider 公共 apiKeys 修改只更新共享凭据，不覆盖专属 key。

TUI 原主连接字段在绑定时显示只读摘要和“编辑此方案”入口，自定义模式仍可用原字段。`/model` 继续打开现有模型选择器，其提交走统一事务；`/fast` 连接修改先持久化成功再应用并显示成功。`/thinking`、`/max-tokens`、`/fast review` 等策略命令完全保留行为。

普通设置 patch 不得夹带未编辑的旧连接字段；显式新段只代表绑定操作时也不得顺带重写旧式候选。slash 命令通过已有 `ctx.controller` 调用新增事务入口，不使用返回 void 的 `ctx.persistConfig` 判断结果；因此不需扩大 `CommandContext`。`cli.tsx::runConfigSet` 对连接 set 调用持久化适配器并捕获结构化错误，校验/有损转换错误退出码 2、读取/写入错误退出码 1，只在成功后输出 Set。

`/reload` 空闲时重读全部模型连接、profile 状态与两角色凭据，通过统一应用入口刷新，不能只调用 setModel。保留原 `/reload` 不重新传启动 flags 的语义；环境仍重新读取。恢复 session 的 setModel 是内存操作，不保存 profile；provider/baseUrl 相同且仅模型覆盖时保留 appliedId 并标记 model 覆盖，不同连接时清除主 appliedId；保留磁盘选择及 selectedId，以“会话模型覆盖”显示。若会话模型 provider/baseUrl 与选中 profile 相同可继续使用该 profile key，否则只用公共凭据；此判定通过同一 resolver 完成。地址比较使用 trim 后的配置原值，null 与 undefined 均归一化为空地址；不做域名别名、重定向或 URL 尾斜杠等宽松等价推断。

启动遇到坏段可使用旧式配置降级；交互式 reload 遇到整文件失败或无效新段则保留当前 live 快照并报错，不把正在使用的有效配置换成降级默认值。reload 与 session 连接恢复使用同一 busy 守卫和 revision 更新规则；不直接调用绕过守卫的内部 setter。

## 6. 界面与接口设计

### 6.1 设置页布局

保留 `/settings`、`aragon config` 两个入口。产品当前界面为英文，本功能沿用短英文标签；本文交付与说明使用中文，不引入局部翻译体系。默认首屏示意：

```text
Settings
  Main profile       Daily coding
  Fast profile       Quick review
  Fast tier          off
  Manage profiles    3 saved
  Thinking           high
  Max tokens         auto
  ...既有其它设置...

Enter Select/Edit    Ctrl+S Save    Esc Cancel
```

选择行 Enter 打开对应角色的配置列表；列表包括“Current custom”、所有保存条目、“Create profile”。列表顺序使用 entries 的存储顺序，不引入最近使用排序或运行状态字段。每行显示名称、provider:model，右侧文本 `Main`/`Fast`/`Main + Fast` 表示已保存绑定，草稿勾选用单独标记；同名时再显示 URL host 及 ID 前 8 位区分。URL 不显示完整凭据或路径中的敏感片段。

ID 短前缀发生碰撞时逐步加长到唯一，窄屏详情行可显示完整 ID。编辑操作通过 Manage profiles 的明确 Edit 动作行进入；不渲染没有独立焦点或按键含义的 `[Edit]` 装饰按钮。

上下和 Tab 移动，Enter 选择后回到设置草稿，Esc 返回上一级。配置少于等于 8 条无需搜索；多于 8 条显示搜索行，`/` 进入搜索，查询同时匹配 name/model/provider，搜索输入中的字母不触发管理快捷键。选择本身不写盘，顶部显示“Unsaved changes”。普通文本字段继续允许 Enter 保存整个设置；选择/动作行 Enter 执行对应动作，Ctrl+S 在根设置页始终保存。底栏随焦点解释当前 Enter 的含义。

管理列表通过明确动作行 New/Edit/Duplicate/Delete 操作，避免字母快捷键与输入冲突。新增从所选角色的持久化连接预填；空快配置默认 provider 与主配置一致、model 留空，地址默认 null，凭据共享。编辑表单字段固定为 Name、Provider、Model、Base URL、Credential mode、API key。provider 或 Base URL 改变后清除本轮未提交 key，将凭据动作设为 shared；若原来有专属 key，必须明确选择“Retain key for new endpoint”并看到目标摘要才能 keep，或重新输入 replace。只改 model/name 可默认 keep。返回原目标也不能自动恢复已清除的新输入。

复制产生新 ID，默认名称为“原名称 (copy)”，按 4.3 复制设置草稿中的专属凭据但不回填输入框；列表没有自动启用复制项。取消子编辑只丢弃该子草稿，返回设置草稿原值。子编辑 Enter 仅验证并合入设置草稿，Ctrl+S 不跨越子页面提交整个设置，以免用户误认编辑保存等于启用。

删除未引用条目时显示名称并二次选择 Delete/Cancel，默认 Cancel；被任一草稿角色引用的条目禁止删除，提示先为这些角色选择替代配置。因而删除最后一个条目前必须切回 Current custom。Esc 在有改动的根草稿上显示 Discard/Continue，默认 Continue；这是产品交互规格，不是本设计节点向用户请求确认。

### 6.2 输入路由、尺寸与失败反馈

`SettingsScreen` 内用 reducer 管理 `root | picker | manager | editor | delete-confirm | discard-confirm`。仅当前页面的 useInput 激活；App 对 settings 的 Esc 不再直接无条件关闭，而转交 screen 的 onCancel 流程。保留 Ctrl+C 原全局退出语义。App 和子页面不能各自处理同一个 Enter/方向键。

复用 `OverlayFrame`、`overlay-window`、主题和 `pickGlyphs`，每个渲染元素对应一个物理行并 `wrap="truncate"`。焦点变化把目标行滚入可见区域；分页和滚轮仍由 App 的 overlay scroll 通道驱动，页面切换将偏移归零。使用 string-width/已有宽度工具处理中文名称和宽字符，不能按字符串长度猜列数。80×24、60×18、40×12 必须保留可见焦点及底部动作；极小尺寸沿用 App 的 tooSmall 提示。无颜色、ASCII 模式仍通过文本标签识别状态，不新增硬编码 Unicode 装饰。

输入框继续先执行 `stripPasteFrames(stripEnterFrames(input))`。真实 Return 才提交；粘贴中的换行不能保存、关闭弹层或进入对话历史。密钥显示固定“Configured”或掩码，不显示长度或后缀。无网络连接时仍可管理配置；缺少 key 的候选可以保存但标为 `Missing API key`，选为启用角色时保留提示，实际请求沿用缺钥错误，不伪称已通过认证。

### 6.3 内部接口契约

新增契约集中在对应专用模块，禁止在 App 再定义同义类型：

```ts
export interface ProfileValidationIssue {
  path: string;
  code: 'invalid' | 'duplicate_id' | 'missing_reference' | 'unsupported_version';
  message: string;
}

export interface ModelSettingsDraft {
  profiles: ModelProfilesConfig | undefined;
  ordinaryPatch: ModelSettingsPatch;
  activateRoles: ModelRole[];
  diskRevision: string;
  liveRevision: number;
}

export interface ModelSettingsPatch extends Partial<
  Omit<PersistedConfig, 'modelProfiles' | 'fast' | 'compaction' | 'log'>
> {
  fast?: Partial<FastConfig>;
  compaction?: Partial<CompactionConfig>;
  log?: Partial<LogConfig>;
}

export interface ModelSettingsSaveResult {
  ok: boolean;
  persisted: boolean;
  status: 'applied' | 'restart_required' | 'rejected' | 'saved_apply_failed';
  code?: 'invalid' | 'busy' | 'conflict' | 'read_failed' | 'write_failed'
    | 'profile_key_required' | 'legacy_conversion_unsupported' | 'apply_failed';
  issues?: ProfileValidationIssue[];
  restartRequired?: boolean;
}

validateModelProfiles(value: unknown): ProfileValidationIssue[];
projectModelProfiles(file: Partial<PersistedConfig>): ProfileProjection;
resolveModelRoleKey(input: RoleKeyInput): string | undefined;
adaptLegacyConnectionPatch(input: LegacyPatchInput): Partial<PersistedConfig>;
saveModelSettings(input: SaveModelSettingsInput): ModelSettingsSaveResult;
AgentController.applyModelSettingsSnapshot(snapshot: ModelSettingsSnapshot): void;
AgentController.saveModelSettings(draft: ModelSettingsDraft): ModelSettingsSaveResult;
AgentController.hasApiKey(provider?: string, role?: ModelRole): boolean;
```

`ProfileProjection` 包含投影后的 file、副本绑定信息及 issues；`RoleKeyInput` 就是 `{config, role, providerId}`；`LegacyPatchInput` 是 `{current, patch}`，patch 使用可表达嵌套部分更新的类型。`saveModelSettings` 位于 `agent/model-profile-settings.ts`，`SaveModelSettingsInput` 为 `{draft, controller}`；通过窄 controller port 读取状态、预构建与应用，避免运行时循环 import。`config/model-profile-store.ts` 只接收准备好的持久化候选和 revision，不 import controller/React，不调用 onSaved。界面收到结果后自行通知；通知异常不能改写事务结果。

`ModelSettingsSnapshot` 包含 provider、model、baseUrl、thinkingLevel、maxTokens、contextWindow、fast 完整配置、apiKeys、apiKeyOverride、apiKeyOverrideTarget、modelProfiles、modelProfileState，不包含消息、工具或用量。`apiKeyOverrideTarget` 为 `{provider: string, baseUrl: string | null}`，仅运行时存在。普通 patch 的其它设置在 snapshot 构造时也先验证，再按第 5.3 节第 8 步应用。测试通过依赖对象注入 reader/writer，生产实现固定使用现有 store。错误 issues.path 指向如 `modelProfiles.entries[2].model` 的具体字段，message 仅描述规则，严禁拼入原始 key 或带凭据的 URL。

结果约束：applied/restart_required 对应 `ok=true, persisted=true`；rejected 对应 `ok=false, persisted=false`；saved_apply_failed 对应 `ok=false, persisted=true, restartRequired=true`。纯 reload 不经过保存结果，使用独立应用错误并保持未写盘语义。事务内部关键应用错误的捕获只位于提交边界，普通通知错误与连接错误分别标明是否必须阻止新请求。

不新增 REST/WebSocket，不新增 slash command，也不增加 profile CLI CRUD 命令。`aragon config get modelProfiles`、`aragon config list --json` 需能展示脱敏的新段；`config set modelProfiles.*` 不支持并以既有 usage 错误退出码 2 拒绝，批量手工配置通过 `config edit` 完成。`aragon -p` 与 `exec` 共享 loadConfig，自动采用磁盘绑定；stdout 事件 schema 不变。

脱敏不能依赖 `maskSecret` 的前后缀保留，也不能依赖通用日志开关：本功能自己的配置输出、校验错误、保存通知始终只包含安全摘要。`registerProfileSecrets` 在可解析原始对象上容错读取 entries 中的字符串 apiKey，先于 schema 校验注册，损坏字段不能使启动抛错；无效段显示整体隐藏。现有 registry 忽略不足 8 字符的值，`log.redactSecrets=false` 也会停用通用日志脱敏，因此注册只能作为补充，不能替代“不把凭据放进消息”的规则；第三方错误回显在主动关闭全局脱敏时的风险见第 10 节。

## 7. 文件 / 模块变更计划

本节为下游实现的目标清单；本评审节点实际仅修订本 spec。表中源码和测试路径相对 `packages/cli/`，其余路径显式标出。

| 动作 | 文件 | 一句话意图 |
| --- | --- | --- |
| 新增 | `src/config/model-profiles.ts` | 定义 profile、校验、名称处理及 ID 纯操作。 |
| 新增 | `src/config/model-profile-resolution.ts` | 连接投影、覆盖标记和角色凭据解析的唯一实现。 |
| 新增 | `src/config/model-profile-store.ts` | 草稿 revision、旧字段适配、事务式保存和错误结果。 |
| 修改 | `src/config/schema.ts` | 为 PersistedConfig/CliConfig 引入可选新段和运行时状态。 |
| 修改 | `src/config/store.ts` | 保留与校验新段、数组完整替换、接入旧字段适配与专属 key 注册。 |
| 修改 | `src/config/load.ts` | 在 flags/env 合并前投影，扩展 makeGetApiKey 角色参数，日志只记安全摘要。 |
| 修改 | `src/config/cli-commands.ts` | 新段白名单脱敏、坏段整体隐藏、编辑后的安全解析诊断。 |
| 修改 | `src/cli.tsx` | config set 连接适配的错误退出码和成功输出；不支持的新段 set 保持拒绝。 |
| 修改 | `src/logging/secret-registry.ts` | 新增 registerProfileSecrets，注册所有配置而非只注册当前配置。 |
| 修改 | `src/logging/install.ts` | 在启动早期读取原始配置后注册 profile keys。 |
| 新增 | `src/agent/model-profile-settings.ts` | 保存前忙碌检查、预构造 snapshot 和应用编排。 |
| 修改 | `src/agent/controller.ts` | 接入 role resolver、设置 revision、事务入口和关键应用失败后的请求阻断。 |
| 修改 | `src/fast/resolve.ts` | 有效配置绑定关闭地址继承，并按 fast 角色检查凭据。 |
| 修改 | `src/fast/wiring.ts` | resolveTier 返回真实角色，reviewer 使用 fast 凭据闭包。 |
| 修改 | `src/team/runtime.ts` | 将角色参数随 resolver 和 key 依赖传到子任务。 |
| 修改 | `src/team/subagent.ts` | 按实际解析角色绑定子 Agent 密钥及 ChildContextManagerRequest。 |
| 修改 | `src/compaction/compactor.ts` | SummarizerChoice 和请求 key 一起携带真实角色，fallback 保持一致。 |
| 修改 | `src/compaction/wiring.ts` | 透传角色化 key/hasKey 以及子任务压缩依赖。 |
| 修改 | `src/compaction/child.ts` | ChildContextManagerRequest 角色、lead fast 候选注入和显式 baseUrl 覆盖。 |
| 新增 | `src/ui/overlays/model-profile-state.ts` | 设置子页面、草稿、搜索、取消及删除状态的纯 reducer。 |
| 新增 | `src/ui/overlays/ModelProfilePicker.tsx` | 配置选择与管理列表、角色标签、搜索及滚动焦点。 |
| 新增 | `src/ui/overlays/ModelProfileEditor.tsx` | 配置字段与凭据动作编辑、错误定位和粘贴净化。 |
| 修改 | `src/ui/overlays/SettingsScreen.tsx` | 顶部选择行与子页面组合，保持原普通设置字段。 |
| 修改 | `src/ui/App.tsx` | 替换保存链路、模型选择事务、settings Esc 路由及失败保留草稿。 |
| 修改 | `src/commands/builtins.ts` | `/fast` 连接提交及 `/reload` 完整模型快照应用，保持其它命令语义。 |
| 新增 | `src/__tests__/model-profiles.test.ts` | 数据校验、默认名称、重名、引用、数组操作和旧配置采用。 |
| 新增 | `src/__tests__/model-profile-store.test.ts` | 原子保存失败、冲突、旧 patch 适配与配置纯度。 |
| 新增 | `src/__tests__/model-profile-resolution.test.ts` | 优先级、URL 继承隔离、两角色不同 key 和覆盖行为。 |
| 新增 | `src/__tests__/model-profile-runtime.test.ts` | controller、team、reviewer、compaction 真实依赖接线测试。 |
| 新增 | `src/__tests__/model-profile-settings.test.tsx` | reducer/UI 选择、编辑、取消、删除、键盘与尺寸测试。 |
| 新增 | `src/__tests__/model-profile-security.test.ts` | config get/list/log/session/exec 的专属 key 不泄露。 |
| 修改 | `src/__tests__/overlay-enter-compatibility.test.tsx` | 新字段顺序下通过真实 stdin filter 验证 Enter 和粘贴行为。 |
| 修改 | `src/__tests__/max-tokens-ui.test.tsx` | 保持普通 token 字段与设置保存的既有回归覆盖。 |
| 修改 | `src/__tests__/fast-resolve.test.ts` | 保留旧继承测试，补 profile 官方地址不继承主网关。 |
| 修改 | `README.md` | CLI 使用说明补充配置管理、作用域、覆盖和重启限制。 |
| 新增 | 根目录 `docs/plans/model-config-profiles/manual-test.md` | 下游实现时记录终端、权限失败、网关切换的人工验收。 |

无需修改 Core、package.json、lockfile、发布脚本、ModelPicker UI 本体、commands/registry.ts 或 exec 事件类型。`fast/reviewer.ts` 不必改变其 provider-only 接口，只需 wiring 注入固定 fast 角色的闭包。diagnostics/info、doctor、headless 已调用 makeGetApiKey，默认 main 角色即可继承新行为，必须通过测试证明无需额外接线。新增角色字段的现有类型构造用例在上述模块的关联测试中同步调整；文件清单是生产改动边界，不要求把旧 fixture 全部重写。

## 8. 实施顺序

1. 实现 profile 纯类型和校验，先写正常/损坏/重名/引用测试，再接 schema/store 的可选段；此时旧配置读写须保持不变。
2. 实现投影、覆盖检测和 main/fast 凭据 resolver，完成同 provider 不同地址与 key 的矩阵测试。
3. 改造 fast、team、compaction 的角色传播，使用假 provider 捕获请求，证明 ref 与 key 不串线。
4. 实现事务保存与 controller 单次应用、旧连接 patch 适配，注入磁盘写入失败验证磁盘/live/UI 的一致性。
5. 完成纯 UI reducer，再接列表、编辑器、SettingsScreen 和 App 路由；更新 `/fast`、`/reload`、模型选择器提交路径。
6. 补齐输出脱敏、README、人工矩阵，运行下面的构建与回归门禁。源文件修改只有在全部门禁通过后才进入下游最终审查；本节点不提交代码。

## 9. 测试与验收标准

### 9.1 自动化测试矩阵

| 编号 | 场景 | 必须观察到的结果 |
| --- | --- | --- |
| AC-01 | 仅旧式 config，没有新段 | 连接、优先级和快速默认关闭保持原行为；启动不写盘。 |
| AC-02 | 新增时名称为空；随后改 model | 首次名称默认模型 ID；后续名称保持，不自动重命名。 |
| AC-03 | 两条同名同模型不同 URL/key | 列表可区分，ID 不同；选择后请求使用对应连接。 |
| AC-04 | 主配置 A、快配置 B，主切 C | B 的 provider/model/baseUrl/key 不变化；评审策略和预算不重置。 |
| AC-05 | 主快绑定同一个 profile 后编辑它 | 两者随编辑生效；编辑页事先显示 Main + Fast 使用关系。 |
| AC-06 | 主网关 URL、快 profile.baseUrl=null | 快请求走 provider 默认 URL，不继承网关。 |
| AC-07 | 同 provider 下 A key 和 B key | 主请求/主子任务用 A；review/快子任务用 B；压缩与其实际角色一致。 |
| AC-08 | 快委派不可用而回退主模型 | 模型、thinking 和 key 全部来自实际 main 角色，不残留 B key。 |
| AC-09 | CLI/env 覆盖 provider/baseUrl | 专属 key 不发向不同目标；settings 显示覆盖，重启行为可解释。 |
| AC-10 | 只有环境 key，打开并直接保存设置 | config.json 不出现该 key；日志也不出现其明文。 |
| AC-11 | 新 key 输入、取消子编辑/根草稿 | 磁盘及 live 不变；不会进入对话、历史、stdout 或错误输出。 |
| AC-12 | 保存时 writer 抛 EACCES/rename 错误 | 旧文件有效，live 未改；弹层保留；只有错误，无成功提示。 |
| AC-13 | 打开后外部修改 config | 检测 hash 冲突，不覆盖外部版本；重新读取建立新基线。 |
| AC-14 | malformed 新段、重复 ID、悬空引用 | 无崩溃，旧式配置降级且有一次提示；坏段不被无关写入洗掉。 |
| AC-15 | entries 新增/删除及无关 fast.review patch | 数组按 ID 完整处理；其它设置和绑定不丢失。 |
| AC-16 | 删除被绑定项、最后一项 | 被绑定项拒绝；先解绑后才可删除；取消不改变任何项。 |
| AC-17 | run/team/manual compaction 忙时保存 | 返回 busy；无写入、无 setter，队列不丢失。 |
| AC-18 | fast 未注册时选择并启用 | 保存成功但显式待重启；重启后可用；未启用时没有额外请求。 |
| AC-19 | `/model`、`/fast model`、`config set model` | 走相同解除绑定规则；专属 key 场景明确拒绝隐式解绑并保留旧状态。 |
| AC-20 | `/reload` 后主快模型和 key 都改变 | 两角色解析与请求都使用重读值；已有消息与用量保留。 |
| AC-21 | session 恢复至另一连接 | 不把当前 profile key 发向会话中不同网关；磁盘绑定不变。 |
| AC-22 | config get/list/text/JSON、本功能启动与错误日志 | 本功能输出无 profile 明文 key，包括未激活项及短 key；通用日志启用脱敏时另验证注册的 key 被替换。 |
| AC-23 | `-p`、`exec`、info、doctor | 采用相同主绑定与 key；exec schema 未变，序列化不包含配置库。 |
| AC-24 | Return、CSI 13u、CSI 13;1u，Shift+Enter 和粘贴 | 真 Enter 只执行一次当前动作；帧被净化，无误保存。 |
| AC-25 | 中文重名、宽字符、80×24/60×18/40×12 | 焦点可见、动作可达、无多行挤破布局、搜索和滚动不串到 transcript。 |
| AC-26 | NO_COLOR、ASCII、warm/cool/light | 角色和错误均能靠文本辨认；没有新增裸 Unicode 导致 glyph test 失败。 |
| AC-27 | 空闲保存后继续对话 | 不清历史、不重置费用/预算；下一请求使用新模型，contextMeter 反映新窗口。 |
| AC-28 | 重启往返 | 条目名称、顺序、ID、两角色绑定、共享/专属凭据模式全部一致。 |
| AC-29 | 启动 key 对网关 A，TUI 激活同 provider 的 B；恢复另一网关 session；编辑 URL | A 的启动 key 不发向 B；只有明确保留才迁移专属 key；仅改名称保留启动覆盖。 |
| AC-30 | CLI/env 覆盖下只改普通设置、仅重命名或编辑未绑定项；同条目显式再选择 | 前三者不回写有效连接、不解绑、不清覆盖；显式选择才激活；草稿复制含本轮已编辑凭据。 |
| AC-31 | 整文件 JSON 损坏、根数组、EACCES、文件不存在；带 key 片段的解析错误 | 前三者所有保存均拒绝且原文件字节不变；不存在可创建；错误无原始片段；reload 保留 live。 |
| AC-32 | 快 summarizer 失败，主快 modelId 相同而网关/key 不同；快子任务压缩 | 阶梯第二次使用自身角色与 ref/key；lead fast 候选不被 child 继承改写；最多两次调用。 |
| AC-33 | 主任务结束但 review 请求尚未 settle；草稿打开后普通设置 setter 修改 | 前者 busy、后者 revision conflict；都不写盘、不覆盖新值。 |
| AC-34 | writer 成功后注入核心应用或日志重配置异常 | persisted=true 且明确待重启；不显示完整成功或重复写盘；核心异常阻断队列 drain 与新请求。 |
| AC-35 | 快默认地址解绑将继承主网关；专属 key 与公共 key 同时存在；CLI 适配失败 | 有损隐式解绑拒绝，磁盘/live 不变；无成功 Set 输出；校验退出 2、I/O 退出 1。 |
| AC-36 | 未激活 key、短 key、坏 entries、未来段版本；文本/JSON/get/list 输出 | 有效字段固定掩码；无效段整体隐藏；本功能输出不依赖 registry 长度或日志开关，不抛异常。 |
| AC-37 | 256 码点模型生成名称、80 码点名称复制、ID 前缀碰撞 | 自动名称与复制均合法且不拆代理对；手填超限报错；详情可唯一识别条目；Edit 可键盘到达。 |

单元测试用受控 ARAGON_HOME，使用临时测试目录而非真实用户配置。provider 请求采用现有注入接口和假 adapter 捕获，不能以真实收费调用作为 CI 门槛。磁盘测试使用真实 JSON 读写；仅故障注入时 mock writer/rename，不用“mock 返回成功”替代持久化验证。UI 测试通过真实 stdin filter 与 Ink 渲染，不能只测试 reducer 后声称键盘交互通过。

### 9.2 实现后的检查命令

在根目录按顺序独立执行，检查每条 exit code，不使用 PowerShell 5.1 不支持的命令连接符：

```text
npm run test -w packages/cli -- src/__tests__/model-profiles.test.ts src/__tests__/model-profile-store.test.ts src/__tests__/model-profile-resolution.test.ts src/__tests__/model-profile-runtime.test.ts src/__tests__/model-profile-settings.test.tsx src/__tests__/model-profile-security.test.ts
npm run typecheck
npm test
npm run build
npm run verify:brand
git diff --check
```

全量测试包含 config-purity、config-skills-merge、fast-config、fast-registry、fast-task-tier、compaction-child、context-one-writer、queue、glyphs、theme、overlay-enter 和 exec 回归。若已有失败，记录基线和本次引入的差异，不删除旧断言换取通过。上述命令是下游代码实现门禁，本设计节点不宣称它们已运行。

### 9.3 人工验收流程

使用隔离 ARAGON_HOME 启动 TUI：保存三套配置，其中两套同 provider 不同网关和账户；主、快分别绑定，关闭并重启核对。切换主模型后通过本地假网关观察快请求仍访问原地址；再复制共享配置并单独修改快角色，验证独立性。测试编辑取消、删除取消、缺钥提醒、只读目录写入失败、另一终端修改冲突和运行中保存拒绝。

Windows Terminal/PowerShell 必测；macOS/Linux 至少各选择一个受支持终端检查布局、粘贴与 0600 权限。没有对应环境时在 manual-test.md 标为未执行，不能把 Linux 的权限结论代替 Windows ACL。最终验收需要全部 AC 可追溯到自动化用例或明确人工记录，快速首次启用的重启提示必须可见。

## 10. 风险与缓解

| 风险 | 缓解与本版边界 |
| --- | --- |
| provider-only key map 导致同厂商多账户串线 | 保留公共 map，同时按 role 解析专属 key；覆盖主、快、review、child、compaction 全链路。 |
| 新段被 shallow merge 或坏数据清洗丢失 | entries 完整替换，校验和写入分离；无关写入保留原始坏段。 |
| 配置已写入但 UI 仍旧，或保存失败仍提示成功 | 预构建快照，先原子写再无 I/O 应用；成功与失败用结构化结果分流。 |
| UI 广播输入造成一次 Enter 同时选择与保存 | 仅当前子页面拥有输入；App 将 settings Esc 转交；真实过滤器回归测试。 |
| 新字段泄露到 config list 或启动日志 | 白名单输出、无效段整体隐藏及早期 key 注册；不向序列化事件传递库对象，注册的长度限制见诊断日志风险。 |
| 两进程在 hash 检查后同时写 | 本版仅乐观检测常见冲突，不承诺跨进程事务锁；文档清楚说明极小竞态。 |
| 环境或 flags 覆盖让用户误以为选择无效 | 显示覆盖来源；不同连接禁用专属 key；TUI 明确操作可立即覆盖本次连接，重启仍遵循启动优先级。 |
| legacy 命令丢失账户或默认地址语义 | 专属 key 或无法表达地址语义时拒绝隐式解绑，指引去设置复制或编辑，原配置保留。 |
| 快速层首次启用无法动态注册 | 精确显示待重启，已有注册层的切换即时；不虚构热启用能力。 |
| 新 profile 明文密钥增加磁盘敏感数据 | 沿用用户现有 config.json 0600 机制；Windows 依赖用户目录 ACL，不宣称加密；profile 自动保存不新建备份。既有 config edit 会复制备份且包含凭据，保留原行为并在 README 说明备份同样敏感。 |
| 主动关闭日志脱敏或使用短 key 时第三方错误回显 | 本功能输出始终只发安全摘要；现有全局 logger 开关和短 key registry 限制仍存在，不能保证外部 SDK 任意错误文本无密钥。不在本需求中重写全局日志策略，README 说明诊断日志分享边界。 |
| 写入已提交而应用回调失败 | persisted/status 明确区分；核心失败阻断新请求并要求重启，保留已写磁盘，不自动回滚或重复保存。 |
| 切小模型时历史超窗或未知模型无目录数据 | 保持现有 provider 校验与 compaction；允许未知模型，保留上下文覆写字段供用户控制。 |
| 旧版 CLI 不认识绑定字段 | 保留旧式连接作为降级候选；回退旧版会使用旧式连接，不能承诺旧版按 profile 执行。 |

## 11. 本节点交付检查

本评审节点仅修改 `docs/plans/model-config-profiles/spec.md`，不实现源码、不修改其它业务文件、不执行 git commit。完成前核对版本 v2、评审记录、评审结论及全部 P0/P1 闭环；检查正文、接口、文件清单和验收编号相互一致，确认已有源码与包文件未被本节点修改。随后使用任务工具提交“无源码变更”逻辑记录，报告完成并查询 index=1 的状态。代码测试、构建和人工终端验收留给下游实现节点执行，不计为本评审节点已完成的验证。

本次已执行文档结构检查：10 条评审记录均有正文处理，AC-01 至 AC-37 连续且不重复，22 个计划修改的现有文件路径存在，版本及两个评审章节正确；`git diff --check` 无空白错误。源码目录的前后摘要不同，核查发现并发任务修改输入框、剪贴板和队列等文件；本节点未写入或回退这些文件。已重读相关 controller/CommandContext 差异及 App 设置保存入口，本文针对连接事务的现状判断仍成立。不能把共享工作区的摘要变化误称为“所有源码未变化”。

## 评审结论

**通过**。

本次设计评审记录的 8 项 P1、2 项 P2 均已落实到正文契约、风险边界或验收场景；无未解决的 P0 / P1。方案可在现有 TypeScript、Ink 和 CLI 分层内实施，不需要修改 Core 或新增依赖。评审认可的是 v2 设计；37 项验收、源码测试、构建及终端人工验证须由下游实现阶段完成。首次启用快速层需重启、跨进程保存仅乐观检测和既有诊断日志限制，均是已明示的范围边界。

## 实施过程发现的方案缺陷

1. 现有 `FastConfig.baseUrl` 是字符串，不能直接承接 profile 的 `null`。连接投影将 `null` 映射为旧字段的空字符串，同时保留有效绑定标记，快速 resolver 根据绑定禁用主地址继承。profile 本身仍保留 `null`。
2. controller 已有系统提示单一写入点的回归约束。事务在提交前预构建提示，提交后通过原 `rebuildSystemPrompt` 安装预构建值；fast 通知采用静默提示更新，避免重复构建或打破单一写入点。
3. 普通设置不能直接将未经 clamp 的草稿覆盖 live。候选磁盘配置统一规范化后，仅按 dirty 字段取值应用到 live，保留未编辑的环境覆盖；`liveToolOutput` 仍只在重启后生效。显式修改主角色共享凭据也清除启动密钥覆盖。
4. 旧式、未绑定的 provider 修改同样需要清空未显式指定的旧地址；不能只在 profile 解绑时执行。适配器现统一处理绑定与自定义连接，避免跨厂商继承地址。
5. 当前任务的“git status 无无关改动”与共享工作区既有及并发改动冲突。实现采取保留其它任务改动、限定自身文件清单的方式，不执行清理、回退或提交。人工跨平台验证按第 9.3 节如实记录为未执行，详见 `manual-test.md`。
