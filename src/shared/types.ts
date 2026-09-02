export interface DiskVersion {
  sha256: string;
  mtimeMs: number;
  size: number;
}

export interface HtmlDocument {
  path: string;
  fileName: string;
  baseDirectory: string;
  source: string;
  version: DiskVersion;
}

export type EditableKind = 'rich-text' | 'image' | 'element';

export interface EditableNode {
  id: string;
  kind: EditableKind;
  tagName: string;
  sourceLabel: string;
  scriptCoupled: boolean;
  startOffset: number;
  endOffset: number;
  originalOuterHtml: string;
}

export interface EditOperation {
  nodeId: string;
  startOffset: number;
  endOffset: number;
  replacementOuterHtml: string;
  timestamp: number;
}

export interface OpenFileResult {
  status: 'opened' | 'cancelled';
  document?: HtmlDocument;
}

export interface SaveFileRequest {
  path: string;
  expectedVersion: DiskVersion;
  operations: EditOperation[];
  fullSource?: string;
}

export type SaveFileResult =
  | { status: 'saved'; document: HtmlDocument }
  | { status: 'conflict'; currentVersion: DiskVersion }
  | { status: 'error'; message: string };

export interface SaveCopyRequest {
  source: string;
  suggestedName: string;
}

export type SaveCopyResult =
  | { status: 'saved'; path: string }
  | { status: 'cancelled' }
  | { status: 'error'; message: string };

export type ChooseImageResult =
  | { status: 'selected'; src: string; fileName: string }
  | { status: 'cancelled' }
  | { status: 'error'; message: string };

export interface HistoryEntry {
  id: string;
  createdAt: number;
  size: number;
}

export interface RecentFile {
  path: string;
  fileName: string;
  lastOpenedAt: number;
}

export interface DraftSnapshot {
  path: string;
  baseVersion: DiskVersion;
  source: string;
  updatedAt: number;
}

export type OpenLinkResult =
  | { status: 'opened' }
  | { status: 'blocked'; message: string }
  | { status: 'error'; message: string };

export interface ExternalFileChange {
  path: string;
  version: DiskVersion | null;
  removed: boolean;
}

export type AppCommand = 'open' | 'save' | 'save-and-close' | 'undo' | 'redo';

export type CodexStatus = 'disconnected' | 'starting' | 'ready' | 'working' | 'error';

export interface CodexMessage {
  id: string;
  role: 'user' | 'assistant' | 'activity' | 'error';
  text: string;
  timestamp: number;
  activity?: 'command' | 'file-change' | 'tool';
}

export interface CodexApprovalRequest {
  id: string;
  kind: 'command' | 'file-change';
  title: string;
  detail: string;
}

export interface CodexSession {
  threadId: string;
  documentPath: string;
  documentCandidates: string[];
  cwd: string;
  connectionMode: 'interactive' | 'watching';
  status: CodexStatus;
  accountLabel: string;
  messages: CodexMessage[];
  workspaceKind: 'html' | 'vinext';
  projectRoot?: string;
}

export interface CodexConnectRequest {
  documentPath?: string;
  projectRoot?: string;
  threadReference?: string;
  forceNew?: boolean;
}

export interface CodexConnectResult {
  session: CodexSession;
  document?: HtmlDocument;
  project?: VinextProjectSession;
}

export interface VinextProjectSession {
  kind: 'vinext';
  root: string;
  name: string;
  entryPath: string;
  routes: string[];
  route: string;
  previewUrl: string;
}

export interface VinextEditOperation {
  id: string;
  nodeId: string;
  action: 'text' | 'attribute' | 'delete';
  attribute?: 'href' | 'alt' | 'src';
  value?: string;
  before: string;
  sourceLabel: string;
  timestamp: number;
}

export type VinextSaveResult =
  | { status: 'saved'; changedFiles: string[] }
  | { status: 'conflict'; path: string; message: string }
  | { status: 'error'; message: string };

export interface CodexTurnRequest {
  threadId: string;
  text: string;
}

export type CodexEvent =
  | { type: 'status'; status: CodexStatus; threadId?: string; message?: string }
  | { type: 'message'; threadId: string; message: CodexMessage }
  | { type: 'assistant-delta'; threadId: string; itemId: string; delta: string }
  | { type: 'approval'; threadId: string; approval: CodexApprovalRequest }
  | { type: 'turn-completed'; threadId: string; status: string };

export interface EditorApi {
  openFile: () => Promise<OpenFileResult>;
  openPath: (path: string) => Promise<OpenFileResult>;
  getDroppedFilePath: (file: File) => string;
  getLaunchDocument: () => Promise<HtmlDocument | null>;
  getRecentFiles: () => Promise<RecentFile[]>;
  reloadFile: (path: string) => Promise<HtmlDocument>;
  saveFile: (request: SaveFileRequest) => Promise<SaveFileResult>;
  saveCopy: (request: SaveCopyRequest) => Promise<SaveCopyResult>;
  chooseImageAsset: () => Promise<ChooseImageResult>;
  listHistory: (path: string) => Promise<HistoryEntry[]>;
  loadHistory: (path: string, id: string) => Promise<string>;
  loadDraft: (path: string) => Promise<DraftSnapshot | null>;
  saveDraft: (draft: DraftSnapshot) => Promise<void>;
  clearDraft: (path: string) => Promise<void>;
  openLink: (url: string) => Promise<OpenLinkResult>;
  setPreviewContent: (html: string) => Promise<string>;
  saveVinextProject: (operations: VinextEditOperation[]) => Promise<VinextSaveResult>;
  stopVinextProject: () => Promise<void>;
  confirmUnsaved: (reason: 'open' | 'history') => Promise<'save' | 'discard' | 'cancel'>;
  connectCodex: (request: CodexConnectRequest) => Promise<CodexConnectResult>;
  startCodexTurn: (request: CodexTurnRequest) => Promise<{ turnId: string }>;
  interruptCodex: (threadId: string) => Promise<void>;
  respondToCodexApproval: (requestId: string, decision: 'accept' | 'decline') => Promise<void>;
  setDirty: (dirty: boolean) => void;
  closeAfterSave: () => void;
  onExternalChange: (callback: (change: ExternalFileChange) => void) => () => void;
  onCommand: (callback: (command: AppCommand) => void) => () => void;
  onCodexEvent: (callback: (event: CodexEvent) => void) => () => void;
}

export interface PreviewRect {
  top: number;
  left: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface PreviewSelection {
  nodeId: string;
  kind: 'rich-text' | 'link' | 'image' | 'element';
  tagName: string;
  rect: PreviewRect;
  linkUrl?: string;
  imageAlt?: string;
  imageSrc?: string;
  hasTextSelection: boolean;
  sourceLabel: string;
  scriptCoupled: boolean;
  sourceMode?: 'html' | 'jsx';
  canDelete?: boolean;
  canReplaceImage?: boolean;
  formatting: {
    bold: boolean;
    italic: boolean;
    orderedList: boolean;
    unorderedList: boolean;
    linked: boolean;
  };
}

export type PreviewToHostMessage =
  | { channel: 'codex-html-editor'; type: 'ready' }
  | { channel: 'codex-html-editor'; type: 'selection'; selection: PreviewSelection | null }
  | {
      channel: 'codex-html-editor';
      type: 'edit';
      nodeId: string;
      replacementOuterHtml: string;
      timestamp: number;
    }
  | { channel: 'codex-html-editor'; type: 'undo-request' }
  | { channel: 'codex-html-editor'; type: 'redo-request' }
  | { channel: 'codex-html-editor'; type: 'save-request' }
  | { channel: 'codex-html-editor'; type: 'open-link'; url: string }
  | { channel: 'codex-html-editor'; type: 'notice'; message: string }
  | { channel: 'codex-html-editor'; type: 'project-edit'; operation: VinextEditOperation };

export type HostToPreviewMessage =
  | { channel: 'codex-html-editor-host'; type: 'set-mode'; mode: 'edit' | 'preview' }
  | { channel: 'codex-html-editor-host'; type: 'focus-node'; nodeId: string }
  | {
      channel: 'codex-html-editor-host';
      type: 'format';
      command: 'bold' | 'italic' | 'ordered-list' | 'unordered-list' | 'unlink' | 'line-break';
    }
  | { channel: 'codex-html-editor-host'; type: 'set-link'; url: string }
  | { channel: 'codex-html-editor-host'; type: 'set-image-alt'; alt: string }
  | { channel: 'codex-html-editor-host'; type: 'set-image-src'; src: string }
  | { channel: 'codex-html-editor-host'; type: 'delete-node' }
  | { channel: 'codex-html-editor-host'; type: 'apply-project-operations'; operations: VinextEditOperation[] };
