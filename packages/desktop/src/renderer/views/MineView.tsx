import { useCallback, useEffect, useState } from "react"

import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { navigateRequirement } from "@/hooks/useHashRoute"
import { showError, showMessage, showSuccess } from "@/lib/feedback"
import { phaseLabel } from "@/lib/labels"
import { getOctopus, type MyWorkItem, type MyWorkList } from "@/lib/octopus"
import { cn } from "@/lib/utils"

function dueLabel(item: MyWorkItem): string {
  return item.plannedEnd || item.nextMilestone?.date || "未排期"
}

function MineTable({
  items,
  emptyText,
  thirdHeader,
}: {
  items: MyWorkItem[]
  emptyText: string
  thirdHeader: string
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>项目</TableHead>
          <TableHead>需求</TableHead>
          <TableHead>{thirdHeader}</TableHead>
          <TableHead>阶段</TableHead>
          <TableHead>截止/里程碑</TableHead>
          <TableHead>状态</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.length === 0 ? (
          <TableRow>
            <TableCell colSpan={6} className="text-muted-foreground">
              {emptyText}
            </TableCell>
          </TableRow>
        ) : (
          items.map((item) => (
            <TableRow key={`${item.kind}:${item.requirementId}:${item.nodeId ?? "req"}`}>
              <TableCell>{item.projectName}</TableCell>
              <TableCell>
                <Button
                  type="button"
                  variant="link"
                  className="h-auto px-0"
                  onClick={() => navigateRequirement(item.requirementId)}
                >
                  {item.requirementName}
                </Button>
              </TableCell>
              <TableCell>{item.nodeName || "需求负责人"}</TableCell>
              <TableCell>{phaseLabel(item.phase)}</TableCell>
              <TableCell>{dueLabel(item)}</TableCell>
              <TableCell className={cn(item.overdue && "font-medium text-destructive")}>
                {item.overdue ? "逾期" : ""}
              </TableCell>
            </TableRow>
          ))
        )}
      </TableBody>
    </Table>
  )
}

export function MineView() {
  const [identity, setIdentityState] = useState<string | null>(null)
  const [draft, setDraft] = useState("")
  const [list, setList] = useState<MyWorkList | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const current = await getOctopus().getIdentity()
      const name = current.name?.trim() || null
      setIdentityState(name)
      if (!name) {
        setList(null)
        return
      }
      const work = await getOctopus().listMyWork(name)
      setList(work)
    } catch (error) {
      showError(error)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  async function saveIdentity(): Promise<void> {
    const name = draft.trim()
    if (!name) {
      showMessage("请填写身份名称", "warning")
      return
    }
    try {
      await getOctopus().setIdentity(name)
      setDraft("")
      showSuccess("身份已保存")
      await refresh()
    } catch (error) {
      showError(error)
    }
  }

  async function clearIdentity(): Promise<void> {
    try {
      await getOctopus().setIdentity(null)
      showSuccess("身份已清除")
      await refresh()
    } catch (error) {
      showError(error)
    }
  }

  if (loading) {
    return (
      <div className="mx-auto max-w-5xl p-4 md:p-6">
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            加载我的工作…
          </CardContent>
        </Card>
      </div>
    )
  }

  if (!identity) {
    return (
      <div className="mx-auto max-w-xl p-4 md:p-6">
        <Card>
          <CardHeader>
            <CardTitle>我的工作</CardTitle>
            <CardDescription>尚未设置身份。请在下方填写名称。</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="mine-identity">我是</Label>
              <Input
                id="mine-identity"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder="例如：张三"
              />
            </div>
            <Button type="button" onClick={() => void saveIdentity()}>
              保存身份
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-4 md:p-6">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
          <div>
            <CardTitle>我的工作（{identity}）</CardTitle>
            <CardDescription>负责的需求与指派给我的节点</CardDescription>
          </div>
          <Button type="button" variant="outline" onClick={() => void clearIdentity()}>
            清除身份
          </Button>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-3">
            <h4 className="text-sm font-semibold">我负责的需求</h4>
            <MineTable
              items={list?.requirements ?? []}
              emptyText="暂无负责的需求"
              thirdHeader="负责人"
            />
          </div>
          <div className="space-y-3">
            <h4 className="text-sm font-semibold">指派给我的节点</h4>
            <MineTable
              items={list?.nodes ?? []}
              emptyText="暂无指派节点"
              thirdHeader="节点"
            />
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
