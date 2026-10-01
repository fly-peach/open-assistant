## Purpose

定义多个 agent 之间的三类交互（同轮委派、跨工作区调用、同侪互通）及其记录、隔离与安全边界，使「多 agent 协作」在不污染彼此上下文的前提下可追溯。

## ADDED Requirements

### Requirement: 同轮委派
系统 SHALL 允许主 agent 在**同一轮**内委派一个或多个子 agent 执行子任务，并把结果回流给主 agent。

#### Scenario: 委派并回收结果
- **WHEN** 主 agent 委派一个子任务
- **THEN** 子 agent 的执行 SHALL 在当前轮内完成，其结果 SHALL 回到主 agent 的上下文

#### Scenario: 子 agent 的上下文隔离
- **WHEN** 主 agent 委派子任务
- **THEN** 子 agent SHALL 只看到交给它的任务描述，MUST NOT 看到主 agent 的完整对话历史

#### Scenario: 并发与上限
- **WHEN** 主 agent 在一轮内委派多个子任务
- **THEN** 系统 SHALL 按配置的并发上限并行执行，超出上限的任务 SHALL 排队而非失败

#### Scenario: 单个子任务失败不拖垮整轮
- **WHEN** 某个子 agent 执行失败
- **THEN** 该失败 SHALL 作为可见结果回到主 agent，其余子任务 SHALL 继续完成

### Requirement: 跨工作区调用
系统 SHALL 允许一个 agent 调用**另一个已绑定工作区的 agent**，且对端在其自己的工作区与上下文中执行。

#### Scenario: 对端在自己的工作区执行
- **WHEN** agent A 调用 agent B
- **THEN** B 的执行 SHALL 发生在 B 所绑定的工作区，使用 B 的人设、工具与记忆

#### Scenario: 对端产生自己的会话记录
- **WHEN** A 调用 B
- **THEN** B 的工作区 SHALL 新增一条可查看的会话记录，MUST NOT 只把内容留在 A 这一侧

#### Scenario: 两侧可互相追溯
- **WHEN** A 调用 B 完成
- **THEN** A 侧的记录 SHALL 标明对端 agent 与会话标识，B 侧的记录 SHALL 标明发起方

#### Scenario: 调用方范围受限
- **WHEN** agent 配置里未把某对端列入可联系名单
- **THEN** 它 MUST NOT 能调用该对端

#### Scenario: 对端不可用时的处理
- **WHEN** 被调用的 agent 没有绑定的工作区或不可用
- **THEN** 调用 SHALL 返回可理解的失败原因，MUST NOT 挂起整轮

### Requirement: 同侪互通开关
系统 SHALL 允许通过 agent 配置控制「是否可与同级 agent 交互」，默认关闭。

#### Scenario: 关闭时不具备该能力
- **WHEN** agent 配置关闭同侪互通
- **THEN** 它的子 agent MUST NOT 拿到与其他 agent 通信的工具

#### Scenario: 开启时具备该能力
- **WHEN** agent 配置开启同侪互通
- **THEN** 它的子 agent SHALL 能与其他同级子 agent 交换信息

#### Scenario: 开关只影响自己
- **WHEN** agent A 开启同侪互通而 agent B 未开启
- **THEN** B 的行为 MUST NOT 因 A 的设置而改变

### Requirement: 结构性防递归
系统 SHALL 保证子 agent 默认不具备再委派或再调用的能力。

#### Scenario: 子 agent 不继承委派工具
- **WHEN** 主 agent 委派出一个子 agent
- **THEN** 该子 agent 的工具集合 SHALL 不包含委派与跨 agent 调用工具

#### Scenario: 递归不可被 prompt 绕过
- **WHEN** 子 agent 被要求继续委派
- **THEN** 它 SHALL 因为不具备该工具而无法执行，MUST NOT 依赖提示词自律来阻止

### Requirement: 审批回流根会话
系统 SHALL 把子 agent 与跨 agent 调用中产生的审批请求路由回发起方的根会话。

#### Scenario: 子 agent 的审批回流
- **WHEN** 子 agent 需要用户审批某个危险操作
- **THEN** 审批请求 SHALL 出现在发起方的根会话中，MUST NOT 悬空在子会话里无人应答

#### Scenario: 根会话可追溯
- **WHEN** 一条子会话产生审批
- **THEN** 它 SHALL 携带指向根会话的标识，使用户能定位到上下文

### Requirement: 交互过程的可见性
系统 SHALL 让用户看到多 agent 交互的过程与结果，而不必阅读交错的原始事件流。

#### Scenario: 子会话单独呈现
- **WHEN** 一轮对话中发生了委派
- **THEN** 子 agent 的工作 SHALL 以独立单元呈现（可展开/收起），MUST NOT 与主对话的消息混排

#### Scenario: 进度可判断
- **WHEN** 一轮中有多个子 agent 在运行
- **THEN** 用户 SHALL 能判断已完成与进行中的数量

#### Scenario: 失败可见
- **WHEN** 某个子 agent 失败
- **THEN** 用户 SHALL 无需展开即可看出该轮包含失败

#### Scenario: 跨 agent 调用可跳转
- **WHEN** 一轮中发生了跨工作区调用
- **THEN** 用户 SHALL 能从记录跳转到对端工作区的对应会话