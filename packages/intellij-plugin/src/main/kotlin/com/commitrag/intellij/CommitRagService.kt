package com.commitrag.intellij

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * Thin wrapper around the commit-rag-cli subprocess.
 *
 * The CLI is responsible for ALL RAG logic (git, embedding, retrieval, LLM).
 * The Kotlin side is only responsible for:
 * 1. Detecting Node.js availability
 * 2. Spawning the CLI subprocess
 * 3. Parsing the JSON result
 * 4. Returning it to the caller
 *
 * Design doc reference: Phase 2 §5.4 — subprocess invocation details.
 */
object CommitRagService {

    /** JSON parser matching the CLI's output format. */
    private val json = Json {
        ignoreUnknownKeys = true
        isLenient = true
    }

    // -----------------------------------------------------------------------
    // CLI output types (match packages/core/src/cli.ts)
    // -----------------------------------------------------------------------

    @Serializable
    data class CliResponse(
        val status: String,
        val error: String? = null,
        val code: String? = null,
        // generate success fields
        val message: String? = null,
        val usage: UsageInfo? = null,
        val model: String? = null,
        val retrievedCount: Int? = null,
        val topScores: List<TopScore>? = null,
        // index success fields
        val indexedCommits: Int? = null,
        val indexPath: String? = null,
        val elapsedSeconds: Double? = null,
    )

    @Serializable
    data class UsageInfo(
        val promptTokens: Int,
        val completionTokens: Int,
        val totalTokens: Int,
    )

    @Serializable
    data class TopScore(
        val hash: String,
        val message: String,
        val score: Double,
    )

    /** Parsed successful generate result. */
    data class GenerateResult(
        val message: String,
        val retrievedCount: Int,
        val topScores: List<TopScore>,
        val model: String,
    )

    // -----------------------------------------------------------------------
    // Public API
    // -----------------------------------------------------------------------

    /**
     * Check whether Node.js is available and meets the minimum version (>= 18).
     * Uses the configured nodePath from settings.
     */
    fun checkNode(): NodeCheckResult = checkNode(CommitRagSettings.instance.nodePath)

    /**
     * Check whether Node.js is available at the given path.
     * This overload exists for testability — callers outside the IntelliJ
     * Platform runtime can pass a path directly.
     */
    fun checkNode(nodePath: String): NodeCheckResult {
        val process = try {
            ProcessBuilder(nodePath, "--version")
                .redirectErrorStream(true)
                .start()
        } catch (e: Exception) {
            return NodeCheckResult(false, null, "Node.js not found at '$nodePath': ${e.message}")
        }

        val output = process.inputStream.bufferedReader(Charsets.UTF_8).use { it.readText().trim() }
        val exitCode = process.waitFor()

        if (exitCode != 0) {
            return NodeCheckResult(false, null, "Node.js exited with code $exitCode: $output")
        }

        // Parse version: "v18.17.0" or "v20.11.0" etc.
        val versionRegex = Regex("""v?(\d+)\.\d+\.\d+""")
        val match = versionRegex.find(output)
        if (match == null) {
            return NodeCheckResult(false, output, "Could not parse Node.js version from: $output")
        }

        val major = match.groupValues[1].toInt()
        val ok = major >= 18
        return NodeCheckResult(
            available = ok,
            version = output,
            error = if (ok) null else "Node.js $output is too old (need ≥ 18.x)",
        )
    }

    /**
     * Resolve API keys and inject them into the subprocess environment.
     *
     * Resolution order per key:
     * 1. System environment variable (highest precedence)
     * 2. PasswordSafe credential store (when IntelliJ Platform is available)
     * 3. Not set (CLI will report a specific MISSING_KEY error)
     *
     * When running outside the IntelliJ Platform (e.g. unit tests), PasswordSafe
     * is silently skipped — only env vars are used.
     */
    private fun injectApiKeys(pb: ProcessBuilder) {
        val env = pb.environment()

        // Only set if not already in the system env (env vars take precedence)
        if (!env.containsKey("COMMIT_RAG_DASHSCOPE_API_KEY")) {
            val key = resolveApiKey("COMMIT_RAG_DASHSCOPE_API_KEY") {
                CommitRagSettings.instance.getDashscopeKey()
            }
            if (key != null) env["COMMIT_RAG_DASHSCOPE_API_KEY"] = key
        }
        if (!env.containsKey("COMMIT_RAG_DEEPSEEK_API_KEY")) {
            val key = resolveApiKey("COMMIT_RAG_DEEPSEEK_API_KEY") {
                CommitRagSettings.instance.getDeepseekKey()
            }
            if (key != null) env["COMMIT_RAG_DEEPSEEK_API_KEY"] = key
        }
    }

    /**
     * Resolve a single API key: env var first, then a fallback (e.g. PasswordSafe).
     * Catches any throwable from the fallback so the method is safe to call
     * outside the IntelliJ Platform runtime.
     */
    private fun resolveApiKey(
        envVarName: String,
        fallback: () -> String?,
    ): String? {
        val envVal = System.getenv(envVarName)
        if (!envVal.isNullOrBlank()) return envVal

        return try {
            fallback()
        } catch (_: Exception) {
            // PasswordSafe / service() not available outside IntelliJ Platform
            null
        }
    }

    /**
     * Generate a commit message by calling `commit-rag-cli generate`.
     *
     * API keys are resolved from env vars first, then from PasswordSafe.
     *
     * Blocks until the subprocess completes (typically 3–10 seconds depending
     * on embedding API latency + LLM response time).
     *
     * @param repoPath  Absolute path to the git repository root.
     * @param cliPath   Path to the `commit-rag-cli` executable (from settings).
     * @param nodePath  Path to the `node` executable (from settings).
     */
    fun generate(repoPath: String, cliPath: String, nodePath: String): GenerateResult {
        val pb = ProcessBuilder(
            nodePath, cliPath, "generate", "--repo", repoPath
        )
            .redirectErrorStream(false)

        // Inject API keys from PasswordSafe into subprocess env
        injectApiKeys(pb)

        val process = pb.start()

        // Read stdout (JSON result)
        val stdout = process.inputStream.bufferedReader(Charsets.UTF_8).use { it.readText().trim() }
        val stderr = process.errorStream.bufferedReader(Charsets.UTF_8).use { it.readText().trim() }
        process.waitFor()

        // Parse the JSON response
        val response: CliResponse = try {
            json.decodeFromString(stdout)
        } catch (e: Exception) {
            throw CommitRagException(
                "Failed to parse CLI output.\n\n" +
                    "stdout: ${stdout.take(500)}\n" +
                    "stderr: ${stderr.take(500)}",
                "CLI_PARSE_ERROR",
            )
        }

        if (response.status == "error") {
            val detail = buildString {
                append(response.error ?: "Unknown error")
                if (stderr.isNotEmpty()) {
                    append("\n\nstderr: ${stderr.take(300)}")
                }
            }
            throw CommitRagException(detail, response.code ?: "CLI_ERROR")
        }

        // Validate success response
        val message = response.message
            ?: throw CommitRagException("CLI returned success but no message field", "CLI_MISSING_MESSAGE")

        return GenerateResult(
            message = message,
            retrievedCount = response.retrievedCount ?: 0,
            topScores = response.topScores ?: emptyList(),
            model = response.model ?: "unknown",
        )
    }

    /**
     * Build the RAG index by calling `commit-rag-cli index`.
     *
     * API keys are resolved from env vars first, then from PasswordSafe.
     */
    fun buildIndex(repoPath: String, cliPath: String, nodePath: String): IndexResult {
        val pb = ProcessBuilder(
            nodePath, cliPath, "index", "--repo", repoPath
        )
            .redirectErrorStream(false)

        // Inject API keys from PasswordSafe into subprocess env
        injectApiKeys(pb)

        val process = pb.start()

        val stdout = process.inputStream.bufferedReader(Charsets.UTF_8).use { it.readText().trim() }
        val stderr = process.errorStream.bufferedReader(Charsets.UTF_8).use { it.readText().trim() }
        val exitCode = process.waitFor()

        val response: CliResponse = try {
            json.decodeFromString(stdout)
        } catch (e: Exception) {
            throw CommitRagException(
                "Failed to parse CLI index output.\n\nstdout: ${stdout.take(500)}",
                "CLI_PARSE_ERROR",
            )
        }

        if (response.status == "error") {
            throw CommitRagException(
                response.error ?: "Unknown index error",
                response.code ?: "CLI_ERROR",
            )
        }

        return IndexResult(
            indexedCommits = response.indexedCommits ?: 0,
            indexPath = response.indexPath ?: "$repoPath/.commit-rag/index.json",
        )
    }

    // -----------------------------------------------------------------------
    // Result types
    // -----------------------------------------------------------------------

    data class NodeCheckResult(
        val available: Boolean,
        val version: String?,
        val error: String?,
    )

    data class IndexResult(
        val indexedCommits: Int,
        val indexPath: String,
    )
}

/**
 * Exception thrown when the CLI subprocess fails.
 */
class CommitRagException(
    message: String,
    val errorCode: String,
) : Exception(message)
