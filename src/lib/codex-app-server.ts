import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { access, readdir, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, delimiter, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import readline from 'node:readline';

import type {
  CodexApprovalRequest,
  CodexConnectRequest,
  CodexEvent,
  CodexMessage,
  CodexSession,
  CodexTurnRequest,
} from '../shared/types';
import { detectVinextProject } from './vinext-project';

type JsonRpcId = string | number;

interface JsonRpcMessage {
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface RawThreadItem {
  id: string;
  type: string;
  text?: string;
  content?: Array<{ type?: string; text?: string }>;
  command?: string;
  status?: string;
  tool?: string;
  server?: string;
  changes?: Array<{ path?: string; kind?: string }>;
}

export interface RawTurn {
  id: string;
  status?: string;
  startedAt?: number | null;
  completedAt?: number | null;
  error?: { message?: string } | null;
  items?: RawThreadItem[];
}

export interface RawThread {
  id: string;
  cwd?: string;
  turns?: RawTurn[];
}

interface CodexAppServerOptions {
  executable: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  version: string;
  onMessage: (message: JsonRpcMessage) => void;
  onExit: (message: string) => void;
}

const SECOND_PASS_CONTEXT_PREFIX = '<second_pass_context>';
const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i;
const THREAD_PATTERN = /\bthr_[a-z0-9_-]{6,}\b/i;
const HTML_EXTENSION_PATTERN = /\.html?$/i;
const IGNORED_DISCOVERY_DIRECTORIES = new Set([
  '.git',
  '.next',
  '.vite',
  'build',
  'coverage',
  'dist',
  'fixtures',
  'node_modules',
  'out',
  'test',
  'tests',
]);

function messageFromError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function isActiveWriterError(error: unknown): boolean {
  return /\bactive writer\b/i.test(messageFromError(error, ''));
}

export function canReadThreadAfterResumeError(error: unknown): boolean {
  const message = messageFromError(error, '');
  return isActiveWriterError(error) || /\bno rollout found for thread id\b/i.test(message);
}

function truncate(value: string, length = 180): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length > length ? `${compact.slice(0, length - 1)}…` : compact;
}

function requestKey(id: JsonRpcId): string {
  return `${typeof id}:${String(id)}`;
}

export function extractCodexThreadId(reference: string): string | null {
  const value = reference.trim();
  if (!value) return null;
  const decoded = (() => {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  })();
  return decoded.match(UUID_PATTERN)?.[0] ?? decoded.match(THREAD_PATTERN)?.[0] ?? null;
}

function userText(item: RawThreadItem): string {
  return (item.content ?? [])
    .filter((part) => part.type === 'text' && typeof part.text === 'string' && !part.text.startsWith(SECOND_PASS_CONTEXT_PREFIX))
    .map((part) => part.text?.trim())
    .filter((part): part is string => Boolean(part))
    .join('\n\n');
}

function fileChangeText(item: RawThreadItem): string {
  const paths = (item.changes ?? [])
    .map((change) => change.path)
    .filter((path): path is string => Boolean(path))
    .map((path) => basename(path));
  if (paths.length === 0) return 'Updated files';
  return `Updated ${[...new Set(paths)].join(', ')}`;
}

function itemToMessage(item: RawThreadItem, timestamp: number): CodexMessage | null {
  if (item.type === 'userMessage') {
    const text = userText(item);
    return text ? { id: item.id, role: 'user', text, timestamp } : null;
  }
  if (item.type === 'agentMessage') {
    return item.text ? { id: item.id, role: 'assistant', text: item.text, timestamp } : null;
  }
  if (item.type === 'commandExecution') {
    const command = item.command ? truncate(item.command) : 'Command';
    const suffix = item.status === 'failed' ? ' failed' : item.status === 'declined' ? ' was declined' : '';
    return { id: item.id, role: 'activity', text: `${command}${suffix}`, timestamp, activity: 'command' };
  }
  if (item.type === 'fileChange') {
    return { id: item.id, role: 'activity', text: fileChangeText(item), timestamp, activity: 'file-change' };
  }
  if (item.type === 'mcpToolCall') {
    return { id: item.id, role: 'activity', text: `Used ${item.server ? `${item.server} / ` : ''}${item.tool ?? 'tool'}`, timestamp, activity: 'tool' };
  }
  return null;
}

export function threadToCodexMessages(thread: RawThread): CodexMessage[] {
  return (thread.turns ?? []).flatMap((turn) => {
    const timestamp = (turn.startedAt ?? turn.completedAt ?? 0) * 1000;
    return (turn.items ?? []).flatMap((item) => {
      const message = itemToMessage(item, timestamp);
      return message ? [message] : [];
    });
  });
}

function isInsideDirectory(candidate: string, root: string): boolean {
  const child = relative(root, candidate);
  return child === '' || (!child.startsWith('..') && !isAbsolute(child));
}

async function existingHtmlPath(candidate: string, cwd?: string): Promise<string | null> {
  const cleaned = candidate.trim().replace(/^file:\/\//, '').replace(/^[`'\"]+|[`'\"),.;:]+$/g, '');
  if (!HTML_EXTENSION_PATTERN.test(cleaned)) return null;
  const path = resolve(isAbsolute(cleaned) ? cleaned : cwd ? join(cwd, cleaned) : cleaned);
  if (cwd && !isInsideDirectory(path, resolve(cwd))) return null;
  try {
    return (await stat(path)).isFile() ? path : null;
  } catch {
    return null;
  }
}

function isIgnoredDiscoveryPath(candidate: string, cwd?: string): boolean {
  if (!cwd) return false;
  const child = relative(resolve(cwd), candidate);
  return child.split(/[\\/]/).some((segment) => IGNORED_DISCOVERY_DIRECTORIES.has(segment));
}

function threadPathCandidates(thread: RawThread): string[] {
  const turns = [...(thread.turns ?? [])].reverse();
  const fileChanges = turns.flatMap((turn) => [...(turn.items ?? [])].reverse())
    .filter((item) => item.type === 'fileChange')
    .flatMap((item) => [...(item.changes ?? [])].reverse())
    .flatMap((change) => change.path ? [change.path] : []);
  const text = turns.flatMap((turn) => turn.items ?? [])
    .flatMap((item) => [item.text ?? '', ...(item.content ?? []).map((part) => part.text ?? '')])
    .filter(Boolean)
    .join('\n');
  const connectedDocuments = [...text.matchAll(/Connected document:\s*([^\r\n]+?\.html?)(?:\s|$)/gi)].map((match) => match[1]);
  const quotedPaths = [...text.matchAll(/[`'\"]([^`'\"\r\n]+?\.html?)[`'\"]/gi)].map((match) => match[1]);
  const absolutePaths = [...text.matchAll(/(?:^|\s)(\/[^\r\n`'\"<>]+?\.html?)(?=\s|$|[),.;:])/g)].map((match) => match[1]);
  return [...fileChanges, ...connectedDocuments, ...quotedPaths, ...absolutePaths];
}

async function scanWorkspaceForHtml(root: string): Promise<string[]> {
  const files: Array<{ path: string; mtimeMs: number }> = [];
  const queue: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }];
  let visited = 0;
  while (queue.length > 0 && visited < 4_000) {
    const current = queue.shift();
    if (!current) break;
    let entries;
    try {
      entries = await readdir(current.path, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      visited += 1;
      if (visited >= 4_000) break;
      const path = join(current.path, entry.name);
      if (entry.isDirectory()) {
        if (current.depth < 3 && !IGNORED_DISCOVERY_DIRECTORIES.has(entry.name) && !entry.name.startsWith('.')) {
          queue.push({ path, depth: current.depth + 1 });
        }
      } else if (entry.isFile() && HTML_EXTENSION_PATTERN.test(extname(entry.name))) {
        try {
          files.push({ path, mtimeMs: (await stat(path)).mtimeMs });
        } catch {
          // The file may have moved during discovery.
        }
      }
    }
  }
  files.sort((left, right) => right.mtimeMs - left.mtimeMs || left.path.localeCompare(right.path));
  return files.slice(0, 50).map((file) => file.path);
}

export async function findHtmlDocumentsForThread(thread: RawThread): Promise<string[]> {
  const cwd = thread.cwd ? resolve(thread.cwd) : undefined;
  const documents: string[] = [];
  const seen = new Set<string>();
  for (const candidate of threadPathCandidates(thread)) {
    const path = await existingHtmlPath(candidate, cwd);
    if (path && !isIgnoredDiscoveryPath(path, cwd) && !seen.has(path)) {
      documents.push(path);
      seen.add(path);
    }
  }
  if (cwd) {
    for (const path of await scanWorkspaceForHtml(cwd)) {
      if (!seen.has(path)) {
        documents.push(path);
        seen.add(path);
      }
    }
  }
  return documents;
}

export async function findHtmlDocumentForThread(thread: RawThread): Promise<string | null> {
  return (await findHtmlDocumentsForThread(thread))[0] ?? null;
}

export function bundledCodexPath(resourcesPath: string, platform = process.platform, arch = process.arch): string | null {
  const targets: Record<string, string> = {
    'darwin-arm64': 'aarch64-apple-darwin',
    'darwin-x64': 'x86_64-apple-darwin',
    'win32-x64': 'x86_64-pc-windows-msvc',
    'win32-arm64': 'aarch64-pc-windows-msvc',
  };
  const target = targets[`${platform}-${arch}`];
  return target ? join(resourcesPath, 'codex', 'vendor', target, 'bin', platform === 'win32' ? 'codex.exe' : 'codex') : null;
}

export function isTrustedCodexLoginUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password
      && ['auth.openai.com', 'chatgpt.com'].includes(url.hostname);
  } catch { return false; }
}

export async function findCodexExecutable(homeDirectory: string, resourcesPath?: string): Promise<{ executable: string; args: string[] }> {
  const configured = process.env.SECOND_PASS_CODEX_EXECUTABLE;
  const configuredArgs = process.env.SECOND_PASS_CODEX_ARGS;
  if (configured) {
    let args = ['app-server'];
    if (configuredArgs) {
      try {
        const parsed = JSON.parse(configuredArgs) as unknown;
        if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === 'string')) throw new Error();
        args = parsed;
      } catch {
        throw new Error('SECOND_PASS_CODEX_ARGS must be a JSON array of strings.');
      }
    }
    return { executable: configured, args };
  }

  const bundled = resourcesPath ? bundledCodexPath(resourcesPath) : null;
  const candidates = [
    ...(bundled ? [bundled] : []),
    join(homeDirectory, '.asdf', 'shims', 'codex'),
    join(homeDirectory, '.local', 'bin', 'codex'),
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return { executable: candidate, args: ['app-server'] };
    } catch {
      // Try the next common installation location.
    }
  }
  return { executable: 'codex', args: ['app-server'] };
}

export function buildCodexSpawnEnvironment(homeDirectory: string, executable: string): NodeJS.ProcessEnv {
  const inheritedPath = process.env.PATH?.split(delimiter).filter(Boolean) ?? [];
  const entries = [
    ...(isAbsolute(executable) ? [dirname(executable)] : []),
    ...(isAbsolute(executable) ? [join(dirname(executable), '..', 'path')] : []),
    ...(isAbsolute(executable) ? [join(dirname(executable), '..', 'codex-path')] : []),
    ...(process.platform === 'win32' ? [] : [
    join(homeDirectory, '.asdf', 'shims'),
    join(homeDirectory, '.asdf', 'bin'),
    join(homeDirectory, '.local', 'bin'),
    join(homeDirectory, '.volta', 'bin'),
    join(homeDirectory, 'Library', 'pnpm'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
    ]),
    ...inheritedPath,
  ];
  return {
    ...process.env,
    PATH: [...new Set(entries)].join(delimiter),
  };
}

class CodexAppServerTransport {
  private process: ChildProcessWithoutNullStreams | null = null;
  private reader: readline.Interface | null = null;
  private pending = new Map<string, PendingRequest>();
  private nextId = 1;
  private startPromise: Promise<void> | null = null;
  private stopping = false;

  constructor(private readonly options: CodexAppServerOptions) {}

  async start(): Promise<void> {
    if (this.process) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startInternal();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  private async startInternal(): Promise<void> {
    this.stopping = false;
    const child = spawn(this.options.executable, this.options.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      env: this.options.env,
    });
    this.process = child;
    this.reader = readline.createInterface({ input: child.stdout });
    this.reader.on('line', (line) => this.handleLine(line));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      if (/\b(error|failed|panic)\b/i.test(chunk)) console.error('[Second Pass Codex]', truncate(chunk, 600));
    });
    child.once('error', (error) => this.handleExit(messageFromError(error, 'Unable to start Codex.')));
    child.once('exit', (code, signal) => {
      if (this.stopping) return;
      this.handleExit(`Codex stopped unexpectedly${signal ? ` (${signal})` : code === null ? '' : ` (code ${code})`}.`);
    });

    await this.request('initialize', {
      clientInfo: { name: 'second_pass', title: 'Second Pass', version: this.options.version },
    });
    this.notify('initialized', {});
  }

  async request<T>(method: string, params: unknown, timeoutMs = 30_000): Promise<T> {
    if (!this.process) throw new Error('Codex is not running.');
    const id = this.nextId++;
    const result = new Promise<T>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestKey(id));
        rejectPromise(new Error(`Codex did not respond to ${method}.`));
      }, timeoutMs);
      this.pending.set(requestKey(id), {
        resolve: (value) => resolvePromise(value as T),
        reject: rejectPromise,
        timer,
      });
    });
    this.write({ id, method, params });
    return result;
  }

  notify(method: string, params: unknown): void {
    this.write({ method, params });
  }

  respond(id: JsonRpcId, result: unknown): void {
    this.write({ id, result });
  }

  respondError(id: JsonRpcId, message: string): void {
    this.write({ id, error: { code: -32601, message } });
  }

  stop(): void {
    this.stopping = true;
    this.reader?.close();
    this.reader = null;
    this.process?.kill();
    this.process = null;
    this.rejectPending(new Error('Codex stopped.'));
  }

  private write(message: JsonRpcMessage): void {
    if (!this.process?.stdin.writable) throw new Error('Codex is not available.');
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      return;
    }
    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(requestKey(message.id));
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(requestKey(message.id));
      if (message.error) pending.reject(new Error(message.error.message ?? 'Codex request failed.'));
      else pending.resolve(message.result);
      return;
    }
    this.options.onMessage(message);
  }

  private handleExit(message: string): void {
    this.reader?.close();
    this.reader = null;
    this.process = null;
    this.rejectPending(new Error(message));
    this.options.onExit(message);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export class CodexWorkspaceBridge {
  private transport: CodexAppServerTransport | null = null;
  private session: CodexSession | null = null;
  private currentTurnId: string | null = null;
  private approvals = new Map<string, { id: JsonRpcId; threadId: string }>();
  private watchTimer: NodeJS.Timeout | null = null;
  private watchRefreshInFlight = false;

  constructor(
    private readonly version: string,
    private readonly homeDirectory: string,
    private readonly emit: (event: CodexEvent) => void,
    private readonly options: { resourcesPath?: string; openSignIn?: (url: string) => Promise<void> } = {},
  ) {}

  async connect(request: CodexConnectRequest): Promise<CodexSession> {
    this.stopWatchPolling();
    const requestedDocumentPath = request.documentPath ? resolve(request.documentPath) : null;
    const requestedProject = request.projectRoot ? await detectVinextProject(request.projectRoot) : null;
    this.emit({ type: 'status', status: 'starting' });
    try {
      await this.ensureTransport();
      const accountResponse = await this.transport!.request<{
        account?: { type?: string; email?: string | null } | null;
        requiresOpenaiAuth?: boolean;
      }>('account/read', { refreshToken: false });
      if (accountResponse.requiresOpenaiAuth && !accountResponse.account) {
        if (this.options.openSignIn) {
          const login = await this.transport!.request<{ authUrl?: string }>('account/login/start', { type: 'chatgpt' });
          if (!login.authUrl || !isTrustedCodexLoginUrl(login.authUrl)) throw new Error('Codex returned an unsupported sign-in address.');
          await this.options.openSignIn(login.authUrl);
          throw new Error('Complete sign-in in your browser, then select Connect again.');
        }
        throw new Error('Sign in to Codex first, then try connecting again.');
      }

      const reference = request.threadReference?.trim() ?? '';
      const threadId = reference ? extractCodexThreadId(reference) : null;
      if (reference && !threadId) throw new Error('Paste a valid Codex task link or thread ID.');
      if (!requestedDocumentPath && !threadId) throw new Error('Paste a Codex task link or thread ID to connect.');

      const sharedOptions = {
        ...(requestedProject ? { cwd: requestedProject.root } : requestedDocumentPath ? { cwd: dirname(requestedDocumentPath) } : {}),
        approvalPolicy: 'on-request',
        approvalsReviewer: 'user',
        sandbox: 'workspace-write',
      };
      let connectionMode: CodexSession['connectionMode'] = 'interactive';
      let response: { thread: RawThread };
      let read: { thread: RawThread } | null = null;
      if (threadId && !request.forceNew) {
        try {
          response = await this.transport!.request<{ thread: RawThread }>('thread/resume', { threadId, ...sharedOptions });
        } catch (error) {
          if (!canReadThreadAfterResumeError(error)) throw error;
          read = await this.transport!.request<{ thread: RawThread }>('thread/read', {
            threadId,
            includeTurns: true,
          });
          response = read;
          connectionMode = 'watching';
        }
      } else {
        response = await this.transport!.request<{ thread: RawThread }>('thread/start', {
          ...sharedOptions,
          serviceName: 'second_pass',
        });
      }
      const connectedThreadId = response.thread.id;
      read ??= await this.transport!.request<{ thread: RawThread }>('thread/read', {
        threadId: connectedThreadId,
        includeTurns: true,
      });
      const thread = {
        ...read.thread,
        cwd: read.thread.cwd ?? response.thread.cwd,
      };
      const project = requestedProject ?? (!requestedDocumentPath && thread.cwd ? await detectVinextProject(thread.cwd) : null);
      const documentCandidates = requestedDocumentPath && !project
        ? [requestedDocumentPath]
        : project ? [] : await findHtmlDocumentsForThread(thread);
      const documentPath = requestedDocumentPath ?? project?.entryPath ?? documentCandidates[0];
      if (!documentPath) {
        throw new Error('Connected to the task, but could not find an HTML document or Vinext App Router project in its workspace.');
      }
      const cwd = project?.root ?? (thread.cwd ? resolve(thread.cwd) : dirname(documentPath));
      this.currentTurnId = null;
      const session: CodexSession = {
        threadId: connectedThreadId,
        documentPath,
        documentCandidates,
        cwd,
        connectionMode,
        status: 'ready',
        accountLabel: this.accountLabel(accountResponse.account),
        messages: threadToCodexMessages(thread),
        workspaceKind: project ? 'vinext' : 'html',
        projectRoot: project?.root,
      };
      this.session = session;
      if (connectionMode === 'watching') this.startWatchPolling();
      this.emit({ type: 'status', status: 'ready', threadId: connectedThreadId });
      return session;
    } catch (error) {
      const message = messageFromError(error, 'Unable to connect to Codex.');
      this.session = null;
      this.emit({ type: 'status', status: 'error', message });
      throw new Error(message);
    }
  }

  async startTurn(request: CodexTurnRequest): Promise<{ turnId: string }> {
    if (!this.session || this.session.threadId !== request.threadId) throw new Error('Connect this document to Codex first.');
    if (this.session.connectionMode === 'watching') throw new Error('This task is active in Codex. Continue the conversation there, or start a new task in Second Pass.');
    if (this.session.status === 'working') throw new Error('Codex is already working.');
    const text = request.text.trim();
    if (!text) throw new Error('Write a request for Codex.');

    const clientUserMessageId = `second-pass-${Date.now()}`;
    const userMessage: CodexMessage = { id: clientUserMessageId, role: 'user', text, timestamp: Date.now() };
    this.session = { ...this.session, status: 'working', messages: [...this.session.messages, userMessage] };
    this.emit({ type: 'message', threadId: request.threadId, message: userMessage });
    this.emit({ type: 'status', status: 'working', threadId: request.threadId });

    const context = [
      SECOND_PASS_CONTEXT_PREFIX,
      this.session.workspaceKind === 'vinext'
        ? `Connected project: ${this.session.projectRoot}\nCurrent page source: ${this.session.documentPath}`
        : `Connected document: ${this.session.documentPath}`,
      this.session.workspaceKind === 'vinext'
        ? 'Apply requested changes to this Vinext App Router project and preserve unrelated source.'
        : 'Apply requested document changes to this HTML file and preserve unrelated source.',
      this.session.workspaceKind === 'vinext'
        ? 'Modify only files required for the requested page change.'
        : 'Do not modify other files unless the user explicitly asks.',
      '</second_pass_context>',
    ].join('\n');
    try {
      const response = await this.transport!.request<{ turn: RawTurn }>('turn/start', {
        threadId: request.threadId,
        clientUserMessageId,
        cwd: this.session.cwd,
        input: [
          { type: 'text', text: context, text_elements: [] },
          { type: 'text', text, text_elements: [] },
        ],
      });
      this.currentTurnId = response.turn.id;
      return { turnId: response.turn.id };
    } catch (error) {
      const message = messageFromError(error, 'Codex could not start this request.');
      this.session = { ...this.session, status: 'ready' };
      this.emit({ type: 'message', threadId: request.threadId, message: { id: `error-${Date.now()}`, role: 'error', text: message, timestamp: Date.now() } });
      this.emit({ type: 'status', status: 'ready', threadId: request.threadId });
      throw new Error(message);
    }
  }

  attachDocument(documentPath: string): CodexSession {
    if (!this.session) throw new Error('Connect to Codex before attaching a document.');
    const path = resolve(documentPath);
    this.session = {
      ...this.session,
      documentPath: path,
      documentCandidates: [path, ...this.session.documentCandidates.filter((candidate) => candidate !== path)],
      cwd: dirname(path),
      workspaceKind: 'html',
      projectRoot: undefined,
    };
    return this.session;
  }

  async interrupt(threadId: string): Promise<void> {
    if (!this.session || this.session.threadId !== threadId || !this.currentTurnId) return;
    await this.transport!.request('turn/interrupt', { threadId, turnId: this.currentTurnId });
  }

  respondToApproval(requestId: string, decision: 'accept' | 'decline'): void {
    const approval = this.approvals.get(requestId);
    if (!approval) throw new Error('This approval request is no longer active.');
    this.transport?.respond(approval.id, { decision });
    this.approvals.delete(requestId);
  }

  async detach(): Promise<void> {
    this.stopWatchPolling();
    const threadId = this.session?.threadId;
    if (!threadId) return;
    for (const approval of this.approvals.values()) this.transport?.respond(approval.id, { decision: 'decline' });
    this.approvals.clear();
    if (this.currentTurnId) {
      await this.transport?.request('turn/interrupt', { threadId, turnId: this.currentTurnId }).catch(() => undefined);
    }
    await this.transport?.request('thread/unsubscribe', { threadId }).catch(() => undefined);
    this.session = null;
    this.currentTurnId = null;
    this.emit({ type: 'status', status: 'disconnected' });
  }

  dispose(): void {
    this.stopWatchPolling();
    this.transport?.stop();
    this.transport = null;
    this.session = null;
    this.currentTurnId = null;
    this.approvals.clear();
  }

  private async ensureTransport(): Promise<void> {
    if (!this.transport) {
      const invocation = await findCodexExecutable(this.homeDirectory, this.options.resourcesPath);
      this.transport = new CodexAppServerTransport({
        ...invocation,
        env: buildCodexSpawnEnvironment(this.homeDirectory, invocation.executable),
        version: this.version,
        onMessage: (message) => this.handleMessage(message),
        onExit: (message) => {
          this.stopWatchPolling();
          this.session = this.session ? { ...this.session, status: 'error' } : null;
          this.emit({ type: 'status', status: 'error', message });
        },
      });
    }
    await this.transport.start();
  }

  private startWatchPolling(): void {
    this.stopWatchPolling();
    this.watchTimer = setInterval(() => void this.refreshWatchingSession(), 1_200);
    this.watchTimer.unref();
  }

  private stopWatchPolling(): void {
    if (this.watchTimer) clearInterval(this.watchTimer);
    this.watchTimer = null;
    this.watchRefreshInFlight = false;
  }

  private async refreshWatchingSession(): Promise<void> {
    if (this.watchRefreshInFlight || !this.transport || this.session?.connectionMode !== 'watching') return;
    const session = this.session;
    this.watchRefreshInFlight = true;
    try {
      const read = await this.transport.request<{ thread: RawThread }>('thread/read', {
        threadId: session.threadId,
        includeTurns: true,
      });
      if (!this.session || this.session.threadId !== session.threadId || this.session.connectionMode !== 'watching') return;
      const messages = threadToCodexMessages(read.thread);
      const previous = new Map(this.session.messages.map((message) => [message.id, message]));
      for (const message of messages) {
        const existing = previous.get(message.id);
        if (!existing || existing.text !== message.text || existing.role !== message.role) {
          this.emit({ type: 'message', threadId: session.threadId, message });
        }
      }
      const latestTurn = read.thread.turns?.at(-1);
      const working = /^(?:in[_-]?progress|running)$/i.test(latestTurn?.status ?? '');
      const status: CodexSession['status'] = working ? 'working' : 'ready';
      const statusChanged = status !== this.session.status;
      this.session = { ...this.session, messages, status };
      if (statusChanged) this.emit({ type: 'status', status, threadId: session.threadId });
    } catch {
      // Watching is best-effort. A later poll can recover after a transient read failure.
    } finally {
      this.watchRefreshInFlight = false;
    }
  }

  private accountLabel(account: { type?: string; email?: string | null } | null | undefined): string {
    if (account?.type === 'chatgpt') return account.email ?? 'ChatGPT account';
    if (account?.type === 'apiKey') return 'OpenAI API key';
    return 'Codex';
  }

  private handleMessage(message: JsonRpcMessage): void {
    if (message.id !== undefined && message.method) {
      this.handleServerRequest(message);
      return;
    }
    if (!message.method || !message.params || typeof message.params !== 'object') return;
    const params = message.params as Record<string, unknown>;
    const threadId = typeof params.threadId === 'string' ? params.threadId : this.session?.threadId;
    if (!threadId || (this.session && threadId !== this.session.threadId)) return;

    if (message.method === 'turn/started') {
      const turn = params.turn as RawTurn | undefined;
      this.currentTurnId = turn?.id ?? this.currentTurnId;
      if (this.session) this.session = { ...this.session, status: 'working' };
      this.emit({ type: 'status', status: 'working', threadId });
      return;
    }
    if (message.method === 'item/agentMessage/delta') {
      const itemId = typeof params.itemId === 'string' ? params.itemId : '';
      const delta = typeof params.delta === 'string' ? params.delta : '';
      if (itemId && delta) this.emit({ type: 'assistant-delta', threadId, itemId, delta });
      return;
    }
    if (message.method === 'item/started' || message.method === 'item/completed') {
      const item = params.item as RawThreadItem | undefined;
      if (!item) return;
      if (message.method === 'item/started' && !['commandExecution', 'fileChange', 'mcpToolCall'].includes(item.type)) return;
      const converted = itemToMessage(item, Date.now());
      if (converted) this.emit({ type: 'message', threadId, message: converted });
      return;
    }
    if (message.method === 'turn/completed') {
      const turn = params.turn as RawTurn | undefined;
      const status = turn?.status === 'failed' ? 'error' : 'ready';
      const errorMessage = turn?.error?.message;
      this.currentTurnId = null;
      if (this.session) this.session = { ...this.session, status };
      if (errorMessage) this.emit({ type: 'message', threadId, message: { id: `error-${Date.now()}`, role: 'error', text: errorMessage, timestamp: Date.now() } });
      this.emit({ type: 'turn-completed', threadId, status: turn?.status ?? 'completed' });
      this.emit({ type: 'status', status, threadId, message: errorMessage });
      return;
    }
    if (message.method === 'error') {
      const error = params.error as { message?: string } | undefined;
      const text = error?.message ?? (typeof params.message === 'string' ? params.message : 'Codex reported an error.');
      this.emit({ type: 'message', threadId, message: { id: `error-${Date.now()}`, role: 'error', text, timestamp: Date.now() } });
    }
  }

  private handleServerRequest(message: JsonRpcMessage): void {
    if (message.id === undefined || !message.method || !message.params || typeof message.params !== 'object') return;
    const params = message.params as Record<string, unknown>;
    const threadId = typeof params.threadId === 'string' ? params.threadId : this.session?.threadId;
    if (!threadId || threadId !== this.session?.threadId) {
      this.transport?.respondError(message.id, 'This request is not connected to the active Second Pass document.');
      return;
    }
    if (message.method !== 'item/commandExecution/requestApproval' && message.method !== 'item/fileChange/requestApproval') {
      this.transport?.respondError(message.id, 'Second Pass does not support this request type yet.');
      return;
    }

    const id = requestKey(message.id);
    const isCommand = message.method === 'item/commandExecution/requestApproval';
    const command = typeof params.command === 'string' ? params.command : '';
    const reason = typeof params.reason === 'string' ? params.reason : '';
    const approval: CodexApprovalRequest = {
      id,
      kind: isCommand ? 'command' : 'file-change',
      title: isCommand ? 'Allow this command?' : 'Allow this file change?',
      detail: truncate((isCommand ? command || reason : reason) || (isCommand ? 'Codex requested permission to run a command.' : 'Codex requested permission to write outside the connected folder.'), 300),
    };
    this.approvals.set(id, { id: message.id, threadId });
    this.emit({ type: 'approval', threadId, approval });
  }
}
