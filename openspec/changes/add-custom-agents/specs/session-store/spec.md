## MODIFIED Requirements

### Requirement: 会话持久化
系统 SHALL 以**工作区内的会话库**作为会话内容与执行状态的唯一事实源，使其在系统重启、执行引擎被替换或迁移后都不丢失。

#### Scenario: 重启后恢复会话
- **WHEN** 系统重启后用户选择继续此前的会话
- **THEN** 系统 SHALL 从该工作区的会话库载入此前的对话内容并据此继续对话

#### Scenario: 写入即时落盘
- **WHEN** 一个会话轮次完成
- **THEN** 该轮次的内容 SHALL 已写入工作区内的会话库，MUST NOT 仅存在于内存或执行引擎的临时状态中

#### Scenario: 事实源位置明确
- **WHEN** 用户查看某条会话
- **THEN** 系统 SHALL 能指出其内容位于该工作区内的哪个文件

#### Scenario: 执行引擎可被替换
- **WHEN** 底层执行引擎被更换或清空
- **THEN** 各工作区的会话内容 SHALL 仍完整存在并可继续，MUST NOT 依赖执行引擎侧的状态才能读取

#### Scenario: 不再需要独立索引
- **WHEN** 系统列出某工作区的会话
- **THEN** 列表 SHALL 直接来自该会话库，MUST NOT 依赖一份与真实数据可能脱钩的旁路索引

## ADDED Requirements

### Requirement: 会话存储的三层结构
系统 SHALL 以「会话 / 轮次 / 消息」三层结构保存对话，使列表、压缩与检索各有明确的单位。

#### Scenario: 一轮完整落库
- **WHEN** 一轮对话结束
- **THEN** 该轮 SHALL 作为一条轮次记录落库，其用户输入与该轮产生的消息 SHALL 一并保存

#### Scenario: 轮次是压缩单位
- **WHEN** 系统需要压缩历史
- **THEN** 它 SHALL 能以轮次为单位选取需要移出上下文的部分，MUST NOT 只能按单条消息处理

#### Scenario: 会话是列表单位
- **WHEN** 用户查看会话列表
- **THEN** 列表项 SHALL 对应会话，而非轮次或单条消息

#### Scenario: 可按轮次检索
- **WHEN** 用户或 agent 需要回溯某一轮的内容
- **THEN** 系统 SHALL 能按会话与轮次序号定位到该轮及其消息

#### Scenario: 消息顺序稳定
- **WHEN** 读取一条会话的全部消息
- **THEN** 它们的顺序 SHALL 与发生顺序一致，且在多次读取间保持稳定

#### Scenario: 轮次状态可见
- **WHEN** 某轮因取消或错误未正常结束
- **THEN** 该状态 SHALL 被记录并在界面上可辨认

### Requirement: 子会话与对端会话的记录
系统 SHALL 把子 agent 与跨工作区调用的会话作为独立记录保存，并保留与父会话的关联。

#### Scenario: 子会话独立成行
- **WHEN** 一轮中委派了子 agent
- **THEN** 该子 agent 的执行 SHALL 在工作中产生一条独立会话记录，并标明它由哪条会话的哪次调用产生

#### Scenario: 子会话不混入主记录
- **WHEN** 用户查看主会话
- **THEN** 子 agent 的消息 MUST NOT 被混排进主会话的消息序列，而应可单独查看

#### Scenario: 跨工作区调用两侧可追溯
- **WHEN** agent A 调用了另一工作区的 agent B
- **THEN** A 侧记录 SHALL 标明对端 agent 与对端会话标识，B 侧记录 SHALL 标明发起方

#### Scenario: 父会话删除时子记录可控
- **WHEN** 用户删除一条有子会话的会话
- **THEN** 系统 SHALL 明确其子记录的处置方式（一并删除或保留为孤儿），MUST NOT 静默留下不可达的数据

### Requirement: 会话列表包含非活跃会话
系统 SHALL 在会话列表中同时呈现活跃与非活跃会话，并使两者对用户可区分。

#### Scenario: 同时列出两种状态
- **WHEN** 用户查看某工作区的会话列表
- **THEN** 列表中 SHALL 同时包含当前活跃与已释放执行资源的会话

#### Scenario: 按最近活动排序
- **WHEN** 列表渲染
- **THEN** 顺序 SHALL 按最近活动时间排列，MUST NOT 让被释放资源的会话沉底或消失

#### Scenario: 会话标题
- **WHEN** 一条会话尚无标题
- **THEN** 系统 SHALL 以首条用户输入生成一个可辨识的默认标题，并允许用户修改

#### Scenario: 会话标识可见
- **WHEN** 用户查看或分享一条会话
- **THEN** 其完整标识 SHALL 可见且可复制，供刷新与分享使用