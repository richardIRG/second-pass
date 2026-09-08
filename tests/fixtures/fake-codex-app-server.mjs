import { readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import readline from 'node:readline';

const reader = readline.createInterface({ input: process.stdin });
let pendingApproval = null;
let threadReadCount = 0;

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function thread(id, cwd, includeHistory = false, includeWatchMessages = false) {
  const documentPath = process.env.SECOND_PASS_FAKE_DOCUMENT_PATH;
  const projectRoot = process.env.SECOND_PASS_FAKE_PROJECT_ROOT;
  const documentPaths = process.env.SECOND_PASS_FAKE_DOCUMENT_PATHS
    ? JSON.parse(process.env.SECOND_PASS_FAKE_DOCUMENT_PATHS)
    : documentPath ? [documentPath] : [];
  const workspace = cwd ?? projectRoot ?? (documentPath ? dirname(documentPath) : process.cwd());
  return {
    id,
    cwd: workspace,
    turns: includeHistory && documentPaths.length > 0 ? [{
      id: 'existing-turn',
      startedAt: 1,
      items: [{ id: 'existing-file-change', type: 'fileChange', changes: documentPaths.map((path) => ({ path, kind: 'update' })) }],
    }, ...(includeWatchMessages ? [{
      id: 'external-turn',
      status: 'completed',
      startedAt: 2,
      items: [
        { id: 'external-user', type: 'userMessage', content: [{ type: 'text', text: 'Make the button quieter.' }] },
        { id: 'external-assistant', type: 'agentMessage', text: 'Updated the button styling.' },
      ],
    }] : [])] : [],
  };
}

async function completeTurn() {
  if (!pendingApproval) return;
  const { documentPath, threadId, turnId } = pendingApproval;
  pendingApproval = null;
  const source = await readFile(documentPath, 'utf8');
  await writeFile(documentPath, source.replace('Build the page you meant', 'Changed live by Codex'), 'utf8');
  send({
    method: 'item/completed',
    params: { threadId, turnId, item: { id: 'assistant-1', type: 'agentMessage', text: 'I updated the headline in the connected document.' } },
  });
  send({
    method: 'item/completed',
    params: { threadId, turnId, item: { id: 'files-1', type: 'fileChange', status: 'completed', changes: [{ path: documentPath, kind: 'update' }] } },
  });
  send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed', items: [], error: null } } });
}

reader.on('line', async (line) => {
  const message = JSON.parse(line);
  if (message.id === 'approval-1' && !message.method) {
    if (message.result?.decision === 'accept') await completeTurn();
    return;
  }
  if (!message.method) return;

  if (message.method === 'initialize') send({ id: message.id, result: { userAgent: 'fake-codex' } });
  if (message.method === 'account/read') send({ id: message.id, result: { account: process.env.SECOND_PASS_FAKE_SIGNED_OUT === '1' ? null : { type: 'chatgpt', email: 'test@example.com' }, requiresOpenaiAuth: true } });
  if (message.method === 'account/login/start') send({ id: message.id, result: { type: 'chatgpt', loginId: 'demo-login', authUrl: 'https://auth.openai.com/authorize?demo=true' } });
  if (message.method === 'thread/start') send({ id: message.id, result: { thread: thread('0198e998-7b74-7a80-8b0f-a334bd81d30f', message.params.cwd) } });
  if (message.method === 'thread/resume') {
    if (process.env.SECOND_PASS_FAKE_STALE_ROLLOUT === '1') {
      send({ id: message.id, error: { code: -32000, message: 'no rollout found for thread id 01a036fb-eb26-7042-a6ec-0d57b57f0894' } });
    } else if (process.env.SECOND_PASS_FAKE_ACTIVE_WRITER === '1') {
      send({ id: message.id, error: { code: -32000, message: `Thread ${message.params.threadId} already has an active writer` } });
    } else {
      send({ id: message.id, result: { thread: thread(message.params.threadId, message.params.cwd) } });
    }
  }
  if (message.method === 'thread/read') {
    threadReadCount += 1;
    const includeWatchMessages = process.env.SECOND_PASS_FAKE_WATCH_MESSAGES === '1' && threadReadCount >= 2;
    send({ id: message.id, result: { thread: thread(message.params.threadId, undefined, true, includeWatchMessages) } });
  }
  if (message.method === 'thread/unsubscribe' || message.method === 'turn/interrupt') send({ id: message.id, result: {} });
  if (message.method === 'turn/start') {
    const turnId = '0198e999-0000-7000-8000-000000000001';
    const context = message.params.input.find((item) => item.type === 'text' && item.text.startsWith('<second_pass_context>'))?.text ?? '';
    const documentPath = context.match(/Connected document: (.+)/)?.[1]?.trim();
    send({ id: message.id, result: { turn: { id: turnId, status: 'inProgress', items: [], error: null } } });
    send({ method: 'turn/started', params: { threadId: message.params.threadId, turn: { id: turnId, status: 'inProgress', items: [] } } });
    send({ method: 'item/agentMessage/delta', params: { threadId: message.params.threadId, turnId, itemId: 'assistant-1', delta: 'I’ll update the connected page.' } });
    pendingApproval = { documentPath, threadId: message.params.threadId, turnId };
    send({
      id: 'approval-1',
      method: 'item/commandExecution/requestApproval',
      params: { threadId: message.params.threadId, turnId, itemId: 'command-1', startedAtMs: Date.now(), command: 'Update the HTML headline', reason: 'Apply the requested document change.' },
    });
  }
});
