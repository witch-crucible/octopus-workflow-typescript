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
import { getOctopus, type RequirementSummary, type TbStatus } from "@/lib/octopus"
import {
  buildKanbanModel,
  type KanbanCardView,
} from "@/lib/view-models"
import { phaseLabel } from "@/lib/labels"
import { cn } from "@/lib/utils"

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
      <div className="kanban-board flex gap-3 overflow-x-auto pb-2">
        {model.columns.map((column) => (
          <div
            key={column.phase}
            data-phase={column.phase}
            className={cn(
              "kanban-column flex w-64 shrink-0 flex-col rounded-lg border bg-muted/30",
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
            <div className="flex items-center justify-between border-b px-3 py-2 text-sm font-medium">
              <span>{column.label}</span>
              <Badge variant="secondary">{column.cards.length}</Badge>
            </div>
            <div className="flex flex-1 flex-col gap-2 p-2">
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
        "kanban-card cursor-grab rounded-md border bg-card p-3 shadow-xs active:cursor-grabbing",
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
      <div className="mb-1 flex flex-wrap items-start gap-1">
        <span className="font-medium leading-snug">{card.displayName}</span>
        {card.teambitionBound ? (
          <Badge variant="secondary">
            TB{card.teambitionStatusName ? ` · ${card.teambitionStatusName}` : ""}
          </Badge>
        ) : (
          <Badge variant="outline">未绑定任务</Badge>
        )}
        {card.versionBadge ? (
          <Badge variant={card.versionBadge.stale ? "destructive" : "secondary"}>
            版本 · {card.versionBadge.label}
            {card.versionBadge.stale ? "（已失效）" : ""}
          </Badge>
        ) : null}
      </div>
      {card.displayDescription ? (
        <p className="mb-2 line-clamp-3 text-xs text-muted-foreground">{card.displayDescription}</p>
      ) : null}
      <div className="mb-2 flex flex-wrap gap-2 text-[11px] text-muted-foreground">
        <span>
          节点 {card.completedTasks}/{card.totalTasks}
        </span>
        <span>{card.scheduleText}</span>
        {card.updatedAtLabel ? <span>{card.updatedAtLabel}</span> : null}
      </div>
      {card.teambitionTaskId ? (
        <select
          className="kanban-tb-status mb-2 w-full rounded-md border bg-background px-2 py-1 text-xs"
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
      <div className="flex gap-1" onClick={(event) => event.stopPropagation()}>
        <Button type="button" size="xs" onClick={onOpen}>
          打开
        </Button>
        <Button type="button" size="xs" variant="secondary" onClick={onEdit}>
          编辑
        </Button>
        <Button type="button" size="xs" variant="destructive" onClick={onDelete}>
          删除
        </Button>
      </div>
    </article>
  )
}
