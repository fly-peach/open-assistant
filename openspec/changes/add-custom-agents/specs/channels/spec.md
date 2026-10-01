## Purpose

定义频道（channel）：把外部消息平台接进来的**业务管道**。一个频道实例归属于某个工作区（因而归属于该工作区绑定的 agent），负责把平台消息收敛成一轮对话、把回复投递回去，并自带访问控制与凭据管理。

## ADDED Requirements

### Requirement: 频道实例归属 agent 定义
系统 SHALL 把频道实例归属于**某个 agent 定义**（而不是某个工作区），使一个 agent 的接入方式跟着它自己走。

#### Scenario: 配置随 agent 定义存放
- **WHEN** 用户为某个 agent 添加一个频道
- **THEN** 该频道的非敏感配置 SHALL 保存在该 agent 的定义目录内，人可直接编辑

#### Scenario: 换工作区不带走近频道
- **WHEN** 用户把一个 agent 从工作区 A 换绑到工作区 B
- **THEN** 该 agent 的频道配置 SHALL 保持不变（它属于 agent，不属于工作区）

#### Scenario: 处理消息的是频道所属的 agent
- **WHEN** 某个频道收到消息
- **THEN** 处理它的 SHALL 是该频道所属的 agent，MUST NOT 由工作区当前的临时绑定决定

#### Scenario: 所属 agent 未被任何工作区绑定时不得启用
- **WHEN** 某个 agent 没有被任何工作区绑定，而用户尝试启用它的频道
- **THEN** 系统 SHALL 拒绝并说明原因（消息没有可落地的会话归属），MUST NOT 让消息进入一个不存在的工作区

#### Scenario: 配置损坏时不静默清空
- **WHEN** 频道配置文件内容不是合法结构
- **THEN** 系统 SHALL 报错并拒绝写入，MUST NOT 以空配置覆盖

### Requirement: 消息落到该 agent 唯一绑定的工作区
系统 SHALL 把频道消息投递到该频道所属 agent **唯一绑定的那个工作区**；因为 agent 与工作区是 1:1 的，这个落点永远是唯一的，不需要也不允许再配置一个「目标工作区」。

#### Scenario: 落到唯一绑定的工作区
- **WHEN** 某个频道收到消息，且其所属 agent 绑定了工作区 W
- **THEN** 该消息 SHALL 作为 W 的一轮对话处理，待办与记忆也落在 W

#### Scenario: 未绑定则不得启用
- **WHEN** 频道所属的 agent 没有被任何工作区绑定
- **THEN** 系统 SHALL 拒绝启用该频道并说明原因（消息没有可落地的会话归属）

#### Scenario: 不存在「选哪个工作区」的问题
- **WHEN** 用户配置一个频道
- **THEN** 界面 MUST NOT 要求或提供「投递目标工作区」选项（唯一性由绑定保证）

#### Scenario: 换绑后落点随之变化
- **WHEN** 该 agent 被换绑到另一个工作区
- **THEN** 后续消息 SHALL 落到新的工作区，界面 SHALL 展示当前落点是哪一个

#### Scenario: 换绑时给出提示
- **WHEN** 一个带启用中频道的 agent 被换绑
- **THEN** 系统 SHALL 在生效前提示「该 agent 的频道消息将改为落到新工作区」

### Requirement: 频道目录与可扩展性
系统 SHALL 维护一份已知频道的目录，使界面能展示每个频道的名称与图标，并允许出现目录之外的频道。

#### Scenario: 首发支持 QQ 与飞书
- **WHEN** 用户查看可添加的频道
- **THEN** 列表中 SHALL 至少包含 QQ 与飞书两个频道

#### Scenario: 目录之外的频道不被拒绝
- **WHEN** 收到一个目录里没有登记的频道键
- **THEN** 系统 SHALL 仍能加载它，并按键名生成可读名称，MUST NOT 整体报错

#### Scenario: 能区分内置与自定义
- **WHEN** 界面展示一个频道
- **THEN** 它 SHALL 能标明该频道是内置的还是自定义的

### Requirement: 频道配置字段
系统 SHALL 为每个频道定义其配置字段，其中一部分是所有频道共用的，另一部分是频道特有的。

#### Scenario: 公共字段
- **WHEN** 配置任意频道
- **THEN** 它 SHALL 都支持这些公共项：是否启用、回复前缀、是否展示工具调用、是否展示工具结果、是否展示思考过程、工具调用与结果的最大长度

#### Scenario: 群聊与私聊策略
- **WHEN** 配置任意频道
- **THEN** 它 SHALL 支持分别设置私聊与群聊的访问策略，以及群里是否需要先提及助手才响应

#### Scenario: QQ 特有字段
- **WHEN** 配置 QQ 频道
- **THEN** 它 SHALL 至少包含应用标识、客户端密钥、收到消息时的确认话术

#### Scenario: 飞书特有字段
- **WHEN** 配置飞书频道
- **THEN** 它 SHALL 至少包含应用标识、应用密钥、事件校验相关凭据、媒体存放目录，并 SHALL 支持在飞书与 Lark 两个域名之间切换

#### Scenario: 无效取值被拒且指出字段
- **WHEN** 配置里出现超出允许范围的取值
- **THEN** 系统 SHALL 拒绝保存并指出具体字段，MUST NOT 静默回退到默认值掩盖错误

### Requirement: 凭据与工作区、与 agent 定义都分离
系统 SHALL 把频道凭据存放在工作区与 agent 定义目录**之外**，并在任何对外输出中掩码。

#### Scenario: 凭据既不落工作区也不落 agent 定义
- **WHEN** 用户填写频道的密钥类字段
- **THEN** 这些凭据 MUST NOT 被写入工作区目录内，也 MUST NOT 被写入 agent 定义目录内的任何文件（后者会被连同 agent 一起复制分享）

#### Scenario: 读取时掩码
- **WHEN** 界面或接口读取频道配置
- **THEN** 凭据类字段 SHALL 只返回掩码或"已设置"的标记，MUST NOT 返回明文

#### Scenario: 分享工作区不泄露凭据
- **WHEN** 用户复制或分享整个工作区
- **THEN** 被复制的数据中 MUST NOT 包含任何频道凭据

#### Scenario: 未填凭据时能判断
- **WHEN** 某个频道的必填凭据缺失
- **THEN** 系统 SHALL 能明确判断并阻止启用该频道，给出可读原因

### Requirement: 启用状态与健康可见
系统 SHALL 让每个频道的启用状态与运行健康对用户可见。

#### Scenario: 展示启用状态
- **WHEN** 用户查看频道列表
- **THEN** 每个频道 SHALL 明确展示已启用还是未启用

#### Scenario: 连接状态可见
- **WHEN** 一个频道已启用
- **THEN** 系统 SHALL 能展示它与平台的连接状态（已连接 / 重连中 / 失败）以及最近一次活动时间

#### Scenario: 失败不静默
- **WHEN** 频道因凭据错误、网络问题或平台拒绝而无法工作
- **THEN** 失败原因 SHALL 对用户可见，MUST NOT 只在日志里留一行

#### Scenario: 停用即断开
- **WHEN** 用户停用一个频道
- **THEN** 系统 SHALL 断开与该平台的连接并停止接收消息，MUST NOT 继续占用资源

### Requirement: 用长连接接收消息
系统 SHALL 通过与平台建立的**出站长连接**接收消息，使本地部署无需公网入口。

#### Scenario: 主动外连
- **WHEN** 启用 QQ 或飞书频道
- **THEN** 系统 SHALL 向平台发起出站连接并在其上接收事件，MUST NOT 要求用户暴露公网地址或端口

#### Scenario: 断线自动重连
- **WHEN** 长连接断开
- **THEN** 系统 SHALL 按退避策略重连，并在界面上反映重连状态

#### Scenario: 连接静默被识别
- **WHEN** 长连接长时间收不到任何数据
- **THEN** 系统 SHALL 认定连接异常并主动重建，MUST NOT 一直等到用户发现消息不进来

#### Scenario: 心跳维持
- **WHEN** 连接建立后
- **THEN** 系统 SHALL 按平台要求维持心跳，并在心跳失败时按可恢复错误处理

#### Scenario: 重复事件被去掉
- **WHEN** 平台重放了已经处理过的事件
- **THEN** 系统 SHALL 依据平台事件标识去重，使同一事件 MUST NOT 产生两轮对话

### Requirement: 入站消息收敛为对话
系统 SHALL 把平台消息收敛成该工作区的一轮对话，并按会话串行化。

#### Scenario: 消息变成一轮对话
- **WHEN** 频道收到一条来自用户的消息
- **THEN** 系统 SHALL 在该工作区内把它作为一轮对话交给绑定的 agent，并把结果投递回原会话

#### Scenario: 会话键稳定
- **WHEN** 同一会话里连续来多条消息
- **THEN** 它们 SHALL 归入同一个会话标识，且该标识 SHALL 与该工作区的会话记录一致

#### Scenario: 同会话串行
- **WHEN** 同一会话在上一轮还没结束时又来一条消息
- **THEN** 系统 SHALL 保证同一会话内串行处理，MUST NOT 让两轮并发写同一份会话状态

#### Scenario: 不同会话并行
- **WHEN** 两个不同会话同时来消息
- **THEN** 它们 SHALL 能并行处理，互不阻塞

#### Scenario: 附件与纯媒体消息
- **WHEN** 收到只含图片、语音或文件的没有配文的消息
- **THEN** 系统 SHALL 把它视为完整输入直接处理，MUST NOT 无限等待后续文本把它挂起

#### Scenario: 图片先到配文后到
- **WHEN** 同一次发送里图片先到、文本后到
- **THEN** 系统 SHALL 把它们合并成一条输入再交给 agent

#### Scenario: 控制命令旁路
- **WHEN** 用户发的是停止一类的控制命令
- **THEN** 系统 SHALL 让它绕过排队与追踪机制立即生效，使用户能打断正在进行的一轮

### Requirement: 回复投递
系统 SHALL 按配置把回复投递回原会话，并支持不同的投递形态。

#### Scenario: 默认只投递最终结果
- **WHEN** 频道未开启流式
- **THEN** 系统 SHALL 只把最终结果投递回原会话

#### Scenario: 可选流式
- **WHEN** 频道开启了流式且平台支持
- **THEN** 系统 SHALL 在生成过程中逐步更新或追加投递

#### Scenario: 过程可见性可配
- **WHEN** 频道配置关闭了思考或工具调用的展示
- **THEN** 这些内容 MUST NOT 出现在投递出去的文本里

#### Scenario: 超长内容可截断
- **WHEN** 工具调用或工具结果超过配置的长度上限
- **THEN** 系统 SHALL 按上限截断并保留可读的提示，MUST NOT 让整条回复发送失败

#### Scenario: 回复回到原会话
- **WHEN** 一条消息来自群 A 的某人
- **THEN** 回复 SHALL 投递回群 A，MUST NOT 投给其他会话或其他工作区

### Requirement: 访问控制
系统 SHALL 对入站消息做来源访问控制，并把未获准的来源交给用户裁决而不是静默丢弃。

#### Scenario: 私聊与群聊分别开关
- **WHEN** 用户只开启群聊准入而关闭私聊准入
- **THEN** 私聊消息 SHALL 按未获准处理，群聊消息 SHALL 正常处理

#### Scenario: 白名单
- **WHEN** 某来源在允许名单内
- **THEN** 它的消息 SHALL 被处理

#### Scenario: 陌生人被挂起而非拒绝
- **WHEN** 收到来自未在名单内的来源的消息
- **THEN** 系统 SHALL 把它记为待处理并回一条可读提示，MUST NOT 静默丢弃也 MUST NOT 直接执行

#### Scenario: 待审批可裁决
- **WHEN** 用户批准一个待处理来源
- **THEN** 它 SHALL 加入允许名单并被清除出待处理列表；拒绝则 SHALL 进入拒绝名单

#### Scenario: 名单变更互斥
- **WHEN** 一个来源被加入允许名单
- **THEN** 它 SHALL 同时从拒绝名单与待处理列表中移除，MUST NOT 同时出现在两处

#### Scenario: 准入以真实发送者为准
- **WHEN** 会话是共享会话（例如群内共享一个会话）
- **THEN** 准入判断 SHALL 依据真实发送者，MUST NOT 依据被共享的会话标识

#### Scenario: 名单可持久化
- **WHEN** 用户修改了名单
- **THEN** 该修改 SHALL 落在该频道所属 agent 的定义目录内（与频道配置同处）并重启后仍生效

### Requirement: 扫码换取凭据
系统 SHALL 支持对需要扫码授权的频道，通过扫码换取凭据并写回频道配置。

#### Scenario: 发起扫码
- **WHEN** 用户对支持扫码的频道点击扫码授权
- **THEN** 系统 SHALL 向平台申请一个二维码并展示给用户，同时开始轮询授权结果

#### Scenario: 授权成功后落盘
- **WHEN** 用户扫码并完成授权
- **THEN** 取得的凭据 SHALL 被写入凭据存储（不落工作区），界面 SHALL 提示成功

#### Scenario: 授权超时可重新发起
- **WHEN** 二维码过期或轮询超时
- **THEN** 系统 SHALL 给出可读提示并允许重新发起，MUST NOT 卡在加载状态

#### Scenario: 授权失败可读
- **WHEN** 平台拒绝授权或返回错误
- **THEN** 失败原因 SHALL 对用户可见

#### Scenario: 轮询不泄露凭据
- **WHEN** 前端轮询授权状态
- **THEN** 轮询响应 MUST NOT 携带任何凭据明文

### Requirement: 连通性自检
系统 SHALL 提供在保存前验证频道配置可用性的手段。

#### Scenario: 测试连接
- **WHEN** 用户点击测试连接
- **THEN** 系统 SHALL 用当前填写的凭据向平台发起一次校验，并返回成功或可读的失败原因

#### Scenario: 未保存也能测试
- **WHEN** 用户还没保存就点击测试
- **THEN** 系统 SHALL 用界面上的当前值测试，MUST NOT 强制先保存

#### Scenario: 测试不改变启用状态
- **WHEN** 测试连接完成
- **THEN** 频道的启用状态 MUST NOT 因测试结果被自动改变

### Requirement: 频道与对话记录的关联
系统 SHALL 让来自频道的对话在会话记录里可辨认来源。

#### Scenario: 标明来源
- **WHEN** 用户查看某条由频道产生的会话
- **THEN** 它 SHALL 标明来自哪个频道

#### Scenario: 可在界面里回看
- **WHEN** 频道往来了一段对话
- **THEN** 该对话 SHALL 出现在所属工作区的会话记录里，用户可直接回看

#### Scenario: 与网页端共用同一份记忆与待办
- **WHEN** 用户在频道里提到一件待办
- **THEN** 它 SHALL 落在该工作区的待办里，与网页端看到的是同一份