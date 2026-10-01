## Purpose

定义项目记忆的形态：工作区内一个由 agent 增量维护、人可浏览的 markdown wiki，外加一张从 wiki 里长出来的知识图谱。**编译一次并持续保持最新**，而不是每次提问都从源文件重新推导。

## ADDED Requirements

### Requirement: 两层结构（源与 wiki）
系统 SHALL 以两层组织项目记忆：**工作区里用户自己的文件就是源层**，wiki 是由 agent 从源层编译出来的产物层。系统 MUST NOT 再额外创建一个「原始资料」子目录。

#### Scenario: 源层就是工作区文件
- **WHEN** 用户把一份资料放进工作区目录
- **THEN** 它 SHALL 直接成为可被编译的源，MUST NOT 需要用户再复制到某个「原始资料目录」

#### Scenario: 不新建原始层目录
- **WHEN** 工作区被初始化
- **THEN** 系统 SHALL 只创建 wiki 目录（规范文件、内容目录、时间线、摘要页、实体页、图谱文件），MUST NOT 创建 `raw/` 之类的原始资料目录

#### Scenario: wiki 归 agent 拥有
- **WHEN** 用户查看 wiki 目录
- **THEN** 其中页面 SHALL 由 agent 创建与维护，人 SHALL 能阅读并可直接编辑

#### Scenario: 规范文件是纪律来源
- **WHEN** agent 维护 wiki
- **THEN** 它 SHALL 遵循规范文件里定义的实体类型、类型继承、目录约定与页面字段，使 wiki 结构保持一致

#### Scenario: wiki 不存在时不报错
- **WHEN** 工作区内没有 wiki 目录
- **THEN** 系统 SHALL 视为「空 wiki」，MUST NOT 因此报错或拒绝服务

#### Scenario: 目录结构可见
- **WHEN** 用户查看工作区文件
- **THEN** wiki 层 SHALL 能在文件树中被浏览，且人可直接打开其中任意页面

### Requirement: 编译管线
系统 SHALL 提供从源层文件编译出 wiki 页面的管线，并支持增量：已编译过的源不重复编译。

#### Scenario: 从源编译出页面
- **WHEN** agent 编译一份源文件
- **THEN** 它 SHALL 产出该源的摘要页，并更新受影响的实体页与内容目录

#### Scenario: 增量编译
- **WHEN** 用户再次编译而源文件未变
- **THEN** 系统 SHALL 跳过该源，MUST NOT 重复生成相同页面

#### Scenario: 已编译判定以元数据为准
- **WHEN** 系统判断一份源是否已编译
- **THEN** 判定 SHALL 依据页面元数据里记录的源标识，MUST NOT 依赖文件名猜测

#### Scenario: 源改名不导致重复
- **WHEN** 用户重命名了工作区里的一份已被编译的源文件
- **THEN** 系统 SHALL 能识别它对应的页面并按需更新，MUST NOT 直接产生一份重复内容

#### Scenario: 编译任务包不塞满上下文
- **WHEN** 系统为一次编译准备输入
- **THEN** 它 SHALL 给出**待编译清单与预览**，全文由 agent 按需读取，MUST NOT 把所有源文件全文一次性塞进上下文

### Requirement: 内容目录与时间线
系统 SHALL 维护两个特殊文件以便导航：一个内容导向的目录，一个时间导向的流水。

#### Scenario: 内容目录随每次编译更新
- **WHEN** 一份源被编译或一次分析被回填
- **THEN** 内容目录 SHALL 被更新，列出该页面的链接与一句话摘要

#### Scenario: 提问前先读目录
- **WHEN** agent 需要回答一个涉及项目知识的问题
- **THEN** 它 SHALL 先读内容目录定位相关页面，再进入具体页面，MUST NOT 直接扫描全部页面

#### Scenario: 时间线可 grep
- **WHEN** 一次编译、提问或体检发生
- **THEN** 系统 SHALL 向时间线追加一条以统一前缀开头的记录，使最近若干条可用文本工具直接取出

#### Scenario: 时间线只增不改
- **WHEN** 用户查看时间线
- **THEN** 它 SHALL 按时间顺序呈现做过什么，历史条目 MUST NOT 被改写

### Requirement: 知识图谱的边与来源
系统 SHALL 从 wiki 里抽出一张有向图：边的**来源有两类**——页面正文里的引用，以及页面元数据里**显式声明的类型化关系**。

#### Scenario: 引用类边
- **WHEN** 一个 wiki 页面在正文里引用了某个源文件或另一个页面
- **THEN** 系统 SHALL 生成一条对应的边，并区分「指向源」与「指向页面」两种边类型

#### Scenario: 页码被保留
- **WHEN** 引用带有页码信息
- **THEN** 该页码 SHALL 作为边的属性保留，供溯源

#### Scenario: 声明式关系
- **WHEN** 一个页面的元数据里声明了与其他页面的类型化关系
- **THEN** 系统 SHALL 生成带关系类型的边，且在图上与普通引用可区分

#### Scenario: 无法解析的目标不产生边
- **WHEN** 一条引用或声明找不到对应目标，或指向自身
- **THEN** 系统 SHALL 忽略该条，MUST NOT 生成悬空边，也 MUST NOT 把整次抽取判为失败

#### Scenario: 三种目标解析方式
- **WHEN** 系统解析一条引用的目标
- **THEN** 它 SHALL 依次按「完整相对路径 / 文件名（不含扩展名）/ wiki 内路径」三种方式查找，使书写形式不同但指向同一文件的引用都能命中

### Requirement: 边的合并与重建
系统 SHALL 以同一对节点同一边类型为唯一键去重，并在去重时保留更权威的那条。

#### Scenario: 声明式关系优先于推断
- **WHEN** 同一对节点之间同时存在「正文推断的引用」与「元数据声明的类型化关系」
- **THEN** 保留的 SHALL 是声明式的那条，MUST NOT 两条共存

#### Scenario: 带页码优先
- **WHEN** 同一对节点之间有多条同类引用且部分带页码
- **THEN** 保留的 SHALL 是带页码的那条

#### Scenario: 全量重建是原子的
- **WHEN** 系统重建图
- **THEN** 它 SHALL 先清掉该工作区的旧边再批量写入，且整个过程在一个事务内；任何失败 SHALL 回滚整个重建并向外报错，MUST NOT 留下清了一半的图

#### Scenario: 重建可重复执行
- **WHEN** 对同一份 wiki 连续重建两次
- **THEN** 得到的图 SHALL 完全一致

### Requirement: 图的节点与类型继承
系统 SHALL 让图中的节点携带可用于筛选与展示的属性，并体现规范文件里定义的**类型继承**。

#### Scenario: 节点属性
- **WHEN** 查询图
- **THEN** 每个节点 SHALL 携带其标识、类型、所属页面路径与可展示的属性

#### Scenario: 类型继承链
- **WHEN** 某实体类型的规范里声明了父类型
- **THEN** 该节点的类型 SHALL 携带完整的祖先链，使按父类型筛选能命中子类型

#### Scenario: 图可可视化
- **WHEN** 用户在界面上查看图谱
- **THEN** 系统 SHALL 能按「节点 + 边」的形式输出，使节点类型、关系类型与孤立节点都能看出来

#### Scenario: 孤立节点可辨认
- **WHEN** 某个页面没有任何入边
- **THEN** 它 SHALL 在图中仍作为一个节点出现，使「孤儿页」可被发现

### Requirement: 图谱参与检索
系统 SHALL 在回答项目相关问题时利用图谱做**引用扩展**，而不只依赖关键词或向量相似度。

#### Scenario: 沿边扩展候选
- **WHEN** 一次检索命中了某些页面
- **THEN** 系统 SHALL 能沿图的边把直接相关的页面纳入候选，使用户不必精确命中关键词也能找到关联知识

#### Scenario: 多路结果融合
- **WHEN** 系统同时得到关键词命中、向量命中与图谱扩展结果
- **THEN** 它 SHALL 将这些来源融合成一个排序后的结果集；缺少向量能力时 SHALL 退化为关键词与图谱两路，MUST NOT 整体失败

#### Scenario: 精排可选
- **WHEN** 用户开启精排
- **THEN** 系统 SHALL 先取多于需要的候选再重排；精排不可用时 SHALL 回退原序，MUST NOT 报错中断

#### Scenario: 引用可溯源
- **WHEN** agent 用检索结果回答
- **THEN** 答案 SHALL 能指出所依据的页面或源文件路径

### Requirement: 收录、回填与体检
系统 SHALL 支持把源收进 wiki、把有价值的答案回填成新页、以及对 wiki 做周期性体检。

#### Scenario: 一次收录触及多个页面
- **WHEN** agent 收录一份源
- **THEN** 它 SHALL 写出该源的摘要页、更新内容目录、更新受影响的实体页，并在时间线上留痕

#### Scenario: 发现矛盾要标记
- **WHEN** 新源与已有页面的论断冲突
- **THEN** agent SHALL 在相关页面标记该矛盾，MUST NOT 静默覆盖旧论断

#### Scenario: 好答案成为新页
- **WHEN** 一次提问产出了分析、对比或新关联
- **THEN** 该产物 SHALL 能被归档成 wiki 中的新页面，MUST NOT 只留在会话记录里消失

#### Scenario: 回填不无提示覆盖
- **WHEN** 回填的页面与既有页面主题相同
- **THEN** 系统 SHALL 更新既有页面或新建一个可区分命名的页面，MUST NOT 无提示地覆盖

#### Scenario: 体检检查项
- **WHEN** 一次体检执行
- **THEN** 它 SHALL 检查：页面之间的矛盾、被新源取代的陈旧论断、无入链的孤立页、被提及但没有独立页的重要概念、缺失的交叉引用

#### Scenario: 体检只报告不改内容
- **WHEN** 体检只报告而不执行修复
- **THEN** 它 MUST NOT 修改 wiki 内容；修复 SHALL 作为显式动作发生

#### Scenario: 体检可周期执行
- **WHEN** 用户配置了周期性体检
- **THEN** 系统 SHALL 按该周期执行并把结果记录下来，且报告具体可执行而非一句「一切正常」

### Requirement: wiki 页面格式
系统 SHALL 让 wiki 页面采用带前置元数据的 markdown，以便机器可靠地组织、去重与建图。

#### Scenario: 页面带结构化元数据
- **WHEN** agent 创建一个 wiki 页面
- **THEN** 该页面 SHALL 带前置元数据，标明其来源、类型、时间与它声明的关系

#### Scenario: 元数据不被正文解析误伤
- **WHEN** 系统从页面正文抽取引用
- **THEN** 它 SHALL 只解析正文，MUST NOT 把元数据区的文本当作引用

#### Scenario: 人的编辑不被破坏
- **WHEN** 用户直接在编辑器中修改某个 wiki 页面
- **THEN** 后续 agent 维护 SHALL 在该修改的基础上继续，MUST NOT 回退用户的改动