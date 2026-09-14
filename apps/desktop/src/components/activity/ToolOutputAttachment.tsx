import { useState } from 'react';
import { getBridge } from '../../bridge.js';
import { SafePayload } from './SafePayload.js';

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
      setState({ phase: 'loaded', text: new TextDecoder().decode(content.bytes) });
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
