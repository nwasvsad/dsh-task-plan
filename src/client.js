/**
 * DeepSeek Harness task-plan plugin, browser half.
 *
 * One global main panel ("任务计划") lists the durable plan table and the live
 * run state. Every task runs as its own ordinary Session, so the left session
 * list is the place to watch one task while this page is the aggregate board;
 * the page's "打开会话" action selects that Session. Daily digests live in the
 * independent dsh-task-digest package.
 *
 * @module dsh-task-plan/client
 */

const NS = 'task-plan'

const ZH = {
  panel: '任务计划',
  title: '任务计划',
  subtitle: '白天录入，谷值时自动执行；次日生成逐任务费用日报。',
  offPeak: '谷值时段',
  peak: '峰时',
  nextRun: '下次自动执行',
  nextSummary: '下次日报',
  dueNow: '已到点，等待执行',
  runAll: '执行全部待执行',
  runningNow: '运行中',
  refresh: '刷新',
  add: '新增任务',
  addTitle: '任务标题',
  addInstruction: '任务说明（会作为会话的第一条指令）',
  addKind: '类型',
  addCwd: '工作目录（可选，绝对路径）',
  addEnabled: '启用',
  submit: '加入计划',
  cancel: '取消',
  save: '保存',
  edit: '编辑',
  delete: '删除',
  runNow: '立即执行',
  retry: '重试',
  openSession: '打开会话',
  noTasks: '还没有任务。把今天想到的事填进来，18:00 会自动执行。',
  noReports: '还没有日报。明天 00:05 会自动生成，也可以手动生成昨天的。',
  tasksTab: '任务计划',
  reportsTab: '每日总结',
  colStatus: '状态',
  colTask: '任务',
  colKind: '类型',
  colLastRun: '上次执行',
  colUsage: 'token / 金额',
  colResult: '结果',
  colActions: '操作',
  tokens: 'token',
  cost: '金额',
  duration: '耗时',
  result: '结果',
  actions: '操作',
  generate: '生成总结',
  generating: '生成中…',
  regenerate: '重新生成',
  generateYesterday: '生成昨日总结',
  openSummary: '打开总结会话',
  summaryCost: '本次总结消耗',
  copy: '复制 Markdown',
  copied: '已复制',
  summarySession: '总结会话',
  mode: '模式',
  llm: '模型生成',
  fallback: '模板生成',
  closeReport: '关闭',
  error: '出错了',
  dismiss: '关闭',
  loading: '加载中…',
  confirmDelete: '确定删除这个任务？',
  peakHint: '当前是峰时，自动执行会等谷值；可以手动立即执行。',
  offPeakHint: '当前是谷值，自动执行按计划进行。',
  disabled: '插件已在配置中禁用',
  emptyResult: '（无最终文本）',
  unknown: '未知',
  now: '现在',
  later: '后',
  ago: '前',
  quota: '单次上限',
  status: {
    pending: '待执行',
    queued: '排队中',
    running: '执行中',
    done: '已完成',
    failed: '失败',
    cancelled: '已取消',
    interrupted: '已中断',
  },
  kinds: {
    dev: '开发',
    research: '调研',
    data: '数据',
    ops: '运维',
    writing: '写作',
    automation: '自动化',
    other: '其他',
  },
}

const EN = {
  panel: 'Task plan',
  title: 'Task plan',
  subtitle: 'Capture during the day, run automatically off-peak, digest each task next morning.',
  offPeak: 'Off-peak',
  peak: 'Peak',
  nextRun: 'Next run',
  nextSummary: 'Next digest',
  dueNow: 'Due now',
  runAll: 'Run all pending',
  runningNow: 'Running',
  refresh: 'Refresh',
  add: 'Add task',
  addTitle: 'Title',
  addInstruction: 'Instruction (first prompt of the task Session)',
  addKind: 'Kind',
  addCwd: 'Working directory (optional, absolute)',
  addEnabled: 'Enabled',
  submit: 'Add to plan',
  cancel: 'Cancel',
  save: 'Save',
  edit: 'Edit',
  delete: 'Delete',
  runNow: 'Run now',
  retry: 'Retry',
  openSession: 'Open session',
  noTasks: 'No tasks yet. Add what you thought of today; it runs at 18:00.',
  noReports: 'No digest yet. It is generated at 00:05, or you can request yesterday now.',
  tasksTab: 'Tasks',
  reportsTab: 'Digests',
  colStatus: 'Status',
  colTask: 'Task',
  colKind: 'Kind',
  colLastRun: 'Last run',
  colUsage: 'Tokens / cost',
  colResult: 'Result',
  colActions: 'Actions',
  tokens: 'tokens',
  cost: 'cost',
  duration: 'duration',
  result: 'result',
  actions: 'actions',
  generate: 'Generate digest',
  generating: 'Generating…',
  regenerate: 'Regenerate',
  generateYesterday: 'Summarise yesterday',
  openSummary: 'Open digest session',
  summaryCost: 'Digest cost',
  copy: 'Copy Markdown',
  copied: 'Copied',
  summarySession: 'Digest session',
  mode: 'Mode',
  llm: 'Model',
  fallback: 'Template',
  closeReport: 'Close',
  error: 'Something went wrong',
  dismiss: 'Dismiss',
  loading: 'Loading…',
  confirmDelete: 'Delete this task?',
  peakHint: 'Peak hours: automatic runs wait for off-peak; you can still run now.',
  offPeakHint: 'Off-peak: automatic runs proceed as scheduled.',
  disabled: 'Disabled by configuration',
  emptyResult: '(no final text)',
  unknown: 'unknown',
  now: 'now',
  later: 'later',
  ago: 'ago',
  quota: 'Per-run cap',
  status: {
    pending: 'Pending',
    queued: 'Queued',
    running: 'Running',
    done: 'Done',
    failed: 'Failed',
    cancelled: 'Cancelled',
    interrupted: 'Interrupted',
  },
  kinds: {
    dev: 'Dev',
    research: 'Research',
    data: 'Data',
    ops: 'Ops',
    writing: 'Writing',
    automation: 'Automation',
    other: 'Other',
  },
}

const inject = ['slots', 'locale', 'uiWorkspace']

const S = {
  page: { height: '100%', overflow: 'auto', padding: '22px 28px 40px', color: 'var(--dsh-text, #1f2328)', boxSizing: 'border-box' },
  header: { display: 'flex', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap', marginBottom: 14 },
  headMain: { flex: '1 1 380px', minWidth: 280 },
  title: { margin: 0, fontSize: 22, fontWeight: 650, letterSpacing: -0.2 },
  subtitle: { margin: '4px 0 0', fontSize: 12.5, opacity: 0.62 },
  headActions: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  button: { border: '1px solid var(--dsh-border, #d0d7de)', background: 'var(--dsh-surface, #fff)', color: 'inherit', borderRadius: 7, padding: '6px 10px', fontSize: 12.5, cursor: 'pointer' },
  buttonPrimary: { border: '1px solid #2f6feb', background: '#2f6feb', color: '#fff', borderRadius: 7, padding: '6px 12px', fontSize: 12.5, cursor: 'pointer' },
  buttonDanger: { border: '1px solid #d0d7de', background: 'transparent', color: '#b42318', borderRadius: 7, padding: '6px 10px', fontSize: 12.5, cursor: 'pointer' },
  buttonDisabled: { opacity: 0.5, cursor: 'not-allowed' },
  badge: { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 9px', borderRadius: 999, fontSize: 12, background: 'rgba(47,111,235,0.09)', color: '#2f6feb' },
  badgePeak: { background: 'rgba(212,112,0,0.12)', color: '#b35c00' },
  stats: { display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 14 },
  stat: { flex: '1 1 150px', border: '1px solid var(--dsh-border-soft, #e6e8eb)', borderRadius: 9, padding: '10px 12px', background: 'var(--dsh-surface, #fff)' },
  statLabel: { fontSize: 11, opacity: 0.6, textTransform: 'uppercase', letterSpacing: 0.4 },
  statValue: { fontSize: 17, fontWeight: 620, marginTop: 3 },
  tabs: { display: 'flex', gap: 4, borderBottom: '1px solid var(--dsh-border-soft, #e6e8eb)', marginBottom: 14 },
  tab: { border: 'none', background: 'transparent', padding: '8px 12px', fontSize: 13, cursor: 'pointer', borderBottom: '2px solid transparent', color: 'inherit', opacity: 0.65 },
  tabActive: { opacity: 1, borderBottomColor: '#2f6feb', fontWeight: 600 },
  form: { border: '1px solid var(--dsh-border-soft, #e6e8eb)', borderRadius: 10, padding: 14, marginBottom: 14, background: 'var(--dsh-surface, #fff)' },
  formGrid: { display: 'grid', gridTemplateColumns: 'minmax(180px, 1fr) 150px minmax(160px, 1fr)', gap: 10, marginBottom: 10, alignItems: 'end' },
  field: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 },
  label: { fontSize: 11.5, opacity: 0.62 },
  input: { border: '1px solid var(--dsh-border, #d0d7de)', borderRadius: 7, padding: '7px 9px', fontSize: 13, background: 'var(--dsh-input, #fff)', color: 'inherit', minWidth: 0 },
  textarea: { border: '1px solid var(--dsh-border, #d0d7de)', borderRadius: 7, padding: '8px 9px', fontSize: 13, background: 'var(--dsh-input, #fff)', color: 'inherit', resize: 'vertical', minHeight: 64, width: '100%', boxSizing: 'border-box' },
  formFoot: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  table: { display: 'flex', flexDirection: 'column', border: '1px solid var(--dsh-border-soft, #e6e8eb)', borderRadius: 10, overflow: 'hidden', background: 'var(--dsh-surface, #fff)' },
  row: { display: 'grid', gridTemplateColumns: '92px minmax(180px, 1.5fr) 92px minmax(150px, 1.1fr) minmax(170px, 1fr) minmax(150px, 1.2fr) 190px', gap: 10, padding: '10px 12px', borderTop: '1px solid var(--dsh-border-soft, #eef0f2)', alignItems: 'center', fontSize: 12.5 },
  headRow: { borderTop: 'none', background: 'rgba(127,127,127,0.04)', fontSize: 11.5, textTransform: 'uppercase', letterSpacing: 0.3, opacity: 0.7, paddingTop: 8, paddingBottom: 8 },
  cell: { minWidth: 0 },
  cellTitle: { fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  cellMuted: { fontSize: 11.5, opacity: 0.62, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  cellResult: { display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', lineHeight: 1.35, opacity: 0.82 },
  actions: { display: 'flex', gap: 5, flexWrap: 'wrap', justifyContent: 'flex-end' },
  tinyButton: { border: '1px solid var(--dsh-border, #d0d7de)', background: 'transparent', color: 'inherit', borderRadius: 6, padding: '3px 7px', fontSize: 11.5, cursor: 'pointer' },
  chip: { display: 'inline-flex', alignItems: 'center', padding: '2px 8px', borderRadius: 999, fontSize: 11.5, background: 'rgba(127,127,127,0.12)', whiteSpace: 'nowrap' },
  chipRunning: { background: 'rgba(47,111,235,0.13)', color: '#2f6feb' },
  chipDone: { background: 'rgba(26,127,55,0.13)', color: '#1a7f37' },
  chipFailed: { background: 'rgba(180,35,24,0.12)', color: '#b42318' },
  chipQueued: { background: 'rgba(84,174,255,0.15)', color: '#0969da' },
  chipInterrupted: { background: 'rgba(127,127,127,0.16)', color: '#57606a' },
  empty: { padding: '36px 20px', textAlign: 'center', opacity: 0.62, fontSize: 13 },
  error: { border: '1px solid rgba(180,35,24,0.35)', background: 'rgba(180,35,24,0.06)', color: '#b42318', borderRadius: 9, padding: '9px 12px', marginBottom: 12, display: 'flex', gap: 10, alignItems: 'center', justifyContent: 'space-between', fontSize: 12.5 },
  editor: { padding: '10px 12px', borderTop: '1px solid var(--dsh-border-soft, #eef0f2)', background: 'rgba(127,127,127,0.03)' },
  editorGrid: { display: 'grid', gridTemplateColumns: 'minmax(200px, 1fr) 150px minmax(180px, 1fr)', gap: 10, marginBottom: 8 },
  reports: { display: 'grid', gridTemplateColumns: '220px minmax(0, 1fr)', gap: 14, alignItems: 'start' },
  reportList: { display: 'flex', flexDirection: 'column', gap: 4 },
  reportItem: { textAlign: 'left', border: '1px solid var(--dsh-border-soft, #e6e8eb)', background: 'transparent', borderRadius: 8, padding: '9px 10px', cursor: 'pointer', color: 'inherit' },
  reportItemActive: { borderColor: '#2f6feb', background: 'rgba(47,111,235,0.06)' },
  reportDate: { fontSize: 12.5, fontWeight: 600 },
  reportMeta: { fontSize: 11, opacity: 0.6, marginTop: 2 },
  reportPane: { border: '1px solid var(--dsh-border-soft, #e6e8eb)', borderRadius: 10, background: 'var(--dsh-surface, #fff)', padding: '16px 18px', minHeight: 200 },
  reportToolbar: { display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 },
  h1: { fontSize: 20, margin: '18px 0 8px', fontWeight: 650 },
  h2: { fontSize: 16, margin: '16px 0 6px', fontWeight: 640 },
  h3: { fontSize: 14, margin: '12px 0 5px', fontWeight: 620 },
  p: { margin: '6px 0', lineHeight: 1.6, fontSize: 13 },
  ul: { margin: '6px 0', paddingLeft: 20, fontSize: 13, lineHeight: 1.6 },
  code: { fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', background: 'rgba(127,127,127,0.13)', padding: '1px 4px', borderRadius: 4, fontSize: 12 },
  tableNode: { borderCollapse: 'collapse', margin: '10px 0', fontSize: 12.5, width: '100%' },
  th: { border: '1px solid var(--dsh-border-soft, #e6e8eb)', padding: '5px 8px', background: 'rgba(127,127,127,0.06)', textAlign: 'left' },
  td: { border: '1px solid var(--dsh-border-soft, #e6e8eb)', padding: '5px 8px' },
  footNote: { marginTop: 14, fontSize: 11.5, opacity: 0.55 },
}

const KIND_KEYS = ['dev', 'research', 'data', 'ops', 'writing', 'automation', 'other']

function tOf(props) {
  const translate = props?.t
  if (typeof translate === 'function') return translate
  return (key) => {
    const parts = String(key).split('.')
    let value = ZH
    for (const part of parts) {
      if (value === undefined || value === null) break
      value = value[part]
    }
    return typeof value === 'string' ? value : key
  }
}

function kindLabel(t, kind) {
  return t(`kinds.${kind}`) === `kinds.${kind}` ? kind : t(`kinds.${kind}`)
}

function statusLabel(t, status) {
  const key = `status.${status}`
  const value = t(key)
  return value === key ? status : value
}

function statusStyle(status) {
  if (status === 'running') return { ...S.chip, ...S.chipRunning }
  if (status === 'queued') return { ...S.chip, ...S.chipQueued }
  if (status === 'done') return { ...S.chip, ...S.chipDone }
  if (status === 'failed') return { ...S.chip, ...S.chipFailed }
  if (status === 'interrupted' || status === 'cancelled') return { ...S.chip, ...S.chipInterrupted }
  return S.chip
}

function formatTokens(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return '0'
  if (n < 1000) return String(Math.round(n))
  if (n < 1_000_000) return `${n / 1000 >= 100 ? Math.round(n / 1000) : Math.round((n / 1000) * 10) / 10}K`
  return `${n / 1_000_000 >= 100 ? Math.round(n / 1_000_000) : Math.round((n / 1_000_000) * 10) / 10}M`
}

function formatMoney(value, currency = '¥') {
  return `${currency}${(Number.isFinite(Number(value)) ? Number(value) : 0).toFixed(4)}`
}

function formatDuration(ms) {
  const value = Number.isFinite(Number(ms)) ? Math.max(0, Math.round(Number(ms))) : 0
  if (value < 1000) return `${value}ms`
  const seconds = Math.round(value / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

function formatClock(timestamp) {
  if (!Number.isFinite(Number(timestamp))) return '—'
  try {
    return new Date(Number(timestamp)).toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
  } catch {
    return new Date(Number(timestamp)).toISOString().slice(5, 16).replace('T', ' ')
  }
}

function formatCountdown(target, now, t) {
  if (!Number.isFinite(Number(target)) || !Number.isFinite(Number(now))) return '—'
  const diff = Number(target) - Number(now)
  if (Math.abs(diff) < 60_000) return diff >= 0 ? `${t('now')}` : `${Math.abs(Math.round(diff / 60_000))}m ${t('ago')}`
  const future = diff > 0
  const abs = Math.abs(diff)
  let text
  if (abs < 3_600_000) text = `${Math.round(abs / 60_000)}m`
  else if (abs < 86_400_000) text = `${Math.floor(abs / 3_600_000)}h ${Math.round((abs % 3_600_000) / 60_000)}m`
  else text = `${Math.floor(abs / 86_400_000)}d ${Math.round((abs % 86_400_000) / 3_600_000)}h`
  return future ? `${text} ${t('later')}` : `${text} ${t('ago')}`
}

function taskStatus(task) {
  if (task.status === 'queued' || task.status === 'running') return task.status
  return task.status
}

async function api(path, options = {}) {
  const headers = { accept: 'application/json' }
  if (options.body !== undefined) headers['content-type'] = 'application/json'
  const response = await fetch(`/api/task-plan/${path}`, {
    method: options.method ?? 'GET',
    credentials: 'same-origin',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
  const text = await response.text()
  let payload = {}
  if (text !== '') {
    try {
      payload = JSON.parse(text)
    } catch {
      payload = { message: text }
    }
  }
  if (!response.ok) {
    const error = new Error(payload?.message ?? `HTTP ${response.status}`)
    error.status = response.status
    error.code = payload?.code
    throw error
  }
  return payload
}

function Chip({ label, style }) {
  return react.createElement('span', { style }, label)
}

function Stat({ label, value }) {
  return react.createElement(
    'div',
    { style: S.stat },
    react.createElement('div', { style: S.statLabel }, label),
    react.createElement('div', { style: S.statValue }, value),
  )
}

function TaskTable({ snapshot, t, busy, editingId, onEdit, onSave, onDelete, onRun, onCancel, onOpen, openSession, currency }) {
  if (snapshot.tasks.length === 0) return react.createElement('div', { style: S.empty }, t('noTasks'))
  const rows = []
  for (const task of snapshot.tasks) {
    const isEditing = editingId === task.id
    const last = task.lastRun ?? null
    const running = task.status === 'running' || task.status === 'queued'
    rows.push(
      react.createElement(
        'div',
        { key: task.id, style: S.row },
        react.createElement('div', { style: S.cell }, react.createElement(Chip, { label: statusLabel(t, task.status), style: statusStyle(task.status) })),
        react.createElement(
          'div',
          { style: S.cell },
          react.createElement('div', { style: S.cellTitle, title: task.title }, task.title),
          react.createElement('div', { style: S.cellMuted, title: task.instruction }, task.instruction),
        ),
        react.createElement('div', { style: S.cell }, react.createElement(Chip, { label: kindLabel(t, task.kind), style: S.chip })),
        react.createElement(
          'div',
          { style: S.cell },
          last === null
            ? react.createElement('div', { style: S.cellMuted }, '—')
            : [
                react.createElement('div', { key: 'time', style: S.cellMuted }, formatClock(last.finishedAt ?? last.startedAt)),
                react.createElement('div', { key: 'dur', style: S.cellMuted }, formatDuration(last.durationMs)),
              ],
        ),
        react.createElement(
          'div',
          { style: S.cell },
          last === null
            ? react.createElement('div', { style: S.cellMuted }, '—')
            : [
                react.createElement('div', { key: 'tok', style: S.cellMuted }, `${formatTokens(last.usage?.totalTokens ?? 0)} ${t('tokens')}`),
                react.createElement('div', { key: 'cost', style: S.cellMuted }, `${formatMoney(last.cost?.cny ?? 0, currency)} · ${formatTokens(last.usage?.outputTokens ?? 0)} out`),
              ],
        ),
        react.createElement(
          'div',
          { style: { ...S.cell, ...S.cellResult }, title: last?.result ?? '' },
          last?.result ? String(last.result).replace(/\s+/g, ' ').slice(0, 220) : last?.error?.message ?? t('emptyResult'),
        ),
        react.createElement(
          'div',
          { style: S.actions },
          react.createElement('button', { type: 'button', style: S.tinyButton, disabled: busy, onClick: () => onEdit(isEditing ? null : task.id) }, isEditing ? t('cancel') : t('edit')),
          running
            ? react.createElement('button', { type: 'button', style: S.tinyButton, disabled: busy, onClick: () => onCancel(task) }, t('cancel'))
            : react.createElement('button', { type: 'button', style: S.tinyButton, disabled: busy, onClick: () => onRun(task) }, task.status === 'pending' ? t('runNow') : t('retry')),
          last?.sessionId !== undefined && last?.sessionId !== null
            ? react.createElement('button', { type: 'button', style: S.tinyButton, onClick: () => openSession(last.sessionId) }, t('openSession'))
            : null,
          react.createElement('button', { type: 'button', style: { ...S.tinyButton, color: '#b42318' }, disabled: busy || running, onClick: () => onDelete(task) }, t('delete')),
        ),
      ),
    )
    if (isEditing) {
      rows.push(
        react.createElement(
          'div',
          { key: `${task.id}-editor`, style: S.editor },
          react.createElement(TaskEditor, { task, t, busy, onCancel: () => onEdit(null), onSave }),
        ),
      )
    }
  }
  return react.createElement(
    'div',
    { style: S.table },
    react.createElement(
      'div',
      { style: { ...S.row, ...S.headRow } },
      [t('colStatus'), t('colTask'), t('colKind'), t('colLastRun'), t('colUsage'), t('colResult'), t('colActions')].map((label, index) =>
        react.createElement('div', { key: label, style: S.cell }, label),
      ),
    ),
    rows,
  )
}

function TaskEditor({ task, t, busy, onCancel, onSave }) {
  const [title, setTitle] = react.useState(task.title)
  const [instruction, setInstruction] = react.useState(task.instruction)
  const [kind, setKind] = react.useState(task.kind)
  const [cwd, setCwd] = react.useState(task.cwd ?? '')
  const [enabled, setEnabled] = react.useState(task.enabled !== false)
  return react.createElement(
    'div',
    { style: S.formGrid },
    react.createElement('label', { style: S.field }, react.createElement('span', { style: S.label }, t('addTitle')), react.createElement('input', { style: S.input, value: title, onChange: (event) => setTitle(event.target.value) })),
    react.createElement(
      'label',
      { style: S.field },
      react.createElement('span', { style: S.label }, t('addKind')),
      react.createElement('select', { style: S.input, value: kind, onChange: (event) => setKind(event.target.value) }, KIND_KEYS.map((key) => react.createElement('option', { key, value: key }, kindLabel(t, key)))),
    ),
    react.createElement('label', { style: S.field }, react.createElement('span', { style: S.label }, t('addCwd')), react.createElement('input', { style: S.input, value: cwd, onChange: (event) => setCwd(event.target.value) })),
    react.createElement(
      'div',
      { style: { gridColumn: '1 / -1', display: 'flex', flexDirection: 'column', gap: 4 } },
      react.createElement('span', { style: S.label }, t('addInstruction')),
      react.createElement('textarea', { style: S.textarea, value: instruction, onChange: (event) => setInstruction(event.target.value) }),
    ),
    react.createElement(
      'div',
      { style: { gridColumn: '1 / -1', display: 'flex', alignItems: 'center', gap: 10 } },
      react.createElement('label', { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5 } }, react.createElement('input', { type: 'checkbox', checked: enabled, onChange: (event) => setEnabled(event.target.checked) }), t('addEnabled')),
      react.createElement('button', { type: 'button', style: S.buttonPrimary, disabled: busy, onClick: () => onSave({ title, instruction, kind, cwd: cwd.trim() === '' ? null : cwd.trim(), enabled }) }, t('save')),
      react.createElement('button', { type: 'button', style: S.button, disabled: busy, onClick: onCancel }, t('cancel')),
    ),
  )
}

function AddForm({ t, busy, defaults, onCreate }) {
  const [title, setTitle] = react.useState('')
  const [instruction, setInstruction] = react.useState('')
  const [kind, setKind] = react.useState('dev')
  const [cwd, setCwd] = react.useState('')
  const [enabled, setEnabled] = react.useState(true)
  const submit = async (event) => {
    event.preventDefault()
    if (title.trim() === '' || instruction.trim() === '') return
    const ok = await onCreate({
      title: title.trim(),
      instruction: instruction.trim(),
      kind,
      cwd: cwd.trim() === '' ? undefined : cwd.trim(),
      enabled,
    })
    if (ok) {
      setTitle('')
      setInstruction('')
      setCwd('')
    }
  }
  return react.createElement(
    'form',
    { style: S.form, onSubmit: submit },
    react.createElement(
      'div',
      { style: S.formGrid },
      react.createElement('label', { style: S.field }, react.createElement('span', { style: S.label }, t('addTitle')), react.createElement('input', { style: S.input, value: title, placeholder: defaults, onChange: (event) => setTitle(event.target.value) })),
      react.createElement(
        'label',
        { style: S.field },
        react.createElement('span', { style: S.label }, t('addKind')),
        react.createElement('select', { style: S.input, value: kind, onChange: (event) => setKind(event.target.value) }, KIND_KEYS.map((key) => react.createElement('option', { key, value: key }, kindLabel(t, key)))),
      ),
      react.createElement('label', { style: S.field }, react.createElement('span', { style: S.label }, t('addCwd')), react.createElement('input', { style: S.input, value: cwd, onChange: (event) => setCwd(event.target.value) })),
    ),
    react.createElement('textarea', { style: S.textarea, value: instruction, placeholder: t('addInstruction'), onChange: (event) => setInstruction(event.target.value) }),
    react.createElement(
      'div',
      { style: { ...S.formFoot, marginTop: 10 } },
      react.createElement('label', { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5 } }, react.createElement('input', { type: 'checkbox', checked: enabled, onChange: (event) => setEnabled(event.target.checked) }), t('addEnabled')),
      react.createElement('button', { type: 'submit', style: S.buttonPrimary, disabled: busy }, t('submit')),
    ),
  )
}


function TaskPlanPage(props) {
  const t = tOf(props)
  const [snapshot, setSnapshot] = react.useState(null)
  const [error, setError] = react.useState(null)
  const [busy, setBusy] = react.useState(false)
  const [editingId, setEditingId] = react.useState(null)
  const alive = react.useRef(true)

  const load = async () => {
    try {
      const data = await api('state')
      if (alive.current) {
        setSnapshot(data)
        setError(null)
      }
    } catch (loadError) {
      if (alive.current) setError(String(loadError?.message ?? loadError))
    }
  }

  react.useEffect(() => {
    alive.current = true
    void load()
    const handle = setInterval(() => {
      if (document.visibilityState === 'visible') void load()
    }, 3000)
    return () => {
      alive.current = false
      clearInterval(handle)
    }
  }, [])

  const act = async (operation) => {
    setBusy(true)
    try {
      await operation()
      await load()
      return true
    } catch (actionError) {
      setError(String(actionError?.message ?? actionError))
      return false
    } finally {
      setBusy(false)
    }
  }

  const create = (input) => act(() => api('tasks', { method: 'POST', body: input }))
  const patch = (input) => act(() => api('tasks', { method: 'PATCH', body: input }))
  const remove = (task) => {
    if (typeof globalThis.confirm === 'function' && !globalThis.confirm(t('confirmDelete'))) return Promise.resolve(false)
    return act(() => api(`tasks?id=${encodeURIComponent(task.id)}`, { method: 'DELETE' }))
  }
  const run = (task) => act(() => api('run', { method: 'POST', body: { ids: [task.id] } }))
  const cancel = (task) => act(() => api('cancel', { method: 'POST', body: { taskId: task.id } }))
  const runAll = () => act(() => api('run', { method: 'POST', body: {} }))

  const currency = snapshot?.config?.currency ?? '¥'
  const tasks = snapshot?.tasks ?? []
  const pending = tasks.filter((task) => task.enabled && task.status === 'pending').length
  const running = tasks.filter((task) => task.status === 'running' || task.status === 'queued').length
  const done = tasks.filter((task) => task.status === 'done').length
  const failed = tasks.filter((task) => task.status === 'failed' || task.status === 'interrupted').length
  const nextRun = snapshot?.nextRunAt ?? 0

  return react.createElement(
    'div',
    { style: S.page, 'data-task-plan': 'page' },
    react.createElement(
      'div',
      { style: S.header },
      react.createElement(
        'div',
        { style: S.headMain },
        react.createElement('h1', { style: S.title }, t('title')),
        react.createElement('p', { style: S.subtitle }, t('subtitle')),
      ),
      react.createElement(
        'div',
        { style: S.headActions },
        snapshot === null
          ? null
          : [
              react.createElement(Chip, { key: 'tier', label: snapshot.offPeak ? t('offPeak') : t('peak'), style: { ...S.badge, ...(snapshot.offPeak ? {} : S.badgePeak) } }),
              snapshot.config?.enabled === false
                ? react.createElement(Chip, { key: 'disabled', label: t('disabled'), style: { ...S.chip, ...S.chipFailed } })
                : null,
              react.createElement('span', { key: 'run', style: S.cellMuted }, `${t('nextRun')} ${formatClock(nextRun)} · ${formatCountdown(nextRun, snapshot.now, t)}`),
            ],
        react.createElement('button', { type: 'button', style: S.button, disabled: busy, onClick: () => void load() }, t('refresh')),
        react.createElement('button', { type: 'button', style: S.buttonPrimary, disabled: busy || pending === 0, onClick: () => void runAll() }, `${t('runAll')}${pending > 0 ? ` (${pending})` : ''}`),
      ),
    ),
    error !== null
      ? react.createElement(
          'div',
          { style: S.error },
          react.createElement('span', null, `${t('error')}: ${error}`),
          react.createElement('button', { type: 'button', style: S.tinyButton, onClick: () => setError(null) }, t('dismiss')),
        )
      : null,
    snapshot === null
      ? react.createElement('div', { style: S.empty }, t('loading'))
      : react.createElement(
          'div',
          null,
          react.createElement(
            'div',
            { style: S.stats },
            react.createElement(Stat, { label: t('status.pending'), value: String(pending) }),
            react.createElement(Stat, { label: t('status.running'), value: String(running) }),
            react.createElement(Stat, { label: t('status.done'), value: String(done) }),
            react.createElement(Stat, { label: t('status.failed'), value: String(failed) }),
            react.createElement(Stat, { label: t('nextRun'), value: formatCountdown(nextRun, snapshot.now, t) }),
            snapshot.run !== null && snapshot.run !== undefined
              ? react.createElement(Stat, { label: t('runningNow'), value: `${snapshot.run.done}/${snapshot.run.total}` })
              : null,
          ),
          react.createElement(AddForm, {
            t,
            busy,
            defaults: t('addTitle'),
            onCreate: create,
          }),
          react.createElement(TaskTable, {
            snapshot,
            t,
            busy,
            editingId,
            currency,
            onEdit: setEditingId,
            onSave: async (input) => {
              const ok = await patch({ id: editingId, ...input })
              if (ok) setEditingId(null)
              return ok
            },
            onDelete: remove,
            onRun: run,
            onCancel: cancel,
            openSession: props.openSession,
          }),
          react.createElement(
            'div',
            { style: S.footNote },
            `${t('quota')}: ${snapshot.config?.maxTasksPerRun ?? 20} · ${snapshot.offPeak ? t('offPeakHint') : t('peakHint')}`,
          ),
        ),
  )
}

function TaskPlanIcon({ size = 20, active = false }) {
  return react.createElement(
    'svg',
    {
      width: size,
      height: size,
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: active ? 2.1 : 1.8,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': 'true',
    },
    react.createElement('rect', { x: 4, y: 3.5, width: 16, height: 17, rx: 2.5 }),
    react.createElement('path', { d: 'M8 8.5h8' }),
    react.createElement('path', { d: 'M8 12h5' }),
    react.createElement('path', { d: 'M8 15.5h3' }),
    react.createElement('path', { d: 'M16.5 13.5l1.6 1.6 2.4-2.6' }),
  )
}

/**
 * Client plugin body.
 * @param {object} ctx Client root context.
 */
function apply(ctx) {
  const t = ctx.locale && typeof ctx.locale.bind === 'function' ? ctx.locale.bind(NS) : (key) => key
  try {
    ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), 'task-plan: dictionaries')
  } catch {
    // Labels fall back to the built-in Chinese dictionary.
  }
  const openSession = (id) => ctx.uiWorkspace.openSession(id)
  ctx.effect(
    () =>
      ctx.slots.inject('main', () =>
        ctx.slots.register(
          {
            name: 'main',
            key: 'task-plan',
            locale: NS,
            inject: () => ({ openSession }),
          },
          TaskPlanPage,
        ),
      ),
    'task-plan: page',
  )
  ctx.effect(
    () =>
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          {
            name: 'sidebar.panellist',
            id: 'task-plan',
            order: 10,
            label: () => t('panel'),
          },
          TaskPlanIcon,
        ),
      ),
    'task-plan: sidebar entry',
  )
}

exports.apply = apply
exports.inject = inject
exports.__test = {
  ZH,
  EN,
  formatTokens,
  formatMoney,
  formatDuration,
  formatCountdown,
  TaskPlanPage,
  TaskPlanIcon,
}
