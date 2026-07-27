import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'

function blankStep(order = 1) {
  return { order, messages: [''], delay: { min: 2, max: 5 } }
}

function blankScript() {
  const id = `s_${Date.now().toString(16)}`
  return {
    id,
    name: '新话术',
    variables: ['name'],
    steps: [blankStep(1)]
  }
}

function downloadJson(filename, obj) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

/**
 * Sub 话术管理：勾选参与随机的话术、编辑句本、导入导出
 */
export default function SubGuestScriptsDialog({ open, onOpenChange, pushLog }) {
  const [busy, setBusy] = useState(false)
  const [pack, setPack] = useState({ version: 1, selectedIds: [], scripts: [] })
  const [activeId, setActiveId] = useState('')

  const scripts = pack.scripts || []
  const selectedIds = useMemo(() => new Set(pack.selectedIds || []), [pack.selectedIds])
  const active = useMemo(
    () => scripts.find((s) => s.id === activeId) || null,
    [scripts, activeId]
  )

  const load = async () => {
    setBusy(true)
    try {
      const data = await window.api?.subGuest?.listScripts?.()
      const next = data || { version: 1, selectedIds: [], scripts: [] }
      setPack(next)
      const ids = next.selectedIds || []
      const first = ids[0] || next.scripts?.[0]?.id || ''
      setActiveId(first)
    } catch (e) {
      pushLog?.('系统', '话术加载', e?.message || String(e))
      window.alert(e?.message || '加载话术失败')
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    if (open) load().catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const persist = async (nextPack) => {
    setBusy(true)
    try {
      const saved = await window.api?.subGuest?.saveScripts?.(nextPack)
      setPack(saved || nextPack)
      pushLog?.('系统', '话术保存', `ok(scripts=${(saved?.scripts || []).length}, selected=${(saved?.selectedIds || []).length})`)
      return saved || nextPack
    } catch (e) {
      pushLog?.('系统', '话术保存', e?.message || String(e))
      window.alert(e?.message || '保存失败')
      throw e
    } finally {
      setBusy(false)
    }
  }

  const toggleSelect = async (id) => {
    const set = new Set(pack.selectedIds || [])
    if (set.has(id)) set.delete(id)
    else set.add(id)
    const next = { ...pack, selectedIds: Array.from(set) }
    setPack(next)
    await persist(next)
  }

  const updateActive = (patch) => {
    if (!active) return
    const nextScripts = scripts.map((s) => (s.id === active.id ? { ...s, ...patch } : s))
    setPack((prev) => ({ ...prev, scripts: nextScripts }))
  }

  const updateStep = (stepIndex, patch) => {
    if (!active) return
    const steps = (active.steps || []).map((st, i) => (i === stepIndex ? { ...st, ...patch } : st))
    updateActive({ steps })
  }

  const updateMessage = (stepIndex, msgIndex, value) => {
    if (!active) return
    const steps = (active.steps || []).map((st, i) => {
      if (i !== stepIndex) return st
      const messages = [...(st.messages || [])]
      messages[msgIndex] = value
      return { ...st, messages }
    })
    updateActive({ steps })
  }

  const addMessage = (stepIndex) => {
    if (!active) return
    const steps = (active.steps || []).map((st, i) => {
      if (i !== stepIndex) return st
      return { ...st, messages: [...(st.messages || []), ''] }
    })
    updateActive({ steps })
  }

  const removeMessage = (stepIndex, msgIndex) => {
    if (!active) return
    const steps = (active.steps || []).map((st, i) => {
      if (i !== stepIndex) return st
      const messages = (st.messages || []).filter((_, j) => j !== msgIndex)
      return { ...st, messages: messages.length ? messages : [''] }
    })
    updateActive({ steps })
  }

  const addStep = () => {
    if (!active) return
    const steps = active.steps || []
    if (steps.length >= 10) {
      window.alert('每个话术最多 10 个句本')
      return
    }
    updateActive({ steps: [...steps, blankStep(steps.length + 1)] })
  }

  const removeStep = (stepIndex) => {
    if (!active) return
    const steps = (active.steps || [])
      .filter((_, i) => i !== stepIndex)
      .map((st, i) => ({ ...st, order: i + 1 }))
    updateActive({ steps: steps.length ? steps : [blankStep(1)] })
  }

  const addScript = async () => {
    if (scripts.length >= 100) {
      window.alert('最多 100 个话术')
      return
    }
    const s = blankScript()
    const next = {
      ...pack,
      scripts: [...scripts, s],
      selectedIds: [...(pack.selectedIds || []), s.id]
    }
    setActiveId(s.id)
    await persist(next)
  }

  const removeScript = async (id) => {
    if (!window.confirm('确认删除该话术？')) return
    const nextScripts = scripts.filter((s) => s.id !== id)
    const next = {
      ...pack,
      scripts: nextScripts,
      selectedIds: (pack.selectedIds || []).filter((x) => x !== id)
    }
    setActiveId(nextScripts[0]?.id || '')
    await persist(next)
  }

  const saveActive = async () => {
    // 规范化 order
    const nextScripts = scripts.map((s) => {
      if (s.id !== active?.id) return s
      const steps = (s.steps || []).map((st, i) => ({
        ...st,
        order: i + 1,
        messages: (st.messages || []).map((m) => String(m ?? '')).filter((m, idx, arr) => m || arr.length === 1),
        delay: {
          min: Number(st.delay?.min) || 1,
          max: Math.max(Number(st.delay?.max) || 1, Number(st.delay?.min) || 1)
        }
      }))
      return { ...s, steps }
    })
    await persist({ ...pack, scripts: nextScripts })
  }

  const exportJson = () => {
    downloadJson(`sub-guest-scripts-${Date.now()}.json`, {
      version: pack.version || 1,
      selectedIds: pack.selectedIds || [],
      scripts: pack.scripts || []
    })
    pushLog?.('系统', '话术导出', `ok(${(pack.scripts || []).length})`)
  }

  const importJson = () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'application/json,.json'
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) return
      try {
        const text = await file.text()
        const data = JSON.parse(text)
        if (!Array.isArray(data.scripts)) throw new Error('JSON 需包含 scripts 数组')
        const next = {
          version: data.version || 1,
          selectedIds: Array.isArray(data.selectedIds) ? data.selectedIds : [],
          scripts: data.scripts
        }
        const saved = await persist(next)
        setActiveId(saved.selectedIds?.[0] || saved.scripts?.[0]?.id || '')
        pushLog?.('系统', '话术导入', `ok(${saved.scripts.length})`)
      } catch (e) {
        window.alert(e?.message || '导入失败')
      }
    }
    input.click()
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl">
        <DialogHeader>
          <DialogTitle>Sub 话术管理</DialogTitle>
          <DialogDescription>
            勾选参与随机的话术（会记住上次选择）。新用户将从勾选集合中随机分配一条话术。
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={busy} onClick={load}>
            刷新
          </Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={addScript}>
            添加话术
          </Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={importJson}>
            导入
          </Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={exportJson}>
            导出
          </Button>
          <div className="text-xs text-muted-foreground self-center">
            已选 {selectedIds.size} / {scripts.length}
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-12 gap-3 min-h-[360px]">
          <div className="md:col-span-4 rounded border p-2 space-y-2 overflow-auto max-h-[55vh]">
            {scripts.map((s) => (
              <div
                key={s.id}
                className={
                  'rounded border p-2 space-y-2 ' +
                  (s.id === activeId ? 'border-primary' : 'border-border')
                }
              >
                <label className="flex items-start gap-2 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={selectedIds.has(s.id)}
                    onChange={() => toggleSelect(s.id)}
                  />
                  <button
                    type="button"
                    className="text-left flex-1"
                    onClick={() => setActiveId(s.id)}
                  >
                    <div className="font-medium">{s.name || s.id}</div>
                    <div className="text-xs text-muted-foreground">
                      id: {s.id} · 句本 {(s.steps || []).length}
                    </div>
                  </button>
                </label>
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={busy || scripts.length <= 1}
                  onClick={() => removeScript(s.id)}
                >
                  删除
                </Button>
              </div>
            ))}
            {!scripts.length && (
              <div className="text-sm text-muted-foreground p-2">暂无话术，请添加或导入</div>
            )}
          </div>

          <div className="md:col-span-8 rounded border p-3 space-y-3 overflow-auto max-h-[55vh]">
            {!active && <div className="text-sm text-muted-foreground">请选择左侧话术进行编辑</div>}
            {active && (
              <>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <Label className="text-xs">名称</Label>
                    <Input
                      className="mt-1"
                      value={active.name || ''}
                      onChange={(e) => updateActive({ name: e.target.value })}
                    />
                  </div>
                  <div>
                    <Label className="text-xs">ID（勿随意改）</Label>
                    <Input className="mt-1" value={active.id} disabled />
                  </div>
                </div>

                {(active.steps || []).map((st, si) => (
                  <div key={si} className="rounded border p-2 space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="text-sm font-medium">句本 {si + 1}</div>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => removeStep(si)}
                      >
                        删除句本
                      </Button>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <Label className="text-xs">间隔 min(秒)</Label>
                        <Input
                          className="mt-1"
                          value={st.delay?.min ?? 2}
                          onChange={(e) =>
                            updateStep(si, {
                              delay: { ...st.delay, min: Number(e.target.value) || 0 }
                            })
                          }
                        />
                      </div>
                      <div>
                        <Label className="text-xs">间隔 max(秒)</Label>
                        <Input
                          className="mt-1"
                          value={st.delay?.max ?? 5}
                          onChange={(e) =>
                            updateStep(si, {
                              delay: { ...st.delay, max: Number(e.target.value) || 0 }
                            })
                          }
                        />
                      </div>
                    </div>
                    {(st.messages || []).map((m, mi) => (
                      <div key={mi} className="flex gap-2">
                        <Input
                          value={m}
                          placeholder={`第 ${mi + 1} 句，可用 {name}`}
                          onChange={(e) => updateMessage(si, mi, e.target.value)}
                        />
                        <Button size="sm" variant="outline" onClick={() => addMessage(si)}>
                          +
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => removeMessage(si, mi)}
                        >
                          -
                        </Button>
                      </div>
                    ))}
                  </div>
                ))}

                <Button size="sm" variant="secondary" disabled={busy} onClick={addStep}>
                  添加句本
                </Button>
              </>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange?.(false)}>
            关闭
          </Button>
          <Button disabled={busy || !active} onClick={saveActive}>
            保存当前话术
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
