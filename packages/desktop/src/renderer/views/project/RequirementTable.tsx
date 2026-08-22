import { useMemo, useState } from "react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
import { navigateRequirement } from "@/hooks/useHashRoute"
import { confirmAction, showError, showMessage, showSuccess } from "@/lib/feedback"
import { PHASE_ORDER, phaseLabel } from "@/lib/labels"
import { getOctopus, type RequirementSummary } from "@/lib/octopus"

type SortKey = "requirementName" | "currentPhase" | "owner" | "plannedStart" | "plannedEnd"
type SortDir = "asc" | "desc"

export type RequirementTableProps = {
  items: RequirementSummary[]
  filter: string
  onReload: () => Promise<void>
}

type DraftRow = {
  owner: string
  plannedStart: string
  plannedEnd: string
}

export function RequirementTable({ items, filter, onReload }: RequirementTableProps) {
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({
    key: "requirementName",
    dir: "asc",
  })
  const [drafts, setDrafts] = useState<Record<string, DraftRow>>({})
  const [editItem, setEditItem] = useState<RequirementSummary | null>(null)
  const [editName, setEditName] = useState("")
  const [editDesc, setEditDesc] = useState("")

  const phaseIndex = (value: string | null | undefined) =>
    PHASE_ORDER.indexOf(value as (typeof PHASE_ORDER)[number])

  const sorted = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return [...items]
      .filter((item) => {
        if (!q) return true
        return [item.requirementName, item.requirementId, item.description, item.owner].some((value) =>
          String(value || "")
            .toLowerCase()
            .includes(q),
        )
      })
      .sort((a, b) => {
        const av =
          sort.key === "currentPhase"
            ? phaseIndex(a.currentPhase)
            : String(a[sort.key] || "")
        const bv =
          sort.key === "currentPhase"
            ? phaseIndex(b.currentPhase)
            : String(b[sort.key] || "")
        const cmp = av < bv ? -1 : av > bv ? 1 : 0
        return cmp * (sort.dir === "asc" ? 1 : -1)
      })
  }, [items, filter, sort])

  const draftFor = (item: RequirementSummary): DraftRow =>
    drafts[item.requirementId] ?? {
      owner: item.owner || "",
      plannedStart: item.plannedStart || "",
      plannedEnd: item.plannedEnd || "",
    }

  const setDraft = (requirementId: string, patch: Partial<DraftRow>) => {
    setDrafts((prev) => {
      const base =
        prev[requirementId] ??
        (() => {
          const item = items.find((entry) => entry.requirementId === requirementId)
          return {
            owner: item?.owner || "",
            plannedStart: item?.plannedStart || "",
            plannedEnd: item?.plannedEnd || "",
          }
        })()
      return { ...prev, [requirementId]: { ...base, ...patch } }
    })
  }

  const toggleSort = (key: SortKey) => {
    setSort((prev) =>
      prev.key === key
        ? { key, dir: prev.dir === "asc" ? "desc" : "asc" }
        : { key, dir: "asc" },
    )
  }

  const sortMark = (key: SortKey) =>
    sort.key === key ? (sort.dir === "asc" ? " ↑" : " ↓") : ""

  const openRequirement = (requirementId: string) => {
    navigateRequirement(requirementId)
  }

  return (
    <>
      <div className="rounded-xl border bg-card">
        <Table className="requirement-table min-w-[1100px]">
          <TableHeader>
            <TableRow>
              <TableHead>
                <button type="button" className="font-medium" onClick={() => toggleSort("requirementName")}>
                  名称{sortMark("requirementName")}
                </button>
              </TableHead>
              <TableHead>
                <button type="button" className="font-medium" onClick={() => toggleSort("currentPhase")}>
                  阶段{sortMark("currentPhase")}
                </button>
              </TableHead>
              <TableHead>
                <button type="button" className="font-medium" onClick={() => toggleSort("owner")}>
                  负责人{sortMark("owner")}
                </button>
              </TableHead>
              <TableHead>
                <button type="button" className="font-medium" onClick={() => toggleSort("plannedStart")}>
                  开始{sortMark("plannedStart")}
                </button>
              </TableHead>
              <TableHead>
                <button type="button" className="font-medium" onClick={() => toggleSort("plannedEnd")}>
                  结束{sortMark("plannedEnd")}
                </button>
              </TableHead>
              <TableHead>里程碑</TableHead>
              <TableHead>进度</TableHead>
              <TableHead>TB</TableHead>
              <TableHead>操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.length === 0 ? (
              <TableRow>
                <TableCell colSpan={9} className="text-muted-foreground">
                  暂无需求
                </TableCell>
              </TableRow>
            ) : (
              sorted.map((item) => {
                const draft = draftFor(item)
                return (
                  <TableRow key={item.requirementId}>
                    <TableCell className="max-w-[220px] whitespace-normal">
                      <button
                        type="button"
                        className="text-left font-medium text-primary hover:underline"
                        onClick={() => openRequirement(item.requirementId)}
                      >
                        {item.requirementName || item.requirementId}
                      </button>
                      <div className="truncate text-xs text-muted-foreground" title={item.requirementId}>
                        {item.requirementId}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Select
                        value={item.currentPhase || PHASE_ORDER[0]}
                        onValueChange={(value) => {
                          void (async () => {
                            try {
                              await getOctopus().moveRequirementPhase(item.requirementId, value)
                              showSuccess("阶段已更新")
                              await onReload()
                            } catch (error) {
                              showError(error)
                              await onReload()
                            }
                          })()
                        }}
                      >
                        <SelectTrigger size="sm" className="w-[110px]">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {PHASE_ORDER.map((phase) => (
                            <SelectItem key={phase} value={phase}>
                              {phaseLabel(phase)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell>
                      <Input
                        className="h-8 w-[110px]"
                        value={draft.owner}
                        placeholder="未设置"
                        onChange={(event) =>
                          setDraft(item.requirementId, { owner: event.target.value })
                        }
                      />
                    </TableCell>
                    <TableCell>
                      <Input
                        type="date"
                        className="h-8 w-[140px]"
                        value={draft.plannedStart}
                        onChange={(event) =>
                          setDraft(item.requirementId, { plannedStart: event.target.value })
                        }
                      />
                    </TableCell>
                    <TableCell>
                      <Input
                        type="date"
                        className="h-8 w-[140px]"
                        value={draft.plannedEnd}
                        onChange={(event) =>
                          setDraft(item.requirementId, { plannedEnd: event.target.value })
                        }
                      />
                    </TableCell>
                    <TableCell className="text-xs whitespace-normal">
                      {item.nextMilestone
                        ? `${item.nextMilestone.name} · ${item.nextMilestone.date}`
                        : "—"}
                    </TableCell>
                    <TableCell>
                      {item.totalTasks ? `${item.completedTasks ?? 0}/${item.totalTasks}` : "—"}
                    </TableCell>
                    <TableCell>{item.teambitionStatusName || "—"}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        <Button
                          type="button"
                          size="xs"
                          variant="secondary"
                          onClick={() => {
                            const start = draft.plannedStart || null
                            const end = draft.plannedEnd || null
                            if ((start && !end) || (!start && end)) {
                              showMessage("起止日期必须成对", "warning")
                              return
                            }
                            void (async () => {
                              try {
                                await getOctopus().updateRequirement(item.requirementId, {
                                  owner: draft.owner.trim() || null,
                                })
                                await getOctopus().updateRequirementSchedule(item.requirementId, {
                                  plannedStart: start,
                                  plannedEnd: end,
                                })
                                showSuccess("需求已保存")
                                await onReload()
                              } catch (error) {
                                showError(error)
                              }
                            })()
                          }}
                        >
                          保存
                        </Button>
                        <Button
                          type="button"
                          size="xs"
                          variant="secondary"
                          onClick={() => {
                            setEditItem(item)
                            setEditName(item.requirementName || "")
                            setEditDesc(item.description || "")
                          }}
                        >
                          编辑
                        </Button>
                        <Button
                          type="button"
                          size="xs"
                          variant="secondary"
                          onClick={() => {
                            void (async () => {
                              const ok = await confirmAction(
                                "确认删除该需求？此操作不可恢复。",
                                "删除需求",
                                "error",
                              )
                              if (!ok) return
                              try {
                                await getOctopus().deleteRequirement(item.requirementId)
                                showSuccess("需求已删除")
                                await onReload()
                              } catch (error) {
                                showError(error)
                              }
                            })()
                          }}
                        >
                          删除
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                )
              })
            )}
          </TableBody>
        </Table>
      </div>

      <Dialog
        open={Boolean(editItem)}
        onOpenChange={(open) => {
          if (!open) setEditItem(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>编辑需求</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="table-edit-name">需求名称</Label>
              <Input
                id="table-edit-name"
                value={editName}
                onChange={(event) => setEditName(event.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="table-edit-desc">需求描述</Label>
              <Textarea
                id="table-edit-desc"
                value={editDesc}
                onChange={(event) => setEditDesc(event.target.value)}
                rows={4}
              />
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setEditItem(null)}>
              取消
            </Button>
            <Button
              type="button"
              onClick={() => {
                const item = editItem
                if (!item) return
                const name = editName.trim()
                if (!name) {
                  showMessage("需求名称不能为空", "warning")
                  return
                }
                void (async () => {
                  try {
                    await getOctopus().updateRequirement(item.requirementId, {
                      name,
                      description: editDesc,
                    })
                    setEditItem(null)
                    await onReload()
                  } catch (error) {
                    showError(error)
                  }
                })()
              }}
            >
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
