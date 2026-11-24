import { useEffect, useRef, useState } from 'react';
import type {
  AgentModelCatalog,
  AgentPromptId,
  AgentPromptModule,
  AgentPromptOverrides,
  AgentSettingsSection,
  CodophonAgentBackend,
} from '../../config/types.ts';
import { getAgentLabel } from '../../lib/app-constants.ts';
import { Button } from './Button.tsx';

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

function ModelPicker({ backend, selected }: { backend: CodophonAgentBackend; selected: string }) {
  const [catalog, setCatalog] = useState<AgentModelCatalog>();
  const [query, setQuery] = useState('');
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState('');
  const [selectionError, setSelectionError] = useState('');
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    void window.codophon.getAgentModelCatalog?.(revision > 0).then(
      (result) => {
        if (active) {
          setCatalog(result);
          setLoading(false);
        }
      },
      (error_: unknown) => {
        if (active) {
          setCatalog(undefined);
          setError(message(error_));
          setLoading(false);
        }
      },
    );
    return () => {
      active = false;
    };
  }, [revision]);

  const terms = query.trim().toLowerCase().split(/\s+/);
  const matches = catalog?.models.filter(({ id, label }) =>
    terms.every((term) => `${label} ${id}`.toLowerCase().includes(term)),
  );
  const selectionUnverified =
    !loading &&
    catalog &&
    backend === 'opencode' &&
    selected.startsWith('github-copilot/') &&
    !catalog.models.some(({ id }) => id === selected);
  return (
    <>
      <p className="agent-settings-current-model">
        {getAgentLabel(backend)} · Configured model: <code>{selected}</code>
      </p>
      <div className="agent-settings-row">
        <input
          aria-label="Filter models"
          className="open-review-source-input"
          onChange={(event) => setQuery(event.currentTarget.value)}
          placeholder="Filter by model name or ID"
          type="search"
          value={query}
        />
        <Button
          disabled={saving || loading}
          onClick={() => {
            setError('');
            setLoading(true);
            setSelectionError('');
            setRevision((value) => value + 1);
          }}
          type="button"
        >
          Refresh
        </Button>
      </div>
      {error || selectionError ? <p role="alert">{error || selectionError}</p> : null}
      {loading ? (
        <p role="status">
          {catalog ? 'Refreshing available models…' : 'Loading available models…'}
        </p>
      ) : null}
      {catalog ? (
        <>
          {!loading && (catalog.note || selectionUnverified) ? (
            <p role="status">
              {catalog.note}
              {selectionUnverified
                ? ' Your current selection was kept but could not be verified.'
                : ''}
            </p>
          ) : null}
          {matches?.length ? (
            <ul aria-label="Available models" className="agent-model-list">
              {matches.map(({ id, label }) => (
                <li key={id}>
                  <button
                    aria-pressed={selected === id}
                    disabled={saving || loading}
                    onClick={() => {
                      if (selected === id) {
                        return;
                      }
                      setSaving(true);
                      setSelectionError('');
                      void window.codophon
                        .selectAgentModel?.(backend, id)
                        .catch((error_: unknown) => setSelectionError(message(error_)))
                        .finally(() => setSaving(false));
                    }}
                    type="button"
                  >
                    <span>{label}</span>
                    <code>{id}</code>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p role="status">No models match your filter.</p>
          )}
        </>
      ) : null}
    </>
  );
}

function PromptEditor({ overrides }: { overrides: AgentPromptOverrides }) {
  const [modules, setModules] = useState<Array<AgentPromptModule>>([]);
  const [selected, setSelected] = useState<AgentPromptId>('walkthroughSummary');
  const [drafts, setDrafts] = useState<AgentPromptOverrides>({});
  const [lastSave, setLastSave] = useState<{
    base: AgentPromptOverrides;
    result: AgentPromptOverrides;
  }>();
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    void window.codophon.getAgentPrompts?.().then(
      (result) => {
        if (active) {
          setModules(result);
        }
      },
      (error_: unknown) => {
        if (active) {
          setError(message(error_));
        }
      },
    );
    return () => {
      active = false;
    };
  }, []);
  const saved = lastSave?.base === overrides ? lastSave.result : overrides;
  const module = modules.find(({ id }) => id === selected);
  const current = module ? (saved[selected] ?? module.text) : '';
  const draft = drafts[selected] ?? current;
  const save = (text: string | null) => {
    setSaving(true);
    setStatus('');
    setError('');
    void window.codophon
      .setAgentPrompt?.(selected, text)
      .then((result) => {
        setLastSave({ base: overrides, result });
        setDrafts((previous) => ({ ...previous, [selected]: undefined }));
        setStatus(text === null ? 'Default restored.' : 'Prompt saved.');
      })
      .catch((error_: unknown) => setError(message(error_)))
      .finally(() => setSaving(false));
  };

  return (
    <>
      <p>
        Edit writing guidance for each task. Codophon still supplies review context and enforces the
        response format.
      </p>
      {module ? (
        <>
          <select
            aria-label="Prompt module"
            className="open-review-source-input"
            disabled={saving}
            onChange={(event) => {
              const next = modules.find(({ id }) => id === event.currentTarget.value);
              if (next) {
                setSelected(next.id);
              }
              setStatus('');
              setError('');
            }}
            value={selected}
          >
            {modules.map(({ id, label }) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
          <textarea
            aria-label={module.label}
            className="open-review-source-input"
            disabled={saving}
            maxLength={16_000}
            onChange={(event) => {
              const value = event.currentTarget.value;
              setStatus('');
              setDrafts((previous) => ({ ...previous, [selected]: value }));
            }}
            spellCheck={false}
            value={draft}
          />
          <div className="agent-settings-row">
            <Button
              disabled={saving || !draft.trim() || draft.trim() === current}
              onClick={() => save(draft)}
              type="button"
            >
              Save prompt
            </Button>
            <Button
              disabled={saving || (draft === module.text && saved[selected] === undefined)}
              onClick={() => save(null)}
              type="button"
            >
              Reset to default
            </Button>
            {status ? <span role="status">{status}</span> : null}
          </div>
        </>
      ) : !error ? (
        <p role="status">Loading prompt modules…</p>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
    </>
  );
}

export function AgentSettingsDialog({
  backend,
  configuredModel,
  initialSection,
  onClose,
  overrides,
}: {
  backend: CodophonAgentBackend;
  configuredModel: string;
  initialSection: AgentSettingsSection;
  onClose: () => void;
  overrides: AgentPromptOverrides;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [section, setSection] = useState(initialSection);
  const [showPromptEditor, setShowPromptEditor] = useState(initialSection === 'prompts');
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  return (
    <dialog
      aria-labelledby="agent-settings-title"
      className="open-review-source-dialog review-brief-dialog agent-settings-dialog"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onKeyDown={(event) => event.stopPropagation()}
      ref={ref}
    >
      <header className="agent-settings-row">
        <h2 id="agent-settings-title">Agent Settings</h2>
        <Button onClick={onClose} type="button">
          Close
        </Button>
      </header>
      <nav aria-label="Agent settings sections" className="agent-settings-row">
        <Button
          aria-pressed={section === 'models'}
          onClick={() => setSection('models')}
          type="button"
        >
          Models
        </Button>
        <Button
          aria-pressed={section === 'prompts'}
          onClick={() => {
            setShowPromptEditor(true);
            setSection('prompts');
          }}
          type="button"
        >
          Prompts
        </Button>
      </nav>
      {section === 'models' ? (
        <ModelPicker backend={backend} key={backend} selected={configuredModel} />
      ) : null}
      {showPromptEditor ? (
        <section className="agent-prompt-editor" hidden={section !== 'prompts'}>
          <PromptEditor overrides={overrides} />
        </section>
      ) : null}
    </dialog>
  );
}
