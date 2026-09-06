import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import {
  DECK_CLASSIFIER_YAML_MAX_BYTES,
  type DeckClassifierArchetypeView,
  type DeckClassifierYamlPreviewView,
} from '@game/online/deck-classifier-types';
import { ActionButton, SelectMenu } from '@/components/common';
import { useDialogAccessibility } from '@/hooks/useDialogAccessibility';
import {
  previewDeckClassifierYaml,
  type DeckClassifierYamlImportPayload,
} from '@/lib/deckClassifierAdminClient';

export function DeckClassifierYamlImport({
  archetypes,
  busy,
  importError,
  onImport,
}: {
  archetypes: readonly DeckClassifierArchetypeView[];
  busy: boolean;
  importError: string | null;
  onImport: (input: DeckClassifierYamlImportPayload) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [attemptFailed, setAttemptFailed] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [file, setFile] = useState<{ name: string; content: string } | null>(null);
  const [preview, setPreview] = useState<DeckClassifierYamlPreviewView | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [archetypeId, setArchetypeId] = useState(archetypes[0]?.id ?? '');
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const generation = useRef(0);
  const submitting = useRef(false);
  const autoName = useRef('');
  const autoNote = useRef('');
  function close() {
    if (busy || submitting.current) return;
    reset();
    setOpen(false);
  }
  useDialogAccessibility({ isOpen: open, dialogRef, initialFocusRef: closeRef, onEscape: close });
  useEffect(
    () => () => {
      generation.current++;
    },
    []
  );

  async function loadPreview(content: string, fileName: string, request: number) {
    try {
      const result = await previewDeckClassifierYaml(content);
      if (request !== generation.current) return;
      setPreview(result);
      const suggested = result.suggestedName || fileName.replace(/\.ya?ml$/i, '').slice(0, 120);
      const previousName = autoName.current;
      setName((current) => (!current || current === previousName ? suggested : current));
      autoName.current = suggested;
      const suggestedNote = `YAML 文件：${fileName}`.slice(0, 1000);
      const previousNote = autoNote.current;
      setNote((current) => (!current || current === previousNote ? suggestedNote : current));
      autoNote.current = suggestedNote;
    } catch (failure) {
      if (request === generation.current)
        setError(failure instanceof Error ? failure.message : 'YAML 读取失败');
    } finally {
      if (request === generation.current) setLoading(false);
    }
  }
  async function selectFile(selected: File | undefined) {
    if (!selected) return;
    const request = ++generation.current;
    setPreview(null);
    setFile(null);
    setError(null);
    setLoading(true);
    try {
      if (!/\.ya?ml$/i.test(selected.name)) throw new Error('请选择 .yaml 或 .yml 文件');
      if (!selected.size || selected.size > DECK_CLASSIFIER_YAML_MAX_BYTES)
        throw new Error('请选择非空且不超过 64 KB 的 YAML 文件');
      const content = await selected.text();
      if (request !== generation.current) return;
      setFile({ name: selected.name, content });
      await loadPreview(content, selected.name, request);
    } catch (failure) {
      if (request === generation.current) {
        setError(failure instanceof Error ? failure.message : '文件读取失败');
        setLoading(false);
      }
    }
  }
  function reset() {
    setAttemptFailed(false);
    generation.current++;
    setFile(null);
    setPreview(null);
    setError(null);
    setLoading(false);
    setName('');
    setNote('');
    autoName.current = '';
    autoNote.current = '';
    if (inputRef.current) inputRef.current.value = '';
  }
  return (
    <>
      <ActionButton
        type="button"
        variant="secondary"
        size="compact"
        disabled={busy}
        onClick={() => setOpen(true)}
      >
        导入 YAML
      </ActionButton>
      {open
        ? createPortal(
            <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 sm:p-5">
              <div
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby="yaml-import-title"
                tabIndex={-1}
                className="modal-surface flex h-[100dvh] w-full min-w-0 flex-col overflow-hidden rounded-none sm:h-auto sm:max-h-[90dvh] sm:max-w-3xl sm:rounded-xl"
              >
                <header className="flex shrink-0 items-center justify-between border-b border-[var(--border-subtle)] p-4">
                  <h2 id="yaml-import-title" className="text-base font-semibold">
                    从 YAML 文件导入样板
                  </h2>
                  <button
                    ref={closeRef}
                    type="button"
                    aria-label="关闭 YAML 导入"
                    className="button-icon"
                    disabled={busy || saving}
                    onClick={close}
                  >
                    <X size={20} />
                  </button>
                </header>
                <div className="min-h-0 overflow-y-auto p-4">
                  <p className="mt-1 text-sm text-[var(--text-muted)]">
                    选择导出的卡组文件，预览后确认导入。仅保存主卡组，能量卡不纳入样板。
                  </p>
                  <form
                    className="mt-3 space-y-3"
                    onSubmit={async (event) => {
                      event.preventDefault();
                      if (
                        !file ||
                        !preview ||
                        preview.existingTemplate ||
                        submitting.current ||
                        busy ||
                        loading
                      )
                        return;
                      submitting.current = true;
                      setSaving(true);
                      setError(null);
                      setAttemptFailed(false);
                      try {
                        if (
                          await onImport({
                            yamlContent: file.content,
                            archetypeId,
                            name: name.trim(),
                            sourceNote: note.trim(),
                          })
                        ) {
                          reset();
                          setOpen(false);
                        } else setAttemptFailed(true);
                      } catch (failure) {
                        setError(failure instanceof Error ? failure.message : '导入失败');
                      } finally {
                        submitting.current = false;
                        setSaving(false);
                      }
                    }}
                  >
                    <fieldset disabled={busy || saving} className="space-y-3">
                      <label className="grid gap-1 text-sm">
                        YAML 卡组文件
                        <input
                          ref={inputRef}
                          type="file"
                          accept=".yaml,.yml"
                          className="block w-full min-w-0 rounded-lg border border-[var(--border-subtle)] p-3 text-sm file:mr-3 file:rounded-md file:border-0 file:bg-[var(--bg-elevated)] file:px-3 file:py-2 file:text-[var(--text-primary)]"
                          onChange={(event) => void selectFile(event.target.files?.[0])}
                        />
                      </label>
                      {loading ? <p role="status">正在读取 YAML 预览…</p> : null}
                      {error || (attemptFailed && importError) ? (
                        <p role="alert" className="text-sm text-[var(--semantic-error)]">
                          {error || importError}
                        </p>
                      ) : null}
                      {file && !preview && !loading ? (
                        <ActionButton
                          type="button"
                          variant="secondary"
                          onClick={() => {
                            setError(null);
                            setLoading(true);
                            void loadPreview(file.content, file.name, ++generation.current);
                          }}
                        >
                          重试 YAML 预览
                        </ActionButton>
                      ) : null}
                      {preview ? (
                        <>
                          <p className="text-sm">
                            主卡组 {preview.memberTotal + preview.liveTotal} 张：成员{' '}
                            {preview.memberTotal} 张、LIVE {preview.liveTotal} 张（
                            {preview.cards.length} 种基础卡号）
                          </p>
                          <div className="max-h-64 overflow-auto rounded border border-[var(--border-subtle)]">
                            <table className="w-full text-left text-sm">
                              <caption className="sr-only">YAML 主卡组预览</caption>
                              <thead>
                                <tr>
                                  <th className="p-2">基础卡号</th>
                                  <th>类型</th>
                                  <th>数量</th>
                                </tr>
                              </thead>
                              <tbody>
                                {preview.cards.map((card) => (
                                  <tr key={card.baseCardCode}>
                                    <td className="break-all p-2">{card.baseCardCode}</td>
                                    <td>{card.cardType === 'MEMBER' ? '成员' : 'LIVE'}</td>
                                    <td>{card.count}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                          {preview.existingTemplate ? (
                            <p role="alert" className="text-sm text-[var(--semantic-warning)]">
                              该构筑已存在于样板“{preview.existingTemplate.name}”（
                              {preview.existingTemplate.enabled ? '已启用' : '已停用'}
                              ），请在样板库编辑或重新启用。
                            </p>
                          ) : null}
                          <div className="grid gap-3 sm:grid-cols-3">
                            <div className="grid min-w-0 gap-1 text-sm">
                              <span>归入分类</span>
                              <SelectMenu
                                label="YAML 归入分类"
                                value={archetypeId}
                                onChange={setArchetypeId}
                                options={archetypes.map((item) => ({
                                  value: item.id,
                                  label: `${item.groupName} · ${item.name}`,
                                }))}
                                disabled={busy || saving}
                              />
                            </div>
                            <label className="grid min-w-0 gap-1 text-sm">
                              YAML 样板名称
                              <input
                                className="input-field h-10 min-w-0 px-3 text-sm"
                                value={name}
                                onChange={(e) => setName(e.target.value)}
                                required
                                maxLength={120}
                              />
                            </label>
                            <label className="grid min-w-0 gap-1 text-sm">
                              YAML 来源备注
                              <input
                                className="input-field h-10 min-w-0 px-3 text-sm"
                                value={note}
                                onChange={(e) => setNote(e.target.value)}
                                maxLength={1000}
                              />
                            </label>
                          </div>
                          <ActionButton
                            type="submit"
                            disabled={
                              loading ||
                              !!preview.existingTemplate ||
                              !name.trim() ||
                              !archetypes.some((item) => item.id === archetypeId)
                            }
                          >
                            确认导入 YAML 样板
                          </ActionButton>
                        </>
                      ) : null}
                      <ActionButton type="button" variant="ghost" onClick={close}>
                        取消 YAML 导入
                      </ActionButton>
                    </fieldset>
                  </form>
                </div>
              </div>
            </div>,
            document.body
          )
        : null}
    </>
  );
}
