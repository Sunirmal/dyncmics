import * as vscode from 'vscode';

// Prompt constants
const BASE_PROMPT =
  'You are a helpful code tutor. Your job is to teach the user with simple descriptions and sample code of the concept. Respond with a guided overview of the concept in a series of messages. Do not give the user the answer directly, but guide them to find the answer themselves. If the user asks a non-programming question, politely decline to respond.';
const EXERCISES_PROMPT =
  'You are a helpful tutor. Your job is to teach the user with fun, simple exercises that they can complete in the editor. Your exercises should start simple and get more complex as the user progresses. Move one concept at a time, and do not move on to the next concept until the user provides the correct answer. Give hints in your exercises to help the user learn. If the user is stuck, you can provide the answer and explain why it is the answer. If the user asks a non-programming question, politely decline to respond.';
const CODE_REVIEW_PROMPT =
  'You are a code reviewer. Review the following code for readability, maintainability, and correctness. Provide constructive feedback and suggestions for improvement. If the user asks a non-programming question, politely decline to respond.';

// Helper: Get workspace context
function getWorkspaceContext(): string {
  const folders =
    vscode.workspace.workspaceFolders?.map(f => f.name).join(', ') || 'No workspace folders';
  const openEditors =
    vscode.window.visibleTextEditors.map(e => e.document.fileName).join(', ') || 'No open editors';

  // Get the active editor and its content
  const activeEditor = vscode.window.activeTextEditor;
  let activeFileContent = '';
  if (activeEditor) {
    const doc = activeEditor.document;
    // Limit content length to avoid sending huge files
    const maxLen = 1000;
    activeFileContent = doc.getText().slice(0, maxLen);
  }

  return `Workspace folders: ${folders}
Open editors: ${openEditors}
Active file content (truncated):\n${activeFileContent || 'No active file'}`;
}

// Helper: Get up to 10 open files' context
async function getMultipleFilesContext(): Promise<string> {
  const editors = vscode.window.visibleTextEditors.slice(0, 10);
  let filesContext = '';

  for (const editor of editors) {
    const fileName = editor.document.fileName;
    const maxLen = 1000;
    const fileContent = editor.document.getText().slice(0, maxLen);
    filesContext += `\n---\nFile: ${fileName}\nContent (truncated):\n${fileContent}\n`;
  }

  if (!filesContext) {
    filesContext = 'No open files found.';
  }

  return filesContext;
}

// Helper: Get all files in workspace, batched by 10, with language mode
async function getWorkspaceFilesInBatches(): Promise<Array<{ batch: number, files: string }>> {
  const uris = await vscode.workspace.findFiles('**/*.{js,ts,py,java,cpp,cs,go,rb,rs,php,md,txt}', '**/node_modules/**', 100);
  const batches: Array<{ batch: number, files: string }> = [];
  let batchNum = 1;

  for (let i = 0; i < uris.length; i += 10) {
    const batchUris = uris.slice(i, i + 10);
    let filesContext = '';
    for (const uri of batchUris) {
      try {
        const doc = await vscode.workspace.openTextDocument(uri);
        const maxLen = 1000;
        const fileContent = doc.getText().slice(0, maxLen);
        filesContext += `\n---\nFile: ${uri.fsPath}\nLanguage: ${doc.languageId}\nContent (truncated):\n${fileContent}\n`;
      } catch (err) {
        filesContext += `\n---\nFile: ${uri.fsPath}\nError reading file: ${err}\n`;
      }
    }
    batches.push({ batch: batchNum++, files: filesContext || 'No files in this batch.' });
  }
  return batches;
}

// Main chat handler
const handler: vscode.ChatRequestHandler = async (
  request: vscode.ChatRequest,
  context: vscode.ChatContext,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken
) => {
   // Ensure request.command is defined
    const command = request.command ?? '';
  // Select prompt based on command

  let prompt = BASE_PROMPT;
  if (command === 'exercise') {
    prompt = EXERCISES_PROMPT;
  } else if (command === 'codeReview') {
    prompt = CODE_REVIEW_PROMPT;
  }
  prompt = CODE_REVIEW_PROMPT;
  // If the request has a custom prompt, use that
  // Build message history
  const messages: vscode.LanguageModelChatMessage[] = [
    vscode.LanguageModelChatMessage.User(prompt)
  ];

  // Add previous assistant/user messages
  for (const turn of context.history) {
    if (turn instanceof vscode.ChatResponseTurn) {
      let assistantMsg = '';
      for (const part of turn.response) {
        // Check if part is a MarkdownString
        if (typeof part === 'object' && part !== null && 'value' in part && typeof (part as any).value === 'string') {
          assistantMsg += (part as any).value;
        }
      }
      messages.push(vscode.LanguageModelChatMessage.Assistant(assistantMsg));
    } else if (turn instanceof vscode.ChatRequestTurn) {
      messages.push(vscode.LanguageModelChatMessage.User(turn.prompt));
    }
  }

  messages.push(vscode.LanguageModelChatMessage.User(request.prompt));

  // Add workspace context
  const workspaceContext = getWorkspaceContext();
  messages.push(
    vscode.LanguageModelChatMessage.Assistant(`Workspace context:\n${workspaceContext}`)
  );

  // Add multiple files context
  try {
    const filesContext = await getMultipleFilesContext();
    messages.push(
      vscode.LanguageModelChatMessage.Assistant(`Code review context for up to 10 files:\n${filesContext}`)
    );
  } catch (err) {
    messages.push(
      vscode.LanguageModelChatMessage.Assistant(`Error reading files for context: ${err}`)
    );
  }

  // Only do batch processing for code review requests
  if (request.command === 'codeReview') {
    try {
      const fileBatches = await getWorkspaceFilesInBatches();
      for (const { batch, files } of fileBatches) {
        const batchMessage = vscode.LanguageModelChatMessage.Assistant(
          `Code review context for batch ${batch} (up to 10 files):\n${files}`
        );
        messages.push(batchMessage);

        // Send to model and stream response for each batch
        try {
          const chatResponse = await request.model.sendRequest(messages, {}, token);
          for await (const fragment of chatResponse.text) {
            stream.markdown(`**Batch ${batch}**\n${fragment}`);
          }
        } catch (err) {
          stream.markdown(`**Batch ${batch} Error:** ${err}`);
        }

        messages.pop(); // Remove the batch message for the next batch
      }
    } catch (err) {
      stream.markdown(`**Error getting workspace files in batches:** ${err}`);
    }
  }

  // Send to model and stream response for the main request
  try {
    const chatResponse = await request.model.sendRequest(messages, {}, token);
    for await (const fragment of chatResponse.text) {
      stream.markdown(fragment);
    }
  } catch (err) {
    stream.markdown(`**Error:** ${err}`);
  }
};

const tutor = vscode.chat.createChatParticipant('chat-tutorial.code-tutor', handler);

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('chat-tutorial.codeReview', async () => {
      // Optionally, open the chat view or provide instructions
      vscode.commands.executeCommand('workbench.action.chat.open');
      vscode.window.showInformationMessage('Type your code review request in the chat with @Virtual_Tutor.');
    })
  );
  context.subscriptions.push(tutor);
}

// If you already have an activate function, just add the command registration and tutor subscription inside it.
