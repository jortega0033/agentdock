import { useState } from 'react';
import { getBridge } from '../../bridge.js';
import { MAX_RENDERED_CHARACTERS, SafePayload } from './SafePayload.js';

export interface ToolOutputRef {
  attachmentId: string;
  mimeType: string;
  byteCount: number;
  sha256: string;
  preview: string;
  previewTruncated: boolean;
}

/**
 * Complete tool output preserved beyond the inline preview (issue #132). The preview is already
 * bounded and safe to render immediately; the full content is fetched on demand through the same
 * authenticated attachment path the daemon exposes, never a filesystem path.
 */
export function ToolOutputAttachment({ output }: { output: ToolOutputRef }) {
  const [state, setState] = useState<
    | { phase: 'idle' | 'loading' }
    | { phase: 'loaded'; text: string }
    | { phase: 'error'; message: string }
  >({ phase: 'idle' });

  const loadFull = async (): Promise<void> => {
    setState({ phase: 'loading' });
    try {
      const content = await getBridge().downloadAttachmentContent(output.attachmentId);
      const decoded = new TextDecoder().decode(content.bytes);
      // A staged attachment can be up to the daemon's 25 MiB attachment cap; SafePayload already
      // bounds what it *renders* (MAX_RENDERED_CHARACTERS) but not what's held in this component's
      // own state. Cap it here too -- one character over the threshold so SafePayload's own
      // truncation marker/badge still applies exactly as it would for the untrimmed string,
      // instead of silently hiding that this view is itself truncated.
      const text =
        decoded.length > MAX_RENDERED_CHARACTERS
          ? decoded.slice(0, MAX_RENDERED_CHARACTERS + 1)
          : decoded;
      setState({ phase: 'loaded', text });
    } catch (failure) {
      setState({
        phase: 'error',
        message: failure instanceof Error ? failure.message : 'failed to load full output',
      });
    }
  };

  if (state.phase === 'loaded') {
    return <SafePayload value={state.text} label="Full tool output" filename="tool-output.txt" code />;
  }

  return (
    <section className="tool-output-attachment" aria-label="Tool output">
      <pre className="activity-payload__content activity-payload__content--code">
        {output.preview}
      </pre>
      <div className="tool-output-attachment__meta">
        <span>{output.byteCount.toLocaleString()} bytes</span>
        {output.previewTruncated ? (
          <button
            type="button"
            className="activity-action"
            disabled={state.phase === 'loading'}
            onClick={() => void loadFull()}
          >
            {state.phase === 'loading' ? 'Loading…' : 'Load full output'}
          </button>
        ) : null}
      </div>
      {state.phase === 'error' ? (
        <div className="banner banner--error" role="alert">
          {state.message}
        </div>
      ) : null}
    </section>
  );
}
