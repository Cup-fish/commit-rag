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
