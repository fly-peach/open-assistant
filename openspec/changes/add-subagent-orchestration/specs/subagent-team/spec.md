## ADDED Requirements

### Requirement: 子 agent 的声明式定义

系统 SHALL 允许在 agent 目录下的 `team/<子 agent 名>/SPEC.md` 用声明的方式定义子 agent，而无需改动代码。

`SPEC.md` SHALL 由 YAML frontmatter 与正文两部分组成：正文作为该子 agent 的系统提示词，frontmatter 声明结构化字段。

frontmatter SHALL 支持以下字段：

| 字段 | 必填 | 含义 |
|---|---|---|
| `name` | 是 | 子 agent 标识，SHALL 与该目录名一致 |
| `description` | 是 | **路由描述**——主 agent 依据它决定是否把任务派给该子 agent |
| `tools` | 否 | 工具白名单（工具名列表）；缺省为继承主 agent 已开启的工具组 |
| `model` | 否 | 该子 agent 使用的模型；缺省沿用与主 agent 相同的解析链 |
| `skills` | 否 | 该子 agent 可用的技能；缺省为空（子 agent 默认不继承主 agent 的技能） |
| `mode` | 否 | `isolated`（默认）或 `fork` |

#### Scenario: 合法声明被装载
- **WHEN** `team/trainer/SPEC.md` 存在且 frontmatter 含合法的 `name` 与 `description`
- **THEN** 该子 agent SHALL 出现在主 agent 的团队中，且正文 SHALL 成为它的系统提示词

#### Scenario: 缺少 description 的声明被拒绝
- **WHEN** 某个 `SPEC.md` 缺少 `description` 字段
- **THEN** 系统 MUST NOT 装载该子 agent，并 SHALL 以可读的方式指出「缺少路由描述」及所在路径

#### Scenario: name 与目录名不一致
- **WHEN** `SPEC.md` 的 `name` 与其所在目录名不同
- **THEN** 系统 MUST NOT 静默采用其中一个，SHALL 报错并指出两者的值

#### Scenario: frontmatter 语法非法
- **WHEN** `SPEC.md` 的 YAML frontmatter 无法解析
- **THEN** 该子 agent MUST NOT 被装载，且 MUST NOT 导致整个团队加载失败

#### Scenario: mode 只接受 isolated 与 fork
- **WHEN** `mode` 被写成 `isolated` / `fork` 之外的任何值
- **THEN** 系统 MUST 拒绝该声明并指出合法取值
- **AND** MUST NOT 依赖底层运行时把未知值静默退回默认行为——底层会**静默放行** `handoff` 并让其表现得与 `isolated` 完全一致，本系统 MUST NOT 继承这种行为

#### Scenario: 未声明任何子 agent
- **WHEN** agent 目录下不存在 `team/` 目录，或其中没有任何合法的 `SPEC.md`
- **THEN** 主 agent SHALL 正常工作，行为与没有子 agent 时一致，MUST NOT 报错

#### Scenario: 拒绝非法子 agent 标识
- **WHEN** 子 agent 目录名含路径分隔符、`..` 或空白
- **THEN** 系统 MUST NOT 装载它

### Requirement: 内置通用子 agent 的处置

底层运行时（deepagents）**总是**在主 agent 的工具清单里注入一个名为 `general-purpose` 的通用子 agent——它使用主 agent 的模型、拥有全部工具，且本产品**没有**发现可以关闭它的入口。系统 SHALL 明确处置它，MUST NOT 让它在用户不知情的情况下与用户定义的子 agent 竞争路由。

#### Scenario: 内置通用子 agent 对用户可见
- **WHEN** 用户查看团队成员列表
- **THEN** 系统 SHALL 把 `general-purpose` 作为「运行时内置成员」显式列出并说明其能力范围，MUST NOT 让它隐式存在

#### Scenario: 用户定义子 agent 与内置成员同名
- **WHEN** 用户试图新建或装载一个名为 `general-purpose` 的子 agent
- **THEN** 系统 MUST 拒绝该声明并指出与内置成员冲突

### Requirement: 主 agent 委派子任务

系统 SHALL 让主 agent 能够在**同一轮**内把一个或多个子任务委派给子 agent，并把结果回流给主 agent。

#### Scenario: 委派并回收结果
- **WHEN** 主 agent 委派一个子任务给某个子 agent
- **THEN** 该子 agent 的执行 SHALL 在当前轮内完成，其结果 SHALL 回到主 agent 的上下文

#### Scenario: 子 agent 的上下文隔离
- **WHEN** 主 agent 委派子任务
- **THEN** 子 agent SHALL 只看到交给它的任务描述，MUST NOT 看到主 agent 的完整对话历史
- **AND** 该隔离 SHALL 仅指**对话历史**：子 agent 收到的是一个两元素对话（自己的系统提示词 + 一段与任务描述逐字相同的用户消息）

#### Scenario: 子 agent 与主 agent 共享工作区文件
- **WHEN** 子 agent 读写文件
- **THEN** 其操作 SHALL 落在与主 agent **同一个**工作区，SHALL 能看到主 agent 已写入的文件，且其写入 SHALL 回流到主 agent 的状态
- **AND** 系统 MUST NOT 把「上下文隔离」表述或实现为文件沙箱——本条正是选择「一个工作区 + 同轮委派」架构的前提

#### Scenario: 并行委派
- **WHEN** 主 agent 在同一条消息里委派多个子任务
- **THEN** 系统 SHALL 并行执行这些子任务，并在全部结束后一起回流

#### Scenario: 回流顺序不代表完成顺序
- **WHEN** 主 agent 在同一轮里并行委派多个子任务且它们完成时间不同
- **THEN** 结果回流到主 agent 的顺序 SHALL 等于**发起顺序**，MUST NOT 等于完成顺序
- **AND** 因此系统 MUST NOT 把「第几条结果」当作完成先后的信号；需要时序的地方 SHALL 由子 agent 在自己的报告里写明

#### Scenario: 只回流最终文本
- **WHEN** 子 agent 完成一次委派
- **THEN** 回到主 agent 的 SHALL 只有该子 agent **最后一条带文本的 AI 消息**；子 agent 的中间工具调用与读到的原始数据 MUST NOT 回流
- **AND** 因此系统 SHALL 保证每个子 agent 的 `description` 或系统提示词要求它「把需要的结论写进最终回复」，MUST NOT 让主 agent 收到无信息的占位结果

#### Scenario: 委派给不存在的子 agent
- **WHEN** 主 agent 请求委派给一个不在当前团队中的子 agent
- **THEN** 系统 SHALL 以可读方式失败并列出当前允许的子 agent，MUST NOT 静默退回给内置通用子 agent

### Requirement: 执行失败的隔离与呈现

底层运行时对工具错误采取**快速失败**语义：只要工具体抛出，本轮执行即被**中止**（不是把错误降级成一条可见的工具结果）。系统 SHALL 在此基础上明确失败的呈现方式，MUST NOT 让用户看到无法解释的中断。

#### Scenario: 子 agent 执行异常不终止整轮
- **WHEN** 某个子 agent 在执行中抛出异常
- **THEN** 系统 SHALL 让主 agent 仍然收到一条**可见的结果**并继续本轮
- **AND** 该失败 SHALL NOT 终止整轮执行
- **AND** 由于底层默认行为是「一个子 agent 抛错 = 整轮中止，且同轮兄弟子任务已算出的结果一并丢弃」，本条 SHALL 由系统在**子 agent 的模型层**做软失败包装来实现，MUST NOT 依赖底层默认行为

#### Scenario: 失败以可见结果回到主 agent
- **WHEN** 子 agent 以软失败包装返回
- **THEN** 它 SHALL 以普通结果的形式回到主 agent，并带上可识别的失败标记
- **AND** 系统 SHALL 约定该标记的形态，使主 agent 能区分「子任务完成」与「子任务失败」，MUST NOT 让两者在形态上无法区分

#### Scenario: 失败可被追踪
- **WHEN** 一次委派以失败结束
- **THEN** 系统 SHALL 保留该失败的归属（哪个子 agent、哪次委派）与可读原因，使界面与日志能定位它

#### Scenario: 任意工具错误的中止语义被明确
- **WHEN** 任何工具（包括主 agent 自己的普通工具）抛出异常
- **THEN** 本轮 SHALL 以可读的错误结束，MUST NOT 留下用户无法解释的中断
- **AND** 系统 SHALL NOT 把「工具错误会被自动转成可见结果让模型自愈」当作前提

### Requirement: 子 agent 的能力边界

系统 SHALL 保证子 agent 的能力不超过主 agent，且子 agent 自身不具备再委派能力。

#### Scenario: 子 agent 不继承委派工具
- **WHEN** 主 agent 委派出一个 `isolated` 子 agent
- **THEN** 该子 agent 的工具集合 SHALL 不包含 `task` 与任何跨 agent 调用工具

#### Scenario: 递归不可被提示词绕过
- **WHEN** 子 agent 被要求继续委派任务
- **THEN** 它 SHALL 因为不具备该工具而无法执行，MUST NOT 依赖提示词自律来阻止

#### Scenario: 工具组开关对子 agent 生效
- **WHEN** 主 agent 的某个工具组被配置关闭
- **THEN** 子 agent MUST NOT 拿到该组的工具，即使用它的 `SPEC.md` 里列出了这些工具

#### Scenario: 子 agent 默认不继承技能
- **WHEN** 某个子 agent 的 `SPEC.md` 未声明 `skills`
- **THEN** 该子 agent SHALL 在没有任何技能的配置下运行，MUST NOT 隐式继承主 agent 的技能

### Requirement: 团队变更的生效边界

团队配置（`team/` 下的声明）SHALL 通过**重建图**生效，且系统 SHALL 明确定义它对进行中的会话产生什么影响。MUST NOT 让会话因为团队变化而出现状态错乱。

底层已实证：`subagents` 数组**不构成图拓扑**（子 agent 在 `task` 工具内部被调用，父图的节点与通道不变），因此重建图后**同一个会话可以直接继续**。

#### Scenario: 团队变更需重建图才生效
- **WHEN** 用户修改了团队配置（新增 / 删除 / 修改某个子 agent 的声明）
- **THEN** 系统 SHALL 重建主 agent 的图，使新团队生效
- **AND** MUST NOT 要求用户重启服务或更换会话
- **AND** 系统 SHALL NOT 依赖「模块加载时求值一次」的图出口方式，否则改动不会生效

#### Scenario: 新会话使用新团队
- **WHEN** 用户在团队变更后开启一个新会话
- **THEN** 该会话 SHALL 使用修改后的团队

#### Scenario: 进行中的会话直接使用新团队
- **WHEN** 团队配置发生变化，而某个会话上一轮**已经正常结束**
- **THEN** 该会话 SHALL 从下一轮起使用新团队，MUST NOT 报错、MUST NOT 状态错乱
- **AND** 系统 MUST NOT 提示用户「请开启新会话」

#### Scenario: 未完成的委派指向已被删除或改名的子 agent
- **WHEN** 某个会话上存在一次**未完成**的委派，而它引用的子 agent 在新团队里已被删除或改名
- **THEN** 该会话 SHALL 以可读的方式失败并说明原因，MUST NOT 静默卡死
- **AND** 系统 SHALL 给出可执行的出路（提示开启新会话，或恢复该子 agent 的声明），MUST NOT 只抛出一条底层错误
- **AND** 系统 MUST NOT 因为该情形而损坏既有会话的数据

#### Scenario: 团队声明损坏时不影响已有会话
- **WHEN** 某个 `SPEC.md` 变成非法内容
- **THEN** 依赖该团队的新会话 SHALL 以可读的方式失败或被降级，且 MUST NOT 影响历史会话的读取

### Requirement: 系统提示词的自包含性

底层运行时的行为约束提示词**只在未显式提供**系统提示词时才生效；一旦显式提供，运行时的内置基础提示词**完全不会出现**。系统 SHALL 保证主 agent 与各子 agent 的系统提示词是自包含的。

#### Scenario: 显式提示词不丢失必要约束
- **WHEN** 系统为主 agent 或某个子 agent 提供系统提示词
- **THEN** 该提示词 SHALL 自包含地描述其职责与必要的边界，MUST NOT 假定运行时的内置约束仍然存在

### Requirement: 团队的可见与可编辑

系统 SHALL 让用户看到当前团队的成员，并能修改决定路由与能力的字段。

#### Scenario: 列出团队成员
- **WHEN** 用户打开某个 agent 的团队管理界面
- **THEN** 系统 SHALL 列出该 agent 目录下 `team/` 中全部合法子 agent 的名称与路由描述，并标注非法声明的存在与原因

#### Scenario: 编辑路由描述
- **WHEN** 用户修改某个子 agent 的 `description` 并保存
- **THEN** 改动 SHALL 落盘到该子 agent 的 `SPEC.md`，且 SHALL 在后续委派路由中生效

#### Scenario: 编辑工具白名单与模型
- **WHEN** 用户修改某个子 agent 的工具白名单或模型并保存
- **THEN** 改动 SHALL 落盘，且 SHALL 在后续委派中生效

#### Scenario: 删除或改名前的风险提示
- **WHEN** 用户要删除或改名一个子 agent
- **THEN** 系统 SHALL 提示该操作可能让「停在一次未完成委派上」的会话卡住
- **AND** 该提示 SHALL 给出一条出路（开启新会话，或稍后再改名）

#### Scenario: 保存非法内容被拒绝
- **WHEN** 用户保存的内容使 `SPEC.md` 变得非法（例如清空了 `description`）
- **THEN** 保存 SHALL 被拒绝并给出可读原因，MUST NOT 破坏原有文件
