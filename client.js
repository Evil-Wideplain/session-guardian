/**
 * session-guardian 的浏览器半边：在插件页上给 trim / compaction 两行各提供一个
 * 配置表单。
 *
 * 表单字段来自 Loader 的 Config schema 中声明为 `.volatile()` 的字段；写入走
 * Settings 的配置表单（`ctx.configForms`），保存后 Host 原地更新配置引用，
 * 不需要重启插件行。这里不 import 任何 DSH 客户端包，React 由模块加载器提供。
 */

window.__ModuleLoader__.load({
  id: 'session-guardian',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** 客户端 locale 命名空间。 */
    const NS = 'session-guardian'

    /** 中文文案；键是扁平的点分键，与 DSH locale 的查找方式一致。 */
    const zh = {
      'common.save': '保存',
      'common.discard': '放弃修改',
      'common.saving': '保存中…',
      'common.loading': '正在读取配置…',
      'common.unavailable': '这一行没有可编辑的配置（未启用，或当前部署没有暴露配置表单）。',
      'common.readOnly': '当前配置只读。',
      'common.saveFailed': '保存失败，请检查值后重试。',
      'common.invalid': '请输入合法的值。',
      'compaction.title': '检索式压缩',
      'compaction.summary': '配置检索式压缩：保留轮数、压力阈值与检查点正文。',
      'compaction.retainRounds': '保留轮数',
      'compaction.retainRoundsHint': '压力触发时保留最近几轮；自动裁剪的区间由 trim 行决定。',
      'compaction.minShadowTokens': '最小遮蔽量（token）',
      'compaction.minShadowTokensHint': '少于这个量不值得压缩。',
      'compaction.pressureTokens': '压力阈值（token）',
      'compaction.pressureTokensHint': '0 表示关闭压力自动压缩，只保留 /compact 与溢出恢复。',
      'compaction.keepToolRecords': '保留工具调用记录',
      'compaction.keepToolRecordsHint': '关闭后，保留窗口里的工具交换整段移出模型可见历史。',
      'compaction.checkpointTemplate': '检查点正文模板',
      'compaction.checkpointTemplateHint': '留空使用默认正文。占位符：{sessionId}、{start}、{end}、{shadowedTokens}、{retrievalGuide}。',
      'trim.title': '上下文裁剪',
      'trim.summary': '配置回到旧会话时的自动上下文裁剪。',
      'trim.idleMs': '空闲阈值（分钟）',
      'trim.idleMsHint': '按分钟输入；默认 30 分钟。',
      'trim.retainRounds': '保留轮数',
      'trim.retainRoundsHint': '保留最近几轮；0 表示一轮都不保留。',
      'trim.minShadowTokens': '最小遮蔽量（token）',
      'trim.minShadowTokensHint': '少于这个量不值得裁。',
      'trim.requireRetrieval': '检索工具不在场时跳过裁剪',
      'trim.requireRetrievalHint': '默认开启：没有检索就裁等于失忆。',
    }

    /** 英文文案；与中文使用同一组扁平键。 */
    const en = {
      'common.save': 'Save',
      'common.discard': 'Discard',
      'common.saving': 'Saving…',
      'common.loading': 'Loading configuration…',
      'common.unavailable': 'This row has no editable configuration (disabled, or this deployment serves no config form).',
      'common.readOnly': 'Configuration is read-only.',
      'common.saveFailed': 'Save failed. Check the values and retry.',
      'common.invalid': 'Enter a valid value.',
      'compaction.title': 'Retrieval compaction',
      'compaction.summary': 'Configure retrieval compaction: retained rounds, pressure, and checkpoint text.',
      'compaction.retainRounds': 'Retained rounds',
      'compaction.retainRoundsHint': 'Used by pressure-triggered compaction; automatic trim decides its own range.',
      'compaction.minShadowTokens': 'Minimum shadowed tokens',
      'compaction.minShadowTokensHint': 'Compacting less than this is not worth it.',
      'compaction.pressureTokens': 'Pressure threshold (tokens)',
      'compaction.pressureTokensHint': '0 disables pressure-triggered compaction; /compact and overflow recovery still work.',
      'compaction.keepToolRecords': 'Keep tool exchanges',
      'compaction.keepToolRecordsHint': 'When off, tool exchanges in the retained window are moved out of the model-visible history.',
      'compaction.checkpointTemplate': 'Checkpoint template',
      'compaction.checkpointTemplateHint': 'Leave empty for the default text. Placeholders: {sessionId}, {start}, {end}, {shadowedTokens}, {retrievalGuide}.',
      'trim.title': 'Context trim',
      'trim.summary': 'Configure automatic context trimming when you return to an old session.',
      'trim.idleMs': 'Idle threshold (minutes)',
      'trim.idleMsHint': 'Enter minutes; the default is 30.',
      'trim.retainRounds': 'Retained rounds',
      'trim.retainRoundsHint': 'Keep the most recent rounds; 0 keeps none.',
      'trim.minShadowTokens': 'Minimum shadowed tokens',
      'trim.minShadowTokensHint': 'Trimming less than this is not worth it.',
      'trim.requireRetrieval': 'Skip when retrieval is unavailable',
      'trim.requireRetrievalHint': 'On by default: trimming without retrieval hides history.',
    }

    /** 共享的内联样式；只依赖继承色，避免绑定具体主题变量。 */
    const styles = {
      root: { display: 'grid', gap: '16px', padding: '4px 0 8px' },
      intro: { display: 'grid', gap: '4px' },
      title: { margin: 0, fontSize: '13px', fontWeight: 600 },
      description: { margin: 0, fontSize: '12px', opacity: 0.7, lineHeight: 1.5 },
      field: { display: 'grid', gap: '6px' },
      label: { fontSize: '12px', fontWeight: 600 },
      hint: { margin: 0, fontSize: '12px', opacity: 0.65, lineHeight: 1.5 },
      invalid: { margin: 0, fontSize: '12px', color: '#d9534f', lineHeight: 1.5 },
      input: {
        width: '100%',
        boxSizing: 'border-box',
        padding: '6px 8px',
        border: '1px solid rgba(127,127,127,0.35)',
        borderRadius: '6px',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        fontSize: '13px',
      },
      textarea: {
        minHeight: '160px',
        resize: 'vertical',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: '12px',
        lineHeight: 1.5,
        whiteSpace: 'pre-wrap',
      },
      checkRow: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px' },
      actions: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' },
      button: {
        padding: '6px 12px',
        border: '1px solid rgba(127,127,127,0.35)',
        borderRadius: '6px',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        fontSize: '12px',
        cursor: 'pointer',
      },
      primary: { background: 'rgba(64,128,255,0.14)', borderColor: 'rgba(64,128,255,0.45)' },
      notice: { margin: 0, fontSize: '12px', opacity: 0.75 },
      alert: { margin: 0, fontSize: '12px', color: '#d9534f' },
    }

    /**
     * 订阅配置表单的快照。
     * @param form - 配置表单；不可用时为 undefined。
     * @returns 当前快照。
     */
    function useFormSnapshot(form) {
      const [snapshot, setSnapshot] = React.useState(() => form === undefined
        ? { status: 'unavailable', value: undefined, writable: false, revision: undefined }
        : form.getSnapshot())
      React.useEffect(() => {
        if (form === undefined) {
          setSnapshot({ status: 'unavailable', value: undefined, writable: false, revision: undefined })
          return undefined
        }
        setSnapshot(form.getSnapshot())
        return form.subscribe(() => { setSnapshot(form.getSnapshot()) })
      }, [form])
      return snapshot
    }

    /**
     * 把配置值变成表单草稿。
     * @param value - 配置值。
     * @param fields - 字段定义。
     * @returns 草稿。
     */
    function draftFrom(value, fields) {
      const draft = {}
      for (const field of fields) {
        const current = value === undefined ? undefined : value[field.name]
        if (field.kind === 'boolean') draft[field.name] = current === true
        else if (field.kind === 'minutes') {
          draft[field.name] = current === undefined || current === null ? '' : String(Number((current / 60_000).toFixed(6)))
        } else draft[field.name] = current === undefined || current === null ? '' : String(current)
      }
      return draft
    }

    /**
     * 把草稿解析成可写入的配置值。
     * @param field - 字段定义。
     * @param raw - 草稿。
     * @returns 解析结果；`value` 为 undefined 表示清除。
     */
    function parseField(field, raw) {
      if (field.kind === 'boolean') return { ok: true, value: raw === true }
      const text = typeof raw === 'string' ? raw : ''
      if (text.trim() === '') return { ok: true, value: undefined }
      if (field.kind === 'number') {
        const number = Number(text)
        if (!Number.isFinite(number) || !Number.isInteger(number) || number < field.min) return { ok: false }
        return { ok: true, value: number }
      }
      if (field.kind === 'minutes') {
        const minutes = Number(text)
        const milliseconds = Math.round(minutes * 60_000)
        if (!Number.isFinite(minutes) || minutes <= 0 || milliseconds < field.min) return { ok: false }
        return { ok: true, value: milliseconds }
      }
      return { ok: true, value: text }
    }

    /**
     * 渲染一个字段。
     * @param props - 字段定义、草稿、编辑回调与文案。
     * @returns 字段节点。
     */
    function Field(props) {
      const { field, value, disabled, invalid, onChange, t } = props
      const id = React.useId()
      const control = field.kind === 'boolean'
        ? h('label', { style: styles.checkRow, htmlFor: id },
          h('input', {
            id,
            type: 'checkbox',
            checked: value === true,
            disabled,
            onChange: event => { onChange(event.target.checked) },
          }),
          t(field.label))
        : field.multiline === true
          ? h('textarea', {
            id,
            rows: 10,
            spellCheck: false,
            value,
            disabled,
            style: { ...styles.input, ...styles.textarea },
            onChange: event => { onChange(event.target.value) },
          })
          : h('input', {
            id,
            type: 'text',
            ...field.kind === 'number' || field.kind === 'minutes' ? { inputMode: 'decimal' } : {},
            value,
            disabled,
            style: styles.input,
            onChange: event => { onChange(event.target.value) },
          })
      return h('div', { style: styles.field },
        field.kind === 'boolean' ? null : h('label', { style: styles.label, htmlFor: id }, t(field.label)),
        control,
        h('p', { style: invalid ? styles.invalid : styles.hint }, invalid ? t('common.invalid') : t(field.hint)))
    }

    /**
     * 造一个行配置卡片。
     * @param spec - 标题、摘要与字段。
     * @returns React 组件。
     */
    function createCard(spec) {
      return function ConfigCard(props) {
        const { t, configForm: form, view } = props
        const snapshot = useFormSnapshot(form)
        const [draft, setDraft] = React.useState(() => draftFrom(snapshot.value, spec.fields))
        const [saving, setSaving] = React.useState(false)
        const [failed, setFailed] = React.useState(false)
        const [invalidField, setInvalidField] = React.useState(undefined)

        React.useEffect(() => {
          setDraft(draftFrom(snapshot.value, spec.fields))
        }, [snapshot.revision, snapshot.status])

        if (view === 'summary') return t(spec.summary)
        if (snapshot.status === 'loading') return h('p', { style: styles.notice }, t('common.loading'))
        if (snapshot.status === 'unavailable' || form === undefined) {
          return h('p', { style: styles.notice }, t('common.unavailable'))
        }

        const disabled = snapshot.writable !== true || saving
        const parsed = spec.fields.map(field => ({ field, result: parseField(field, draft[field.name]) }))
        const dirty = parsed.some(({ field, result }) => !result.ok
          || !Object.is(result.value, snapshot.value === undefined ? undefined : snapshot.value[field.name]))
        const blocked = !snapshot.writable || saving || !dirty

        const save = async () => {
          if (!snapshot.writable || saving) return
          for (const { field, result } of parsed) {
            if (!result.ok) {
              setInvalidField(field.name)
              return
            }
          }
          setInvalidField(undefined)
          const ops = []
          for (const { field, result } of parsed) {
            const current = snapshot.value === undefined ? undefined : snapshot.value[field.name]
            if (Object.is(result.value, current)) continue
            ops.push(result.value === undefined
              ? { op: 'unset', path: [field.name] }
              : { op: 'set', path: [field.name], value: result.value })
          }
          if (ops.length === 0) return
          setSaving(true)
          setFailed(false)
          try {
            const accepted = await form.mutate(ops)
            if (!accepted) setFailed(true)
          } catch {
            setFailed(true)
          } finally {
            setSaving(false)
          }
        }

        return h('div', { style: styles.root },
          h('div', { style: styles.intro },
            h('h3', { style: styles.title }, t(spec.title)),
            h('p', { style: styles.description }, t(spec.description))),
          snapshot.writable !== true ? h('p', { style: styles.notice }, t('common.readOnly')) : null,
          ...spec.fields.map(field => h(Field, {
            key: field.name,
            field,
            value: draft[field.name],
            disabled,
            invalid: invalidField === field.name,
            t,
            onChange: (next) => {
              setDraft(previous => ({ ...previous, [field.name]: next }))
              setInvalidField(undefined)
              setFailed(false)
            },
          })),
          failed ? h('p', { role: 'alert', style: styles.alert }, t('common.saveFailed')) : null,
          h('div', { style: styles.actions },
            h('button', {
              type: 'button',
              style: styles.button,
              disabled: blocked,
              onClick: () => { setDraft(draftFrom(snapshot.value, spec.fields)); setInvalidField(undefined); setFailed(false) },
            }, t('common.discard')),
            h('button', {
              type: 'button',
              style: { ...styles.button, ...styles.primary },
              disabled: blocked,
              onClick: () => { void save() },
            }, saving ? t('common.saving') : t('common.save'))))
      }
    }

    /** 压缩后端的字段；与 Host 侧的 `.volatile()` 字段一一对应。 */
    const compactionFields = [
      { name: 'retainRounds', kind: 'number', min: 0, label: 'compaction.retainRounds', hint: 'compaction.retainRoundsHint' },
      { name: 'minShadowTokens', kind: 'number', min: 0, label: 'compaction.minShadowTokens', hint: 'compaction.minShadowTokensHint' },
      { name: 'pressureTokens', kind: 'number', min: 0, label: 'compaction.pressureTokens', hint: 'compaction.pressureTokensHint' },
      { name: 'keepToolRecords', kind: 'boolean', label: 'compaction.keepToolRecords', hint: 'compaction.keepToolRecordsHint' },
      { name: 'checkpointTemplate', kind: 'text', multiline: true, label: 'compaction.checkpointTemplate', hint: 'compaction.checkpointTemplateHint' },
    ]

    /** 裁剪行的字段。 */
    const trimFields = [
      { name: 'idleMs', kind: 'minutes', min: 1_000, label: 'trim.idleMs', hint: 'trim.idleMsHint' },
      { name: 'retainRounds', kind: 'number', min: 0, label: 'trim.retainRounds', hint: 'trim.retainRoundsHint' },
      { name: 'minShadowTokens', kind: 'number', min: 1, label: 'trim.minShadowTokens', hint: 'trim.minShadowTokensHint' },
      { name: 'requireRetrieval', kind: 'boolean', label: 'trim.requireRetrieval', hint: 'trim.requireRetrievalHint' },
    ]

    const CompactionCard = createCard({
      title: 'compaction.title',
      description: 'compaction.summary',
      summary: 'compaction.summary',
      fields: compactionFields,
    })

    const TrimCard = createCard({
      title: 'trim.title',
      description: 'trim.summary',
      summary: 'trim.summary',
      fields: trimFields,
    })

    return {
      inject: ['slots', 'locale', 'configForms'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'session-guardian: dictionaries')
        const registerCard = (key, formId, Card) => {
          const form = ctx.configForms.get(formId)
          const register = () => ctx.slots.register({
            name: 'plugins.row.config',
            key,
            locale: NS,
            inject: () => ({ configForm: form }),
          }, Card)
          ctx.slots.inject('plugins.row.config', () => typeof ctx.configForms.whileServed === 'function'
            ? ctx.configForms.whileServed([formId], register)
            : register())
        }
        registerCard('session-guardian#session-guardian-compaction', 'session-guardian-compaction', CompactionCard)
        registerCard('session-guardian#session-guardian-trim', 'session-guardian-trim', TrimCard)
      },
    }
  },
})
