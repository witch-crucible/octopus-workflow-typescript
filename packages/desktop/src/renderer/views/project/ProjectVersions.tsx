import { useCallback, useEffect, useState } from "react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { readableError, showError, showSuccess } from "@/lib/feedback"
import { getOctopus, type Project } from "@/lib/octopus"

export type ProjectVersionItem = {
  versionId: string
  name: string
  status?: string
  startDate?: string
  endDate?: string
  note?: string
}

export type ProjectVersionsProps = {
  projectId: string
  project: Project | null
  onProjectChange: (project: Project) => void
}

export function ProjectVersions({
  projectId,
  project,
  onProjectChange,
}: ProjectVersionsProps) {
  const [versions, setVersions] = useState<ProjectVersionItem[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [noteTarget, setNoteTarget] = useState<ProjectVersionItem | null>(null)
  const [noteDraft, setNoteDraft] = useState("")

  const defaultId =
    (project?.teambitionVersion as { defaultVersionId?: string } | undefined)?.defaultVersionId ||
    project?.defaultVersionId ||
    ""

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const list = (await getOctopus().listProjectVersions(projectId)) as ProjectVersionItem[]
      setVersions(Array.isArray(list) ? list : [])
    } catch (err) {
      setError(readableError(err))
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <>
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3 space-y-0">
          <CardTitle>Teambition 版本计划</CardTitle>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              onClick={() => {
                void (async () => {
                  try {
                    await getOctopus().syncProjectVersions(projectId)
                    await load()
                    showSuccess("版本已刷新")
                  } catch (err) {
                    showError(err)
                  }
                })()
              }}
            >
              刷新版本
            </Button>
            <div className="flex items-center gap-2">
              <Label>默认版本</Label>
              <Select
                value={defaultId || "__none__"}
                onValueChange={(value) => {
                  void (async () => {
                    try {
                      const next = await getOctopus().setProjectDefaultVersion(
                        projectId,
                        value === "__none__" ? null : value,
                      )
                      onProjectChange(next)
                      showSuccess("默认版本已更新")
                    } catch (err) {
                      showError(err)
                    }
                  })()
                }}
              >
                <SelectTrigger className="w-[200px]">
                  <SelectValue placeholder="未设置" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">未设置</SelectItem>
                  {versions.map((version) => (
                    <SelectItem key={version.versionId} value={version.versionId}>
                      {version.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {loading ? <p className="text-sm text-muted-foreground">加载中…</p> : null}
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          {!loading && !error ? (
            versions.length === 0 ? (
              <div className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
                暂无版本，或版本列表端点尚未确认。
              </div>
            ) : (
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {versions.map((version) => (
                  <article key={version.versionId} className="rounded-lg border p-4">
                    <h3 className="font-medium">{version.name}</h3>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {version.status || "未标注状态"} · {version.startDate || "未排期"} →{" "}
                      {version.endDate || "未排期"}
                    </p>
                    <p className="mt-2 text-sm">{version.note || "暂无说明"}</p>
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      className="mt-3"
                      onClick={() => {
                        setNoteTarget(version)
                        setNoteDraft(version.note || "")
                      }}
                    >
                      更新说明
                    </Button>
                  </article>
                ))}
              </div>
            )
          ) : null}
        </CardContent>
      </Card>

      <Dialog
        open={Boolean(noteTarget)}
        onOpenChange={(open) => {
          if (!open) setNoteTarget(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>版本说明</DialogTitle>
          </DialogHeader>
          <Textarea
            value={noteDraft}
            onChange={(event) => setNoteDraft(event.target.value)}
            rows={5}
          />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setNoteTarget(null)}>
              取消
            </Button>
            <Button
              type="button"
              onClick={() => {
                const target = noteTarget
                if (!target) return
                void (async () => {
                  try {
                    await getOctopus().updateVersionNote(projectId, target.versionId, noteDraft)
                    setNoteTarget(null)
                    await load()
                    showSuccess("版本说明已更新")
                  } catch (err) {
                    showError(err)
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
