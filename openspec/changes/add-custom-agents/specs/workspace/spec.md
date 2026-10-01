## MODIFIED Requirements

### Requirement: 工作区初始化是显式动作
系统 SHALL 通过用户显式触发的「初始化」动作向工作区写入初始文件，MUST NOT 隐式写入；**初始化不再写入人设与首次引导物料**（二者随 agent 定义存放，见 `agent-registry`）。

#### Scenario: 展示初始化入口
- **WHEN** 用户选定的工作区尚未初始化
- **THEN** 界面 SHALL 展示初始化入口，并说明将会写入哪些文件

#### Scenario: 点击初始化写入初始文件
- **WHEN** 用户触发初始化
- **THEN** 系统 SHALL 向工作区写入工作区级物料（项目描述文件与应用数据目录），并告知用户写入了什么；MUST NOT 在此写入人设或首次引导文件

#### Scenario: 初始化幂等且不覆盖
- **WHEN** 工作区中已存在同名文件
- **THEN** 初始化 MUST NOT 覆盖它，只补齐缺失的文件

#### Scenario: 可在非空目录上初始化
- **WHEN** 用户对一个包含自身文件的目录触发初始化
- **THEN** 系统 SHALL 只新增缺失的初始文件，MUST NOT 删除或移动用户已有的文件

#### Scenario: 已初始化时不再提示
- **WHEN** 工作区级物料已就位
- **THEN** 界面 MUST NOT 再展示初始化入口

#### Scenario: 初始化失败可理解
- **WHEN** 初始化因权限或磁盘错误失败
- **THEN** 系统 SHALL 报告可理解的错误，并保持工作区可用（MUST NOT 使工作区变为不可用状态）

#### Scenario: 未初始化不阻断对话
- **WHEN** 用户在一个尚未初始化的可选工作区中发起对话
- **THEN** 系统 SHALL 允许对话（是否可用由工作区绑定状态决定），MUST NOT 仅因未初始化而拒绝

#### Scenario: 引导完成后不得重启引导
- **WHEN** agent 侧完成了首次引导并删除了引导文件
- **THEN** 系统 MUST NOT 因此重新展示工作区初始化入口 —— 工作区初始化与 agent 首次引导**已解耦**，两者互不触发

#### Scenario: 拒绝不可用的路径
- **WHEN** 用户选择的路径不是目录、不存在且无法创建、或不可读写
- **THEN** 系统 SHALL 拒绝该选择并给出可理解的错误

#### Scenario: 拒绝文件系统根目录
- **WHEN** 用户选择某个文件系统根（如 `C:\` 或 `/`）
- **THEN** 系统 SHALL 拒绝，以避免 agent 获得整个磁盘的访问范围

#### Scenario: 同一目录对应同一工作区
- **WHEN** 用户多次选择同一个目录（含大小写或末尾斜杠不同的写法）
- **THEN** 系统 SHALL 将其识别为同一工作区，MUST NOT 为同一目录生成不同的工作区身份

## REMOVED Requirements

### Requirement: 人设文件保护
**Reason**: 人设文件不再位于工作区，而是随 agent 定义存放在 agents 根下（见 `agent-registry` 与 `agent-binding`）。工作区侧的「保护人设文件」因此失去对象。

**Migration**:
- 人设从 `<工作区>/AGENTS.md` 迁移到 `<agents 根>/<agent-id>/AGENTS.md`；迁移期间工作区内的同名文件改名保留，不删除
- 对 agent 目录内人设文件的写入限制，改由 `agent-registry` 承担（常规工具不得覆盖人设，仅首次设定身份时经专用通道写入）
- 工作区侧的路径约束（`文件操作路径约束`）继续生效，不受本项移除影响