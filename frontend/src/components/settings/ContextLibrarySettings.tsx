import {
  useEffect,
  useCallback,
  useId,
  useMemo,
  useRef,
  useState,
  type SyntheticEvent,
  type ReactNode,
} from 'react'
import { useTranslation } from 'react-i18next'
import {
  AlertTriangle,
  BookOpen,
  Check,
  Copy,
  Download,
  FilePlus2,
  Link2,
  LockKeyhole,
  Pencil,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
  Upload,
  Unlink,
  Users,
  X,
} from 'lucide-react'
import { Button } from '@/components/shared/FormComponents'
import { useStore } from '@/store'
import { agentContextPacksApi, classifyContextPackError } from '@/api/agent-context-packs'
import { chatsApi } from '@/api/chats'
import { presetsApi } from '@/api/presets'
import { worldBooksApi } from '@/api/world-books'
import { triggerBlobDownload } from '@/lib/downloads'
import {
  CONTEXT_PACK_TARGET_TYPES,
  contextPackNeedsReview,
  type AgentContextPack,
  type AgentContextPackRevision,
  type ContextPackAclEntry,
  type ContextPackAttachment,
  type ContextPackDetail,
  type ContextPackEntryV1,
  type ContextPackPermission,
  type ContextPackTargetType,
  type ContextPackUiErrorCode,
  type ContextPackVisibility,
} from '@/types/agent-context-packs'
import styles from './ContextLibrarySettings.module.css'

interface TargetOption {
  id: string
  label: string
}

type TargetOptions = Record<ContextPackTargetType, TargetOption[]>
type DialogMode = 'create' | 'edit' | 'revision' | 'attach' | 'acl' | 'review' | 'duplicate' | 'delete'

interface DialogPayload {
  name: string
  description: string
  visibility: ContextPackVisibility
  content: ContextPackEntryV1[]
  scope: ContextPackTargetType
  targetId: string
  revision: number
  required: boolean
  acl: ContextPackAclEntry[]
  acknowledged: boolean
  preserveAttachments: boolean
}

const EMPTY_TARGET_OPTIONS: TargetOptions = {
  preset: [],
  chat: [],
  world_book: [],
}
const TARGET_PAGE_SIZE = 200
const TARGET_MAX_PAGES = 1_000
const TARGET_MAX_OPTIONS = TARGET_PAGE_SIZE * TARGET_MAX_PAGES

interface TargetPage {
  readonly data: Array<{ id: string; name: string }>
  readonly total: number
  readonly limit: number
  readonly offset: number
}

async function listAllTargetOptions(
  loadPage: (offset: number) => Promise<TargetPage>,
): Promise<TargetOption[]> {
  const options: TargetOption[] = []
  const seenIds = new Set<string>()
  let offset = 0
  let expectedTotal: number | null = null
  for (let pageCount = 0; pageCount < TARGET_MAX_PAGES; pageCount += 1) {
    const page = await loadPage(offset)
    if (
      !page
      || !Array.isArray(page.data)
      || !Number.isSafeInteger(page.total)
      || page.total < 0
      || page.total > TARGET_MAX_OPTIONS
      || !Number.isSafeInteger(page.limit)
      || page.limit < 1
      || page.limit > TARGET_PAGE_SIZE
      || !Number.isSafeInteger(page.offset)
      || page.offset !== offset
      || page.data.length > page.limit
    ) throw new Error('malformed target pagination metadata')
    if (expectedTotal === null) expectedTotal = page.total
    else if (page.total !== expectedTotal) throw new Error('target pagination total changed during hydration')
    if (page.data.length === 0) {
      if (offset < page.total) throw new Error('target pagination made no progress')
      return options
    }
    const nextOffset = offset + page.data.length
    if (nextOffset <= offset || nextOffset > page.total) {
      throw new Error('target pagination made invalid progress')
    }
    for (const item of page.data) {
      if (
        !item
        || typeof item.id !== 'string'
        || item.id.length === 0
        || typeof item.name !== 'string'
        || seenIds.has(item.id)
      ) throw new Error('target pagination returned a duplicate cursor')
      seenIds.add(item.id)
      options.push({ id: item.id, label: item.name })
    }
    if (nextOffset >= page.total) return options
    if (page.data.length < page.limit) throw new Error('target pagination stopped before its total')
    offset = nextOffset
  }
  throw new Error('target pagination exceeds the bounded page limit')
}

function packStatusLabelKey(pack: AgentContextPack): string {
  return `contextLibrary.status.${pack.state}`
}

function errorLabelKey(error: ContextPackUiErrorCode): string {
  return `contextLibrary.errors.${error}`
}

function AccessibleDialog({
  title,
  description,
  onClose,
  returnFocusFallback,
  children,
}: {
  title: string
  description: string
  onClose: () => void
  returnFocusFallback?: { readonly current: HTMLElement | null }
  children: ReactNode
}) {
  const { t } = useTranslation('settings')
  const titleId = useId()
  const descriptionId = useId()
  const dialogRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const returnTarget = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const dialog = dialogRef.current
    const initialFocus = dialog?.querySelector<HTMLElement>('[data-dialog-initial-focus]')
      ?? dialog?.querySelector<HTMLElement>(
        'input:not([disabled]), textarea:not([disabled]), select:not([disabled]), button:not([disabled])',
      )
    initialFocus?.focus()

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key !== 'Tab' || !dialog) return
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(
        'input:not([disabled]), textarea:not([disabled]), select:not([disabled]), button:not([disabled]), [tabindex="0"]',
      ))
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      if (returnTarget?.isConnected) returnTarget.focus()
      else if (returnFocusFallback?.current?.isConnected) returnFocusFallback.current.focus()
    }
  }, [onClose, returnFocusFallback])

  return (
    <div className={styles.dialogOverlay} onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <div
        ref={dialogRef}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
      >
        <header className={styles.dialogHeader}>
          <div>
            <h3 id={titleId}>{title}</h3>
            <p id={descriptionId}>{description}</p>
          </div>
          <button
            type="button"
            className={styles.iconButton}
            onClick={onClose}
            aria-label={t('contextLibrary.actions.cancel')}
          >
            <X aria-hidden="true" />
          </button>
        </header>
        {children}
      </div>
    </div>
  )
}

function cloneContent(content: ContextPackEntryV1[]): ContextPackEntryV1[] {
  return content.map((entry) => ({ ...entry, tags: [...entry.tags] }))
}

function EntryEditor({
  entries,
  onChange,
}: {
  entries: ContextPackEntryV1[]
  onChange: (entries: ContextPackEntryV1[]) => void
}) {
  const { t } = useTranslation('settings')
  const updateEntry = (index: number, patch: Partial<ContextPackEntryV1>) => {
    onChange(entries.map((entry, candidateIndex) => (
      candidateIndex === index ? { ...entry, ...patch } : entry
    )))
  }

  return (
    <fieldset className={styles.entryEditor}>
      <legend>{t('contextLibrary.fields.content')}</legend>
      <p>{t('contextLibrary.contentHelp')}</p>
      <ol>
        {entries.map((entry, index) => (
          <li key={`${index}-${entry.id}`}>
            <div className={styles.entryHeader}>
              <strong>{t('contextLibrary.entryNumber', { number: index + 1 })}</strong>
              <Button
                size="icon"
                className={styles.iconButton}
                variant="danger-ghost"
                icon={<Trash2 aria-hidden="true" />}
                aria-label={t('contextLibrary.removeEntry', { number: index + 1 })}
                onClick={() => onChange(entries.filter((_, candidateIndex) => candidateIndex !== index))}
                disabled={entries.length === 1}
              />
            </div>
            <div className={styles.inlineFields}>
              <label className={styles.field}>
                <span>{t('contextLibrary.fields.entryId')}</span>
                <input
                  value={entry.id}
                  data-dialog-initial-focus={index === 0 ? 'true' : undefined}
                  onChange={(event) => updateEntry(index, { id: event.target.value })}
                  required
                />
              </label>
              <label className={styles.field}>
                <span>{t('contextLibrary.fields.entryTitle')}</span>
                <input
                  value={entry.title}
                  onChange={(event) => updateEntry(index, { title: event.target.value })}
                />
              </label>
            </div>
            <label className={styles.field}>
              <span>{t('contextLibrary.fields.tags')}</span>
              <input
                value={entry.tags.join(', ')}
                onChange={(event) => updateEntry(index, {
                  tags: event.target.value.split(',').map((tag) => tag.trim()).filter(Boolean),
                })}
              />
              <small>{t('contextLibrary.tagsHelp')}</small>
            </label>
            <label className={styles.field}>
              <span>{t('contextLibrary.fields.body')}</span>
              <textarea
                value={entry.body}
                onChange={(event) => updateEntry(index, { body: event.target.value })}
                rows={8}
              />
            </label>
          </li>
        ))}
      </ol>
      <Button
        className={styles.actionButton}
        icon={<Plus aria-hidden="true" />}
        onClick={() => onChange([
          ...entries,
          { id: `entry-${entries.length + 1}`, title: '', body: '', tags: [] },
        ])}
      >
        {t('contextLibrary.addEntry')}
      </Button>
    </fieldset>
  )
}

function ActionDialog({
  mode,
  detail,
  targets,
  targetsStatus,
  returnFocusFallback,
  onClose,
  onRetryTargets,
  onSubmit,
}: {
  mode: DialogMode
  detail: ContextPackDetail | null
  targets: TargetOptions
  targetsStatus: 'idle' | 'loading' | 'ready' | 'error'
  returnFocusFallback?: { readonly current: HTMLElement | null }
  onClose: () => void
  onRetryTargets: () => void
  onSubmit: (payload: DialogPayload) => Promise<boolean>
}) {
  const { t } = useTranslation('settings')
  const pack = detail?.pack
  const latestContent = detail?.revisions.find((revision) => revision.revision === pack?.latestRevision)?.content ?? []
  const [name, setName] = useState(mode === 'duplicate' ? `${pack?.name ?? ''} ${t('contextLibrary.copySuffix')}` : pack?.name ?? '')
  const [description, setDescription] = useState(pack?.description ?? '')
  const [visibility, setVisibility] = useState<ContextPackVisibility>(pack?.visibility ?? 'private')
  const [content, setContent] = useState<ContextPackEntryV1[]>(
    mode === 'revision' && latestContent.length > 0
      ? cloneContent(latestContent)
      : [{ id: 'main', title: '', body: '', tags: [] }],
  )
  const [scope, setScope] = useState<ContextPackTargetType>('preset')
  const [targetId, setTargetId] = useState('')
  const attachableRevisions = detail?.revisions.filter((candidate) => candidate.state === 'active') ?? []
  const attachableRevisionNumbers = new Set(attachableRevisions.map((candidate) => candidate.revision))
  const [revision, setRevision] = useState(
    detail?.revisions.find((candidate) => candidate.revision === pack?.latestRevision && candidate.state === 'active')?.revision
      ?? attachableRevisions[0]?.revision
      ?? 0,
  )
  const [required, setRequired] = useState(false)
  const [acl, setAcl] = useState<ContextPackAclEntry[]>(detail?.acl ?? [])
  const [principalUserId, setPrincipalUserId] = useState('')
  const [permission, setPermission] = useState<ContextPackPermission>('read')
  const [acknowledged, setAcknowledged] = useState(false)
  const [preserveAttachments, setPreserveAttachments] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  const targetsLoading = targetsStatus === 'loading' || targetsStatus === 'idle'
  const targetsReady = targetsStatus === 'ready'
  const targetOptions = targets[scope]
  const contentIsValid = content.length > 0
    && content.every((entry) => entry.id.trim().length > 0)
    && new Set(content.map((entry) => entry.id.trim())).size === content.length
  const revisionIsAttachable = pack?.state === 'active' && attachableRevisionNumbers.has(revision)
  const canSubmit = mode === 'delete'
    || (mode === 'review' && acknowledged)
    || (mode === 'revision' && contentIsValid)
    || (mode === 'attach' && targetsReady && Boolean(targetId) && revisionIsAttachable)
    || mode === 'acl'
    || ((mode === 'create' || mode === 'edit' || mode === 'duplicate')
      && (mode !== 'create' || contentIsValid)
      && name.trim().length > 0)

  const appendAclEntry = () => {
    const principal = principalUserId.trim()
    if (!principal || acl.some((entry) => entry.principalUserId === principal)) return
    setAcl((entries) => [...entries, { principalUserId: principal, permission }])
    setPrincipalUserId('')
  }

  const handleSubmit = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!canSubmit || submitting) return
    setSubmitting(true)
    const succeeded = await onSubmit({
      name: name.trim(),
      description: description.trim(),
      visibility,
      content: content.map((entry) => ({ ...entry, id: entry.id.trim(), tags: [...entry.tags] })),
      scope,
      targetId,
      revision,
      required,
      acl,
      acknowledged,
      preserveAttachments,
    })
    setSubmitting(false)
    if (succeeded) onClose()
  }

  return (
    <AccessibleDialog
      title={t(`contextLibrary.dialogs.${mode}.title`)}
      description={t(`contextLibrary.dialogs.${mode}.description`)}
      onClose={onClose}
      returnFocusFallback={returnFocusFallback}
    >
      <form className={styles.dialogForm} onSubmit={handleSubmit}>
        {(mode === 'create' || mode === 'edit' || mode === 'duplicate') && (
          <label className={styles.field}>
            <span>{t('contextLibrary.fields.name')}</span>
            <input data-dialog-initial-focus value={name} onChange={(event) => setName(event.target.value)} required />
          </label>
        )}
        {(mode === 'create' || mode === 'edit') && (
          <>
            <label className={styles.field}>
              <span>{t('contextLibrary.fields.description')}</span>
              <textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={3} />
            </label>
            <label className={styles.field}>
              <span>{t('contextLibrary.fields.visibility')}</span>
              <select value={visibility} onChange={(event) => setVisibility(event.target.value as ContextPackVisibility)}>
                <option value="private">{t('contextLibrary.visibility.private')}</option>
                <option value="account">{t('contextLibrary.visibility.account')}</option>
                <option value="restricted">{t('contextLibrary.visibility.restricted')}</option>
              </select>
              <small>{t('contextLibrary.visibility.help')}</small>
            </label>
          </>
        )}
        {(mode === 'create' || mode === 'revision') && <EntryEditor entries={content} onChange={setContent} />}
        {mode === 'attach' && (
          <>
            <label className={styles.field}>
              <span>{t('contextLibrary.fields.scope')}</span>
              <select data-dialog-initial-focus value={scope} onChange={(event) => {
                setScope(event.target.value as ContextPackTargetType)
                setTargetId('')
              }}>
                {CONTEXT_PACK_TARGET_TYPES.map((targetScope) => (
                  <option key={targetScope} value={targetScope}>{t(`contextLibrary.scopes.${targetScope}`)}</option>
                ))}
              </select>
            </label>
            <label className={styles.field}>
              <span>{t('contextLibrary.fields.target')}</span>
              <select value={targetId} onChange={(event) => setTargetId(event.target.value)} disabled={!targetsReady} required>
                <option value="">
                  {targetsLoading
                    ? t('contextLibrary.loadingTargets')
                    : targetsStatus === 'error'
                      ? t('contextLibrary.targetLoadError')
                      : targetOptions.length === 0
                        ? t('contextLibrary.noTargetsAvailable')
                        : t('contextLibrary.selectTarget')}
                </option>
                {targetOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
              </select>
            </label>
            <div
              className={targetsStatus === 'error' ? styles.errorBanner : styles.targetLoadStatus}
              role={targetsStatus === 'error' ? 'alert' : undefined}
            >
              {targetsStatus === 'error' ? <AlertTriangle aria-hidden="true" /> : targetsReady ? <Check aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}
              <span>{t(targetsStatus === 'error'
                ? 'contextLibrary.targetLoadError'
                : targetsReady
                  ? 'contextLibrary.targetsLoaded'
                  : 'contextLibrary.loadingTargets')}</span>
              {targetsStatus === 'error' && (
                <Button className={styles.actionButton} icon={<RefreshCw aria-hidden="true" />} onClick={onRetryTargets}>
                  {t('contextLibrary.actions.retryTargets')}
                </Button>
              )}
            </div>
            <label className={styles.field}>
              <span>{t('contextLibrary.fields.version')}</span>
              <select value={revision} onChange={(event) => setRevision(Number(event.target.value))}>
                {attachableRevisions.map((candidate) => (
                  <option key={candidate.revision} value={candidate.revision}>{t('contextLibrary.versionNumber', { number: candidate.revision })}</option>
                ))}
              </select>
            </label>
            <label className={styles.reviewCheck}>
              <input type="checkbox" checked={required} onChange={(event) => setRequired(event.target.checked)} />
              <span>{t('contextLibrary.requiredAttachment')}</span>
            </label>
          </>
        )}
        {mode === 'acl' && (
          <>
            <ul className={styles.aclEditor} aria-label={t('contextLibrary.accessList')}>
              {acl.map((entry) => (
                <li key={entry.principalUserId}>
                  <span>{entry.principalUserId}</span>
                  <select
                    aria-label={t('contextLibrary.accessFor', { name: entry.principalUserId })}
                    value={entry.permission}
                    onChange={(event) => setAcl((entries) => entries.map((candidate) => (
                      candidate.principalUserId === entry.principalUserId
                        ? { ...candidate, permission: event.target.value as ContextPackPermission }
                        : candidate
                    )))}
                  >
                    <option value="read">{t('contextLibrary.acl.read')}</option>
                    <option value="use">{t('contextLibrary.acl.use')}</option>
                    <option value="edit">{t('contextLibrary.acl.edit')}</option>
                  </select>
                  <button
                    type="button"
                    className={styles.iconButton}
                    onClick={() => setAcl((entries) => entries.filter((candidate) => candidate.principalUserId !== entry.principalUserId))}
                    aria-label={t('contextLibrary.removeAccess', { name: entry.principalUserId })}
                  >
                    <Trash2 aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
            <div className={styles.inlineFields}>
              <label className={styles.field}>
                <span>{t('contextLibrary.fields.account')}</span>
                <input data-dialog-initial-focus value={principalUserId} onChange={(event) => setPrincipalUserId(event.target.value)} autoComplete="off" />
              </label>
              <label className={styles.field}>
                <span>{t('contextLibrary.fields.access')}</span>
                <select value={permission} onChange={(event) => setPermission(event.target.value as ContextPackPermission)}>
                  <option value="read">{t('contextLibrary.acl.read')}</option>
                  <option value="use">{t('contextLibrary.acl.use')}</option>
                  <option value="edit">{t('contextLibrary.acl.edit')}</option>
                </select>
              </label>
              <Button className={styles.actionButton} icon={<Plus aria-hidden="true" />} onClick={appendAclEntry}>
                {t('contextLibrary.addAccess')}
              </Button>
            </div>
            <p className={styles.formNote}>{t('contextLibrary.aclServerAuthority')}</p>
          </>
        )}
        {mode === 'review' && (
          <label className={styles.reviewCheck}>
            <input data-dialog-initial-focus type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} />
            <span>{t('contextLibrary.reviewAcknowledgement')}</span>
          </label>
        )}
        {mode === 'duplicate' && (
          <label className={styles.reviewCheck}>
            <input type="checkbox" checked={preserveAttachments} onChange={(event) => setPreserveAttachments(event.target.checked)} />
            <span>{t('contextLibrary.preserveAttachments')}</span>
          </label>
        )}
        {mode === 'delete' && <p className={styles.dangerText}>{t('contextLibrary.deleteWarning', { name: pack?.name })}</p>}
        <footer className={styles.dialogActions}>
          <Button className={styles.actionButton} onClick={onClose}>{t('contextLibrary.actions.cancel')}</Button>
          <Button
            className={styles.actionButton}
            variant={mode === 'delete' ? 'danger' : 'primary'}
            type="submit"
            disabled={!canSubmit}
            loading={submitting}
          >
            {t(`contextLibrary.dialogs.${mode}.confirm`)}
          </Button>
        </footer>
      </form>
    </AccessibleDialog>
  )
}

function RevisionHistory({
  detail,
  selected,
  onSelect,
}: {
  detail: ContextPackDetail
  selected: AgentContextPackRevision | null
  onSelect: (revision: AgentContextPackRevision) => void
}) {
  const { t, i18n } = useTranslation('settings')
  return (
    <div className={styles.tableScroll}>
      <table className={styles.table}>
        <caption>{t('contextLibrary.versionHistoryCaption')}</caption>
        <thead><tr>
          <th scope="col">{t('contextLibrary.columns.version')}</th>
          <th scope="col">{t('contextLibrary.columns.state')}</th>
          <th scope="col">{t('contextLibrary.columns.size')}</th>
          <th scope="col">{t('contextLibrary.columns.created')}</th>
          <th scope="col"><span className={styles.srOnly}>{t('contextLibrary.columns.actions')}</span></th>
        </tr></thead>
        <tbody>
          {detail.revisions.map((revision) => (
            <tr key={revision.revision}>
              <th scope="row">{revision.revision}</th>
              <td>{t(`contextLibrary.status.${revision.state}`)}</td>
              <td>{t('contextLibrary.byteCount', { count: revision.byteCount })}</td>
              <td>{new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium' }).format(new Date(revision.createdAt * 1000))}</td>
              <td><Button
                size="sm"
                className={styles.actionButton}
                variant={selected?.revision === revision.revision ? 'primary' : 'secondary'}
                onClick={() => onSelect(revision)}
              >{t('contextLibrary.actions.preview')}</Button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function RevisionPreview({ revision }: { revision: AgentContextPackRevision }) {
  const { t } = useTranslation('settings')
  return (
    <section className={styles.preview} aria-label={t('contextLibrary.previewTitle', { number: revision.revision })}>
      <header>
        <strong>{t('contextLibrary.previewTitle', { number: revision.revision })}</strong>
        <span><LockKeyhole aria-hidden="true" />{t('contextLibrary.immutable')}</span>
      </header>
      <ol>
        {revision.content.map((entry) => (
          <li key={entry.id}>
            <h5>{entry.title || entry.id}</h5>
            {entry.tags.length > 0 && <p className={styles.tags}>{entry.tags.join(' · ')}</p>}
            <pre>{entry.body}</pre>
          </li>
        ))}
      </ol>
    </section>
  )
}

export default function ContextLibrarySettings() {
  const { t, i18n } = useTranslation('settings')
  const packs = useStore((state) => state.contextPacks)
  const selectedPackId = useStore((state) => state.selectedContextPackId)
  const detail = useStore((state) => state.selectedContextPack)
  const loading = useStore((state) => state.contextPacksLoading)
  const detailLoading = useStore((state) => state.contextPackDetailLoading)
  const busyAction = useStore((state) => state.contextPackBusyAction)
  const error = useStore((state) => state.contextPackError)
  const contextPackAclRevision = useStore((state) => state.contextPackAclRevision)
  const loadPacks = useStore((state) => state.loadContextPacks)
  const selectPack = useStore((state) => state.selectContextPack)
  const importPack = useStore((state) => state.importContextPack)
  const createPack = useStore((state) => state.createContextPack)
  const updatePack = useStore((state) => state.updateContextPack)
  const deletePack = useStore((state) => state.deleteContextPack)
  const createRevision = useStore((state) => state.createContextPackRevision)
  const attachPack = useStore((state) => state.attachContextPack)
  const detachPack = useStore((state) => state.detachContextPack)
  const replaceAcl = useStore((state) => state.replaceContextPackAcl)
  const reviewPack = useStore((state) => state.reviewContextPack)
  const duplicatePack = useStore((state) => state.duplicateContextPack)
  const clearError = useStore((state) => state.clearContextPackError)
  const [dialogMode, setDialogMode] = useState<DialogMode | null>(null)
  const [selectedRevision, setSelectedRevision] = useState<AgentContextPackRevision | null>(null)
  const [targets, setTargets] = useState<TargetOptions>(EMPTY_TARGET_OPTIONS)
  const [targetsStatus, setTargetsStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [notice, setNotice] = useState<{ kind: 'progress' | 'success'; text: string } | null>(null)
  const [exporting, setExporting] = useState(false)
  const autoSelectionAttempts = useRef(new Set<string>())
  const targetRequestEpoch = useRef(0)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const packListHeadingRef = useRef<HTMLHeadingElement>(null)
  const detailPackId = detail?.pack.id
  const revisionConflict = error === 'revision_conflict'
  const closeDialog = useCallback(() => setDialogMode(null), [])

  useEffect(() => {
    if (revisionConflict) setDialogMode(null)
  }, [revisionConflict])


  useEffect(() => { void loadPacks() }, [loadPacks])

  useEffect(() => {
    const firstPackId = packs[0]?.id
    if (selectedPackId || !firstPackId || autoSelectionAttempts.current.has(firstPackId)) return
    autoSelectionAttempts.current.add(firstPackId)
    void selectPack(firstPackId)
  }, [packs, selectPack, selectedPackId])

  useEffect(() => {
    const latest = detail?.revisions.find((revision) => revision.revision === detail.pack.latestRevision)
    setSelectedRevision(latest ?? detail?.revisions[0] ?? null)
  }, [detail?.pack.id, detail?.pack.latestRevision, detail?.revisions])

  const loadTargets = useCallback(async () => {
    const requestEpoch = ++targetRequestEpoch.current
    setTargetsStatus('loading')
    try {
      const [presetOptions, chatOptions, worldBooks] = await Promise.all([
        listAllTargetOptions((offset) => presetsApi.list({ limit: TARGET_PAGE_SIZE, offset })),
        listAllTargetOptions((offset) => chatsApi.list({ limit: TARGET_PAGE_SIZE, offset })),
        worldBooksApi.listAll(),
      ])
      if (requestEpoch !== targetRequestEpoch.current) return
      setTargets({
        preset: presetOptions,
        chat: chatOptions,
        world_book: worldBooks.map((book) => ({ id: book.id, label: book.name })),
      })
      setTargetsStatus('ready')
    } catch {
      if (requestEpoch !== targetRequestEpoch.current) return
      setTargets(EMPTY_TARGET_OPTIONS)
      setTargetsStatus('error')
    }
  }, [])

  useEffect(() => {
    if (!detailPackId) {
      ++targetRequestEpoch.current
      setTargets(EMPTY_TARGET_OPTIONS)
      setTargetsStatus('idle')
      return
    }
    void loadTargets()
    return () => { ++targetRequestEpoch.current }
  }, [detailPackId, loadTargets])

  const selectedPack = detail?.pack ?? null
  const selectedNeedsReview = selectedPack ? contextPackNeedsReview(selectedPack) : false
  const sortedPacks = useMemo(
    () => [...packs].sort((left, right) => left.name.localeCompare(right.name, i18n.language)),
    [i18n.language, packs],
  )

  const targetLabel = (attachment: ContextPackAttachment) => (
    targets[attachment.scope].find((target) => target.id === attachment.targetId)?.label
      ?? t('contextLibrary.unavailableTarget')
  )

  const handleDialogSubmit = async (payload: DialogPayload): Promise<boolean> => {
    setNotice(null)
    clearError()
    if (dialogMode === 'create') {
      return Boolean(await createPack({
        name: payload.name,
        description: payload.description,
        visibility: payload.visibility,
        content: payload.content,
      }))
    }
    if (!selectedPack || !dialogMode) return false
    if (dialogMode === 'edit') {
      return Boolean(await updatePack(selectedPack.id, {
        name: payload.name,
        description: payload.description,
        visibility: payload.visibility,
        expectedRevision: selectedPack.latestRevision,
      }))
    }
    if (dialogMode === 'revision') {
      return Boolean(await createRevision(selectedPack.id, {
        content: payload.content,
        expectedRevision: selectedPack.latestRevision,
      }))
    }
    if (dialogMode === 'attach') {
      return Boolean(await attachPack(selectedPack.id, {
        scope: payload.scope,
        targetId: payload.targetId,
        revision: payload.revision,
        required: payload.required,
        expectedContextAclRevision: contextPackAclRevision,
      }))
    }
    if (dialogMode === 'acl') {
      return Boolean(await replaceAcl(selectedPack.id, {
        expectedContextAclRevision: contextPackAclRevision,
        entries: payload.acl.map(({ principalUserId, permission }) => ({ principalUserId, permission })),
      }))
    }
    if (dialogMode === 'review') {
      return Boolean(await reviewPack(selectedPack.id, {
        state: 'active',
        acknowledge: true,
        expectedRevision: selectedPack.latestRevision,
      }))
    }
    if (dialogMode === 'duplicate') {
      return Boolean(await duplicatePack(selectedPack.id, {
        name: payload.name,
        description: selectedPack.description,
        preserveAttachments: payload.preserveAttachments,
      }))
    }
    if (dialogMode === 'delete') return deletePack(selectedPack.id, selectedPack.latestRevision)
    return false
  }

  const handleExport = async () => {
    if (!selectedPack || !selectedRevision || exporting) return
    setNotice({ kind: 'progress', text: t('contextLibrary.exporting') })
    setExporting(true)
    clearError()
    try {
      const snapshot = await agentContextPacksApi.exportPortable(selectedPack.id, selectedRevision.revision)
      triggerBlobDownload(
        new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' }),
        `context-pack-${selectedPack.id}-r${selectedRevision.revision}.json`,
      )
      setNotice({ kind: 'success', text: t('contextLibrary.exportComplete') })
    } catch (exportError) {
      setNotice(null)
      useStore.setState({ contextPackError: classifyContextPackError(exportError) })
    } finally {
      setExporting(false)
    }
  }

  const handleImport = async (event: SyntheticEvent<HTMLInputElement>) => {
    const input = event.currentTarget
    const file = input.files?.[0]
    if (!file || busyAction === 'import') return
    setNotice({ kind: 'progress', text: t('contextLibrary.importing') })
    clearError()
    try {
      let snapshot: unknown
      try {
        snapshot = JSON.parse(await file.text()) as unknown
      } catch {
        setNotice(null)
        useStore.setState({ contextPackError: 'validation_failed' })
        return
      }
      const imported = await importPack(snapshot)
      if (imported) {
        setNotice({
          kind: 'success',
          text: t('contextLibrary.importComplete', { name: imported.pack.name }),
        })
      } else {
        setNotice(null)
      }
    } catch (importError) {
      setNotice(null)
      useStore.setState({ contextPackError: classifyContextPackError(importError) })
    } finally {
      input.value = ''
      const currentState = useStore.getState()
      if (currentState.contextPackBusyAction === 'import') {
        useStore.setState({ contextPackBusyAction: null })
      }
      if (currentState.contextPackError) setNotice(null)
    }
  }
  const targetLiveStatus = dialogMode === 'attach' && targetsStatus !== 'error'
    ? t(targetsStatus === 'ready' ? 'contextLibrary.targetsLoaded' : 'contextLibrary.loadingTargets')
    : null
  const liveStatusText = notice?.text ?? targetLiveStatus


  return (
    <section className={styles.library} aria-labelledby="context-library-title">
      <header className={styles.pageHeader}>
        <div>
          <p className={styles.eyebrow}>{t('contextLibrary.eyebrow')}</p>
          <h2 id="context-library-title"><BookOpen aria-hidden="true" />{t('contextLibrary.title')}</h2>
          <p>{t('contextLibrary.description')}</p>
        </div>
        <div className={styles.headerActions}>
          <Button
            className={styles.actionButton}
            icon={<Upload aria-hidden="true" />}
            onClick={() => fileInputRef.current?.click()}
            loading={busyAction === 'import'}
            disabled={revisionConflict || busyAction === 'import'}
          >
            {t('contextLibrary.actions.import')}
          </Button>
          <input
            ref={fileInputRef}
            className={styles.srOnly}
            type="file"
            accept="application/json,.json"
            aria-label={t('contextLibrary.importFileLabel')}
            tabIndex={-1}
            onChange={(event) => void handleImport(event)}
          />
          <Button className={styles.actionButton} variant="primary" icon={<Plus aria-hidden="true" />} onClick={() => setDialogMode('create')} disabled={revisionConflict}>
            {t('contextLibrary.actions.create')}
          </Button>
        </div>
      </header>

      {error && <div className={styles.errorBanner} role="alert">
        <AlertTriangle aria-hidden="true" />
        <span>{t(errorLabelKey(error))}</span>
        <Button className={styles.actionButton} icon={<RefreshCw aria-hidden="true" />} onClick={() => {
          if (revisionConflict) {
            clearError()
            return
          }
          clearError()
          void loadPacks()
          if (selectedPackId) void selectPack(selectedPackId)
        }}>{t(revisionConflict ? 'contextLibrary.actions.reviewLatest' : 'contextLibrary.actions.refresh')}</Button>
      </div>}
      {liveStatusText && <p
        className={notice?.kind === 'success' ? styles.successBanner : styles.statusBanner}
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >{liveStatusText}</p>}

      <div className={styles.libraryLayout}>
        <aside className={styles.packIndex} aria-label={t('contextLibrary.packList')}>
          <div className={styles.indexHeader}><h3 ref={packListHeadingRef} tabIndex={-1}>{t('contextLibrary.packs')}</h3><span>{packs.length}</span></div>
          {loading ? <p className={styles.loading}>{t('contextLibrary.loading')}</p> : sortedPacks.length === 0 ? (
            <div className={styles.emptyState}><FilePlus2 aria-hidden="true" /><strong>{t('contextLibrary.emptyTitle')}</strong><p>{t('contextLibrary.emptyDescription')}</p></div>
          ) : <ul className={styles.packList}>{sortedPacks.map((pack) => {
            const attention = contextPackNeedsReview(pack)
            return <li key={pack.id}><button
              type="button"
              className={selectedPackId === pack.id ? styles.packButtonActive : styles.packButton}
              onClick={() => void selectPack(pack.id)}
              aria-current={selectedPackId === pack.id ? 'true' : undefined}
            >
              <span><strong>{pack.name}</strong><small>{t('contextLibrary.versionNumber', { number: pack.latestRevision })}</small></span>
              <span className={attention ? styles.statusAttention : styles.statusReady}>
                {attention ? <LockKeyhole aria-hidden="true" /> : <Check aria-hidden="true" />}
                <span className={styles.srOnly}>{t(packStatusLabelKey(pack))}</span>
              </span>
            </button></li>
          })}</ul>}
        </aside>

        <main className={styles.detail}>
          {detailLoading ? <p className={styles.loading}>{t('contextLibrary.loadingDetail')}</p> : !detail || !selectedPack ? (
            <div className={styles.detailPlaceholder}><BookOpen aria-hidden="true" /><p>{t('contextLibrary.selectPack')}</p></div>
          ) : <>
            <header className={styles.detailHeader}>
              <div>
                <div className={styles.titleRow}>
                  <h3>{selectedPack.name}</h3>
                  <span className={selectedNeedsReview ? styles.statusAttention : styles.statusReady}>
                    {selectedNeedsReview ? <AlertTriangle aria-hidden="true" /> : <Check aria-hidden="true" />}
                    {t(packStatusLabelKey(selectedPack))}
                  </span>
                </div>
                <p>{selectedPack.description || t('contextLibrary.noDescription')}</p>
                <dl className={styles.metadataList}>
                  <div><dt>{t('contextLibrary.fields.visibility')}</dt><dd>{t(`contextLibrary.visibility.${selectedPack.visibility}`)}</dd></div>
                  <div><dt>{t('contextLibrary.fields.source')}</dt><dd>{t(`contextLibrary.source.${selectedPack.provenance.kind}`)}</dd></div>
                  <div><dt>{t('contextLibrary.fields.updated')}</dt><dd>{new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium' }).format(new Date(selectedPack.updatedAt * 1000))}</dd></div>
                </dl>
              </div>
              <div className={styles.headerActions}>
                <Button className={styles.actionButton} icon={<Pencil aria-hidden="true" />} onClick={() => setDialogMode('edit')} disabled={revisionConflict}>{t('contextLibrary.actions.edit')}</Button>
                <Button className={styles.actionButton} icon={<Copy aria-hidden="true" />} onClick={() => setDialogMode('duplicate')} disabled={revisionConflict}>{t('contextLibrary.actions.duplicate')}</Button>
                <Button className={styles.actionButton} icon={<Download aria-hidden="true" />} onClick={() => void handleExport()} loading={exporting} disabled={!selectedRevision || exporting}>{t('contextLibrary.actions.export')}</Button>
              </div>
            </header>

            {selectedNeedsReview && <section className={styles.reviewBanner} aria-labelledby="context-pack-review-title">
              <ShieldCheck aria-hidden="true" />
              <div><h4 id="context-pack-review-title">{t('contextLibrary.reviewTitle')}</h4><p>{t(selectedPack.state === 'repair_required' ? 'contextLibrary.repairDescription' : 'contextLibrary.reviewDescription')}</p></div>
              <Button className={styles.actionButton} variant="primary" onClick={() => setDialogMode('review')} disabled={revisionConflict || selectedPack.state === 'repair_required'}>{t('contextLibrary.actions.review')}</Button>
            </section>}

            <details id="setsec-contextLibrary-versions" className={styles.disclosure} open>
              <summary><span>{t('contextLibrary.sections.versions')}</span><span>{detail.revisions.length}</span></summary>
              <div className={styles.disclosureBody}>
                <div className={styles.sectionActions}><p>{t('contextLibrary.versionImmutableHelp')}</p><Button className={styles.actionButton} icon={<FilePlus2 aria-hidden="true" />} onClick={() => setDialogMode('revision')} disabled={revisionConflict || selectedNeedsReview}>{t('contextLibrary.actions.newVersion')}</Button></div>
                <RevisionHistory detail={detail} selected={selectedRevision} onSelect={setSelectedRevision} />
                {selectedRevision && <RevisionPreview revision={selectedRevision} />}
              </div>
            </details>

            <details id="setsec-contextLibrary-attachments" className={styles.disclosure} open>
              <summary><span>{t('contextLibrary.sections.attachments')}</span><span>{detail.attachments.length}</span></summary>
              <div className={styles.disclosureBody}>
                <div className={styles.sectionActions}><p>{t('contextLibrary.attachmentsDescription')}</p><Button className={styles.actionButton} icon={<Link2 aria-hidden="true" />} onClick={() => setDialogMode('attach')} disabled={revisionConflict || selectedNeedsReview || detail.revisions.length === 0}>{t('contextLibrary.actions.attach')}</Button></div>
                {detail.attachments.length === 0 ? <p className={styles.emptyInline}>{t('contextLibrary.noAttachments')}</p> : <ul className={styles.attachmentList}>{detail.attachments.map((attachment) => <li key={attachment.attachmentId}>
                  <span className={styles.scopeIcon}><Link2 aria-hidden="true" /></span>
                  <span><strong>{targetLabel(attachment)}</strong><small>{t(`contextLibrary.scopes.${attachment.scope}`)} · {t('contextLibrary.versionNumber', { number: attachment.revision })}</small></span>
                  <span className={attachment.state === 'active' ? styles.statusReady : styles.statusAttention}>{t(`contextLibrary.status.${attachment.state}`)}</span>
                  <Button size="icon" className={styles.iconButton} variant="danger-ghost" onClick={() => void detachPack(selectedPack.id, attachment, contextPackAclRevision)} disabled={revisionConflict || Boolean(busyAction)} aria-label={t('contextLibrary.detachFrom', { name: targetLabel(attachment) })} icon={<Unlink aria-hidden="true" />} />
                </li>)}</ul>}
              </div>
            </details>

            <details id="setsec-contextLibrary-access" className={styles.disclosure}>
              <summary><span>{t('contextLibrary.sections.access')}</span><span>{detail.acl.length}</span></summary>
              <div className={styles.disclosureBody}>
                <div className={styles.sectionActions}><p>{t('contextLibrary.accessDescription')}</p><Button className={styles.actionButton} icon={<Users aria-hidden="true" />} onClick={() => setDialogMode('acl')} disabled={revisionConflict}>{t('contextLibrary.actions.manageAccess')}</Button></div>
                {detail.acl.length === 0 ? <p className={styles.emptyInline}>{t('contextLibrary.privateOnly')}</p> : <ul className={styles.accessList}>{detail.acl.map((entry) => <li key={entry.principalUserId}><span>{entry.principalUserId}</span><span>{t(`contextLibrary.acl.${entry.permission}`)}</span></li>)}</ul>}
              </div>
            </details>

            <footer className={styles.dangerZone}><div><strong>{t('contextLibrary.deleteTitle')}</strong><p>{t('contextLibrary.deleteDescription')}</p></div><Button className={styles.actionButton} variant="danger-ghost" icon={<Trash2 aria-hidden="true" />} onClick={() => setDialogMode('delete')} disabled={revisionConflict}>{t('contextLibrary.actions.delete')}</Button></footer>
          </>}
        </main>
      </div>

      {dialogMode && (
        <ActionDialog
          mode={dialogMode}
          detail={detail}
          targets={targets}
          targetsStatus={targetsStatus}
          returnFocusFallback={dialogMode === 'delete' ? packListHeadingRef : undefined}
          onClose={closeDialog}
          onRetryTargets={() => { void loadTargets() }}
          onSubmit={handleDialogSubmit}
        />
      )}
    </section>
  )
}
