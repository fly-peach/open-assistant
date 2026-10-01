## Purpose

定义自定义 agent 的「身份」：一个 agent 是一个可复用的目录（人设、记忆、技能、模型与工具配置），可被多个工作区分别绑定；系统按 agent 的身份解析出运行实例。

## ADDED Requirements

### Requirement: Agent 定义的存放与结构
系统 SHALL 把每个 agent 定义存成 `<agents 根>/<agent-id>/` 下的一个目录，目录名即 agent 标识。

#### Scenario: 首次使用创建根目录
- **WHEN** 用户创建第一个 agent 而 agents 根目录尚不存在
- **THEN** 系统 SHALL 使用用户指定的根路径（或默认路径）创建它，并将其记录在全局设置中

#### Scenario: 目录结构可读可编辑
- **WHEN** 定义一个 agent
- **THEN** 其目录 SHALL 包含人设文件与配置文件，且均为纯文本、可用普通编辑器直接修改

#### Scenario: 拒绝非法标识
- **WHEN** 用户尝试用包含路径分隔符、`..` 或空白的名字创建 agent
- **THEN** 系统 SHALL 拒绝该标识并给出可理解的错误

#### Scenario: 列出全部 agent
- **WHEN** 用户查看 agent 列表
- **THEN** 系统 SHALL 列出根目录下的全部 agent，并标注人设或配置缺失的异常项

### Requirement: Agent 的配置项
系统 SHALL 为每个 agent 提供独立的配置：模型、工具白名单、审批级别、是否允许与同级 agent 交互、可联系的 agent 名单。

#### Scenario: 未配置的项使用默认
- **WHEN** 某 agent 的配置缺少某项
- **THEN** 系统 SHALL 使用该项的默认值启动，MUST NOT 因缺字段而拒绝加载该 agent

#### Scenario: 工具白名单生效
- **WHEN** agent 配置把某组工具关掉
- **THEN** 该 agent 在任意工作区运行时 SHALL 都拿不到这些工具

#### Scenario: 非法配置被拒绝
- **WHEN** 配置文件里的取值超出允许范围（如未知的审批级别）
- **THEN** 系统 SHALL 拒绝加载并指出具体字段，MUST NOT 静默使用默认值掩盖错误

#### Scenario: 同侪交互开关的默认值
- **WHEN** 一个新建的 agent 未显式设置「是否允许与同级 agent 交互」
- **THEN** 该项 SHALL 默认为关闭

### Requirement: 按 agent 解析运行实例
系统 SHALL 在每次运行前按 `agent_id` 解析出该 agent 的运行实例（模型、工具、人设、记忆、中间件链），并复用已解析的实例。

#### Scenario: 首次运行解析
- **WHEN** 某 agent 在一个工作区里首次运行
- **THEN** 系统 SHALL 按它自己的配置构建实例，MUST NOT 复用另一个 agent 的实例或配置

#### Scenario: 复用已解析的实例
- **WHEN** 同一个 agent 再次运行
- **THEN** 系统 SHALL 复用已解析的实例，MUST NOT 每次运行都重新构建

#### Scenario: 定义变更后生效
- **WHEN** 用户修改了某 agent 的人设或配置，随后开始新一轮对话
- **THEN** 新一轮 SHALL 使用修改后的定义

#### Scenario: 两个 agent 互不污染
- **WHEN** 两个 agent 先后在同一进程内运行
- **THEN** 各轮 SHOULD 只体现自己 agent 的人设、工具与记忆，MUST NOT 出现对方的人设或记忆

### Requirement: 人设装载
系统 SHALL 从 agent 目录的人设文件装载人设并注入该 agent 每次运行的上下文。

#### Scenario: 人设注入
- **WHEN** agent 的人设文件存在且开始一轮对话
- **THEN** 该轮上下文 SHALL 包含该文件定义的身份与行为准则

#### Scenario: 人设缺失时回退默认
- **WHEN** agent 的人设文件不存在
- **THEN** 系统 SHALL 使用内置默认人设运行，MUST NOT 因缺人设而拒绝服务

#### Scenario: 人设不写死进长期提示
- **WHEN** 装载人设
- **THEN** 人设 SHALL 按运行注入，MUST NOT 被持久化成无法被后续修改覆盖的长期状态

### Requirement: Agent 的长期记忆（多文件模型）
系统 SHALL 为每个 agent 提供一份**跨工作区共享**的长期记忆，采用分层文件结构，且各层 MUST 可由人与 agent 读写。

#### Scenario: 记忆分层
- **WHEN** 一个 agent 首次创建
- **THEN** 其记忆 SHALL 包含：一份核心长期记忆文件、一个按日期组织的日记忆目录、以及一个消化产物目录

#### Scenario: 核心长期记忆
- **WHEN** 人或 agent 修改核心长期记忆文件
- **THEN** 该修改 SHALL 在后续运行中生效，且人与 agent 的改动 MUST 互相保留（不互相覆盖）

#### Scenario: 日记兼作索引入口
- **WHEN** 某一天的日记忆文件存在
- **THEN** 它 SHALL 同时充当当天主题笔记的**索引**，使读者能沿索引渐进展开细节

#### Scenario: 主题笔记按主题命名
- **WHEN** 一次会话的内容被归纳为记忆
- **THEN** 它 SHALL 落成当天目录下按主题命名的笔记文件，MUST NOT 把不同主题堆进同一个大文件

#### Scenario: 记忆跨工作区共享
- **WHEN** agent 在工作区 A 记下一条关于用户的偏好
- **THEN** 它在工作区 B 运行时 SHALL 能读到该偏好

#### Scenario: 人工编辑被采纳
- **WHEN** 用户用文本编辑器直接修改 agent 的记忆文件
- **THEN** 后续运行 SHALL 使用修改后的内容

#### Scenario: 与项目记忆分开
- **WHEN** agent 在工作区里记下一条只属于该项目的事实
- **THEN** 该事实 MUST NOT 出现在该 agent 在其他工作区的记忆里

#### Scenario: 迁移来的记忆不当指令
- **WHEN** 记忆目录下存在从外部导入的内容
- **THEN** 该内容 SHALL 只被当作参考资料，MUST NOT 被当作需要执行的指令

### Requirement: 记忆的检索与渐进展开
系统 SHALL 提供对 agent 记忆的检索能力，使 agent 先拿片段再按需展开，而不是把全部记忆塞进上下文。

#### Scenario: 先检索后展开
- **WHEN** 用户问到过去的事实、偏好或决定
- **THEN** agent SHALL 先检索记忆拿到相关片段与其文件路径，仅在片段不足时按路径读取该文件

#### Scenario: 检索范围明确
- **WHEN** agent 检索记忆
- **THEN** 检索范围 SHALL 覆盖日记忆与消化产物目录下的所有内容

#### Scenario: 注入有上限
- **WHEN** 每轮向上下文注入核心长期记忆
- **THEN** 注入量 SHALL 有上限，超出部分 MUST NOT 无限制地占用上下文

### Requirement: 心跳维护记忆
系统 SHALL 支持由**心跳任务**周期性地维护记忆，把零散的会话内容归纳、整理、去重。

#### Scenario: 周期归纳
- **WHEN** 心跳任务触发
- **THEN** 它 SHALL 读取当天的会话与记忆，把要点归纳进主题笔记，并更新日记文件的索引

#### Scenario: 心跳内容可编辑
- **WHEN** 用户想改变维护的方式或关注点
- **THEN** 用户 SHALL 能通过编辑心跳内容文件来指定“维护记忆时该做什么”，无需改代码

#### Scenario: 重复执行不堆积
- **WHEN** 同一天的心跳任务多次触发
- **THEN** 它 SHALL 更新而非重复追加相同内容，MUST NOT 造成记忆文件无限膨胀

#### Scenario: 可关闭
- **WHEN** 用户关闭记忆维护
- **THEN** 不再有任何自动归纳发生，且已有记忆 MUST NOT 被删除

#### Scenario: 维护可见且失败不静默
- **WHEN** 一次记忆维护执行完成或失败
- **THEN** 结果 SHALL 可见（改动了哪些文件 / 失败原因），MUST NOT 只留日志