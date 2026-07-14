# commit-rag Architecture Decision Records

> 这是一份架构决策记录（ADR），记录项目中每一个"为什么这样做"的决策。
> 设计文档 §7 建议"边做边写"——这份文档就是你面试时被追问技术细节的第一手素材。

---

## ADR-1: 为什么用 RAG 而不是直接 prompt LLM？

**日期**：2026-07-13
**状态**：已采纳

### 背景

最 naive 的做法是把 `git diff` 直接丢给 DeepSeek："写一条 commit message"。但这样生成的结果是**通用**的——LLM 会按照它训练数据里的 Conventional Commits 规范来写，而不是你这个项目自己的规范。

### 决策

用 RAG（检索增强生成）——先把仓库的 commit 历史做向量化索引，每次生成前去索引里检索与当前 diff 最相似的几条历史 commit，作为 few-shot 示例拼进 prompt。

### 为什么这样做

1. **项目规范 > 通用规范**：有的项目用 `feat(core):`，有的用 `feature:`，有的用中文，有的中英混合。RAG 让模型看到"这个项目实际怎么写的"，而不是"标准应该怎么写"。
2. **这是你自己的项目经验**：面试官问"你做过 RAG 吗"时，你可以从 git 接口层讲到 embedding provider 可插拔讲到 prompt 构造讲到向量检索——这是一条完整的 RAG pipeline。
3. **差异化**：GitHub Copilot 的 commit message 功能也是直接 prompt，但它看不到你的 commit 历史风格。RAG 就是这个插件的核心差异化点。

### 后果

- ✅ 生成的消息贴合项目自身风格
- ❌ 需要额外的 embedding API（Qwen/DashScope）
- ❌ 冷启动仓库（commit 很少）退化为普通 prompt
- ❌ 索引需要时间和 API 调用（首次约 1-2 分钟/200 条 commit）

---

## ADR-2: 为什么 embedding 用 Qwen 而不是本地模型或 DeepSeek？

**日期**：2026-07-13
**状态**：已采纳

### 背景

最初计划用 `@xenova/transformers`（本地 MiniLM），后来改为阿里云 DashScope 的 Qwen text-embedding-v4。

### 决策

使用云端 Qwen embedding API，放弃本地模型方案。

### 为什么这样做

1. **DeepSeek 没有 embedding 接口**（已验证）：只提供 chat completion，不能做向量化。
2. **中文语义优化**：Qwen 专门做过中文语义优化。commit history 大概率中英混杂甚至以中文为主，本地小模型（MiniLM 量级）在中文上会明显弱一截。
3. **规避 native binding 风险**：VS Code 插件的 Electron 环境里，`@xenova/transformers` 这类依赖 ONNX runtime 的包，打包成 `.vsix` 时经常遇到 native binding 兼容性问题——这是 VS Code 插件生态里一个众所周知的坑。纯 HTTP 调用不需要任何 native 依赖。
4. **接口一致性**：DashScope 是 OpenAI 兼容格式，和 DeepSeek 调用代码几乎一样，不需要额外 SDK。

### 后果

- ✅ 中文 embedding 质量高
- ✅ 无 native 依赖，打包简单
- ✅ 支持批量调用（最多 10 条/请求）
- ✅ 支持自定义向量维度（64-2048）
- ❌ 索引阶段需要联网（不能完全离线）
- ❌ 多一个 API key 要管理（DashScope + DeepSeek）
- ❌ 有费用（但 ¥0.0005/千 token，200 条 commit 索引约 ¥0.02）

### 备选方案

如果未来要做离线兜底，`EmbeddingProvider` 接口已经预留好了——实现一个 `LocalEmbeddingProvider` 即可，不用改 indexer 或 retriever。

---

## ADR-3: 为什么 IDE 核心引擎和 VS Code 插件要分离？

**日期**：2026-07-13
**状态**：已采纳

### 决策

```
@commit-rag/core  (IDE 无关的 TypeScript 库)
        ↓ import
commit-rag-vscode (VS Code 插件，薄 UI 层)
```

### 为什么这样做

1. **代码复用**：Phase 2 做 JetBrains 插件时，核心逻辑不用在 Kotlin 里重写一遍——core 多导出一个 CLI 命令，JetBrains 插件用 `ProcessBuilder` 拉子进程、读 JSON 输出。
2. **可测试性**：核心引擎不依赖 VS Code API，可以直接在终端用 Node.js 跑测试。VS Code 插件必须跑在 Extension Development Host 里才能测，CI 集成麻烦。
3. **面试讲点**："核心引擎与 IDE 解耦"这个架构决策本身就很值得展开讲——为什么分离、怎么分离、跨语言复用怎么做、各自的边界在哪。

### 后果

- ✅ 核心逻辑可独立测试（所有 smoke test 都是 CLI 跑的）
- ✅ JetBrains 插件可以直接复用（Phase 2）
- ✅ 未来可以导出为 GitHub Action / CLI 工具
- ❌ monorepo 多了一个包，构建配置多一点

---

## ADR-4: 为什么用 execFile 而不是 exec？

**日期**：2026-07-13
**状态**：已采纳

### 决策

在 `git.ts` 中，所有 git 命令通过 `child_process.execFile` 执行，参数以数组传递。

### 为什么这样做

`exec` 把命令拼接成字符串交给 shell 执行，如果参数里包含 shell 元字符（`;`、`|`、`$()` 等），存在注入风险。虽然 commit message 场景下风险很低（参数都是我们自己构造的），但：

1. 这是一个**安全意识**的体现——面试官如果问你"这段代码有没有安全问题"，你直接说"我用 execFile 传 argv 数组，不经过 shell"。
2. 如果未来支持用户自定义的分支名/文件名参数，execFile 天然安全。
3. 设计文档 §3.1 明确标注了这是"安全加分点"。

### 后果

- ✅ 无 shell 注入风险
- ❌ 不能用 shell 管道（但我们也不需要）

---

## ADR-5: 为什么 MVP 不用向量数据库？

**日期**：2026-07-13
**状态**：已采纳

### 决策

MVP 阶段用 JSON 文件 + 暴力余弦相似度，不引入向量数据库（如 Chroma、Pinecone、hnswlib）。

### 为什么这样做

1. **量级**：默认索引 200 条 commit。暴力扫描 200 条 × 1024 维向量的时间 < 1ms，完全不需要近似搜索。
2. **复杂度**：引入向量数据库 = 新的依赖 + 新的配置 + 潜在的 native binding 问题。MVP 阶段不值得。
3. **面试时怎么说**："当前量级（< 1000 条）暴力搜索足够。如果项目 commit 数量很大，可以接入 `hnswlib-node` 做近似最近邻搜索，核心的 `retrieve()` 函数接口不变，只改内部实现。"

### 后果

- ✅ 零额外依赖
- ✅ 索引文件是人可读的 JSON（方便调试）
- ❌ 如果 commit 数量 > 5000，线性扫描可能变慢（但索引上限默认 200）

### 升级路径

```typescript
// 现在
function retrieve(queryVec, index, k) {
  return index
    .map(e => ({ entry: e, score: cosineSim(queryVec, e.vector) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

// 未来 → 把 cosineSimilarity 换成 hnswlib 的 searchKnn
// retrieve() 的接口签名完全不变
```

---

## ADR-6: 为什么生成结果只填输入框不自动提交？

**日期**：2026-07-13
**状态**：已采纳

### 决策

LLM 生成的 commit message 填入 SCM 输入框，用户必须**手动 review** 后再点 Commit。绝不会自动提交。

### 为什么这样做

1. **AI 只建议，人来确认**：LLM 可能读错 diff、选错 type、生成不准确的描述。自动提交 = 用户无法拦截错误。
2. **呼应你的 TRPG 项目设计哲学**：设计文档 §4.2 提到你之前 TRPG 项目里"AI 不直接产出关键结果，人/确定性逻辑做最后把关"——两个项目同一套设计哲学，面试时呼应起来讲非常有说服力。
3. **工程伦理**：git commit message 是不可逆的（改历史需要 force push），AI 生成的内容必须经过人工确认。

### 后果

- ✅ 用户始终有最终控制权
- ✅ 可以在 VS Code 的 SCM 输入框里编辑后再提交
- ❌ 比自动提交多一次点击

---

## ADR-7: 为什么 API key 存在 SecretStorage 而不是 settings.json？

**日期**：2026-07-13
**状态**：已采纳

### 决策

API key 通过 VS Code 的 `SecretStorage` API 存储（底层是 Windows Credential Manager / macOS Keychain / Linux libsecret），绝不出现在 `settings.json` 或任何文本文件里。

### 为什么这样做

1. **安全**：settings.json 经常被提交到 dotfiles 仓库或通过 Settings Sync 同步到其他设备。API key 明文出现在 settings.json = 泄露风险。
2. **面试细节**：这是一个小的工程决策但体现了安全意识——面试官如果问"API key 怎么存的"，你的答案比"放 settings.json"强一个档次。
3. **VS Code 最佳实践**：官方文档推荐敏感信息用 SecretStorage。

### 后果

- ✅ API key 存在系统密钥链，不会意外泄露
- ❌ 用户换设备需要重新配置 key（这是预期行为）
- ❌ 无法通过 settings sync 自动同步 key（这是好事）

---

## 技术栈总览

| 组件 | 技术选择 | 关键理由 |
|------|---------|---------|
| Embedding | Qwen text-embedding-v4 | 中文优化、无 native 依赖、OpenAI 兼容 |
| LLM | DeepSeek deepseek-chat | 代码理解强、OpenAI 兼容、性价比高 |
| 向量检索 | 暴力余弦相似度 | MVP 量级（< 1000 条）不需要向量 DB |
| Git 接口 | child_process.execFile | 安全（避免 shell 注入） |
| 插件框架 | VS Code Extension API | Phase 1 目标平台 |
| 打包 | pnpm workspace + tsc | 严格依赖隔离、monorepo 原生支持 |
| 密钥存储 | VS Code SecretStorage | OS 密钥链、不落明文 |
