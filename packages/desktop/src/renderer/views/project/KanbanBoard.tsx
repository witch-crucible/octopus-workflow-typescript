import { CalendarDays, CheckSquare2, CircleDot } from "lucide-react"
import { useRef, useState } from "react"

import { Badge } from "@/components/ui/badge"
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
import { Textarea } from "@/components/ui/textarea"
import { navigateRequirement } from "@/hooks/useHashRoute"
import { confirmAction, showError, showSuccess } from "@/lib/feedback"
import { phaseLabel } from "@/lib/labels"
import { getOctopus, type RequirementSummary, type TbStatus } from "@/lib/octopus"
import { cn } from "@/lib/utils"
import { buildKanbanModel, type KanbanCardView } from "@/lib/view-models"

export type KanbanBoardProps = {
  items: RequirementSummary[]
  filter: string
  lastCreatedId?: string
  tbStatuses: TbStatus[]
  onReload: () => Promise<void>
}

export function KanbanBoard({
  items,
  filter,
  lastCreatedId = "",
  tbStatuses,
  onReload,
}: KanbanBoardProps) {
  const model = buildKanbanModel(items, { filter, lastCreatedId })
  const dragRef = useRef<{ requirementId: string; fromPhase: string } | null>(null)
  const [dragOverPhase, setDragOverPhase] = useState<string | null>(null)
  const [editTarget, setEditTarget] = useState<KanbanCardView | null>(null)
  const [editName, setEditName] = useState("")
  const [editDesc, setEditDesc] = useState("")

  const openRequirement = (requirementId: string) => {
    navigateRequirement(requirementId)
  }

  const handleDrop = async (toPhase: string) => {
    const drag = dragRef.current
    dragRef.current = null
    setDragOverPhase(null)
    if (!drag || drag.fromPhase === toPhase) return
    try {
      await getOctopus().moveRequirementPhase(drag.requirementId, toPhase)
      showSuccess(`需求已移至「${phaseLabel(toPhase)}」`)
      await onReload()
    } catch (error) {
      showError(error)
      await onReload()
    }
  }

  const saveEdit = async () => {
    if (!editTarget) return
    const name = editName.trim()
    if (!name) {
      showError(new Error("需求名称不能为空"))
      return
    }
    try {
      await getOctopus().updateRequirement(editTarget.requirementId, {
        name,
        description: editDesc,
      })
      setEditTarget(null)
      showSuccess("需求已更新")
      await onReload()
    } catch (error) {
      showError(error)
    }
  }

  if (model.kind === "empty") {
    return (
      <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
        该项目还没有需求。在右侧创建需求。
      </div>
    )
  }

  if (model.kind === "nomatch") {
    return (
      <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
        没有匹配「{model.filter}」的需求
      </div>
    )
  }

  return (
    <>
      <div className="kanban-board flex min-h-[calc(100dvh-190px)] items-start gap-3 overflow-x-auto px-1 pb-4">
        {model.columns.map((column, columnIndex) => (
          <div
            key={column.phase}
            data-phase={column.phase}
            className={cn(
              "kanban-column flex w-[282px] shrink-0 flex-col overflow-hidden rounded-xl border border-slate-200/80 bg-slate-100/75 dark:border-white/10 dark:bg-white/[0.035]",
              dragOverPhase === column.phase && "ring-2 ring-primary",
            )}
            onDragOver={(event) => {
              event.preventDefault()
              event.dataTransfer.dropEffect = "move"
              setDragOverPhase(column.phase)
            }}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node)) {
                setDragOverPhase((current) => (current === column.phase ? null : current))
              }
            }}
            onDrop={(event) => {
              event.preventDefault()
              void handleDrop(column.phase)
            }}
          >
            <div
              className={cn(
                "flex items-center justify-between border-b border-slate-200/70 px-3 py-2.5 text-sm font-semibold dark:border-white/10",
                columnIndex === 0 && "bg-slate-200/70 dark:bg-white/[0.06]",
                columnIndex > 0 &&
                  "bg-sky-100/85 text-sky-700 dark:bg-sky-900/25 dark:text-sky-300",
              )}
            >
              <span className="truncate">{column.label}</span>
              <span className="ml-2 rounded-full bg-white/75 px-2 py-0.5 text-[11px] font-medium text-muted-foreground shadow-xs dark:bg-black/15">
                {column.cards.length}
              </span>
            </div>
            <div className="flex flex-1 flex-col gap-2.5 p-2.5">
              {column.cards.map((card) => (
                <KanbanCard
                  key={card.requirementId}
                  card={card}
                  tbStatuses={tbStatuses}
                  onOpen={() => openRequirement(card.requirementId)}
                  onEdit={() => {
                    setEditTarget(card)
                    setEditName(card.requirementName || card.requirementId)
                    setEditDesc(card.description || "")
                  }}
                  onDelete={() => {
                    void (async () => {
                      const ok = await confirmAction(
                        `删除需求「${card.displayName}」的状态？\n只删除状态库记录，不会删除源码目录。此操作不可恢复。`,
                        "删除需求",
                        "error",
                      )
                      if (!ok) return
                      try {
                        await getOctopus().deleteRequirement(card.requirementId)
                        showSuccess("需求已删除")
                        await onReload()
                      } catch (error) {
                        showError(error)
                      }
                    })()
                  }}
                  onTbStatus={async (statusId) => {
                    try {
                      await getOctopus().updateRequirementTeambitionStatus(
                        card.requirementId,
                        statusId,
                      )
                      showSuccess("Teambition 状态已更新")
                      await onReload()
                    } catch (error) {
                      showError(error)
                    }
                  }}
                  onDragStart={() => {
                    dragRef.current = {
                      requirementId: card.requirementId,
                      fromPhase: card.phase,
                    }
                  }}
                  onDragEnd={() => {
                    dragRef.current = null
                    setDragOverPhase(null)
                  }}
                />
              ))}
            </div>
          </div>
        ))}
      </div>

      <Dialog
        open={Boolean(editTarget)}
        onOpenChange={(open) => {
          if (!open) setEditTarget(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>编辑需求</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="kanban-edit-name">需求名称</Label>
              <Input
                id="kanban-edit-name"
                value={editName}
                onChange={(event) => setEditName(event.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="kanban-edit-desc">需求描述</Label>
              <Textarea
                id="kanban-edit-desc"
                value={editDesc}
                onChange={(event) => setEditDesc(event.target.value)}
                rows={4}
              />
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setEditTarget(null)}>
              取消
            </Button>
            <Button type="button" onClick={() => void saveEdit()}>
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

function KanbanCard({
  card,
  tbStatuses,
  onOpen,
  onEdit,
  onDelete,
  onTbStatus,
  onDragStart,
  onDragEnd,
}: {
  card: KanbanCardView
  tbStatuses: TbStatus[]
  onOpen: () => void
  onEdit: () => void
  onDelete: () => void
  onTbStatus: (statusId: string) => void
  onDragStart: () => void
  onDragEnd: () => void
}) {
  const statusIdOf = (status: TbStatus) => String(status.id || status.statusId || "")
  const statusNameOf = (status: TbStatus) =>
    String(status.name || status.statusName || status.id || status.statusId || "")

  return (
    <article
      draggable
      data-requirement-id={card.requirementId}
      data-phase={card.phase}
      className={cn(
        "kanban-card group cursor-grab rounded-lg border border-slate-200/90 bg-card p-3.5 shadow-[0_1px_2px_rgba(15,23,42,0.06)] transition-[box-shadow,transform] hover:-translate-y-px hover:shadow-md active:cursor-grabbing dark:border-white/10",
        card.highlight && "ring-2 ring-primary",
      )}
      onClick={onOpen}
      onDragStart={(event) => {
        if ((event.target as HTMLElement).closest(".kanban-tb-status")) {
          event.preventDefault()
          return
        }
        onDragStart()
        event.dataTransfer.effectAllowed = "move"
        event.dataTransfer.setData("text/plain", card.requirementId)
      }}
      onDragEnd={onDragEnd}
    >
      <div className="mb-2 flex flex-wrap items-start gap-1.5">
        <span className="min-w-0 flex-1 text-sm font-semibold leading-5 text-foreground">
          {card.displayName}
        </span>
        {card.teambitionBound ? (
          <Badge
            className="border-emerald-200 bg-emerald-50 text-[10px] text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300"
            variant="outline"
          >
            TB{card.teambitionStatusName ? ` · ${card.teambitionStatusName}` : ""}
          </Badge>
        ) : (
          <Badge className="text-[10px] font-normal text-muted-foreground" variant="outline">
            未绑定任务
          </Badge>
        )}
        {card.versionBadge ? (
          <Badge variant={card.versionBadge.stale ? "destructive" : "secondary"}>
            版本 · {card.versionBadge.label}
            {card.versionBadge.stale ? "（已失效）" : ""}
          </Badge>
        ) : null}
      </div>
      {card.displayDescription ? (
        <p className="mb-3 line-clamp-2 text-xs leading-5 text-muted-foreground">
          {card.displayDescription}
        </p>
      ) : null}
      <div className="mb-3 grid gap-1.5 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <CheckSquare2 className="size-3.5" />
          节点 {card.completedTasks}/{card.totalTasks}
        </span>
        <span className="flex items-center gap-1.5">
          <CalendarDays className="size-3.5" />
          {card.scheduleText}
        </span>
        {card.updatedAtLabel ? (
          <span className="flex items-center gap-1.5">
            <CircleDot className="size-3.5" />
            {card.updatedAtLabel}
          </span>
        ) : null}
      </div>
      {card.teambitionTaskId ? (
        <select
          className="kanban-tb-status mb-3 w-full rounded-md border bg-background px-2 py-1.5 text-xs"
          value={card.teambitionStatusId || ""}
          onClick={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.stopPropagation()}
          draggable={false}
          onChange={(event) => {
            const value = event.target.value
            if (value) onTbStatus(value)
          }}
        >
          {tbStatuses.map((status) => {
            const id = statusIdOf(status)
            return (
              <option key={id} value={id}>
                {statusNameOf(status)}
              </option>
            )
          })}
        </select>
      ) : null}
      <div
        className="flex gap-1 border-t border-border/60 pt-2.5"
        onClick={(event) => event.stopPropagation()}
      >
        <Button type="button" size="xs" variant="ghost" className="text-primary" onClick={onOpen}>
          打开
        </Button>
        <Button type="button" size="xs" variant="ghost" onClick={onEdit}>
          编辑
        </Button>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          className="text-destructive hover:text-destructive"
          onClick={onDelete}
        >
          删除
        </Button>
      </div>
    </article>
  )
}
