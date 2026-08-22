import { useCallback, useEffect, useMemo, useState } from "react"

import mascot from "@/assets/mascot.jpg"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { navigateMine, navigateProject } from "@/hooks/useHashRoute"
import { confirmAction, showError, showMessage, showSuccess } from "@/lib/feedback"
import { getOctopus, type ProjectSummary } from "@/lib/octopus"
import { cn } from "@/lib/utils"
import { buildHubCardsModel, type HubCardView } from "@/lib/view-models"

export function HubView() {
  const [items, setItems] = useState<ProjectSummary[]>([])
  const [filter, setFilter] = useState("")
  const [lastCreatedId, setLastCreatedId] = useState("")
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState("")
  const [editDescription, setEditDescription] = useState("")

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const summaries = await getOctopus().listProjectSummaries()
      setItems(summaries)
    } catch (error) {
      showError(error)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const model = useMemo(
    () => buildHubCardsModel(items, { filter, lastCreatedId }),
    [items, filter, lastCreatedId],
  )

  async function handleCreate(): Promise<void> {
    const trimmed = name.trim()
    if (!trimmed) {
      showMessage("请填写项目名称", "warning")
      return
    }
    setCreating(true)
    try {
      const desc = description.trim()
      const created = desc
        ? await getOctopus().createProject(trimmed, desc)
        : await getOctopus().createProject(trimmed)
      setLastCreatedId(created.projectId)
      setName("")
      setDescription("")
      showSuccess("项目已创建")
      await load()
      navigateProject(created.projectId)
    } catch (error) {
      showError(error)
    } finally {
      setCreating(false)
    }
  }

  function beginEdit(card: HubCardView): void {
    setEditingId(card.projectId)
    setEditName(card.name || "")
    setEditDescription(card.description || "")
  }

  function cancelEdit(): void {
    setEditingId(null)
    setEditName("")
    setEditDescription("")
  }

  async function saveEdit(projectId: string): Promise<void> {
    const trimmed = editName.trim()
    if (!trimmed) {
      showMessage("项目名称不能为空", "warning")
      return
    }
    try {
      await getOctopus().updateProjectMeta(projectId, {
        name: trimmed,
        description: editDescription,
      })
      showSuccess("项目已更新")
      cancelEdit()
      await load()
    } catch (error) {
      showError(error)
    }
  }

  async function handleDelete(card: HubCardView): Promise<void> {
    const label = card.displayName
    const ok = await confirmAction(
      `删除项目「${label}」及其下全部需求状态？\n只删除状态库记录，不会删除源码目录或 workflow.yaml。此操作不可恢复。`,
      "删除项目",
      "error",
    )
    if (!ok) return
    try {
      await getOctopus().deleteProject(card.projectId)
      if (lastCreatedId === card.projectId) setLastCreatedId("")
      if (editingId === card.projectId) cancelEdit()
      showSuccess("项目已删除")
      await load()
    } catch (error) {
      showError(error)
    }
  }

  return (
    <div className="mx-auto grid max-w-7xl gap-6 p-4 md:grid-cols-[minmax(0,1fr)_320px] md:p-6">
      <div className="min-w-0 space-y-6">
        <div className="flex items-start gap-4 rounded-xl border border-border bg-card p-4 shadow-sm">
          <img
            src={mascot}
            alt=""
            width={108}
            height={108}
            className="size-[84px] shrink-0 rounded-xl object-cover md:size-[108px]"
          />
          <div className="min-w-0 space-y-1">
            <p className="text-xs font-semibold tracking-[0.16em] text-primary">OCTOPUS WORKFLOW</p>
            <p className="text-lg font-semibold leading-snug md:text-xl">
              一只章鱼，编排整条软件交付流水线
            </p>
            <p className="text-sm text-muted-foreground">项目 → 需求 → 设计 → 开发 → 测试 → 部署</p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <h2 className="mr-auto text-lg font-semibold">项目管理中心</h2>
          <Input
            type="search"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="按名称或 ID 筛选"
            className="max-w-xs"
          />
          <Button type="button" variant="outline" onClick={navigateMine}>
            我的工作
          </Button>
        </div>

        {loading ? (
          <div className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
            加载项目中…
          </div>
        ) : null}

        {!loading && model.kind === "empty" ? (
          <div className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
            还没有项目。在右侧填写名称即可创建项目；进入项目后再创建需求并可选绑定 Teambition。
          </div>
        ) : null}

        {!loading && model.kind === "nomatch" ? (
          <div className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
            没有匹配「{model.filter}」的项目
          </div>
        ) : null}

        {!loading && model.kind === "cards" ? (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {model.filtered.map((card) => {
              const editing = editingId === card.projectId
              return (
                <Card
                  key={card.projectId}
                  className={cn(
                    "gap-4 py-4",
                    card.highlight && "ring-2 ring-primary/40",
                  )}
                >
                  <CardHeader className="gap-2 px-4">
                    <CardTitle className="text-base">{card.displayName}</CardTitle>
                    <CardDescription className="line-clamp-3">
                      {card.displayDescription}
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-3 px-4">
                    <div className="text-sm text-muted-foreground">
                      需求 {card.requirementCount} 个
                    </div>
                    {card.teambitionBound ? (
                      <Badge variant="secondary">
                        已绑定 TB · {card.teambitionProjectId}
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="text-muted-foreground">
                        未绑定 Teambition
                      </Badge>
                    )}
                    <div className="break-all text-xs text-muted-foreground">
                      {card.projectId}
                      {card.updatedAtLabel ? (
                        <>
                          <br />
                          更新于 {card.updatedAtLabel}
                        </>
                      ) : null}
                    </div>

                    {editing ? (
                      <div className="space-y-2 rounded-lg border border-border p-3">
                        <Input
                          value={editName}
                          onChange={(event) => setEditName(event.target.value)}
                          placeholder="项目名称"
                        />
                        <Input
                          value={editDescription}
                          onChange={(event) => setEditDescription(event.target.value)}
                          placeholder="项目描述"
                        />
                        <div className="flex gap-2">
                          <Button type="button" size="sm" onClick={() => void saveEdit(card.projectId)}>
                            保存
                          </Button>
                          <Button type="button" size="sm" variant="outline" onClick={cancelEdit}>
                            取消
                          </Button>
                        </div>
                      </div>
                    ) : null}
                  </CardContent>
                  {!editing ? (
                    <CardFooter className="flex flex-wrap gap-2 px-4">
                      <Button type="button" size="sm" onClick={() => navigateProject(card.projectId)}>
                        打开项目
                      </Button>
                      <Button type="button" size="sm" variant="outline" onClick={() => beginEdit(card)}>
                        编辑
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="destructive"
                        onClick={() => void handleDelete(card)}
                      >
                        删除
                      </Button>
                    </CardFooter>
                  ) : null}
                </Card>
              )
            })}
          </div>
        ) : null}
      </div>

      <aside>
        <Card className="gap-4 py-4">
          <CardHeader className="px-4">
            <CardTitle className="text-base">创建项目</CardTitle>
            <CardDescription>
              创建项目容器（可含多个需求）。删除项目会清掉其下需求状态，不删源码目录。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 px-4">
            <div className="space-y-2">
              <Label htmlFor="hub-project-name">项目名称</Label>
              <Input
                id="hub-project-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="例如：商城改版"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="hub-project-desc">项目描述（可选）</Label>
              <Textarea
                id="hub-project-desc"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                rows={4}
                placeholder="简要说明项目目标"
              />
            </div>
            <Button
              type="button"
              className="w-full"
              disabled={creating}
              onClick={() => void handleCreate()}
            >
              {creating ? "创建中…" : "创建项目"}
            </Button>
          </CardContent>
        </Card>
      </aside>
    </div>
  )
}
