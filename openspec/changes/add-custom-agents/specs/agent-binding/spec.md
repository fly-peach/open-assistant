## Purpose

定义工作区与 agent 的绑定关系：一个工作区只绑一个 agent，绑定决定该工作区里「用谁的人设、谁的工具、谁的记忆」，换绑是可追溯的显式动作。

## ADDED Requirements

### Requirement: 一个工作区只绑一个 agent
系统 SHALL 保证一个工作区在任一时点**至多绑定一个** agent，并把绑定记录保存在该工作区内。

#### Scenario: 写入绑定
- **WHEN** 用户为一个工作区选择 agent
- **THEN** 系统 SHALL 把该 agent 标识写进工作区内的绑定记录，并立即生效

#### Scenario: 拒绝第二个绑定
- **WHEN** 一个工作区已绑定 agent，用户又选择另一个
- **THEN** 该动作 SHALL 被识别为「换绑」而不是新增绑定，MUST NOT 同时存在两个绑定

#### Scenario: 绑定记录可读
- **WHEN** 用户查看某工作区
- **THEN** 系统 SHALL 展示它绑定的 agent 标识；未绑定时明确展示未绑定状态

#### Scenario: 绑定随工作区走
- **WHEN** 用户把整个工作区目录复制到另一台机器
- **THEN** 该工作区在新机器上 SHALL 仍绑定同一个 agent，无需重新配置

### Requirement: 一个 agent 只绑一个工作区
系统 SHALL 保证一个 agent 在任一时刻**至多被一个工作区**绑定（与 QwenPaw 的「agent ↔ 工作目录 1:1」一致），使「这个 agent 的消息与数据落在哪里」永远唯一。

#### Scenario: 绑定已被占用的 agent 被拒
- **WHEN** agent A 已被工作区 W1 绑定，用户尝试把 W2 绑定到 A
- **THEN** 系统 SHALL 拒绝并指出 A 当前绑在哪个工作区，MUST NOT 允许同一个 agent 同时服务两个工作区

#### Scenario: 拒绝时给出可行的替代做法
- **WHEN** 绑定因上述原因被拒
- **THEN** 提示 SHALL 给出可行路径：复制一份该 agent 的定义用于当前工作区

#### Scenario: 解除绑定后可重新绑定
- **WHEN** 原工作区解除了对该 agent 的绑定，或原工作区已不存在
- **THEN** 该 agent SHALL 能被重新绑定到其他工作区

#### Scenario: 复制定义得到独立实例
- **WHEN** 用户复制 agent A 的定义为新 agent A2
- **THEN** A2 SHALL 成为独立实例：此后对人设与配置的修改互不影响

#### Scenario: 复制定义时不带频道配置
- **WHEN** 复制一个已配置频道的 agent 定义
- **THEN** 副本 MUST NOT 带上原 agent 的频道配置（否则两个 agent 会去连同一个机器人），凭据本身也不在定义目录里因此不会被带走

### Requirement: 未绑定的工作区不得对话
系统 SHALL 拒绝在未绑定 agent 的工作区中开始对话，并引导用户先完成绑定。

#### Scenario: 未绑定则阻止
- **WHEN** 用户在未绑定 agent 的工作区中发送消息
- **THEN** 系统 SHALL 阻止该轮执行并给出可理解的提示，MUST NOT 用任意默认 agent 代跑

#### Scenario: 绑定后即可对话
- **WHEN** 用户完成绑定后再次发送消息
- **THEN** 该轮 SHALL 正常执行，并使用刚绑定的 agent

#### Scenario: 绑定的 agent 不存在
- **WHEN** 工作区绑定的 agent 标识在 agents 根下找不到对应定义
- **THEN** 系统 SHALL 阻止对话并明确指出该标识不存在，MUST NOT 静默改用其他 agent

### Requirement: 换绑是显式且可追溯的动作
系统 SHALL 把更换绑定当作显式动作处理：需要用户确认，并记录换绑历史。

#### Scenario: 换绑需要确认
- **WHEN** 用户为一个已绑定的工作区选择另一个 agent
- **THEN** 系统 SHALL 在生效前给出确认，说明历史会话将归属于此前绑定的 agent

#### Scenario: 换绑被记录
- **WHEN** 换绑生效
- **THEN** 系统 SHALL 在绑定记录里留下可追溯的换绑痕迹（此前绑定的是谁、何时、由谁触发）

#### Scenario: 保留历史（默认）
- **WHEN** 用户以默认方式换绑
- **THEN** 原有会话 SHALL 被保留，并标注其创建时所属的 agent；MUST NOT 静默删除

#### Scenario: 归档历史
- **WHEN** 用户选择归档方式换绑
- **THEN** 原有会话 SHALL 被整体转入该工作区内的归档区，且仍可被查看

#### Scenario: 换绑后新会话归属新 agent
- **WHEN** 换绑后用户开始新会话
- **THEN** 该会话 SHALL 记录为新 agent 创建

### Requirement: 运行身份以绑定为准
系统 SHALL 以工作区的绑定记录作为运行时 agent 身份的唯一依据，MUST NOT 采用客户端直接传来的 agent 标识。

#### Scenario: 忽略客户端传入的身份
- **WHEN** 客户端在运行请求里传入一个与工作区绑定不一致的 agent 标识
- **THEN** 系统 SHALL 以工作区绑定为准执行，MUST NOT 让该请求使用另一个 agent 的工具或记忆

#### Scenario: 绑定是权限边界
- **WHEN** 某 agent 的工具白名单与另一 agent 不同
- **THEN** 工作区的运行 SHALL 只体现其绑定 agent 的白名单