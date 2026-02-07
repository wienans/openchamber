import * as vscode from 'vscode';
import { createOpencodeClient, type Part, type PermissionRuleset, type TextPartInput } from '@opencode-ai/sdk/v2';
import { ChatViewProvider } from './ChatViewProvider';
import { AgentManagerPanelProvider } from './AgentManagerPanelProvider';
import { SessionEditorPanelProvider } from './SessionEditorPanelProvider';
import { createOpenCodeManager, type OpenCodeManager } from './opencode';
import { startGlobalEventWatcher, stopGlobalEventWatcher, setChatViewProvider } from './sessionActivityWatcher';

let chatViewProvider: ChatViewProvider | undefined;
let agentManagerProvider: AgentManagerPanelProvider | undefined;
let sessionEditorProvider: SessionEditorPanelProvider | undefined;
let openCodeManager: OpenCodeManager | undefined;
let outputChannel: vscode.OutputChannel | undefined;

let activeSessionId: string | null = null;
let activeSessionTitle: string | null = null;

const SETTINGS_KEY = 'openchamber.settings';
const INLINE_PROMPT_COMMAND = 'openchamber.inlinePrompt';

const INLINE_ROLE_PROMPT = 'You are a software engineering assistant mean to create robust and conanical code';

const INLINE_FUNCTION_PROMPT = `
You have been given a function change.
Create the contents that should be inserted at the cursor location inside the function.
If the function already contains contents, use those as context
Check the contents of the file you are in for any helper functions or context
Your response should be only the code to insert at the cursor (no explanations).

if there are DIRECTIONS, follow those when changing this function.  Do not deviate
`.trim();

const INLINE_SELECTION_PROMPT = `
You receive a selection in VS Code that you need to replace with new code.
The selection's contents may contain notes, incorporate the notes every time if there are some.
consider the context of the selection and what you are suppose to be implementing
Return only the code that should replace the selection (no explanations).
`.trim();

const inlinePromptDecoration = vscode.window.createTextEditorDecorationType({
  backgroundColor: new vscode.ThemeColor('editor.rangeHighlightBackground'),
  isWholeLine: false,
  after: {
    contentText: ' ⏳ OpenChamber',
    color: new vscode.ThemeColor('editorCodeLens.foreground'),
    margin: '0 0 0 0.5rem',
  },
});

const pendingInlinePrompts = new Map<string, { editor: vscode.TextEditor; range: vscode.Range }>();

const formatIso = (value: number | null | undefined) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '(none)';
  try {
    return new Date(value).toISOString();
  } catch {
    return String(value);
  }
};

const formatDurationMs = (value: number | null | undefined) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '(none)';
  const seconds = Math.round(value / 100) / 10;
  return `${seconds}s`;
};

const formatLineRange = (range: vscode.Range): string => {
  const startLine = range.start.line + 1;
  const endLine = range.end.line + 1;
  return startLine === endLine ? `${startLine}` : `${startLine}-${endLine}`;
};

const isTextPart = (part: Part): part is Part & { type: 'text'; text: string } => {
  return part.type === 'text' && typeof (part as { text?: string }).text === 'string';
};

const collectTextParts = (parts: Part[]): string => {
  return parts
    .filter(isTextPart)
    .map((part) => part.text)
    .join('');
};

const registerInlinePrompt = (editor: vscode.TextEditor, range: vscode.Range): string => {
  const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  pendingInlinePrompts.set(id, { editor, range });
  editor.setDecorations(
    inlinePromptDecoration,
    Array.from(pendingInlinePrompts.values())
      .filter((entry) => entry.editor === editor)
      .map((entry) => entry.range)
  );
  return id;
};

const unregisterInlinePrompt = (id: string): void => {
  const entry = pendingInlinePrompts.get(id);
  if (!entry) return;
  pendingInlinePrompts.delete(id);
  entry.editor.setDecorations(
    inlinePromptDecoration,
    Array.from(pendingInlinePrompts.values())
      .filter((other) => other.editor === entry.editor)
      .map((other) => other.range)
  );
};

const refreshInlineDecorations = (editor: vscode.TextEditor | undefined): void => {
  if (!editor) return;
  editor.setDecorations(
    inlinePromptDecoration,
    Array.from(pendingInlinePrompts.values())
      .filter((entry) => entry.editor === editor)
      .map((entry) => entry.range)
  );
};

const findEnclosingFunctionSymbol = async (
  document: vscode.TextDocument,
  position: vscode.Position
): Promise<vscode.DocumentSymbol | null> => {
  const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
    'vscode.executeDocumentSymbolProvider',
    document.uri
  );
  if (!symbols?.length) return null;

  const targetKinds = new Set([
    vscode.SymbolKind.Function,
    vscode.SymbolKind.Method,
    vscode.SymbolKind.Constructor,
  ]);

  const findIn = (items: vscode.DocumentSymbol[]): vscode.DocumentSymbol | null => {
    for (const item of items) {
      if (!item.range.contains(position)) {
        continue;
      }
      const childMatch = findIn(item.children || []);
      if (childMatch) return childMatch;
      if (targetKinds.has(item.kind)) {
        return item;
      }
    }
    return null;
  };

  return findIn(symbols);
};

const buildInlinePrompt = (options: {
  contextType: 'selection' | 'function' | 'line';
  contextRange: vscode.Range;
  contextText: string;
  filePath: string;
  fileText: string;
  instructions: string;
}): string => {
  const directions = options.instructions.trim() || 'No additional directions provided.';
  const location = `${options.filePath}:${formatLineRange(options.contextRange)}`;

  if (options.contextType === 'selection') {
    return `${INLINE_SELECTION_PROMPT}
<DIRECTIONS>
${directions}
</DIRECTIONS>
<SELECTION_LOCATION>
${location}
</SELECTION_LOCATION>
<SELECTION_CONTENT>
${options.contextText}
</SELECTION_CONTENT>
<FILE_CONTAINING_SELECTION>
${options.fileText}
</FILE_CONTAINING_SELECTION>`;
  }

  return `${INLINE_FUNCTION_PROMPT}
<DIRECTIONS>
${directions}
</DIRECTIONS>
<FUNCTION_LOCATION>
${location}
</FUNCTION_LOCATION>
<FUNCTION_TEXT>
${options.contextText}
</FUNCTION_TEXT>
<FILE_CONTAINING_FUNCTION>
${options.fileText}
</FILE_CONTAINING_FUNCTION>`;
};

export async function activate(context: vscode.ExtensionContext) {
  outputChannel = vscode.window.createOutputChannel('OpenChamber');
  context.subscriptions.push(inlinePromptDecoration);

  let moveToRightSidebarScheduled = false;

  const isCursorLikeHost = () => /\bcursor\b/i.test(vscode.env.appName);

  const findMoveToRightSidebarCommandId = async (): Promise<string | null> => {
    const commands = await vscode.commands.getCommands(true);

    const preferred = [
      // Newer VS Code naming
      'workbench.action.moveViewToSecondarySideBar',
      'workbench.action.moveViewToSecondarySidebar',
      'workbench.action.moveFocusedViewToSecondarySideBar',
      'workbench.action.moveFocusedViewToSecondarySidebar',

      // Some builds use "Auxiliary Bar" naming
      'workbench.action.moveViewToAuxiliaryBar',
      'workbench.action.moveFocusedViewToAuxiliaryBar',
    ];

    for (const commandId of preferred) {
      if (commands.includes(commandId)) return commandId;
    }

    const fuzzy = commands.find((commandId) => {
      const id = commandId.toLowerCase();
      const looksLikeMoveView = id.includes('workbench.action') && id.includes('move') && id.includes('view');
      if (!looksLikeMoveView) return false;

      // Support both "secondary sidebar" and "auxiliary bar" naming.
      return (id.includes('secondary') && id.includes('side') && id.includes('bar')) || (id.includes('auxiliary') && id.includes('bar'));
    });

    return fuzzy || null;
  };

  const attemptMoveChatToRightSidebar = async (): Promise<'moved' | 'unsupported' | 'failed'> => {
    const moveCommandId = await findMoveToRightSidebarCommandId();
    if (!moveCommandId) return 'unsupported';

    try {
      await vscode.commands.executeCommand('openchamber.chatView.focus');
      await vscode.commands.executeCommand(moveCommandId);
      return 'moved';
    } catch (error) {
      outputChannel?.appendLine(
        `[OpenChamber] Failed moving chat view to right sidebar (command=${moveCommandId}): ${error instanceof Error ? error.message : String(error)}`
      );
      return 'failed';
    }
  };

  const maybeMoveChatToRightSidebarOnStartup = async () => {
    if (isCursorLikeHost()) return;

    const attempted = context.globalState.get<boolean>('openchamber.sidebarAutoMoveAttempted') || false;
    if (attempted) return;
    await context.globalState.update('openchamber.sidebarAutoMoveAttempted', true);

    if (moveToRightSidebarScheduled) return;
    moveToRightSidebarScheduled = true;

    // Defer until after activation to avoid stealing focus during startup.
    setTimeout(() => {
      void (async () => {
        try {
          await attemptMoveChatToRightSidebar();
        } finally {
          moveToRightSidebarScheduled = false;
        }
      })();
    }, 800);
  };


  // Migration: clear legacy auto-set API URLs (ports 47680-47689 were auto-assigned by older extension versions)
  const config = vscode.workspace.getConfiguration('openchamber');
  const legacyApiUrl = config.get<string>('apiUrl') || '';
  if (/^https?:\/\/localhost:4768\d\/?$/.test(legacyApiUrl.trim())) {
    await config.update('apiUrl', '', vscode.ConfigurationTarget.Global);
  }

  // Create OpenCode manager first
  openCodeManager = createOpenCodeManager(context);

  // Create chat view provider with manager reference
  // The webview will show a loading state until OpenCode is ready
  chatViewProvider = new ChatViewProvider(context, context.extensionUri, openCodeManager);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      ChatViewProvider.viewType,
      chatViewProvider,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  // Register sidebar/focus commands AFTER the webview view provider is registered
  context.subscriptions.push(
    vscode.commands.registerCommand('openchamber.openSidebar', async () => {
      // Best-effort: open the container (if available), then focus the chat view.
      try {
        await vscode.commands.executeCommand('workbench.view.extension.openchamber');
      } catch (e) {
        outputChannel?.appendLine(`[OpenChamber] workbench.view.extension.openchamber failed: ${e}`);
      }

      try {
        await vscode.commands.executeCommand('openchamber.chatView.focus');
      } catch (e) {
        outputChannel?.appendLine(`[OpenChamber] openchamber.chatView.focus failed: ${e}`);
        vscode.window.showErrorMessage(`OpenChamber: Failed to open sidebar - ${e}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('openchamber.focusChat', async () => {
      await vscode.commands.executeCommand('openchamber.chatView.focus');
    })
  );

  void maybeMoveChatToRightSidebarOnStartup();

  // Create Agent Manager panel provider
  agentManagerProvider = new AgentManagerPanelProvider(context, context.extensionUri, openCodeManager);
  sessionEditorProvider = new SessionEditorPanelProvider(context, context.extensionUri, openCodeManager);

  context.subscriptions.push(
    vscode.commands.registerCommand('openchamber.openAgentManager', () => {
      agentManagerProvider?.createOrShow();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('openchamber.setActiveSession', (sessionId: unknown, title?: unknown) => {
      if (typeof sessionId === 'string' && sessionId.trim().length > 0) {
        activeSessionId = sessionId.trim();
        activeSessionTitle = typeof title === 'string' && title.trim().length > 0 ? title.trim() : null;
        return;
      }

      activeSessionId = null;
      activeSessionTitle = null;
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('openchamber.openActiveSessionInEditor', () => {
      if (!activeSessionId) {
        vscode.window.showInformationMessage('OpenChamber: No active session');
        return;
      }
      sessionEditorProvider?.createOrShow(activeSessionId, activeSessionTitle ?? undefined);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('openchamber.openSessionInEditor', (sessionId: string, title?: string) => {
      if (typeof sessionId !== 'string' || sessionId.trim().length === 0) {
        return;
      }
      sessionEditorProvider?.createOrShow(sessionId.trim(), title);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('openchamber.openNewSessionInEditor', () => {
      sessionEditorProvider?.createOrShowNewSession();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('openchamber.openCurrentOrNewSessionInEditor', () => {
      if (activeSessionId) {
        sessionEditorProvider?.createOrShow(activeSessionId, activeSessionTitle ?? undefined);
      } else {
        sessionEditorProvider?.createOrShowNewSession();
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('openchamber.restartApi', async () => {
      try {
        await openCodeManager?.restart();
        vscode.window.showInformationMessage('OpenChamber: API connection restarted');
      } catch (e) {
        vscode.window.showErrorMessage(`OpenChamber: Failed to restart API - ${e}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('openchamber.addToContext', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage('OpenChamber [Add to Context]:No active editor');
        return;
      }

      const selection = editor.selection;
      const selectedText = editor.document.getText(selection);

      if (!selectedText) {
        vscode.window.showWarningMessage('OpenChamber [Add to Context]: No text selected');
        return;
      }

      // Get file info for context
      const filePath = vscode.workspace.asRelativePath(editor.document.uri);
      const languageId = editor.document.languageId;
      
      // Get line numbers (1-based for display)
      const startLine = selection.start.line + 1;
      const endLine = selection.end.line + 1;
      const lineRange = startLine === endLine ? `${startLine}` : `${startLine}-${endLine}`;

      // Format as file path with line numbers, followed by markdown code block
      const contextText = `${filePath}:${lineRange}\n\`\`\`${languageId}\n${selectedText}\n\`\`\``;

      // Send to webview and reveal the panel
      chatViewProvider?.addTextToInput(contextText);

      // Focus the chat panel
      vscode.commands.executeCommand('openchamber.focusChat');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('openchamber.explain', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage('OpenChamber [Explain]: No active editor');
        return;
      }

      const selection = editor.selection;
      const selectedText = editor.document.getText(selection);
      const filePath = vscode.workspace.asRelativePath(editor.document.uri);
      const languageId = editor.document.languageId;

      let prompt: string;

      if (selectedText) {
        // Selection exists - explain the selected code
        const startLine = selection.start.line + 1;
        const endLine = selection.end.line + 1;
        const lineRange = startLine === endLine ? `${startLine}` : `${startLine}-${endLine}`;
        prompt = `Explain the following Code / Text:\n\n${filePath}:${lineRange}\n\`\`\`${languageId}\n${selectedText}\n\`\`\``;
      } else {
        // No selection - explain the entire file
        prompt = `Explain the following Code / Text:\n\n${filePath}`;
      }

      // Create new session and send the prompt
      chatViewProvider?.createNewSessionWithPrompt(prompt);
      vscode.commands.executeCommand('openchamber.focusChat');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('openchamber.improveCode', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage('OpenChamber [Improve Code]: No active editor');
        return;
      }

      const selection = editor.selection;
      const selectedText = editor.document.getText(selection);

      if (!selectedText) {
        vscode.window.showWarningMessage('OpenChamber [Improve Code]: No text selected');
        return;
      }

      const filePath = vscode.workspace.asRelativePath(editor.document.uri);
      const languageId = editor.document.languageId;
      const startLine = selection.start.line + 1;
      const endLine = selection.end.line + 1;
      const lineRange = startLine === endLine ? `${startLine}` : `${startLine}-${endLine}`;

      const prompt = `Improve the following Code:\n\n${filePath}:${lineRange}\n\`\`\`${languageId}\n${selectedText}\n\`\`\``;

      // Create new session and send the prompt
      chatViewProvider?.createNewSessionWithPrompt(prompt);
      vscode.commands.executeCommand('openchamber.focusChat');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(INLINE_PROMPT_COMMAND, async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage('OpenChamber [Inline Prompt]: No active editor');
        return;
      }

      if (!openCodeManager) {
        vscode.window.showErrorMessage('OpenChamber [Inline Prompt]: OpenCode manager is unavailable');
        return;
      }

      if (openCodeManager.getStatus() !== 'connected') {
        try {
          await openCodeManager.start();
        } catch (error) {
          vscode.window.showErrorMessage('OpenChamber [Inline Prompt]: OpenCode API is not ready yet');
          outputChannel?.appendLine(
            `[OpenChamber] Inline prompt failed to start API: ${error instanceof Error ? error.message : String(error)}`
          );
          return;
        }
      }

      const selection = editor.selection;
      const selectedText = editor.document.getText(selection);
      const insertionRange = selection.isEmpty
        ? new vscode.Range(selection.active, selection.active)
        : new vscode.Range(selection.start, selection.end);

      const filePath = vscode.workspace.asRelativePath(editor.document.uri);
      const fileText = editor.document.getText();

      let contextType: 'selection' | 'function' | 'line' = 'selection';
      let contextRange = selection;
      let contextText = selectedText;

      if (!selectedText) {
        const symbol = await findEnclosingFunctionSymbol(editor.document, selection.active);
        if (symbol) {
          contextType = 'function';
          contextRange = symbol.range;
          contextText = editor.document.getText(symbol.range);
        } else {
          contextType = 'line';
          contextRange = editor.document.lineAt(selection.active.line).range;
          contextText = editor.document.getText(contextRange);
          vscode.window.showInformationMessage(
            'OpenChamber [Inline Prompt]: No function found at cursor, using current line context'
          );
        }
      }

      const userInstructions = await vscode.window.showInputBox({
        title: 'OpenChamber Inline Prompt',
        prompt: 'What should be implemented?',
        placeHolder: 'Add any additional instructions for the AI',
        ignoreFocusOut: true,
      });

      if (userInstructions === undefined) {
        return;
      }

      const promptText = buildInlinePrompt({
        contextType,
        contextRange,
        contextText,
        filePath,
        fileText,
        instructions: userInstructions,
      });

      const apiUrl = openCodeManager.getApiUrl();
      if (!apiUrl) {
        vscode.window.showErrorMessage('OpenChamber [Inline Prompt]: OpenCode API URL is unavailable');
        return;
      }

      const workingDirectory = openCodeManager.getWorkingDirectory();
      const indicatorRange = selection.isEmpty
        ? editor.document.lineAt(selection.active.line).range
        : selection;
      const promptId = registerInlinePrompt(editor, indicatorRange);

      try {
        const permission: PermissionRuleset = { edit: 'deny' };
        const client = createOpencodeClient({ baseUrl: apiUrl, directory: workingDirectory });
        const session = await client.session.create(
          {
            directory: workingDirectory,
            title: 'Inline Prompt',
            permission,
          },
          { responseStyle: 'data', throwOnError: true }
        );

        const parts: TextPartInput[] = [{ type: 'text', text: promptText }];
        const response = await client.session.prompt(
          {
            sessionID: session.id,
            directory: workingDirectory,
            agent: 'general',
            system: INLINE_ROLE_PROMPT,
            parts,
          },
          { responseStyle: 'data', throwOnError: true }
        );

        const output = collectTextParts(response.parts);
        if (!output.trim()) {
          vscode.window.showInformationMessage('OpenChamber [Inline Prompt]: No text output received');
          return;
        }

        if (editor.document.isClosed) {
          vscode.window.showWarningMessage('OpenChamber [Inline Prompt]: Editor was closed before insertion');
          return;
        }

        await editor.edit((editBuilder) => {
          editBuilder.replace(insertionRange, output);
        });
      } catch (error) {
        vscode.window.showErrorMessage('OpenChamber [Inline Prompt]: Failed to get response from OpenCode');
        outputChannel?.appendLine(
          `[OpenChamber] Inline prompt error: ${error instanceof Error ? error.message : String(error)}`
        );
      } finally {
        unregisterInlinePrompt(promptId);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('openchamber.newSession', () => {
      chatViewProvider?.createNewSession();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('openchamber.showSettings', () => {
      chatViewProvider?.showSettings();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('openchamber.showOpenCodeStatus', async () => {
      const config = vscode.workspace.getConfiguration('openchamber');
      const configuredApiUrl = (config.get<string>('apiUrl') || '').trim();

      const extensionVersion = String(context.extension?.packageJSON?.version || '');
      const workspaceFolders = (vscode.workspace.workspaceFolders || []).map((folder) => folder.uri.fsPath);
      const primaryWorkspace = workspaceFolders[0] || '';

      const debug = openCodeManager?.getDebugInfo();
      const resolvedApiUrl = openCodeManager?.getApiUrl();
      const workingDirectory = openCodeManager?.getWorkingDirectory() ?? '';
      const workingDirectoryMatchesWorkspace = Boolean(primaryWorkspace && workingDirectory === primaryWorkspace);
      let resolvedApiPath = '';
      if (resolvedApiUrl) {
        try {
          resolvedApiPath = new URL(resolvedApiUrl).pathname || '/';
        } catch {
          resolvedApiPath = '(invalid url)';
        }
      }

      const safeFetch = async (input: string, timeoutMs = 6000) => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        const startedAt = Date.now();
        try {
          const resp = await fetch(input, {
            method: 'GET',
            headers: { Accept: 'application/json' },
            signal: controller.signal,
          });
          const elapsedMs = Date.now() - startedAt;
          const contentType = resp.headers.get('content-type') || '';
          const isJson = contentType.toLowerCase().includes('json') && !contentType.toLowerCase().includes('text/html');

          let summary = '';
          if (isJson) {
            const json = await resp.json().catch(() => null);
            if (Array.isArray(json)) {
              summary = `json[array] len=${json.length}`;
            } else if (json && typeof json === 'object') {
              const keys = Object.keys(json).slice(0, 8);
              summary = `json[object] keys=${keys.join(',')}${Object.keys(json).length > keys.length ? ',…' : ''}`;
            } else {
              summary = `json[${typeof json}]`;
            }
          } else {
            summary = contentType ? `content-type=${contentType}` : 'no content-type';
          }

          return { ok: resp.ok && isJson, status: resp.status, elapsedMs, summary };
        } catch (error) {
          const elapsedMs = Date.now() - startedAt;
          const isAbort =
            controller.signal.aborted ||
            (error instanceof Error && (error.name === 'AbortError' || error.message.toLowerCase().includes('aborted')));
          const message = isAbort
            ? `timeout after ${timeoutMs}ms`
            : error instanceof Error
              ? error.message
              : String(error);
          return { ok: false, status: 0, elapsedMs, summary: `error=${message}` };
        } finally {
          clearTimeout(timeout);
        }
      };

      const buildProbeUrl = (pathname: string, includeDirectory = true) => {
        if (!resolvedApiUrl) return null;
        const base = `${resolvedApiUrl.replace(/\/+$/, '')}/`;
        const url = new URL(pathname.replace(/^\/+/, ''), base);
        if (includeDirectory && workingDirectory) {
          url.searchParams.set('directory', workingDirectory);
        }
        return url.toString();
      };

      const probeTargets: Array<{ label: string; path: string; includeDirectory?: boolean; timeoutMs?: number }> = [
        { label: 'health', path: '/global/health', includeDirectory: false },
        { label: 'config', path: '/config', includeDirectory: true },
        { label: 'providers', path: '/config/providers', includeDirectory: true },
        // Can be slower on large configs; keep the probe from producing false negatives.
        { label: 'agents', path: '/agent', includeDirectory: true, timeoutMs: 12000 },
        { label: 'commands', path: '/command', includeDirectory: true, timeoutMs: 10000 },
        { label: 'project', path: '/project/current', includeDirectory: true },
        { label: 'path', path: '/path', includeDirectory: true },
        // Session listing is what powers the sidebar. This helps diagnose "no sessions shown" bugs.
        { label: 'sessions', path: '/session', includeDirectory: true, timeoutMs: 12000 },
        { label: 'sessionStatus', path: '/session/status', includeDirectory: true },
      ];

      const probes = resolvedApiUrl
        ? await Promise.all(
            probeTargets.map(async (entry) => {
              const url = buildProbeUrl(entry.path, entry.includeDirectory !== false);
              if (!url) {
                return { label: entry.label, url: '(none)', result: null as null };
              }
              const result = await safeFetch(url, typeof entry.timeoutMs === 'number' ? entry.timeoutMs : undefined);
              return { label: entry.label, url, result };
            })
          )
        : [];

      const storedSettings = context.globalState.get<Record<string, unknown>>(SETTINGS_KEY) || {};
      const settingsKeys = Object.keys(storedSettings).filter((key) => key !== 'lastDirectory');

      const lines = [
        `Time: ${new Date().toISOString()}`,
        `OpenChamber version: ${extensionVersion || '(unknown)'}`,
        `OpenCode Version: ${debug?.version ?? '(unknown)'}`,
        `VS Code version: ${vscode.version}`,
        `Platform: ${process.platform} ${process.arch}`,
        `Workspace folders: ${workspaceFolders.length}${workspaceFolders.length ? ` (${workspaceFolders.join(', ')})` : ''}`,
        `Status: ${openCodeManager?.getStatus() ?? 'unknown'}`,
        `Working directory: ${workingDirectory}`,
        `Working dir matches workspace: ${workingDirectoryMatchesWorkspace ? 'yes' : 'no'}`,
        `API URL (configured): ${configuredApiUrl || '(none)'}`,
        `OpenCode binary (configured): ${(vscode.workspace.getConfiguration('openchamber').get<string>('opencodeBinary') || '').trim() || '(none)'}`,
        `API URL (resolved): ${openCodeManager?.getApiUrl() ?? '(none)'}`,
        `API URL path: ${resolvedApiPath || '(none)'}`,
        debug
          ? `OpenCode server URL: ${debug.serverUrl ?? '(none)'}`
          : `OpenCode server URL: (unknown)`,
        debug
          ? `OpenCode mode: ${debug.mode} (starts=${debug.startCount}, restarts=${debug.restartCount})`
          : `OpenCode mode: (unknown)`,
        debug
          ? `OpenCode CLI path: ${debug.cliPath || '(not found - SDK manages process)'}`
          : `OpenCode CLI path: (unknown)`,
        debug
          ? `OpenCode detected port: ${debug.detectedPort ?? '(none)'}`
          : `OpenCode detected port: (unknown)`,
        debug
          ? `OpenCode API prefix: ${debug.apiPrefixDetected ? (debug.apiPrefix || '(root)') : '(unknown)'}`
          : `OpenCode API prefix: (unknown)`,
        debug
          ? `Last start: ${formatIso(debug.lastStartAt)}`
          : `Last start: (unknown)`,
        debug
          ? `Last ready: ${debug.lastReadyElapsedMs !== null ? `${debug.lastReadyElapsedMs}ms` : '(unknown)'}`
          : `Last ready: (unknown)`,
        debug
          ? `Ready attempts: ${debug.lastReadyAttempts ?? '(unknown)'}`
          : `Ready attempts: (unknown)`,
        debug
          ? `Start attempts: ${debug.lastStartAttempts ?? '(unknown)'}`
          : `Start attempts: (unknown)`,
        debug
          ? `Last connected: ${formatIso(debug.lastConnectedAt)}`
          : `Last connected: (unknown)`,
        debug && debug.lastConnectedAt ? `Connected for: ${formatDurationMs(Date.now() - debug.lastConnectedAt)}` : `Connected for: (n/a)`,
        debug && debug.lastExitCode !== null ? `Last exit code: ${debug.lastExitCode}` : `Last exit code: (none)`,
        debug?.lastError ? `Last error: ${debug.lastError}` : `Last error: (none)`,
        `Settings keys (stored): ${settingsKeys.length ? settingsKeys.join(', ') : '(none)'}`,
        probes.length ? '' : '',
        ...(probes.length
          ? [
              'OpenCode API probes:',
              ...probes.map((probe) => {
                if (!probe.result) return `- ${probe.label}: (no url)`;
                const { ok, status, elapsedMs, summary } = probe.result;
                const suffix = ok ? '' : ` url=${probe.url}`;
                return `- ${probe.label}: ${ok ? 'ok' : 'fail'} status=${status} time=${elapsedMs}ms ${summary}${suffix}`;
              }),
            ]
          : []),
        '',
      ];

      outputChannel?.appendLine(lines.join('\n'));
      outputChannel?.show(true);
    })
  );

  context.subscriptions.push(
    vscode.window.onDidChangeActiveColorTheme((theme) => {
      chatViewProvider?.updateTheme(theme.kind);
      agentManagerProvider?.updateTheme(theme.kind);
      sessionEditorProvider?.updateTheme(theme.kind);
    })
  );

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      refreshInlineDecorations(editor);
    })
  );

  // Theme changes can update the `workbench.colorTheme` setting slightly after the
  // `activeColorTheme` event. Listen for config changes too so we can re-resolve
  // the contributed theme JSON and update Shiki themes in the webview.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration('workbench.colorTheme') ||
        event.affectsConfiguration('workbench.preferredLightColorTheme') ||
        event.affectsConfiguration('workbench.preferredDarkColorTheme')
      ) {
        chatViewProvider?.updateTheme(vscode.window.activeColorTheme.kind);
        agentManagerProvider?.updateTheme(vscode.window.activeColorTheme.kind);
        sessionEditorProvider?.updateTheme(vscode.window.activeColorTheme.kind);
      }
    })
  );

  // Subscribe to status changes - this broadcasts to webview
  context.subscriptions.push(
    openCodeManager.onStatusChange((status, error) => {
      chatViewProvider?.updateConnectionStatus(status, error);
      agentManagerProvider?.updateConnectionStatus(status, error);
      sessionEditorProvider?.updateConnectionStatus(status, error);

      // Start/stop global event watcher based on connection status
      // Mirrors web server and desktop Tauri behavior
      if (status === 'connected' && chatViewProvider && openCodeManager) {
        setChatViewProvider(chatViewProvider);
        void startGlobalEventWatcher(openCodeManager, chatViewProvider);
      } else if (status === 'disconnected' || status === 'error') {
        stopGlobalEventWatcher();
      }
    })
  );

  // Start OpenCode API without blocking activation.
  // Blocking here delays webview resolution and causes a blank panel until startup completes.
  void openCodeManager.start();
}

export async function deactivate() {
  stopGlobalEventWatcher();
  await openCodeManager?.stop();
  openCodeManager = undefined;
  chatViewProvider = undefined;
  agentManagerProvider = undefined;
  sessionEditorProvider = undefined;
  outputChannel?.dispose();
  outputChannel = undefined;
}
