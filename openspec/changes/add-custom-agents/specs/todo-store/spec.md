## MODIFIED Requirements

### Requirement: TODO 以 JSON 文件持久化
系统 SHALL 将 TODO 以单个 JSON 文件保存在工作区内，该文件既是人可读可编辑的，也是系统的唯一事实源；**其范围即该工作区（也就是该工作区绑定的 agent 实例）**，不同工作区的 TODO 相互独立。

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

#### Scenario: 不同工作区互不可见
- **WHEN** agent 在工作区 A 中列出 TODO
- **THEN** 结果 MUST NOT 包含工作区 B 的条目

#### Scenario: 随工作区迁移
- **WHEN** 用户把整个工作区目录复制到另一台机器
- **THEN** 其中的 TODO SHALL 一并保留，且在该机器上可被读取与修改

#### Scenario: 与 agent 长期记忆分离
- **WHEN** 同一 agent 被绑定到另一个工作区
- **THEN** 它在新工作区看到的 TODO SHALL 是新工作区的，MUST NOT 沿用上一个工作区的 TODO