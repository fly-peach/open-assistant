## Purpose

定义按工作区（即按 agent 实例）的定时任务与心跳：任务的存放、字段、触发身份与投递方式，使「每天提醒我看待办」这类需求有明确归属。

## ADDED Requirements

### Requirement: 定时任务按工作区存放
系统 SHALL 把定时任务保存在其所属工作区内，使任务随工作区一起迁移。

#### Scenario: 存放位置
- **WHEN** 在某工作区里创建一条定时任务
- **THEN** 任务 SHALL 保存在该工作区内的一个固定路径文件中，人可直接编辑

#### Scenario: 任务随工作区迁移
- **WHEN** 用户把整个工作区目录复制到另一台机器
- **THEN** 其中的定时任务 SHALL 一并保留并可继续触发

#### Scenario: 任务只在所属工作区触发
- **WHEN** 工作区 A 有一条定时任务
- **THEN** 该任务 MUST NOT 在其他工作区中被触发或影响其他工作区

#### Scenario: 文件损坏时不静默清空
- **WHEN** 任务文件内容不是合法结构
- **THEN** 系统 SHALL 报错并拒绝写入，MUST NOT 以空任务列表覆盖

### Requirement: 定时任务的字段
系统 SHALL 为每条任务保存触发规则、任务内容、投递方式与运行约束。

#### Scenario: 支持一次性与周期性
- **WHEN** 用户创建任务
- **THEN** 它 SHALL 能在「只在某个时刻执行一次」与「按周期重复」之间选择

#### Scenario: 周期规则含时区
- **WHEN** 任务按周期重复
- **THEN** 它 SHALL 带时区设置，且触发时刻按该时区解释

#### Scenario: 可限定重复的结束
- **WHEN** 用户为重复任务设置结束条件
- **THEN** 系统 SHALL 支持按截止时间或按执行次数结束

#### Scenario: 投递方式可配
- **WHEN** 任务执行完成
- **THEN** 投递方式 SHALL 可配置为「流式推送过程」或「只推送最终结果」

#### Scenario: 可静默执行
- **WHEN** 用户把任务设为静默
- **THEN** 该任务 SHALL 执行但不向会话投递过程与结果

#### Scenario: 运行约束
- **WHEN** 任务被执行
- **THEN** 其并发上限、超时时长与错过触发的宽限窗口 SHALL 按该任务的配置生效

### Requirement: 任务内容的两类形态
系统 SHALL 允许任务内容为「一段固定文本」或「交给 agent 的请求」，并对其做不同处理。

#### Scenario: 文本任务
- **WHEN** 任务内容是一段固定文本
- **THEN** 系统 SHALL 直接投递该文本，MUST NOT 为此启动 agent

#### Scenario: agent 任务
- **WHEN** 任务内容是交给 agent 的请求
- **THEN** 系统 SHALL 在该工作区绑定的 agent 上执行该请求

#### Scenario: 文本任务不支持静默
- **WHEN** 用户把固定文本任务设为静默
- **THEN** 系统 SHALL 拒绝该组合并给出可理解的说明

### Requirement: 触发身份与投递目标
系统 SHALL 在触发时使用该工作区当前绑定的 agent，并把结果投递到该工作区内的会话。

#### Scenario: 身份来自绑定
- **WHEN** 一条任务被触发
- **THEN** 执行它的 agent SHALL 是工作区当前绑定的 agent，任务本身 MUST NOT 另存一份 agent 配置

#### Scenario: 换绑后按新身份执行
- **WHEN** 工作区换绑了 agent 后任务再次触发
- **THEN** 该任务 SHALL 以新绑定的 agent 身份执行

#### Scenario: 结果可在会话中查看
- **WHEN** agent 任务执行完成
- **THEN** 其结果 SHALL 出现在该工作区的会话记录中，用户可回看

#### Scenario: 每次执行可追溯
- **WHEN** 某任务被多次触发
- **THEN** 系统 SHALL 记录每次执行的时刻、结果状态与失败原因

### Requirement: 错过与失败的处理
系统 SHALL 对错过的触发与执行失败给出明确、可见的处置。

#### Scenario: 错过触发
- **WHEN** 到达触发时刻但系统未在运行
- **THEN** 系统 SHALL 在启动后按宽限窗口决定是否补跑，并记录该决定

#### Scenario: 执行失败可查
- **WHEN** 一次执行失败
- **THEN** 失败原因 SHALL 被记录且对用户可见

#### Scenario: 失败不静默
- **WHEN** 任务连续失败
- **THEN** 系统 SHALL 让用户能察觉，MUST NOT 只在日志里留一行警告

### Requirement: 心跳（heartbeat）
系统 SHALL 支持一种「把某个文件当作请求、按周期交给 agent」的任务形态，作为周期任务的特例。

#### Scenario: 心跳以文件为内容
- **WHEN** 配置了心跳
- **THEN** 系统 SHALL 按配置的周期读取 agent 的心跳文件作为本轮请求交给 agent

#### Scenario: 活跃时段
- **WHEN** 配置了活跃时段
- **THEN** 心跳 SHALL 只在时段内触发，时段外 MUST NOT 执行

#### Scenario: 与普通任务区分
- **WHEN** 用户查看任务列表
- **THEN** 心跳 SHALL 与普通定时任务可区分，且在界面上可单独编辑其内容文件