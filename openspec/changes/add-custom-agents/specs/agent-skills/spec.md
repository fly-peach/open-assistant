## Purpose

定义 agent 的技能体系：技能以目录形式随 agent 存放，通过渐进披露把上下文成本控制在可预期范围内，并同时支持 agent 私有技能与跨 agent 共享技能。

## ADDED Requirements

### Requirement: 技能以目录形式存放
系统 SHALL 把每个技能表示为一个目录，目录内含一份说明文件与可选的脚本与参考资料。

#### Scenario: 技能结构
- **WHEN** 定义一个技能
- **THEN** 它 SHALL 位于某个 agent 目录下的技能目录中，且其说明文件包含名称与用途描述

#### Scenario: 可被普通编辑器修改
- **WHEN** 用户直接编辑技能说明文件
- **THEN** 后续运行 SHALL 使用修改后的内容，无需重建 agent

#### Scenario: 附带资源
- **WHEN** 技能需要脚本或参考资料
- **THEN** 这些文件 SHALL 与说明文件同处一个技能目录内，并可被 agent 按需读取

#### Scenario: 非法技能不被加载
- **WHEN** 某技能目录缺少说明文件或说明文件缺名称
- **THEN** 系统 SHALL 跳过该技能并在界面上标注异常，MUST NOT 使整个 agent 加载失败

### Requirement: 渐进披露
系统 SHALL 只在上下文中放置技能的**名称与用途描述**，技能正文按需读取。

#### Scenario: 默认只暴露描述
- **WHEN** agent 启动一轮对话且存在若干技能
- **THEN** 注入了上下文的技能信息 SHALL 只包含名称与用途描述，MUST NOT 包含技能正文

#### Scenario: 需要时读取正文
- **WHEN** agent 判断某个技能与当前任务相关
- **THEN** 它 SHALL 能通过一个工具读取该技能的完整说明并据此执行

#### Scenario: 技能数量增长时的上下文成本可控
- **WHEN** agent 的技能数量显著增加
- **THEN** 每轮固定注入的技能上下文 SHALL 只随技能数量线性增长（每条一行描述），MUST NOT 随技能正文长度增长

#### Scenario: 引用资料按需读取
- **WHEN** 技能正文引用了参考资料
- **THEN** 这些资料 SHALL 在需要时才被读取，MUST NOT 随技能正文一起注入

### Requirement: 私有技能与共享技能
系统 SHALL 同时支持只属于某个 agent 的技能与多个 agent 共用的技能，并规定同名时的优先级。

#### Scenario: 私有技能只对本人可见
- **WHEN** agent A 有一个私有技能
- **THEN** agent B 的可用技能列表里 MUST NOT 出现它

#### Scenario: 共享技能对多个 agent 可见
- **WHEN** 共享技能池中有一个技能
- **THEN** 使用该池的 agent SHALL 能在其技能列表中看到它

#### Scenario: 同名时私有优先
- **WHEN** agent 私有技能与共享技能同名
- **THEN** 生效的 SHALL 是该 agent 的私有技能，且系统 SHALL 能说明发生了覆盖

### Requirement: 技能的启用与控制
系统 SHALL 允许按 agent 控制哪些技能可用。

#### Scenario: 关闭技能
- **WHEN** 用户在 agent 配置中关闭某个技能
- **THEN** 该技能 SHALL 不出现在该 agent 的可用技能列表中

#### Scenario: 关闭只影响该 agent
- **WHEN** agent A 关闭了一个共享技能而 agent B 未关闭
- **THEN** B SHALL 仍能使用该技能

#### Scenario: 技能与工具白名单独立
- **WHEN** agent 的工具白名单关闭了某组工具
- **THEN** 这 MUST NOT 影响它的技能是否可被列出与读取