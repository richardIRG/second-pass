# Second Pass

Edit text and images directly in an HTML page, then save your changes back to the file. Keep Codex beside you for larger changes.

**[Download Second Pass](https://richardirg.github.io/second-pass/)** · **[All releases](https://github.com/richardIRG/second-pass/releases)**

## Install

| Computer | Download | Setup |
| --- | --- | --- |
| Mac with an Apple M-series chip | [Mac, Apple silicon](https://github.com/richardIRG/second-pass/releases/latest/download/Second-Pass-Mac-Apple-Silicon.dmg) | Open the disk image and drag Second Pass to Applications. |
| Mac with an Intel processor | [Mac, Intel](https://github.com/richardIRG/second-pass/releases/latest/download/Second-Pass-Mac-Intel.dmg) | Open the disk image and drag Second Pass to Applications. |
| Windows with an Intel or AMD processor | [Windows installer](https://github.com/richardIRG/second-pass/releases/latest/download/Second-Pass-Windows-x64-Setup.exe) | Open the installer. Second Pass installs for your Windows account. |

On Mac, choose **Apple menu > About This Mac** to find your chip or processor. The Windows download is an x64 build. Native Windows ARM support is not included.

These initial downloads are not signed with an Apple Developer ID or a Windows publisher certificate.

### First launch on Mac

1. Open Second Pass from Applications.
2. If macOS blocks it because the developer cannot be verified, open **System Settings > Privacy & Security**, then select **Open Anyway** for Second Pass.
3. Confirm **Open**. If asked for access to Documents or Downloads, allow access to the file you want to edit.

This is an exception for this app. You do not need to disable system-wide security settings. See [Apple's instructions](https://support.apple.com/en-us/102445).

### First launch on Windows

1. Open the downloaded installer.
2. If Microsoft Defender SmartScreen shows an unrecognized-app warning, select **More info > Run anyway** after confirming you downloaded this release from this repository.
3. Open **Second Pass** from the Start menu.

A company-managed computer may require IT approval. If your organization's policy blocks the app, ask IT to approve it.

## Try it in a minute

1. [Download the sample HTML](https://richardirg.github.io/second-pass/fieldwork-demo.html) and save it to Documents.
2. Open Second Pass, select **Open HTML file**, and choose the sample. You can also drag the file into the window.
3. Click the headline and type your changes. Select an image and use **Replace** to choose a new one.
4. Select **Save**, or press **Cmd+S** on Mac or **Ctrl+S** on Windows.
5. Switch to **Preview** to use links, or choose the mobile width.

The sample is fictional. Local HTML editing works without an account or an internet connection.

## Connect a Codex task

Codex is included in the download. You do not need Node.js, npm, or a separate CLI installation.

1. Create an HTML page in Codex on the same computer.
2. Copy that task's link and paste it into Second Pass. Select **Connect**.
3. If a browser sign-in opens, sign in with your own ChatGPT account with Codex access. Return to Second Pass and select **Connect** again.
4. Save direct edits before asking Codex to make another change.

Second Pass uses the local Codex configuration and authentication on your computer. It can connect to a task already open in Codex in watch mode. Continue the conversation in Codex; saved changes will appear in Second Pass.

Task links do not transfer documents between computers. A teammate should open their own local task, or download the HTML and open it directly. Cloud-only and remote-host task workspaces are not available through a local task link.

Connecting Codex uses your account and its limits. Codex may send prompts and relevant file content to OpenAI as part of a request. Second Pass does not include a shared account or API key.

## What you can edit

- Text, bold and italic formatting, links, lists, and line breaks.
- Link destinations, image alt text, and images through a file picker.
- Selected elements, with undo and redo.
- Standalone HTML and static source-authored JSX in supported Vinext App Router projects.

Second Pass preserves source outside edited regions and creates a backup before saving. Runtime-generated text, general Next.js projects, and visual layout building are outside this release.

For Vinext projects, dependencies and the project's Node.js/Vite runtime must already be installed. The no-terminal setup above applies to standalone HTML and the bundled Codex connection.

## Updates and feedback

Download the newer release and install it over your current version. There is no automatic updater in this release. Keep your HTML and images in Documents or another working folder, outside the installation.

[Report an issue](https://github.com/richardIRG/second-pass/issues/new). Include your operating system, what you expected, and what happened. Keep private documents, tokens, and client information out of public issues.

## Development

Use Node.js 24 and pnpm 10.18.2:

```sh
pnpm install
pnpm start
pnpm typecheck
pnpm test
pnpm test:e2e
```

Make a release on the target operating system:

```sh
pnpm prepare:codex
pnpm make
node scripts/collect-release.mjs
```

The release workflow builds and tests Mac Apple silicon, Mac Intel, and Windows x64 on their respective GitHub runners. A version tag publishes all downloads only after every build passes. The download page workflow deploys the docs directory to GitHub Pages.

The bundled Codex version is pinned in scripts/prepare-codex.mjs. Its npm archive is verified against the registry's SHA-512 integrity value. Codex is distributed under its upstream Apache-2.0 license, included with the runtime. Other bundled components retain their own licenses.

Before removing the first-launch caveats, configure Developer ID signing and Apple notarization for Mac and publisher signing for Windows, then verify the installers on fresh machines.
