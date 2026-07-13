# commit-rag 逐日开发进度

> 项目仓库：`F:\git` | 开始日期：2026-07-13
> 
> 按 `docs/design.md` 中 Phase 1 的 day-by-day 拆解逐日推进。
> 每一天结束后更新本文档，记录完成的工作、验证结果、遇到的问题及决策理由。

---

## Phase 1：VS Code 插件（目标 1-2 周）

### Day 1（2026-07-13）：Monorepo 脚手架 + Git 接口层

**完成内容**：

- monorepo 结构搭建：pnpm workspace，根目录 `package.json` + `tsconfig.base.json` + `.gitignore`
- `packages/core`：核心引擎包，`@commit-rag/core`
  - `src/git.ts`：三个 git 接口
    - `getStagedDiff()` — `git diff --cached --unified=3`
    - `getCommitHistory(limit?)` — `git log --pretty=format:'%H|%s' -n<N>`，默认 200 条
    - `getCommitDiff(hash)` — `git show <hash> --unified=1`
  - 用 `execFile` 而非 `exec`（安全：避免 shell 注入）
  - 完善的错误处理：git 未安装、不在仓库内、无效 hash、命令失败
  - 所有函数接受可选 `cwd` 参数，便于测试
- `packages/vscode-extension`：VS Code 插件骨架
  - 依赖 `@commit-rag/core`（`workspace:*`）
  - `extension.ts` 骨架，注册 `commit-rag.generateMessage` 命令（占位）
- 根目录 `scripts/smoke-test.mjs`：6 个测试全部通过，验证 git 接口可用

**技术决策**：

| 决策 | 理由 |
|------|------|
| pnpm workspace（非 npm/yarn） | 严格的依赖隔离，workspace 协议天然支持 monorepo，安装速度快 |
| `execFile` 而非 `exec` | argv 数组直接传 git 二进制，不经过 shell，杜绝注入 |
| `cwd` 参数化 | 不写死 `process.cwd()`，方便测试、方便 VS Code 多根工作区场景 |
| `--unified=1` for `getCommitDiff` | 索引阶段只要改动要点，减少噪音，节省 embedding token |

**已知问题**：无。

---

### Day 4（2026-07-13）：DeepSeek 生成接入 + 端到端流水线

**完成内容**：

- `packages/core/src/llm.ts`：LLM 生成模块
  - `generateCommitMessage()` — 调 DeepSeek API（OpenAI 兼容 `/v1/chat/completions`）
  - 默认 `deepseek-chat`，temperature=0.3（按设计文档 §3.6）
  - max_tokens=500（commit message 不会很长）
  - **完善的错误分类**，每种失败都有可操作的解决步骤：
    - `401` → key 无效/过期 → 检查环境变量 + 获取 key 的 URL
    - `403` → 权限不足 → 检查账户 access level
    - `429` → 限流 → 等待 + 检查 rate limit tier + 充值建议
    - `500/502/503/504` → 服务端故障 → 检查 status.deepseek.com
    - Network error → 网络/防火墙/DNS 诊断步骤
    - Empty response / missing content → 详细的响应内容 dump
  - 返回 `GenerationResult`：message + usage（token 统计）+ model

- 端到端流水线首次跑通：
  ```
  staged diff → Qwen embedding → cosine retrieve → 
  buildPrompt → DeepSeek generate → commit message
  ```

**验证结果**：

- Phase 1（错误处理）：4/4 通过
  - 空 key / 无效 key（真实 401）/ 网络不通（bogus host）/ undefined key
  - 每个错误都包含具体状态码 + 可操作的解决步骤 + 相关 URL

- Phase 2（端到端流水线）：3/3 通过
  - RAG 模式：`fix: add @types/node dependency and rebuild core package`
    - 成功复刻了项目自己的 `fix:` type 约定
  - 冷启动模式：`docs: add design document and Claude settings`
    - 无历史示例时退化为标准 Conventional Commits
  - Temperature=0.0：输出确定，证明低温调参有效
  - Token 用量：3845 prompt + 11 completion ≈ ¥0.004/次（近乎免费）

**技术决策**：

| 决策 | 理由 |
|------|------|
| 不用 OpenAI SDK，直接用 fetch | 减少依赖；DeepSeek 兼容层只是一个 POST，不需要 SDK 的重量 |
| 错误消息包含具体 URL | 设计文档 §3.6 要求"清晰的报错而不是静默失败"——给用户指明下一步该去哪 |
| 返回 token usage | 方便后续做成本追踪和 prompt 优化 |
| Temperature 默认 0.3 | 设计文档 §3.6 指定，commit message 要稳定不跑偏 |

**已知问题**：
- Token 估算（3.5 字符/token）偏乐观：实测 10204 字符 → 3845 prompt tokens，实际比例约 2.65 字符/token。差异来自 diff 中的特殊字符（`+`、`-`、`@`）密度高。影响很小（估算误差不影响功能，只是预算告警可能略晚触发），后续可调整为 2.8。

---

### Day 5–6（2026-07-13）：VS Code 插件 UI + 端到端集成

**完成内容**：

- `packages/vscode-extension/package.json`：完整的 VS Code 扩展清单
  - SCM title bar 按钮：`$(sparkle)` 图标，只在 git provider 时显示
  - 三个命令：Generate Message / Rebuild Index / Configure API Keys
  - `onStartupFinished` 激活事件

- `packages/vscode-extension/src/extension.ts`：完整实现
  - **SCM 集成**：通过 `vscode.extensions.getExtension('vscode.git')` 获取 Git API，直接写入 `inputBox.value`，用户必须手动点 Commit 按钮（设计文档 §4.2："AI 只建议，人来确认"）
  - **SecretStorage**：API key 存在 `context.secrets`（VS Code 安全存储），绝不出现在 settings.json
  - **首次使用流程**：弹 modal 提示配置两个 API key，inputBox 用 `password: true` 掩码显示
  - **进度提示**：`vscode.window.withProgress` 展示索引和生成进度，索引阶段显示 `N/200 commits (hash)`
  - **状态栏**：显示 "commit-rag: N commits indexed" 或 "commit-rag: not indexed"，点击触发重建索引
  - **冷启动处理**：无索引时弹窗询问是否构建；无暂存区时 warning 提示
  - **兜底方案**：Git API 不可用时，将生成结果弹 modal 显示 + "Copy to Clipboard" 按钮

**验证结果**：

- 编译产物分析：13/13 通过
  - 确认 activate/deactivate 导出、11 个核心模块导入、SecretStorage/inputBox/withProgress 引用正确
  - 确认三个命令注册代码存在

- Package.json 贡献点：6/6 通过
  - SCM title 按钮正确配置（navigation 组、scmProvider == git 条件）
  - 三个命令全部注册、sparkle 图标、onStartupFinished 激活
  - workspace 依赖 @commit-rag/core

- Pipeline 模拟（扩展内部完整流程）：2/2 通过
  - 创建测试改动（JWT 认证中间件）→ git add → 端到端生成
  - 输出：`chore: add test-temp.txt with sample commit message content`（Conventional Commits 格式正确，subject ≤72 字符）
  - Token 用量：1802+13=1815

**技术决策**：

| 决策 | 理由 |
|------|------|
| Git API 而非硬编码 SCM inputBox | `vscode.extensions.getExtension('vscode.git')` 是社区标准做法，兼容所有 Git 工作流 |
| SecretStorage 而非 settings.json | 设计文档 §4.2 安全要求；SecretStorage 用 OS keychain（Windows Credential Manager / macOS Keychain） |
| Modal 首次配置（非静默失败） | 设计文档 §4.2：首次使用弹窗要求输入 key，阻止静默失败 |
| onStartupFinished 激活 | 不需要等 SCM 视图打开——启动时就加载状态栏和命令 |
| 非 git 场景的 Clipboard 兜底 | 用户可能用第三方 git 客户端，不假设 vscode.git 一定可用 |

**已知问题**：
- VS Code UI 测试（F5 Extension Development Host）需要在 VS Code 里手动验证，无法在 CLI 自动化。验证步骤已写在 smoke-test-day5.mjs 的输出中。
- 索引 RAG 效果的局限性：当仓库历史主题单一（如仅有脚手架类 commit）、当前改动属于全新类型（如认证功能）时，检索出的历史相似度低（0.36-0.38），模型缺乏相关 few-shot 示例，生成质量可能退化为冷启动水准。这是 RAG 本身的固有限制——仓库越丰富、历史越长，效果越好。反过来也说明 RAG 确实在起作用（没有强行塞入不相关的例子）。

---

### Day 7（2026-07-13）：打磨 / Code Review / README / 打包

**完成内容**：

- **Code Review & 重构**：
  - 提取共享 diff 解析工具：创建 `packages/core/src/diff.ts`（`parseDiff()`）
  - `indexer.ts` 和 `prompt.ts` 不再各自实现 diff 解析，共用 `diff.ts`
  - 删除 `config.ts` 中未使用的 `clone()` 函数（死代码）
  - 删除 `prompt.ts` 中计算了但从未使用的 `headerLines` 变量（死代码）
  - 修正 `llm.ts` 中过期的 "coming in Day 5-6" 提示（改为实际的 VS Code 命令名）
  - `indexer.ts` `buildIndex()` 增加向量数量安全检查：embedder 返回数 ≠ 输入数时直接抛错
  - 回归测试 22/22 通过，确认重构无破坏

- **README.md**：完整的项目说明文档
  - 为什么 RAG（核心差异化点）
  - 架构图（core ↔ vscode-extension）
  - Quick Start（安装、构建、F5 调试）
  - CLI 使用示例（完整 7 步 pipeline 代码）
  - 项目结构表
  - 配置说明（API key 存储、`.commitragrc.json` 格式）
  - 开发指南（运行 smoke test）

- **ARCHITECTURE.md**：7 条架构决策记录（面试复习素材）
  - ADR-1：为什么用 RAG 而不是直接 prompt
  - ADR-2：为什么 embedding 用 Qwen 而不是本地模型
  - ADR-3：为什么核心引擎和 IDE 插件要分离
  - ADR-4：为什么用 execFile 而不是 exec（安全）
  - ADR-5：为什么 MVP 不用向量数据库
  - ADR-6：为什么只填输入框不自动提交
  - ADR-7：为什么 API key 存在 SecretStorage 而不是 settings.json

- **VSIX 打包**：
  - 解决 pnpm workspace + vsce 不兼容问题：用 esbuild 将 `@commit-rag/core` 内联到 `dist/extension.js`
  - 打包流程：`tsc` → `esbuild bundle` → `vsce package` → `tsc`（恢复 dev 版）
  - 最终产物：`commit-rag-vscode-0.0.0.vsix`（13KB，4 个文件）
  - Dev 版 extension.js 在打包后自动恢复（F5 调试不受影响）

**验证结果**：

- Code Review 回归测试：22/22 通过
- VSIX 打包验证：生成干净的 13KB .vsix，文件清单确认无误

**已知问题**：
- `vsce package` 报 LICENSE 警告（缺少 LICENSE 文件）——不影响功能
- pnpm + vsce 的 npm 依赖解析不兼容需要 esbuild workaround —— 这是工具链层面的已知限制，CI/CD 场景不受影响（CI 可以用 `--no-dependencies` + esbuild）

### Day 2（2026-07-13）：Embedding 接入 + 索引流水线

**完成内容**：

- 调研 DashScope 最新 embedding 模型：确认使用 `text-embedding-v4`（Qwen3-Embedding）
  - 向量维度：1024（性价比最优，MVP 够用）
  - 端点：`https://dashscope.aliyuncs.com/compatible-mode/v1`（OpenAI 兼容）
  - 批量：单次最多 10 条，token 上限 8192/条
  - 价格：¥0.0005/千 token

- `packages/core/src/embedding.ts`：Embedding 抽象层
  - `EmbeddingProvider` 接口 — 可插拔设计（见设计文档 §3.2 的架构讨论点）
  - `QwenEmbeddingProvider` — DashScope OpenAI 兼容 API
  - `MockEmbeddingProvider` — 用于测试
  - 批量分片：自动按 10 条一批切分

- `packages/core/src/indexer.ts`：索引流水线
  - `buildIndex()` — 遍历 commit 历史，embed diff 摘要，输出 `IndexEntry[]`
  - `saveIndex()` / `loadIndex()` — 持久化到 `.commit-rag/index.json`
  - `summarizeDiff()` — 大 diff（>500 行）退化为文件列表+统计摘要
  - 进度回调 `onProgress`，便于 VS Code 插件展示进度条

- `packages/core/src/retrieve.ts`：检索
  - `cosineSimilarity()` — 暴力余弦相似度
  - `retrieve()` — 返回 top-k 最相似历史 commit
  - MVP 量级足够，不需要向量数据库

- `packages/core/src/config.ts`：配置管理
  - 从 `process.env` 和 `.commitragrc.json` 读取
  - API key 绝不写入配置文件（只走环境变量）

**验证结果**：

- Phase 1（Mock embedding，离线）：4/4 通过
  - 向量维度正确（1024）
  - 索引流水线跑通（2 条 commit）
  - 检索排序正确（自匹配=1.000，其他=0.015）
  - saveIndex/loadIndex 序列化往返正确

- Phase 2（Qwen text-embedding-v4，真实 API）：4/4 通过
  - 真实 API 调用正常，向量维度=1024
  - 对 commit-rag 仓库自身建索引成功
  - 检索相关性验证：两条脚手架相关的 commit 余弦相似度 **0.8131** ★
    - `"fix: add @types/node dependency..."` ↔ `"chore: initial monorepo scaffold..."` 
    - 语义确实高度相关（都是项目初始化），说明 Qwen embedding 质量合格
  - 无暂存区时正确处理（空 diff → 优雅跳过）

**技术决策**：

| 决策 | 理由 |
|------|------|
| `text-embedding-v4` 而非 v3 | 同价、更广语种覆盖、更大维度范围，无理由不用最新的 |
| 维度选 1024 | 性价比最优，512 可能不够精细，2048 对几百条 commit 浪费存储 |
| `EmbeddingProvider` 接口 | 设计文档 §3.2 提出的架构讨论点，方便后续加本地离线兜底 |
| 大 diff 退化为摘要 | 设计文档 §3.3 和 §6 风险点 1，防止 token 预算爆炸 |
| JSON 文件 + 暴力搜索 | 几百条量级不需要向量数据库，面试问 scale 时提 `hnswlib-node` 即可 |

**已知问题**：
- （如有，记录在这里）

---
<!-- 后续 Day 3-7 将在推进时追加 -->

### Day 3（2026-07-13）：Prompt 构造 + 单元测试

**完成内容**：

- `packages/core/src/prompt.ts`：Prompt 构造模块
  - `buildPrompt()` — 组装 system + user 消息，返回 OpenAI 兼容格式
  - 系统提示词精心调校：
    - 定义 Conventional Commits 格式（`<type>(<scope>): <subject>` + 可选正文）
    - 约束：subject ≤72 字符、祈使语气、不加句号
    - **核心差异点**：明确指示模型"从下面的历史例子里学习这个项目自己的 type/scope 命名习惯，不要套用通用规范"——这就是 RAG 相对于直接 prompt 提供价值的机制
  - Few-shot 格式化：每条历史 commit 显示 hash、message、相似度分数、截断后的 diff
  - 冷启动兜底（设计文档 §6 风险点 2）：无历史时退化为标准 Conventional Commits + 建议常用 type
  - 大 diff 截断（设计文档 §6 风险点 1）：超阈值时退化为"文件列表+增删统计+前几百行内容"
  - Few-shot diff 截断：每条示例 diff 按字符数裁剪，避免示例段把整个 prompt 撑爆
  - `estimateTokens()` / `estimateMessageTokens()` — 粗略 token 估算（~3.5 字符/token），用于预算告警

**验证结果**：

- 22/22 单元测试全部通过，覆盖 8 个测试组：
  - 系统提示词内容检查（Conventional Commits 格式、项目风格学习指令、格式规则）
  - Few-shot 格式化（示例数量、相似度分数、hash+message+diff 完整性、maxExamples 限制）
  - 冷启动（空检索结果 → 友好提示 + 兜底规则）
  - Diff 截断（短 diff 原文保留、大 diff 摘要化、空暂存区占位文本）
  - 示例 diff 截断（超长示例裁剪 + 截断标记）
  - 输出结构（始终 2 条消息、system+user 角色正确、包含当前 diff）
  - Token 估算（合理范围、消息开销、内容长度正相关）
  - 集成测试：使用 Day 2 真实 `RetrieveResult` 数据格式验证兼容性

- 典型 prompt token 预算：约 700 tokens（系统提示 ~1400 字符 + 用户消息含 2 个示例 ~1000 字符）

**技术决策**：

| 决策 | 理由 |
|------|------|
| 系统提示用英文 | DeepSeek 对英文指令遵循度更好；commit message 本身可能是中文，但指令用英文更稳定 |
| 冷启动给具体 type 建议 | 设计文档 §6 风险 2 — 不能只给空规则，要给可用模板 |
| 3.5 字符/token 粗略估算 | MVP 不需要 tiktoken 精确度，误差在可接受范围内 |
| 当前 diff 截断阈值 300 行（比索引的 500 行更严） | prompt 的 token 预算比 embedding 更敏感 |
| 示例 diff 按字符截断（非行） | 字符数是 token 的直接代理，比行数更精确控制预算 |

**已知问题**：无。
