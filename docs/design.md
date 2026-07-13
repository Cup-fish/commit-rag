# AI Commit Message 插件 —— 设计与实施计划

> 用途：这份文档是给 Claude Code 直接执行的设计+计划文档，建议存到项目仓库的 `docs/design.md`，然后在 Claude Code 里说"按这份设计文档帮我搭Day 1的脚手架"开始干活。项目名先占用 `commit-rag`，你可以随时改。

## 0. 先说清楚一个时间预期上的调整

你选的是"两个都做，分两期"+"1-2周做出MVP"。这两个选择放一起有个张力需要提前挑明：**1-2周只够扎扎实实做完一个平台**（VS Code），JetBrains插件用的是完全不同的技术栈（Kotlin + IntelliJ Platform SDK），如果硬塞进同一个1-2周窗口，大概率两个都做不完整，简历上反而不好写。

所以这份计划把范围定成：

- **Phase 1（本计划的主体，目标1-2周）**：VS Code插件，端到端做完，这是你写进简历、能演示、能被追问细节的那个"MVP"。
- **Phase 2（后续，不计入这1-2周）**：JetBrains插件，复用Phase 1的核心引擎，工作量会小很多。

这样设计还有个好处：核心引擎（RAG+Prompt+DeepSeek调用）做成IDE无关的独立模块，两个IDE插件都是薄薄一层UI适配层去调用它——这个"核心引擎与IDE解耦"的架构决策本身就是一个很好的面试讲点（后面第5节会展开）。

---

## 1. 项目定位

一个能在你写完代码、`git add` 之后，根据**暂存区的diff**和**这个仓库过去的commit风格**，自动生成一条符合项目自身习惯的commit message的IDE插件。核心不是"调一次LLM生成文本"，而是"用RAG让生成结果贴合这个项目自己的历史规范"——这也是你在面试时要重点讲清楚"为什么要RAG，不直接prompt模型"的地方。

---

## 2. 整体架构

```
┌─────────────────────────────────────────────┐
│              commit-rag-core                 │  ← IDE无关的核心引擎（TypeScript库+CLI）
│  git.ts     indexer.ts   retrieve.ts         │
│  prompt.ts  llm.ts       config.ts           │
└───────────────┬───────────────┬─────────────┘
                 │               │
     ┌───────────▼───┐   ┌───────▼──────────┐
     │ VS Code 插件   │   │ JetBrains 插件     │
     │ (Phase 1)      │   │ (Phase 2)         │
     │ 直接import核心库│   │ 通过CLI子进程调用核心│
     └────────────────┘   └───────────────────┘
```

**为什么这样分层**：VS Code插件本身就是TypeScript/Node.js环境，可以直接把core当npm包引用；JetBrains插件是Kotlin/JVM环境，语言不通，与其在Kotlin里重写一遍RAG逻辑（重复代码、两边容易长歪），不如让core额外导出一个命令行接口（`commit-rag-cli generate` / `commit-rag-cli index`），JetBrains插件用`ProcessBuilder`起子进程调用、读JSON输出。这是跨语言复用逻辑的标准做法，面试问"两个平台的代码怎么共享"时可以直接讲这个设计。

---

## 3. 核心引擎设计（commit-rag-core）

### 3.1 Git接口层（git.ts）

用 Node 的 `child_process.execFile`（不要用 `exec`，避免shell注入问题——这个细节值得在代码里写注释说明，是个安全加分点）：

- `getStagedDiff()` → `git diff --cached --unified=3`，拿到当前暂存区的完整diff
- `getCommitHistory(limit=200)` → `git log --pretty=format:'%H|%s' -n <limit>`，拿最近N条commit的hash+message
- `getCommitDiff(hash)` → `git show <hash> --unified=1`，拿某条历史commit的diff，供索引阶段使用

### 3.2 一个必须提前知道的技术约束：DeepSeek没有Embedding接口

查证过了，DeepSeek官方API目前只提供对话补全接口，**不提供embedding接口**（这是DeepSeek平台本身的已知限制，社区里也有人专门提过这个功能请求，目前还没做）。所以RAG的"检索"这一半不能指望DeepSeek，需要单独找embedding方案。

**更新：embedding换成阿里云百炼/DashScope的Qwen embedding接口（`text-embedding-v3`，或实现时看看有没有更新的`v4`），不再用本地模型。** 原计划是本地跑`@xenova/transformers`，换成Qwen有几个实打实的理由：

1. **质量**：Qwen的embedding模型是专门做过中文语义优化的，你的commit history大概率中英文混杂甚至以中文为主，本来打算用的本地小模型（MiniLM量级）在中文语义理解上会明显弱一截。检索质量直接决定RAG效果——检索出来的历史commit不相关，few-shot例子就是噪音，生成质量照样跑偏。
2. **规避一个真实的工程风险**：VS Code插件运行在Electron的特殊Node环境里，`@xenova/transformers`这类依赖本地推理后端（ONNX runtime）的包，打包成`.vsix`时经常遇到native binding兼容性问题，这是VS Code插件生态里一个众所周知的坑。换成纯HTTP调用的云端API，插件打包简单很多，MVP阶段这个风险规避的价值不小。
3. **接口一致性**：DashScope的embedding接口是OpenAI兼容格式，调用方式和已经在写的DeepSeek客户端代码几乎一样，不用额外学一套SDK。
4. 支持批量调用，索引几百条commit不用一条条发请求；还支持自定义向量维度（比如设成512/768），可以控制索引文件体积。

**代价也要说清楚**：现在要管两个API key（DeepSeek管生成，DashScope/Qwen管检索），插件配置项多一项；索引阶段也从"完全离线"变成"需要联网"。如果想保留离线能力，建议把embedding这块抽成一个`EmbeddingProvider`接口，Qwen做默认实现，本地模型作为可选的离线兜底——这个"embedding provider可插拔"的设计本身也是个不错的架构讨论点，比死绑一个provider更值得讲，而且不强求MVP阶段就把两个都实现完，先把接口留出来就行。

> 实现时让Claude Code查一下DashScope当时最新的embedding模型名和SDK调用方式（`text-embedding-v3`/`v4`这类版本号迭代比较快），别直接照抄这里写的版本号。

### 3.3 索引流水线（indexer.ts）

- 首次在一个仓库运行时（或索引文件缺失/用户手动`--reindex`）：遍历最近N条commit（默认200条，控制索引耗时和体积）
- 每条commit：拿到diff+message，如果diff过大（比如一次性格式化几十个文件），做截断/摘要（优先保留文件名列表+增删行数统计，而不是塞进完整diff内容，避免向量化质量被噪音稀释）
- 用本地embedding模型算向量，存进本地索引文件（比如 `.commit-rag/index.json`，字段：hash、message、diff摘要、向量）
- MVP阶段量级（几百条commit）不需要真正的向量数据库，一个JSON数组+暴力余弦相似度就够快。想加深度的话，后续可以换成 `hnswlib-node` 之类的近似最近邻库，这个作为"如果面试官问你怎么scale"的备用回答即可，不用现在就做

### 3.4 检索（retrieve.ts）

- 把当前暂存区diff也过一遍同一个本地embedding模型
- 和索引里的历史commit做余弦相似度排序，取top-k（默认5条）最相似的历史commit（diff+message）

### 3.5 Prompt构造（prompt.ts）

- **System部分**：定义输出格式（建议走Conventional Commits规范：`<type>(<scope>): <subject>` + 可选正文），约束（subject控制在合理长度、祈使语气、不要句号结尾），并明确告诉模型"从下面给的历史例子里学习这个项目自己的type/scope命名习惯，不要套用你自己知道的通用规范"——这句指令是RAG真正发挥作用的地方
- **Few-shot部分**：把top-k检索到的历史(diff片段, commit message)对拼进去，作为示例
- **当前任务部分**：当前暂存区diff（同样要做截断/摘要保护，避免大diff把token预算打爆——比如超过一定文件数就退化成"文件列表+增删统计"而不是完整内容）

### 3.6 生成（llm.ts）

- 用OpenAI兼容SDK调 `https://api.deepseek.com`，`deepseek-chat`模型，低temperature（比如0.3，保证输出稳定不跑偏）
- 做好错误处理：API key无效、网络失败、限流，都要给出清晰的报错而不是插件静默失败——这是"工程成熟度"的加分细节，值得在实现时认真做

### 3.7 配置（config.ts）

- API key绝不硬编码，走环境变量或IDE的密钥存储（VS Code有专门的`SecretStorage` API，见下）
- 索引条数上限、top-k、模型名等做成可配置项，放一个仓库根目录下的`.commitragrc.json`或者IDE设置里

---

## 4. Phase 1：VS Code插件（1-2周，这是你的MVP交付物）

### 4.1 技术栈
TypeScript + VS Code Extension API，用pnpm/npm workspace把`packages/core`和`packages/vscode-extension`放一个monorepo里，插件直接依赖core作为本地包——这样"核心逻辑真的是共享的"而不是复制粘贴，Claude Code写的时候要注意保持这个结构。

### 4.2 UI集成要点
- 在VS Code的源代码管理（SCM）视图标题栏加一个自定义按钮（VS Code SCM API支持），点击触发生成
- 生成结果**只填入commit message输入框，不自动提交**——一定要让人工review后再点提交按钮。这个"AI只建议，人来确认"的设计本身也是个值得讲的点，尤其是你之前TRPG项目里已经有"AI不直接产出关键结果，人/确定性逻辑做最后把关"的同一套设计哲学，两个项目呼应起来讲会很有说服力
- 首次使用时：弹窗要求输入DeepSeek API key，存进VS Code的`SecretStorage`（不是明文写进settings.json——这个安全细节别漏）；同时触发首次索引，用`vscode.window.withProgress`展示进度条
- 状态栏显示索引状态（"已索引XX条历史commit"），提供一个手动"重新索引"命令

### 4.3 Day-by-day拆解（给Claude Code按天推进用）

- **Day 1**：monorepo脚手架，git接口层，能在终端跑通"读取暂存区diff"和"读取历史commit列表"
- **Day 2**：接入本地embedding模型，写索引流水线，拿一个你自己现成的仓库（比如TRPG引擎或OCR项目）实际跑一遍索引，人工检查检索结果是不是真的相关，不相关就调prompt或diff摘要策略
- **Day 3**：检索+prompt构造，写几个单元测试锁定prompt模板的行为
- **Day 4**：接DeepSeek生成，把各种失败情况（key错、断网、限流）都手动触发一遍看报错是否清晰
- **Day 5-6**：VS Code插件UI（SCM按钮、密钥存储、进度提示），端到端跑通，拿2-3个真实仓库实测
- **Day 7（缓冲）**：打磨、写README（配一个演示GIF）、`vsce package`打出`.vsix`，同时把"为什么RAG不直接prompt""为什么本地embedding不用DeepSeek"这些架构决策写成一份简短说明——这份说明就是你以后面试的复习素材，边做边写比做完再补省事很多

---

## 5. Phase 2：JetBrains插件（后续sprint，不占用MVP的1-2周）

- Kotlin + IntelliJ Platform Plugin SDK（用官方Gradle模板起项目）
- 复用策略：**不在Kotlin里重写RAG逻辑**，而是让core多导出一个CLI命令（`commit-rag-cli generate`），JetBrains插件用`ProcessBuilder`拉起这个CLI子进程、解析JSON输出。代价是有一次进程启动的延迟、且要求本地装了Node.js，MVP/演示场景完全可以接受
- UI集成点：IntelliJ Platform在VCS提交面板里有生成commit message的扩展点，但具体的扩展点名称和API在不同IDE版本之间有过调整，**这块建议做Phase 2时先让Claude Code查一下当前版本的官方SDK文档确认扩展点名称，不要直接照抄某篇旧教程的代码**，这是我这边没法给你保证准确性的一处，需要实现时现查
- 这一期做完之后，Kotlin/IntelliJ SDK的经验对你目前"全栈+AI辅助开发"定位也是个不错的补充——Kotlin是JVM生态语言，IntelliJ Platform开发本身涉及不少工程化的东西（Gradle构建、PSI、扩展点机制），跟你之前想靠近Java方向这件事也不冲突，算是一个自然的搭桥

---

## 6. 已知风险 / 实现时要留意的点

1. **大diff把token预算打爆**：格式化、批量重命名这类commit的diff可能几千行，prompt构造阶段一定要有"超过阈值就退化成文件列表+统计摘要"的兜底逻辑，否则要么报错要么烧很多token
2. **冷启动仓库**：一个新仓库/commit历史很少的仓库，索引库里没什么可检索的，需要有一个"检索不到相似历史时，退化成纯Conventional Commits规范生成，不强行塞无关例子"的兜底prompt
3. **本地embedding模型的包生态变动**：`@xenova/transformers`所在的JS embedding生态更新比较快，具体模型名、API写法让Claude Code实现时以当前最新文档为准，不要完全照抄这份计划里的示例包名
4. **IntelliJ扩展点API**：如第5节所说，Phase 2开工前需要重新核实，不要在Phase 1阶段就假设它一定长这样

---

## 7. 交给Claude Code时怎么开场

建议把这份文档存到仓库 `docs/design.md`，然后跟Claude Code说类似："这是我们商量好的设计文档，先按Phase 1的Day 1拆解帮我搭monorepo脚手架和git接口层，其他阶段先不要做。" 一天一天推进，每天结束前让它简单总结一下今天做了什么、还有什么已知问题没解决——这份逐日记录本身也是你以后面试讲"开发过程中遇到什么问题、怎么解决的"的第一手素材，比事后回忆靠谱得多。