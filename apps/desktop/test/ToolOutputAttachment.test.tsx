import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ToolOutputAttachment,
  type ToolOutputRef,
} from '../src/components/activity/ToolOutputAttachment.js';
import { MAX_RENDERED_CHARACTERS } from '../src/components/activity/SafePayload.js';
import { clearBridgeOverride, setBridgeOverride } from '../src/bridge.js';
import type { AgentDockBridge } from '../src/window.js';

const OUTPUT: ToolOutputRef = {
  attachmentId: '123e4567-e89b-42d3-a456-426614174010',
  mimeType: 'text/plain',
  byteCount: 5_000,
  sha256: 'deadbeef',
  preview: 'first line of a very long build log\n',
  previewTruncated: true,
};

function installDownloadBridge(
  handler: (attachmentId: string) => { fileName: string; mimeType: string; bytes: Uint8Array },
): ReturnType<typeof vi.fn> {
  const downloadAttachmentContent = vi.fn(async (attachmentId: string) => handler(attachmentId));
  setBridgeOverride({ downloadAttachmentContent } as unknown as AgentDockBridge);
  return downloadAttachmentContent;
}

afterEach(() => {
  clearBridgeOverride();
});

describe('ToolOutputAttachment (issue #132)', () => {
  it('shows the bounded preview and byte count immediately, with a load button when truncated', () => {
    installDownloadBridge(() => ({
      fileName: 'x.txt',
      mimeType: 'text/plain',
      bytes: new Uint8Array(),
    }));
    render(<ToolOutputAttachment output={OUTPUT} />);

    expect(screen.getByText(/first line of a very long build log/)).toBeInTheDocument();
    expect(screen.getByText('5,000 bytes')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Load full output' })).toBeInTheDocument();
  });

  it('does not offer a load button when the preview already holds the complete content', () => {
    render(<ToolOutputAttachment output={{ ...OUTPUT, previewTruncated: false }} />);
    expect(screen.queryByRole('button', { name: 'Load full output' })).not.toBeInTheDocument();
  });

  it('fetches and renders the full output on demand, by attachment id, via the copy/export-capable payload view', async () => {
    const fullText = 'first line of a very long build log\n...\nlast line\n';
    const download = installDownloadBridge((id) => {
      expect(id).toBe(OUTPUT.attachmentId);
      return { fileName: 'x.txt', mimeType: 'text/plain', bytes: new TextEncoder().encode(fullText) };
    });
    render(<ToolOutputAttachment output={OUTPUT} />);

    fireEvent.click(screen.getByRole('button', { name: 'Load full output' }));
    expect(screen.getByRole('button', { name: 'Loading…' })).toBeDisabled();

    await waitFor(() =>
      expect(document.querySelector('.activity-payload__content')?.textContent).toBe(fullText),
    );
    expect(download).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Load full output' })).not.toBeInTheDocument();
  });

  it('still shows the truncation marker for a load whose content exceeds the render bound', async () => {
    const huge = 'y'.repeat(MAX_RENDERED_CHARACTERS + 5_000);
    installDownloadBridge(() => ({
      fileName: 'x.txt',
      mimeType: 'text/plain',
      bytes: new TextEncoder().encode(huge),
    }));
    render(<ToolOutputAttachment output={OUTPUT} />);

    fireEvent.click(screen.getByRole('button', { name: 'Load full output' }));

    await waitFor(() => expect(screen.getByText('Truncated')).toBeInTheDocument());
    const rendered = document.querySelector('.activity-payload__content')?.textContent ?? '';
    expect(rendered.length).toBeLessThan(MAX_RENDERED_CHARACTERS + 100);
  });

  it('surfaces a load failure as an alert without losing the visible preview', async () => {
    installDownloadBridge(() => {
      throw new Error('attachment not found: 123e4567-e89b-42d3-a456-426614174010');
    });
    render(<ToolOutputAttachment output={OUTPUT} />);

    fireEvent.click(screen.getByRole('button', { name: 'Load full output' }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('attachment not found'),
    );
    expect(screen.getByText(/first line of a very long build log/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Load full output' })).not.toBeDisabled();
  });
});
