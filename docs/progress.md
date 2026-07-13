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
