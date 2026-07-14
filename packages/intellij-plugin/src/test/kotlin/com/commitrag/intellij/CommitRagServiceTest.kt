package com.commitrag.intellij

import kotlinx.serialization.json.Json
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable
import java.io.File

/**
 * Tests for [CommitRagService] -- the CLI subprocess wrapper.
 *
 * Phase 2 Day 3 objective: verify that ProcessBuilder -> CLI -> JSON parse
 * works end-to-end from Kotlin.
 *
 * Test categories:
 * 1. Pure JSON parsing (no external dependencies)
 * 2. Node.js detection
 * 3. CLI integration: error paths (no API keys needed)
 * 4. CLI integration: full pipeline (requires API keys, skipped by default)
 */
class CommitRagServiceTest {

    companion object {
        /** Resolved path to commit-rag-cli.js, or null if not available. */
        private var cliPath: String? = null
        private var repoPath: String? = null

        /** Hard-coded copy of the JSON parser for direct parse tests. */
        private val json = Json {
            ignoreUnknownKeys = true
            isLenient = true
        }

        @JvmStatic
        @BeforeAll
        fun resolvePaths() {
            // Resolve CLI path: check system property, then relative paths
            cliPath = System.getProperty("commitrag.cli.path")
                ?: System.getenv("COMMIT_RAG_CLI_PATH")
                ?: findCli()

            // Resolve repo path (this project itself, for git operations)
            repoPath = System.getProperty("commitrag.repo.path")
                ?: findRepoRoot()
        }

        /**
         * Walk up from the current directory to find the monorepo root,
         * then build the path to packages/core/dist/cli.js.
         */
        private fun findCli(): String? {
            var dir = File(System.getProperty("user.dir"))
            for (i in 1..5) {
                val candidate = File(dir, "packages/core/dist/cli.js")
                if (candidate.exists()) return candidate.absolutePath
                dir = dir.parentFile ?: break
            }
            return null
        }

        private fun findRepoRoot(): String? {
            var dir = File(System.getProperty("user.dir"))
            for (i in 1..5) {
                val candidate = File(dir, ".git")
                if (candidate.exists() && candidate.isDirectory) return dir.absolutePath
                dir = dir.parentFile ?: break
            }
            return null
        }
    }

    // =====================================================================
    // Phase 1: Pure JSON parsing (no external deps, always runs)
    // =====================================================================

    @Test
    fun parseErrorResponseJSON() {
        val jsonText = """
            {"status":"error","error":"DashScope API key not configured.","code":"MISSING_DASHSCOPE_KEY"}
        """.trimIndent()

        val response = json.decodeFromString<CommitRagService.CliResponse>(jsonText)

        assertEquals("error", response.status)
        assertEquals("MISSING_DASHSCOPE_KEY", response.code)
        assertTrue(response.error!!.contains("DashScope"))
        assertNull(response.message)
    }

    @Test
    fun parseSuccessGenerateResponseJSON() {
        val jsonText = """
            {
              "status": "ok",
              "message": "feat(auth): add JWT middleware with role-based access control",
              "usage": { "promptTokens": 1802, "completionTokens": 13, "totalTokens": 1815 },
              "model": "deepseek-chat",
              "retrievedCount": 5,
              "topScores": [
                { "hash": "abc1234", "message": "feat(core): add auth module", "score": 0.8521 },
                { "hash": "def5678", "message": "chore: initial scaffold", "score": 0.4233 }
              ]
            }
        """.trimIndent()

        val response = json.decodeFromString<CommitRagService.CliResponse>(jsonText)

        assertEquals("ok", response.status)
        assertEquals("feat(auth): add JWT middleware with role-based access control", response.message)
        assertEquals(5, response.retrievedCount)
        assertEquals("deepseek-chat", response.model)
        assertEquals(2, response.topScores!!.size)
        assertEquals("abc1234", response.topScores!![0].hash)
        assertEquals(0.8521, response.topScores!![0].score, 0.0001)
        assertNull(response.error)
    }

    @Test
    fun parseSuccessIndexResponseJSON() {
        val jsonText = """
            {"status":"ok","indexedCommits":200,"indexPath":"/repo/.commit-rag/index.json","elapsedSeconds":3.5}
        """.trimIndent()

        val response = json.decodeFromString<CommitRagService.CliResponse>(jsonText)

        assertEquals("ok", response.status)
        assertEquals(200, response.indexedCommits)
        assertEquals("/repo/.commit-rag/index.json", response.indexPath)
        assertEquals(3.5, response.elapsedSeconds!!, 0.01)
        assertNull(response.error)
    }

    @Test
    fun parseResponseWithUnknownExtraFieldsIsTolerant() {
        val jsonText = """
            {"status":"ok","message":"fix: typo","extraField":123,"anotherOne":{"nested":true}}
        """.trimIndent()

        // Should NOT throw since json is configured with ignoreUnknownKeys = true
        val response = json.decodeFromString<CommitRagService.CliResponse>(jsonText)
        assertEquals("ok", response.status)
        assertEquals("fix: typo", response.message)
    }

    @Test
    fun commitRagExceptionStoresErrorCode() {
        val ex = CommitRagException("Something went wrong", "TEST_CODE")
        assertEquals("TEST_CODE", ex.errorCode)
        assertEquals("Something went wrong", ex.message)
    }

    // =====================================================================
    // Phase 2: Node.js detection
    // =====================================================================

    @Test
    fun nodejsIsAvailableAndMeetsVersionRequirement() {
        val result = CommitRagService.checkNode("node")
        assertTrue(result.available, "Node.js should be installed (>= 18 required)")
        assertNotNull(result.version)
        assertNull(result.error)
        println("Node.js version: ${result.version}")
    }

    @Test
    fun nodejsDetectionDoesNotThrow() {
        // Verify checkNode() doesn't crash even in edge cases
        val result = CommitRagService.checkNode("node")
        assertNotNull(result)
    }

    // =====================================================================
    // Phase 3: CLI integration -- error paths (no API keys needed)
    // =====================================================================

    @Test
    fun cliReturnsMissingDashscopeKeyWhenNoEnvVarsSet() {
        org.junit.jupiter.api.Assumptions.assumeTrue(
            cliPath != null,
            "Skipped: commit-rag-cli not found. Build @commit-rag/core first."
        )
        org.junit.jupiter.api.Assumptions.assumeTrue(
            repoPath != null,
            "Skipped: not inside a git repository."
        )

        val ex = assertThrows(CommitRagException::class.java) {
            CommitRagService.generate(
                repoPath = repoPath!!,
                cliPath = cliPath!!,
                nodePath = "node",
            )
        }

        // The CLI checks DashScope key first
        assertTrue(
            ex.errorCode == "MISSING_DASHSCOPE_KEY" || ex.errorCode == "CLI_ERROR",
            "Expected MISSING_DASHSCOPE_KEY or CLI_ERROR, got: ${ex.errorCode}"
        )
        println("CLI error: [${ex.errorCode}] ${ex.message!!.take(200)}")
    }

    @Test
    fun cliReturnsMissingDeepseekKeyWhenOnlyDashscopeKeySet() {
        org.junit.jupiter.api.Assumptions.assumeTrue(cliPath != null, "CLI not found")
        org.junit.jupiter.api.Assumptions.assumeTrue(repoPath != null, "Not in git repo")

        val ex = assertThrows(CommitRagException::class.java) {
            // Pass a fake DashScope key; CLI should fail on DeepSeek check next
            val env = mapOf("COMMIT_RAG_DASHSCOPE_API_KEY" to "test-fake-key")
            callCliWithEnv(repoPath!!, cliPath!!, "node", env)
        }

        assertTrue(
            ex.errorCode == "MISSING_DEEPSEEK_KEY" || ex.errorCode == "CLI_ERROR",
            "Expected MISSING_DEEPSEEK_KEY, got: ${ex.errorCode}"
        )
        println("CLI error: [${ex.errorCode}] ${ex.message!!.take(200)}")
    }

    @Test
    fun cliHandlesGenerateGracefully() {
        org.junit.jupiter.api.Assumptions.assumeTrue(cliPath != null, "CLI not found")
        org.junit.jupiter.api.Assumptions.assumeTrue(repoPath != null, "Not in git repo")

        // This repo might have staged changes, env vars, an index, etc.
        // We just verify the CLI runs and returns a predictable response
        // without crashing.
        try {
            val result = CommitRagService.generate(
                repoPath = repoPath!!,
                cliPath = cliPath!!,
                nodePath = "node",
            )
            // If we get here, the CLI ran successfully (API keys were in env)
            println("Unexpected success (API keys available in env): ${result.message.take(80)}")
            assertTrue(result.message.isNotEmpty())
            assertTrue(result.retrievedCount >= 0)
        } catch (ex: CommitRagException) {
            // Expected: no API keys, or no staged changes
            println("CLI error (expected): [${ex.errorCode}] ${ex.message!!.take(200)}")
            assertTrue(
                ex.errorCode in listOf(
                    "MISSING_DASHSCOPE_KEY", "MISSING_DEEPSEEK_KEY",
                    "NO_STAGED_CHANGES", "NO_INDEX", "CLI_ERROR", "GIT_ERROR"
                ),
                "Unexpected error code: ${ex.errorCode}"
            )
        }
    }

    @Test
    fun cliReturnsNoIndexWhenIndexMissing() {
        org.junit.jupiter.api.Assumptions.assumeTrue(cliPath != null, "CLI not found")
        org.junit.jupiter.api.Assumptions.assumeTrue(repoPath != null, "Not in git repo")

        // Create a temp git repo, stage a change, but DON'T build the RAG index
        val tmpDir = File.createTempFile("commitrag-test-", "")
        tmpDir.delete()
        tmpDir.mkdirs()
        try {
            // Init git repo
            ProcessBuilder("git", "init")
                .directory(tmpDir)
                .redirectErrorStream(true)
                .start().also { it.inputStream.bufferedReader().use { r -> r.readText() }; it.waitFor() }

            ProcessBuilder("git", "config", "user.email", "test@test.com")
                .directory(tmpDir).start().waitFor()
            ProcessBuilder("git", "config", "user.name", "Test")
                .directory(tmpDir).start().waitFor()

            // Create and commit a file (needed for git to have a baseline)
            File(tmpDir, "test.txt").writeText("hello")
            ProcessBuilder("git", "add", "test.txt").directory(tmpDir).start().waitFor()
            ProcessBuilder("git", "commit", "-m", "initial commit").directory(tmpDir).start().waitFor()

            // Stage a change
            File(tmpDir, "test.txt").writeText("hello world")
            ProcessBuilder("git", "add", "test.txt").directory(tmpDir).start().waitFor()

            // Call generate -- should fail with NO_INDEX since .commit-rag/ doesn't exist
            val ex = assertThrows(CommitRagException::class.java) {
                val env = mapOf(
                    "COMMIT_RAG_DASHSCOPE_API_KEY" to "test-key",
                    "COMMIT_RAG_DEEPSEEK_API_KEY" to "test-key",
                )
                callCliWithEnv(tmpDir.absolutePath, cliPath!!, "node", env)
            }

            println("CLI error (expected NO_INDEX): [${ex.errorCode}] ${ex.message!!.take(200)}")
            assertEquals("NO_INDEX", ex.errorCode,
                "Expected NO_INDEX since .commit-rag/index.json doesn't exist in temp repo")
        } finally {
            tmpDir.deleteRecursively()
        }
    }

    // =====================================================================
    // Phase 4: Full pipeline (only if real API keys are configured)
    // =====================================================================

    @Test
    @EnabledIfEnvironmentVariable(
        named = "COMMIT_RAG_DASHSCOPE_API_KEY",
        matches = ".+",
        disabledReason = "No DashScope API key configured"
    )
    @EnabledIfEnvironmentVariable(
        named = "COMMIT_RAG_DEEPSEEK_API_KEY",
        matches = ".+",
        disabledReason = "No DeepSeek API key configured"
    )
    fun fullPipelineGeneratesCommitMessageForStagedChanges() {
        org.junit.jupiter.api.Assumptions.assumeTrue(cliPath != null, "CLI not found")
        org.junit.jupiter.api.Assumptions.assumeTrue(repoPath != null, "Not in git repo")

        // Create a temp file, stage it, generate, then clean up
        val tmpFile = File(repoPath, "test-cli-temp.txt")
        try {
            tmpFile.writeText("// Test change for Phase 2 Day 3 smoke test\n// JWT auth middleware\n")
            ProcessBuilder("git", "add", tmpFile.name)
                .directory(File(repoPath))
                .start()
                .waitFor()

            // Build index first if needed
            try {
                CommitRagService.buildIndex(
                    repoPath = repoPath!!,
                    cliPath = cliPath!!,
                    nodePath = "node",
                )
                println("Index built successfully")
            } catch (ex: CommitRagException) {
                println("Index skipped: [${ex.errorCode}] ${ex.message!!.take(100)}")
            }

            // Generate
            val result = CommitRagService.generate(
                repoPath = repoPath!!,
                cliPath = cliPath!!,
                nodePath = "node",
            )

            println("Generated message: ${result.message}")
            println("Retrieved: ${result.retrievedCount} similar commits")
            println("Model: ${result.model}")
            result.topScores.forEach { score ->
                println("  ${score.hash} (${"%.4f".format(score.score)}) ${score.message.take(60)}")
            }

            assertTrue(result.message.isNotEmpty(), "Message should not be empty")
            assertTrue(result.message.length <= 200, "Message should be reasonably short")
            assertTrue(result.retrievedCount >= 0, "retrievedCount should be non-negative")

        } finally {
            // Cleanup: unstage
            ProcessBuilder("git", "reset", "--", tmpFile.name)
                .directory(File(repoPath))
                .start()
                .waitFor()
            tmpFile.delete()
        }
    }

    // =====================================================================
    // Helpers
    // =====================================================================

    /**
     * Call the CLI generate command with custom environment variables,
     * using the same ProcessBuilder approach as CommitRagService.generate()
     * but with custom env vars injected.
     */
    private fun callCliWithEnv(
        repoPath: String,
        cliPath: String,
        nodePath: String,
        extraEnv: Map<String, String>,
    ): CommitRagService.GenerateResult {
        val pb = ProcessBuilder(nodePath, cliPath, "generate", "--repo", repoPath)
            .redirectErrorStream(false)

        // Inject custom env vars
        val env = pb.environment()
        extraEnv.forEach { (key, value) -> env[key] = value }

        val process = pb.start()
        val stdout = process.inputStream.bufferedReader(Charsets.UTF_8).use { it.readText().trim() }
        val stderr = process.errorStream.bufferedReader(Charsets.UTF_8).use { it.readText().trim() }
        process.waitFor()

        // Parse with the same logic as CommitRagService
        val response = try {
            json.decodeFromString<CommitRagService.CliResponse>(stdout)
        } catch (e: Exception) {
            throw CommitRagException(
                "Failed to parse CLI output.\nstdout: ${stdout.take(300)}\nstderr: ${stderr.take(300)}",
                "CLI_PARSE_ERROR",
            )
        }

        if (response.status == "error") {
            throw CommitRagException(
                response.error ?: "Unknown error",
                response.code ?: "CLI_ERROR",
            )
        }

        return CommitRagService.GenerateResult(
            message = response.message!!,
            retrievedCount = response.retrievedCount ?: 0,
            topScores = response.topScores ?: emptyList(),
            model = response.model ?: "unknown",
        )
    }
}
