package com.commitrag.intellij

import com.intellij.credentialStore.CredentialAttributes
import com.intellij.credentialStore.Credentials
import com.intellij.ide.passwordSafe.PasswordSafe
import com.intellij.openapi.components.*
import com.intellij.openapi.options.Configurable
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBPasswordField
import com.intellij.ui.components.JBTextField
import com.intellij.util.ui.FormBuilder
import javax.swing.JComponent
import javax.swing.JPanel

/**
 * Persistent plugin settings stored at the IDE (application) level.
 *
 * API keys are stored in PasswordSafe (OS keychain / credential store),
 * NOT in plain-text settings files. Environment variables take precedence
 * over PasswordSafe when both are set.
 *
 * Design doc reference: Phase 2 section 5.3
 */
@State(
    name = "CommitRagSettings",
    storages = [Storage("commit-rag.xml")],
)
@Service(Service.Level.APP)
class CommitRagSettings : PersistentStateComponent<CommitRagSettings.State> {

    data class State(
        /** Path to the Node.js executable. Default: "node" (look up on PATH). */
        var nodePath: String = "node",
        /** Path to the commit-rag-cli script. Default: "commit-rag-cli" (look up on PATH). */
        var cliPath: String = "commit-rag-cli",
    )

    private var myState = State()

    override fun getState(): State = myState

    override fun loadState(state: State) {
        myState = state
    }

    companion object {
        val instance: CommitRagSettings
            get() = service()

        // Credential attribute keys for PasswordSafe
        private const val DASHSCOPE_SERVICE = "commit-rag:dashscope"
        private const val DEEPSEEK_SERVICE = "commit-rag:deepseek"

        private val dashscopeAttributes = CredentialAttributes(DASHSCOPE_SERVICE)
        private val deepseekAttributes = CredentialAttributes(DEEPSEEK_SERVICE)
    }

    val nodePath: String get() = myState.nodePath
    val cliPath: String get() = myState.cliPath

    // -------------------------------------------------------------------
    // API key storage via PasswordSafe (OS keychain)
    // -------------------------------------------------------------------

    /**
     * Get the DashScope API key.
     * Resolution order: env var > PasswordSafe > null.
     */
    fun getDashscopeKey(): String? {
        val envKey = System.getenv("COMMIT_RAG_DASHSCOPE_API_KEY")
        if (!envKey.isNullOrBlank()) return envKey

        return PasswordSafe.instance.get(dashscopeAttributes)?.getPasswordAsString()
    }

    /**
     * Get the DeepSeek API key.
     * Resolution order: env var > PasswordSafe > null.
     */
    fun getDeepseekKey(): String? {
        val envKey = System.getenv("COMMIT_RAG_DEEPSEEK_API_KEY")
        if (!envKey.isNullOrBlank()) return envKey

        return PasswordSafe.instance.get(deepseekAttributes)?.getPasswordAsString()
    }

    /** Whether any API key is configured (env or PasswordSafe). */
    fun hasAnyKeyConfigured(): Boolean =
        getDashscopeKey() != null || getDeepseekKey() != null

    /** Whether both API keys are configured. */
    fun hasBothKeysConfigured(): Boolean =
        getDashscopeKey() != null && getDeepseekKey() != null

    /** Store the DashScope API key in PasswordSafe. */
    fun setDashscopeKey(key: String?) {
        if (key.isNullOrBlank()) {
            PasswordSafe.instance.set(dashscopeAttributes, null)
        } else {
            PasswordSafe.instance.set(dashscopeAttributes, Credentials(null, key.trim()))
        }
    }

    /** Store the DeepSeek API key in PasswordSafe. */
    fun setDeepseekKey(key: String?) {
        if (key.isNullOrBlank()) {
            PasswordSafe.instance.set(deepseekAttributes, null)
        } else {
            PasswordSafe.instance.set(deepseekAttributes, Credentials(null, key.trim()))
        }
    }
}

// ---------------------------------------------------------------------------
// Settings UI -- Tools > commit-rag
// ---------------------------------------------------------------------------

class CommitRagSettingsConfigurable : Configurable {

    private val settings = CommitRagSettings.instance

    private var nodePathField: JBTextField? = null
    private var cliPathField: JBTextField? = null
    private var dashscopeKeyField: JBPasswordField? = null
    private var deepseekKeyField: JBPasswordField? = null

    override fun getDisplayName(): String = "commit-rag"

    override fun createComponent(): JComponent {
        val nodeField = JBTextField(settings.nodePath).apply {
            emptyText.text = "node"
        }
        val cliField = JBTextField(settings.cliPath).apply {
            emptyText.text = "commit-rag-cli"
        }
        val dashscopeField = JBPasswordField().apply {
            emptyText.text = "sk-..."
            // Fill with existing key from PasswordSafe (masked by JBPasswordField)
            val existing = settings.getDashscopeKey()
            if (existing != null) {
                text = existing
            }
        }
        val deepseekField = JBPasswordField().apply {
            emptyText.text = "sk-..."
            val existing = settings.getDeepseekKey()
            if (existing != null) {
                text = existing
            }
        }

        nodePathField = nodeField
        cliPathField = cliField
        dashscopeKeyField = dashscopeField
        deepseekKeyField = deepseekField

        return FormBuilder.createFormBuilder()
            // ---- Executable paths ----
            .addLabeledComponent("Node.js path:", nodeField)
            .addComponent(JBLabel(
                "<html><small>Node.js 18 or newer is required. Default: 'node' (on PATH).</small></html>"))
            .addVerticalGap(8)
            .addLabeledComponent("commit-rag-cli path:", cliField)
            .addComponent(JBLabel(
                "<html><small>Path to the commit-rag CLI script. Default: 'commit-rag-cli' (on PATH).</small></html>"))
            .addVerticalGap(16)
            // ---- API Keys ----
            .addComponent(JBLabel("<html><h3>API Keys</h3></html>"))
            .addComponent(JBLabel(
                "<html><p>Keys are stored securely in your OS keychain (PasswordSafe).<br>" +
                    "<b>Environment variables take precedence</b> if set:<br>" +
                    "<code>COMMIT_RAG_DASHSCOPE_API_KEY</code> / " +
                    "<code>COMMIT_RAG_DEEPSEEK_API_KEY</code></p></html>"))
            .addVerticalGap(4)
            .addLabeledComponent("DashScope API key (Qwen embedding):", dashscopeField)
            .addComponent(JBLabel(
                "<html><small>Get a key at: https://dashscope.console.aliyun.com/apiKey</small></html>"))
            .addVerticalGap(8)
            .addLabeledComponent("DeepSeek API key (LLM generation):", deepseekField)
            .addComponent(JBLabel(
                "<html><small>Get a key at: https://platform.deepseek.com/api_keys</small></html>"))
            .addVerticalGap(4)
            .addComponent(JBLabel(
                "<html><small>Leave blank to use environment variables. " +
                    "Keys are never written to plain-text files.</small></html>"))
            .addComponentFillVertically(JPanel(), 0)
            .panel
    }

    override fun isModified(): Boolean {
        val currentDashscope = settings.getDashscopeKey() ?: ""
        val currentDeepseek = settings.getDeepseekKey() ?: ""
        val fieldDashscope = String(dashscopeKeyField?.password ?: charArrayOf())
        val fieldDeepseek = String(deepseekKeyField?.password ?: charArrayOf())

        return nodePathField?.text != settings.nodePath ||
            cliPathField?.text != settings.cliPath ||
            fieldDashscope != currentDashscope ||
            fieldDeepseek != currentDeepseek
    }

    override fun apply() {
        val state = settings.state
        state.nodePath = nodePathField?.text?.trim()?.ifEmpty { "node" } ?: "node"
        state.cliPath = cliPathField?.text?.trim()?.ifEmpty { "commit-rag-cli" } ?: "commit-rag-cli"
        settings.loadState(state)

        // Save API keys to PasswordSafe (empty = delete)
        val dashscopeValue = String(dashscopeKeyField?.password ?: charArrayOf()).trim()
        settings.setDashscopeKey(dashscopeValue.ifEmpty { null })

        val deepseekValue = String(deepseekKeyField?.password ?: charArrayOf()).trim()
        settings.setDeepseekKey(deepseekValue.ifEmpty { null })
    }

    override fun reset() {
        nodePathField?.text = settings.nodePath
        cliPathField?.text = settings.cliPath
        dashscopeKeyField?.text = settings.getDashscopeKey() ?: ""
        deepseekKeyField?.text = settings.getDeepseekKey() ?: ""
    }
}
