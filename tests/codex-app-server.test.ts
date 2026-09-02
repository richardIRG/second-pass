import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildCodexSpawnEnvironment, canReadThreadAfterResumeError, extractCodexThreadId, findHtmlDocumentForThread, findHtmlDocumentsForThread, isActiveWriterError, threadToCodexMessages } from '../src/lib/codex-app-server';

describe('Codex App Server helpers', () => {
  it('extracts UUIDv7 thread IDs from task links and raw values', () => {
    const id = '0198e998-7b74-7a80-8b0f-a334bd81d30f';
    expect(extractCodexThreadId(id)).toBe(id);
    expect(extractCodexThreadId(`https://chatgpt.com/codex/tasks/${id}`)).toBe(id);
    expect(extractCodexThreadId('thr_example_123')).toBe('thr_example_123');
    expect(extractCodexThreadId('not a task link')).toBeNull();
  });

  it('builds a Finder-safe PATH for asdf and Homebrew Codex installations', () => {
    const environment = buildCodexSpawnEnvironment('/Users/example', '/Users/example/.asdf/shims/codex');
    const entries = environment.PATH?.split(':') ?? [];
    expect(entries).toContain('/Users/example/.asdf/shims');
    expect(entries).toContain('/Users/example/.asdf/bin');
    expect(entries).toContain('/opt/homebrew/bin');
    expect(entries).toContain('/usr/bin');
  });

  it('recognizes the active-writer conflict returned by another Codex client', () => {
    expect(isActiveWriterError(new Error('Thread 01a already has an active writer'))).toBe(true);
    expect(isActiveWriterError(new Error('Thread not found'))).toBe(false);
  });

  it('falls back to a direct task read when resume reports stale rollout state', () => {
    expect(canReadThreadAfterResumeError(new Error('Thread 01a already has an active writer'))).toBe(true);
    expect(canReadThreadAfterResumeError(new Error('no rollout found for thread id 01a036fb'))).toBe(true);
    expect(canReadThreadAfterResumeError(new Error('Authentication failed'))).toBe(false);
  });

  it('turns stored thread items into display messages without exposing connection context', () => {
    const messages = threadToCodexMessages({
      id: 'thread',
      turns: [{
        id: 'turn',
        startedAt: 100,
        items: [
          {
            id: 'user',
            type: 'userMessage',
            content: [
              { type: 'text', text: '<second_pass_context>\nConnected document: /tmp/page.html' },
              { type: 'text', text: 'Tighten the headline.' },
            ],
          },
          { id: 'assistant', type: 'agentMessage', text: 'Done.' },
          { id: 'files', type: 'fileChange', changes: [{ path: '/tmp/page.html', kind: 'update' }] },
        ],
      }],
    });

    expect(messages).toEqual([
      { id: 'user', role: 'user', text: 'Tighten the headline.', timestamp: 100_000 },
      { id: 'assistant', role: 'assistant', text: 'Done.', timestamp: 100_000 },
      { id: 'files', role: 'activity', text: 'Updated page.html', timestamp: 100_000, activity: 'file-change' },
    ]);
  });

  it('finds the latest existing HTML file referenced by a resumed task', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'second-pass-thread-'));
    const documentPath = join(directory, 'prototype.html');
    await writeFile(documentPath, '<h1>Prototype</h1>', 'utf8');
    try {
      await expect(findHtmlDocumentForThread({
        id: 'thread',
        cwd: directory,
        turns: [{
          id: 'turn',
          items: [{ id: 'change', type: 'fileChange', changes: [{ path: documentPath, kind: 'update' }] }],
        }],
      })).resolves.toBe(documentPath);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('returns all task HTML candidates while ignoring test and build artifacts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'second-pass-candidates-'));
    const firstPath = join(directory, 'work', 'first.html');
    const secondPath = join(directory, 'work', 'second.html');
    const fixturePath = join(directory, 'tests', 'fixtures', 'fixture.html');
    const outputPath = join(directory, 'out', 'packaged.html');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(directory, 'work'), { recursive: true });
    await mkdir(join(directory, 'tests', 'fixtures'), { recursive: true });
    await mkdir(join(directory, 'out'), { recursive: true });
    await Promise.all([
      writeFile(firstPath, '<h1>First</h1>', 'utf8'),
      writeFile(secondPath, '<h1>Second</h1>', 'utf8'),
      writeFile(fixturePath, '<h1>Fixture</h1>', 'utf8'),
      writeFile(outputPath, '<h1>Packaged</h1>', 'utf8'),
    ]);
    try {
      await expect(findHtmlDocumentsForThread({
        id: 'thread',
        cwd: directory,
        turns: [{
          id: 'turn',
          items: [{
            id: 'change',
            type: 'fileChange',
            changes: [
              { path: firstPath, kind: 'add' },
              { path: secondPath, kind: 'add' },
              { path: fixturePath, kind: 'add' },
              { path: outputPath, kind: 'add' },
            ],
          }],
        }],
      })).resolves.toEqual([secondPath, firstPath]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
