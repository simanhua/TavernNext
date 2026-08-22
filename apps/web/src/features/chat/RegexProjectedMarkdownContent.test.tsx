// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { runRegexScripts, type RegexWorkerFactory, type TavernRegex } from '@tavernnext/extension-runtime';
import { RegexProjectedMarkdownContent } from './RegexProjectedMarkdownContent.js';

afterEach(cleanup);

const factory: RegexWorkerFactory = (request) => ({
  result: Promise.resolve(runRegexScripts(request.raw, [request.script], request.context)),
  terminate: () => undefined,
});

function rule(patch: Partial<TavernRegex>): TavernRegex {
  return {
    id: 'display', scriptName: 'Display', findRegex: '/<panel>/g', replaceString: '**Status**', trimStrings: [],
    placement: [2], disabled: false, markdownOnly: true, promptOnly: false, runOnEdit: false,
    substituteRegex: 0, minDepth: null, maxDepth: null, ...patch,
  };
}

describe('RegexProjectedMarkdownContent', () => {
  it('renders display-only projection while leaving the caller-owned raw content unchanged', async () => {
    const raw = '<panel>';
    render(<RegexProjectedMarkdownContent
      content={raw}
      role="assistant"
      depth={0}
      scripts={{ preset: [rule({})], character: [] }}
      createWorker={factory}
    />);

    await waitFor(() => expect(screen.getByText('Status').tagName).toBe('STRONG'));
    expect(raw).toBe('<panel>');
  });

  it('does not apply prompt-only rules to display content', async () => {
    render(<RegexProjectedMarkdownContent
      content="<panel>"
      role="assistant"
      depth={0}
      scripts={{ preset: [rule({ promptOnly: true, markdownOnly: false })], character: [] }}
      createWorker={factory}
    />);

    await waitFor(() => expect(screen.getByText('<panel>')).not.toBeNull());
  });

  it('substitutes display macro values before matching', async () => {
    render(<RegexProjectedMarkdownContent
      content="A.lice"
      role="assistant"
      depth={0}
      scripts={{ preset: [rule({ findRegex: '/^{{user}}$/g', replaceString: 'friend', substituteRegex: 2 })], character: [] }}
      macroValues={{ user: 'A.lice' }}
      createWorker={factory}
    />);

    await waitFor(() => expect(screen.getByText('friend')).not.toBeNull());
  });

  it('shows a fail-open trace when a display Worker times out', async () => {
    const never: RegexWorkerFactory = () => ({ result: new Promise(() => undefined), terminate: () => undefined });
    render(<RegexProjectedMarkdownContent
      content="<panel>"
      role="assistant"
      depth={0}
      scripts={{ preset: [rule({})], character: [] }}
      limits={{ perRuleMs: 5, aggregateMs: 50 }}
      createWorker={never}
    />);

    expect(await screen.findByText('Regex projection trace')).not.toBeNull();
    expect(screen.getByText(/preset:Display — timeout/)).not.toBeNull();
    expect(screen.getByText('<panel>')).not.toBeNull();
  });

  it('honors run-on-edit in the live edit projection', async () => {
    const { rerender } = render(<RegexProjectedMarkdownContent
      content="<panel>"
      role="assistant"
      depth={0}
      scripts={{ preset: [rule({ runOnEdit: false })], character: [] }}
      createWorker={factory}
      isEdit
    />);
    await waitFor(() => expect(screen.getByText('<panel>')).not.toBeNull());

    rerender(<RegexProjectedMarkdownContent
      content="<panel>"
      role="assistant"
      depth={0}
      scripts={{ preset: [rule({ runOnEdit: true })], character: [] }}
      createWorker={factory}
      isEdit
    />);
    await waitFor(() => expect(screen.getByText('Status').tagName).toBe('STRONG'));
  });
});
