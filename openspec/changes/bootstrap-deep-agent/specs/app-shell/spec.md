## Purpose

定义应用外壳：导航、页面路由、可停靠侧边面板与扩展插槽，使功能可以持续加进来而不用每次重排界面。

## ADDED Requirements

### Requirement: 应用壳层结构
系统 SHALL 提供稳定的应用外壳，由左导航区、顶部栏与内容区组成；导航与顶部栏 MUST NOT 随页面切换而重建。

#### Scenario: 壳层常驻
- **WHEN** 用户在不同页面之间切换
- **THEN** 导航区与顶部栏 SHALL 保持挂载且状态不丢失（如滚动位置、展开状态）

#### Scenario: 内容区只换页面
- **WHEN** 用户进入某个页面
- **THEN** 只有内容区 SHALL 被替换，导航与顶部栏 MUST NOT 被重新挂载

#### Scenario: 顶部栏承载全局操作
- **WHEN** 顶部栏渲染
- **THEN** 它 SHALL 承载跨页面常驻的操作与状态（当前工作区、设置入口等），MUST NOT 依赖具体页面提供

### Requirement: 多页面路由
系统 SHALL 用可分享的地址标识当前页面与页面内状态，使用户可刷新、可回退、可把地址发给别人后看到同一视图。

#### Scenario: 刷新后回到同一视图
- **WHEN** 用户刷新页面
- **THEN** 系统 SHALL 回到刷新前所在的页面与页面内状态（如当前会话、当前工作区）

#### Scenario: 前进后退可用
- **WHEN** 用户在页面之间跳转后点击浏览器的后退
- **THEN** 系统 SHALL 回到上一页面，MUST NOT 出现白屏或状态错乱

#### Scenario: 地址可分享
- **WHEN** 用户把当前地址发给另一个人
- **THEN** 对方打开后 SHALL 落在同一页面与同一页面内状态

### Requirement: 导航条目可配置
系统 SHALL 允许用户调整导航条目的顺序与显隐，同时保证核心条目不可隐藏。

#### Scenario: 调整顺序
- **WHEN** 用户拖动某个导航条目改变顺序
- **THEN** 新的顺序 SHALL 立即在导航区生效，并在重新打开后保持

#### Scenario: 隐藏扩展条目
- **WHEN** 用户隐藏一个扩展提供的导航条目
- **THEN** 该条目 SHALL 从导航区消失，但仍可被恢复

#### Scenario: 核心条目不可隐藏
- **WHEN** 用户尝试隐藏一个核心条目（如对话、设置）
- **THEN** 系统 MUST NOT 允许，该条目 SHALL 始终可见

#### Scenario: 可一键恢复默认
- **WHEN** 用户重置导航配置
- **THEN** 顺序与显隐 SHALL 恢复为默认，MUST NOT 影响其他用户数据

#### Scenario: 调整时即时可见
- **WHEN** 用户在设置中调整导航的顺序或显隐
- **THEN** 系统 SHALL 在设置页内提供导航区的实时预览，使用户在调整过程中就能看到结果，MUST NOT 需要离开设置页去确认

### Requirement: 侧边面板可停靠
系统 SHALL 让侧边面板既能贴附在内容区两侧，也能被拖出成为可自由摆放的浮动面板，且两种形态之间可来回切换。

#### Scenario: 贴附在边侧
- **WHEN** 面板处于贴附状态
- **THEN** 它 SHALL 与内容区并排且占用固定宽度，MUST NOT 覆盖内容区

#### Scenario: 拖出成为浮动面板
- **WHEN** 用户把面板从边侧向外拖动超过一个阈值
- **THEN** 面板 SHALL 脱离边侧成为浮动面板，内容区 SHALL 收回原来让出的宽度

#### Scenario: 拖回可重新贴附
- **WHEN** 用户把浮动的面板拖回边侧并放开
- **THEN** 面板 SHALL 重新贴附到该边侧，内容区 SHALL 相应收缩

#### Scenario: 浮动面板不越出视口
- **WHEN** 用户把浮动面板拖向视口边缘，或缩小了窗口
- **THEN** 面板 SHALL 被约束在视口内并保留可见的边距，MUST NOT 拖出可视范围

#### Scenario: 面板内容不因换形态而重建
- **WHEN** 面板在贴附与浮动之间切换
- **THEN** 面板内部的内容 SHALL 保持挂载与状态（滚动位置、展开项、已加载数据），MUST NOT 被重新加载

#### Scenario: 键盘可达
- **WHEN** 用户使用键盘聚焦到面板的拖动手柄并操作
- **THEN** 用户 SHALL 能不依赖指针完成贴附与浮动的切换

#### Scenario: 尊重动效偏好
- **WHEN** 用户的系统设置为减少动效
- **THEN** 面板的移动 SHALL 直接到位，MUST NOT 播放位移动画

### Requirement: 页面级故障隔离
系统 SHALL 保证单个页面的渲染失败不影响外壳与其他页面。

#### Scenario: 单页崩溃不拖垮外壳
- **WHEN** 某个页面在渲染时抛出错误
- **THEN** 只有该页面 SHALL 被替换为错误提示与重试入口，导航区与顶部栏 SHALL 保持可用

#### Scenario: 重试可恢复
- **WHEN** 用户在错误提示中触发重试
- **THEN** 系统 SHALL 重新尝试渲染该页面，MUST NOT 需要刷新整个应用

#### Scenario: 切换页面可自愈
- **WHEN** 某页面出错后用户切换到另一个页面
- **THEN** 新页面 SHALL 正常渲染

#### Scenario: 加载期间有反馈
- **WHEN** 某个页面的资源仍在加载
- **THEN** 内容区 SHALL 显示加载状态，MUST NOT 显示空白

### Requirement: 扩展插槽
系统 SHALL 在外壳中提供固定的注入位置，使新增功能可以挂载到既有版面上而不必改动外壳。

#### Scenario: 状态栏插槽
- **WHEN** 有扩展向内容区上方的状态栏位置注册内容
- **THEN** 该内容 SHALL 出现在该位置，且不影响没有注册时的布局

#### Scenario: 全局浮层插槽
- **WHEN** 有扩展向全局浮层位置注册内容
- **THEN** 该内容 SHALL 渲染在外壳最上层，可覆盖整个应用

#### Scenario: 无注册时无占位
- **WHEN** 某个插槽没有任何扩展注册内容
- **THEN** 该插槽 MUST NOT 占据可见空间

### Requirement: 沉浸式页面
系统 SHALL 允许特定页面临时隐藏主导航，以获得更大的可用面积。

#### Scenario: 进入沉浸式页面
- **WHEN** 用户进入被标记为沉浸式的页面
- **THEN** 主导航 SHALL 隐藏，顶部栏 SHALL 补上品牌与返回入口

#### Scenario: 离开后恢复
- **WHEN** 用户离开该页面
- **THEN** 主导航 SHALL 恢复显示，MUST NOT 需要手动打开