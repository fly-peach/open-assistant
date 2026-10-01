## Purpose

定义 TODO 的持久化契约：TODO 以单个 JSON 文件为唯一事实源，人和 agent 都能读写，agent 通过专门的工具操作它，且写入必须并发安全。

## ADDED Requirements

### Requirement: TODO 以 JSON 文件持久化
系统 SHALL 将 TODO 以单个 JSON 文件保存在工作区内，该文件既是人可读可编辑的，也是系统的唯一事实源。

#### Scenario: 文件位置固定
- **WHEN** 系统初始化一个工作区的 TODO
- **THEN** TODO SHALL 保存在该工作区内一个固定路径的 JSON 文件中

#### Scenario: 人工编辑被采纳
- **WHEN** 用户用文本编辑器直接修改该 JSON 文件
- **THEN** 系统与 agent 在后续读取时 SHALL 使用修改后的内容

#### Scenario: 文件不存在时视为空
- **WHEN** 工作区内不存在 TODO 文件
- **THEN** 系统 SHALL 将其视为「无 TODO」而非错误

#### Scenario: 文件损坏时不静默清空
- **WHEN** TODO 文件内容不是合法 JSON
- **THEN** 系统 SHALL 报告错误并拒绝写入，MUST NOT 以空列表覆盖该文件

### Requirement: TODO 条目的字段
系统 SHALL 为每条 TODO 保存足够的结构化信息，使其可被排序、筛选与追溯来源。

#### Scenario: 条目标识唯一且稳定
- **WHEN** 一条 TODO 被创建
- **THEN** 它 SHALL 获得一个在该文件内唯一且此后不变的标识

#### Scenario: 条目包含状态
- **WHEN** 一条 TODO 被创建
- **THEN** 它 SHALL 带有状态字段，取值限于「待办 / 进行中 / 已完成」

#### Scenario: 条目记录创建与更新时间
- **WHEN** 一条 TODO 被创建或被修改
- **THEN** 其创建时间与更新时间 SHALL 被记录

#### Scenario: 条目记录来源
- **WHEN** 一条 TODO 被创建
- **THEN** 它 SHALL 记录来源（用户直接提出 / agent 自行添加），以便区分人与机器写入

### Requirement: agent 可读写 TODO
系统 SHALL 向 agent 提供操作 TODO 的工具，且每个工具 MUST 只通过修改 JSON 文件生效。

#### Scenario: 列出 TODO
- **WHEN** agent 需要了解当前待办
- **THEN** 它 SHALL 能通过工具读取全部 TODO 及其状态

#### Scenario: 新建 TODO
- **WHEN** agent 添加一条 TODO
- **THEN** 该条目 SHALL 出现在 JSON 文件中，且带有完整字段

#### Scenario: 更新 TODO
- **WHEN** agent 修改某条 TODO 的状态或内容
- **THEN** 该条目的对应字段 SHALL 被更新，其他条目 MUST NOT 受影响

#### Scenario: 删除 TODO
- **WHEN** agent 删除一条 TODO
- **THEN** 该条目 SHALL 从文件中移除，其他条目 MUST NOT 受影响

#### Scenario: 操作不存在的条目必须报错
- **WHEN** agent 试图更新或删除一个不存在的 TODO 标识
- **THEN** 工具 SHALL 返回明确的错误，MUST NOT 静默成功

### Requirement: 并发写入不互相覆盖
系统 MUST NOT 因并发写入而导致 TODO 丢失。

#### Scenario: 人与 agent 同时修改
- **WHEN** 用户在界面或编辑器中修改 TODO 的同时 agent 也在写入
- **THEN** 系统 SHALL 检测到冲突并保留双方可追溯的结果，MUST NOT 直接覆盖对方写入

#### Scenario: 写入为原子替换
- **WHEN** 任意一方写入 TODO 文件
- **THEN** 写入 SHALL 以原子方式完成，MUST NOT 让读者看到写了一半的文件