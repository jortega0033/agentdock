import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, RefObject } from 'react';
import type { ApprovalDecisionV2, WorkspaceTrustViewV2 } from '@agent-dock/shared';
import type {
  RendererInteraction,
  RendererQuestionResponse,
} from '../../electron/interaction-broker.js';

const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  'input:not([disabled])',
  'textarea:not([disabled])',
  'select:not([disabled])',
  'a[href]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function focusableElements(dialog: HTMLElement | null): HTMLElement[] {
  return dialog ? Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)) : [];
}

function useDialogFocus(dialogRef: RefObject<HTMLElement | null>, focusKey?: string) {
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    const initial =
      dialog?.querySelector<HTMLElement>('[data-dialog-initial-focus]') ??
      focusableElements(dialog)[0] ??
      dialog;
    initial?.focus();

    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, [dialogRef, focusKey]);

  return (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Tab') return;
    const dialog = dialogRef.current;
    const focusable = focusableElements(dialog);
    if (focusable.length === 0) {
      event.preventDefault();
      dialog?.focus();
      return;
    }

    const first = focusable[0];
    const last = focusable.at(-1);
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !dialog?.contains(active))) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && (active === last || !dialog?.contains(active))) {
      event.preventDefault();
      first?.focus();
    }
  };
}

interface WorkspaceTrustDialogProps {
  workspace: WorkspaceTrustViewV2;
  busy: boolean;
  error?: string;
  onCancel(): void;
  onTrust(): void;
}

export function WorkspaceTrustDialog({
  workspace,
  busy,
  error,
  onCancel,
  onTrust,
}: WorkspaceTrustDialogProps) {
  const dialogRef = useRef<HTMLElement>(null);
  const trapFocus = useDialogFocus(dialogRef);

  return (
    <div className="dialog-backdrop">
      <section
        ref={dialogRef}
        className="security-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="workspace-trust-title"
        aria-describedby="workspace-trust-description"
        tabIndex={-1}
        onKeyDown={(event) => {
          trapFocus(event);
          if (event.key === 'Escape' && !busy) onCancel();
        }}
      >
        <span className="eyebrow">Workspace trust</span>
        <h2 id="workspace-trust-title">Trust {workspace.displayName}?</h2>
        <p id="workspace-trust-description">
          A trusted workspace may load project configuration and let the selected agent request
          tools. AgentDock will still ask before new actions and record approval decisions.
        </p>
        {!workspace.reusable && (
          <div className="banner banner--error" role="alert">
            This workspace identity could not be proven stable, so it cannot be trusted.
          </div>
        )}
        {error && (
          <div className="banner banner--error" role="alert">
            {error}
          </div>
        )}
        <div className="dialog-actions">
          <button
            data-dialog-initial-focus
            className="button button--secondary"
            type="button"
            disabled={busy}
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            className="button button--primary"
            type="button"
            disabled={busy || !workspace.reusable}
            onClick={onTrust}
          >
            {busy ? 'Trusting…' : 'Trust workspace & run'}
          </button>
        </div>
      </section>
    </div>
  );
}

interface InteractionDialogProps {
  interaction: RendererInteraction;
  busy: boolean;
  error?: string;
  onApproval(decision: ApprovalDecisionV2): void;
  onQuestions(answers: RendererQuestionResponse['answers']): void;
  onCancelSession(): void;
}

export function InteractionDialog(props: InteractionDialogProps) {
  return props.interaction.kind === 'approval' ? (
    <ApprovalDialog {...props} interaction={props.interaction} />
  ) : (
    <QuestionDialog {...props} interaction={props.interaction} />
  );
}

function ApprovalDialog({
  interaction,
  busy,
  error,
  onApproval,
}: InteractionDialogProps & {
  interaction: Extract<RendererInteraction, { kind: 'approval' }>;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const trapFocus = useDialogFocus(dialogRef, interaction.interactionHandle);
  const canDeny = interaction.allowedDecisions.includes('deny');

  return (
    <div className="dialog-backdrop">
      <section
        ref={dialogRef}
        className="security-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="approval-title"
        aria-describedby="approval-description"
        tabIndex={-1}
        onKeyDown={(event) => {
          trapFocus(event);
          if (event.key === 'Escape' && canDeny && !busy) onApproval('deny');
        }}
      >
        <span className="eyebrow">Approval required</span>
        <h2 id="approval-title">{interaction.title}</h2>
        <p id="approval-description">Review the exact action before letting the agent continue.</p>
        <dl className="interaction-details">
          <div>
            <dt>Action</dt>
            <dd>{interaction.action}</dd>
          </div>
          <div>
            <dt>Target</dt>
            <dd>{interaction.target}</dd>
          </div>
          {interaction.reason && (
            <div>
              <dt>Reason</dt>
              <dd>{interaction.reason}</dd>
            </div>
          )}
          <div>
            <dt>Possible effects</dt>
            <dd>
              {interaction.possibleEffects.length > 0
                ? interaction.possibleEffects.join(', ')
                : 'none reported'}
              {!interaction.effectsComplete && ' (provider report incomplete)'}
            </dd>
          </div>
        </dl>
        {error && (
          <div className="banner banner--error" role="alert">
            {error}
          </div>
        )}
        <div className="dialog-actions">
          {canDeny && (
            <button
              data-dialog-initial-focus
              className="button button--danger"
              type="button"
              disabled={busy}
              onClick={() => onApproval('deny')}
            >
              Deny
            </button>
          )}
          {interaction.allowedDecisions.includes('allow_once') && (
            <button
              className="button button--secondary"
              type="button"
              disabled={busy}
              onClick={() => onApproval('allow_once')}
            >
              Allow once
            </button>
          )}
          {interaction.allowedDecisions.includes('allow_session') && (
            <button
              className="button button--primary"
              type="button"
              disabled={busy}
              onClick={() => onApproval('allow_session')}
            >
              Allow for this session
            </button>
          )}
        </div>
      </section>
    </div>
  );
}

function QuestionDialog({
  interaction,
  busy,
  error,
  onQuestions,
  onCancelSession,
}: InteractionDialogProps & {
  interaction: Extract<RendererInteraction, { kind: 'question' }>;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [text, setText] = useState<Record<string, string>>({});
  const trapFocus = useDialogFocus(dialogRef, interaction.interactionHandle);

  useEffect(() => {
    setSelected({});
    setText({});
  }, [interaction.interactionHandle]);

  const answers = useMemo<RendererQuestionResponse['answers'] | undefined>(() => {
    const built: RendererQuestionResponse['answers'] = [];
    for (const question of interaction.questions) {
      const freeText = text[question.questionHandle]?.trim();
      if (freeText) {
        built.push({
          questionHandle: question.questionHandle,
          answer: { kind: 'text', text: freeText },
        });
        continue;
      }
      const optionHandles = selected[question.questionHandle] ?? [];
      if (optionHandles.length === 0) return undefined;
      built.push({
        questionHandle: question.questionHandle,
        answer: { kind: 'options', optionHandles },
      });
    }
    return built;
  }, [interaction.questions, selected, text]);

  return (
    <div className="dialog-backdrop">
      <section
        ref={dialogRef}
        className="security-dialog security-dialog--wide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="question-dialog-title"
        tabIndex={-1}
        onKeyDown={(event) => {
          trapFocus(event);
          if (event.key === 'Escape' && !busy) onCancelSession();
        }}
      >
        <span className="eyebrow">Agent needs input</span>
        <h2 id="question-dialog-title">Answer to continue</h2>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (answers && !busy) onQuestions(answers);
          }}
        >
          {interaction.questions.map((question, questionIndex) => (
            <fieldset key={question.questionHandle} className="question-fieldset">
              <legend>
                {questionIndex + 1}. {question.title}
              </legend>
              <p>{question.prompt}</p>
              {question.preview && <pre className="question-preview">{question.preview}</pre>}
              {question.options?.map((option) => {
                const checked = (selected[question.questionHandle] ?? []).includes(
                  option.optionHandle,
                );
                return (
                  <label key={option.optionHandle} className="question-option">
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={busy}
                      onChange={() => {
                        setSelected((current) => {
                          const values = current[question.questionHandle] ?? [];
                          return {
                            ...current,
                            [question.questionHandle]: checked
                              ? values.filter((value) => value !== option.optionHandle)
                              : [...values, option.optionHandle],
                          };
                        });
                      }}
                    />
                    <span>
                      <strong>{option.label}</strong>
                      {option.description && <small>{option.description}</small>}
                    </span>
                  </label>
                );
              })}
              {question.allowsFreeText && (
                <label>
                  {question.options?.length ? 'Or enter a response' : 'Response'}
                  <textarea
                    value={text[question.questionHandle] ?? ''}
                    maxLength={16 * 1024}
                    rows={3}
                    disabled={busy}
                    onChange={(event) =>
                      setText((current) => ({
                        ...current,
                        [question.questionHandle]: event.target.value,
                      }))
                    }
                  />
                </label>
              )}
            </fieldset>
          ))}
          {error && (
            <div className="banner banner--error" role="alert">
              {error}
            </div>
          )}
          <div className="dialog-actions">
            <button
              className="button button--danger"
              type="button"
              disabled={busy}
              onClick={onCancelSession}
            >
              Cancel session
            </button>
            <button className="button button--primary" type="submit" disabled={busy || !answers}>
              {busy ? 'Sending…' : 'Send answers'}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
