# Second Pass

A private macOS editor for making small, precise changes directly on rendered HTML documents and Vinext App Router projects.

## Run locally

```bash
pnpm install
pnpm start
```

Paste a Codex task link or thread ID into the launch screen. Second Pass resumes the task, finds its standalone HTML document or Vinext project, opens the rendered page, and keeps it synchronized with Codex. Use **Cmd+S** to save direct visual edits.

The first document opened from Desktop, Documents, or Downloads may trigger a macOS access prompt. If access was previously denied, Second Pass presents the discovered file in a native approval sheet. Select **Allow and Open** once; macOS remembers that file for future sessions. Local prototype builds use Electron's development identity; a public release requires Developer ID signing for a stable permission identity.

You can also open an HTML file directly, drop an `.html` or `.htm` file onto the window, reopen a recent document, or launch a specific file:

```bash
pnpm start -- -- /absolute/path/to/document.html
```

## Work beside Codex

Install and sign in to the Codex CLI, then paste an existing task link or thread ID on the launch screen. If you open a file directly, select **Codex** in the toolbar to resume that document’s last conversation, start a new one, or connect another task.

Second Pass runs the local Codex App Server, scopes new threads to the document folder, and refreshes the rendered page whenever Codex writes the file. Save visual edits before sending another Codex request. While Codex is working, the document stays in Preview mode to prevent competing writes.

If the pasted task is already open in another Codex client, Second Pass connects in watch mode instead of competing for the task’s writer lock. Continue the conversation in Codex while Second Pass refreshes both the conversation sidebar and rendered page. Select **New** in the Codex panel to start a separate writable task inside Second Pass.

For Vinext projects, Second Pass detects `app/page.tsx` or `src/app/page.tsx`, starts the project through its installed Vite runtime, and instruments source-authored JSX in memory. Static JSX text, links, image sources, image alt text, and safely nested elements can be edited directly. Dynamic expressions remain read-only and can be changed through Codex.

## V1 workflow

- Direct text editing with bold, italic, links, lists, line breaks, and sanitized rich-text paste
- Link URL, image alt text, and native file-picker image replacement
- Undoable deletion of selected source-authored elements, including buttons, images, and dividers
- Edit and Preview modes, including safe opening of links in the default browser
- Responsive, tablet, and mobile preview widths
- Hover outlines, active formatting state, source-region labels, and warnings for script-controlled text
- Undo and redo, optional change review, explicit Save, and byte-for-byte preservation outside edited source ranges
- Autosaved crash-recovery drafts, automatic pre-save backups, and a restoreable History panel
- Automatic reload when clean, automatic merge for non-overlapping disk changes, and safe conflict handling for overlapping changes
- A side-by-side Codex conversation with persisted workspace bindings, streamed progress, approvals, interruption, and live preview refresh
- Vinext App Router detection, managed Vite preview, route switching, and safe static JSX source edits
- Recent files, drag-and-drop opening, command-line file opening, and Save a Copy during conflicts
- Sandboxed page scripts, narrow IPC, validated external navigation, atomic writes, and hardened Electron fuses

Only source-authored content is editable. Runtime-generated copy, computed JSX expressions, general Next.js support, layout manipulation, and element-level page building are outside V1.

Replacement images are copied into the workspace so the saved page remains portable. Standalone HTML documents use an `assets` folder beside the document. Vinext projects use `public/second-pass-assets` and save a root-relative source path. Existing files are never overwritten.

## Verify and build

```bash
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm make
```

`pnpm make` creates a macOS ZIP in `out/make`. The build is unsigned, so public distribution still requires an Apple Developer identity, signing, notarization, and a release identity.
