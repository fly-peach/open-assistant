## ADDED Requirements

### Requirement: 运行拓扑的呈现

系统 SHALL 把一轮对话中的编排结构渲染成节点与边的图，使用户能直接看出「谁把什么派给了谁」。

- 节点 SHALL 包含一个主 agent 节点，以及本轮中出现过的每个子 agent 节点
- 边 SHALL 连接「发起委派的一方」与「被委派的子 agent」
- 边 SHALL 可追溯到发起它的那次工具调用

#### Scenario: 一轮内发生多次委派
- **WHEN** 一轮对话中主 agent 委派了 3 个子任务
- **THEN** 画布 SHALL 显示 1 个主 agent 节点、3 个子 agent 节点与 3 条边

#### Scenario: 并行委派并排呈现
- **WHEN** 主 agent 在同一条消息里同时委派了多个子任务
- **THEN** 这些子 agent 节点 SHALL 在画布上并排呈现，而非串成一条链

#### Scenario: 同一子 agent 被委派多次
- **WHEN** 同一个子 agent 在一轮内被委派了多次
- **THEN** 系统 SHALL 保留每次委派的区分（例如多条边或带次数的节点），MUST NOT 把它们静默合并成一次

#### Scenario: 没有委派时只显示主 agent
- **WHEN** 一轮对话中没有任何委派
- **THEN** 画布 SHALL 只显示主 agent 一个节点，MUST NOT 显示上一个会话的残留内容，也 MUST NOT 报错

#### Scenario: 无团队配置时的空态
- **WHEN** 当前 agent 没有声明任何子 agent
- **THEN** 画布 SHALL 给出可读的空态说明，MUST NOT 渲染出一张空白的、看不出所以然的图

### Requirement: 执行状态可见

系统 SHALL 在画布上呈现每个子 agent 的执行状态，使用户不必展开细节即可判断进展。

#### Scenario: 状态随时间变化
- **WHEN** 某个子 agent 正在执行、随后成功结束
- **THEN** 该节点的状态 SHALL 依次呈现为「进行中」与「成功」

#### Scenario: 部分失败可见
- **WHEN** 一轮中 3 个子 agent 有 1 个失败
- **THEN** 画布 SHALL 无需展开即可看出该轮包含一次失败，且其余节点 SHALL 仍显示为成功

#### Scenario: 主 agent 自身的状态
- **WHEN** 主 agent 仍在等待子 agent 结果
- **THEN** 主 agent 节点 SHALL 呈现为「进行中」，而非已完成

### Requirement: 与子会话互跳

系统 SHALL 让用户从画布的节点与边跳转到对应的会话内容。

#### Scenario: 从节点展开子会话
- **WHEN** 用户点击某个子 agent 节点
- **THEN** 系统 SHALL 展示该子 agent 本轮的工作内容（可展开 / 收起）

#### Scenario: 从边定位工具调用
- **WHEN** 用户点击某条边
- **THEN** 对话流 SHALL 定位到发起该次委派的工具调用

#### Scenario: 子会话不混入主对话
- **WHEN** 子 agent 的工作被展示
- **THEN** 它 SHALL 以独立单元呈现，MUST NOT 与主对话的消息混排

### Requirement: 画布是只读的

画布 SHALL 只用于观测，MUST NOT 提供任何改变执行结构的入口。

#### Scenario: 没有编辑入口
- **WHEN** 用户与画布交互
- **THEN** 界面上 MUST NOT 存在新建节点、删除节点、拖动连线或改变执行顺序的入口

#### Scenario: 拖拽不产生副作用
- **WHEN** 用户在画布上拖动节点或画布本身
- **THEN** 这只 SHALL 影响视图呈现，MUST NOT 修改任何持久化的配置或团队定义

#### Scenario: 修改团队必须走团队管理界面
- **WHEN** 用户想改变团队构成
- **THEN** 他 SHALL 通过团队管理界面（或直接编辑 `SPEC.md`）完成，画布 MUST NOT 提供该能力的捷径

### Requirement: 历史会话可复现拓扑

系统 SHALL 让用户在一轮对话结束后重新查看它，仍然能看到当时的编排结构。

#### Scenario: 重新打开历史会话
- **WHEN** 用户重新打开一个已经结束的会话
- **THEN** 画布 SHALL 还原该轮当时的节点、边与最终状态

#### Scenario: 刷新页面后仍然可见
- **WHEN** 用户在某一轮进行中刷新页面
- **THEN** 画布 SHALL 在重新加载后重建出该轮已发生的拓扑

#### Scenario: 团队后来发生了变化
- **WHEN** 用户查看一个历史会话，而当前团队配置与当时不同
- **THEN** 画布 SHALL 呈现**当时**的编排结构，MUST NOT 用当前团队覆盖历史呈现

#### Scenario: 拓扑记录缺失时不臆造
- **WHEN** 某个历史会话没有可用的拓扑记录
- **THEN** 系统 SHALL 明确说明该轮没有可复现的编排信息，MUST NOT 根据当前团队推测出一张图
