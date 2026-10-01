# file-workspace-ui Specification

## Purpose
定义工作区在界面上的呈现：右侧侧边栏展示当前工作区的文件树与文件内容，文件按其真实类型渲染，TODO 文件使用专用视图，其余文件按本来面目呈现。

## Requirements

### Requirement: 工作区面板
系统 SHALL 将当前工作区的文件浏览与查看作为一个**可停靠侧边面板**提供（停靠能力本身见 `app-shell`），使用户既能与对话并排看，也能拖出来单独摆。

#### Scenario: 默认停靠在内容区一侧
- **WHEN** 用户打开工作区面板
- **THEN** 它 SHALL 默认停靠在内容区一侧并与对话区并排，MUST NOT 覆盖对话内容

#### Scenario: 可拖出为浮动面板
- **WHEN** 用户把工作区面板拖出边侧
- **THEN** 它 SHALL 成为浮动面板，对话区 SHALL 收回被让出的宽度

#### Scenario: 换形态不丢状态
- **WHEN** 工作区面板在停靠与浮动之间切换
- **THEN** 已展开的目录、当前预览的文件与滚动位置 SHALL 保持

#### Scenario: 面板可收起
- **WHEN** 用户收起工作区面板
- **THEN** 它 SHALL 让出空间给对话区，且被让出的宽度 SHALL 在重新打开后恢复

#### Scenario: 未选择工作区时的空状态
- **WHEN** 尚未选择任何工作区
- **THEN** 面板 SHALL 展示引导性空状态（含「选择本机目录」入口），MUST NOT 展示其他工作区的文件

#### Scenario: 通过本机目录选择器指定工作区
- **WHEN** 用户点击选择工作区
- **THEN** 系统 SHALL 打开本机目录选择器（可逐层浏览或直接输入绝对路径），并在确定后把该目录作为当前工作区

#### Scenario: 展示当前工作区的完整路径
- **WHEN** 面板处于展开状态且已选定工作区
- **THEN** 面板 SHALL 展示该工作区的完整绝对路径，使用户清楚 agent 的工作范围

#### Scenario: 路径过长不撑破布局
- **WHEN** 工作区路径比面板宽度还长
- **THEN** 路径 SHALL 以中间省略的方式展示，并可通过悬停看到完整路径，MUST NOT 撑破或溢出面板

### Requirement: 文件树
系统 SHALL 以目录树的形式展示当前工作区内的文件，并允许逐层展开目录。

#### Scenario: 目录可展开
- **WHEN** 用户点击文件树中的一个目录
- **THEN** 该目录的子项 SHALL 被加载并展示

#### Scenario: 目录与文件可区分
- **WHEN** 文件树渲染任意节点
- **THEN** 目录与文件 SHALL 在图标或形态上可区分，且不同类型文件 SHALL 有不同的图标

#### Scenario: 大目录不阻塞
- **WHEN** 工作区中存在包含大量条目的目录
- **THEN** 打开侧边栏 SHALL NOT 因该目录而长时间无响应

#### Scenario: 只展示工作区内的内容
- **WHEN** 文件树展示工作区
- **THEN** 它 MUST NOT 展示工作区目录之外的内容

### Requirement: 按文件类型渲染
系统 SHALL 依据文件的真实类型选择渲染方式，使内容以最贴合其类型的形式呈现。

#### Scenario: 结构化文本可读呈现
- **WHEN** 用户打开一个 JSON 文件
- **THEN** 内容 SHALL 以结构化、可读的形式呈现，MUST NOT 直接堆成未格式化的原始字符串

#### Scenario: Markdown 按富文本呈现
- **WHEN** 用户打开一个 Markdown 文件
- **THEN** 内容 SHALL 以渲染后的富文本形式呈现

#### Scenario: 源代码带语法高亮
- **WHEN** 用户打开一个已知编程语言的源文件
- **THEN** 内容 SHALL 带语法高亮呈现

#### Scenario: 图片按图片呈现
- **WHEN** 用户打开一个图片文件
- **THEN** 内容 SHALL 作为图片呈现，MUST NOT 展示二进制乱码

#### Scenario: 纯文本如实呈现
- **WHEN** 用户打开一个纯文本文件
- **THEN** 内容 SHALL 以等宽文本原样呈现

#### Scenario: 无法渲染的类型不报错
- **WHEN** 用户打开一个系统不支持预览的文件类型
- **THEN** 系统 SHALL 给出可理解的提示，MUST NOT 崩溃或展示乱码

### Requirement: TODO 专用视图
当工作区中的 TODO 文件被打开时，系统 SHALL 使用专用视图呈现，而非按普通文件渲染。

#### Scenario: 打开 TODO 文件进入专用视图
- **WHEN** 用户打开工作区中的 TODO 文件
- **THEN** 系统 SHALL 以专用的待办视图呈现，MUST NOT 只展示原始 JSON

#### Scenario: 按状态分组呈现
- **WHEN** 专用视图渲染 TODO
- **THEN** 条目 SHALL 按状态分组呈现，且各组 SHALL 可看出进度

#### Scenario: 界面内可修改
- **WHEN** 用户在专用视图中修改某条 TODO 的状态、内容或删除该条目
- **THEN** 修改 SHALL 立即反映到 TODO 文件中，并可在文件树侧看到文件更新

#### Scenario: 专用视图与文件内容一致
- **WHEN** agent 通过工具修改了 TODO
- **THEN** 专用视图 SHALL 在无需用户手动刷新页面的情况下反映该修改

#### Scenario: 空状态
- **WHEN** TODO 文件中没有条目
- **THEN** 专用视图 SHALL 展示空状态并提示如何新增，MUST NOT 展示空白区域

### Requirement: 文件内容随改动可见
系统 SHALL 让工作区文件的改动对用户可见。

#### Scenario: agent 改动后可见
- **WHEN** agent 通过工具在工作区内新建或修改文件
- **THEN** 文件树与已打开文件的预览 SHALL 反映该改动，MUST NOT 停留在改动前的旧内容

#### Scenario: 外部编辑器改动后可见
- **WHEN** 用户在工作区目录中用外部编辑器修改了文件
- **THEN** 用户刷新或重新打开该文件时 SHALL 看到最新内容
