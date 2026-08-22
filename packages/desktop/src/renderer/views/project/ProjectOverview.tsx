import { useEffect, useState } from "react"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { readableError } from "@/lib/feedback"
import { phaseLabel } from "@/lib/labels"
import { getOctopus } from "@/lib/octopus"

type OverviewData = {
  projectName: string
  requirementCount: number
  unscheduledCount: number
  unboundTbCount: number
  ownerlessCount: number
  readyNodeCount: number
  waitingNodeCount: number
  milestonePlanned: number
  milestoneReached: number
  milestoneOverdue: number
  heinrich: { major: number; minor: number; trivial: number }
  byPhase: Array<{ phase: string; count: number }>
}

export type ProjectOverviewProps = {
  projectId: string
}

export function ProjectOverviewPanel({ projectId }: ProjectOverviewProps) {
  const [overview, setOverview] = useState<OverviewData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    void (async () => {
      try {
        const data = (await getOctopus().getProjectOverview(projectId)) as OverviewData
        if (!cancelled) {
          setOverview(data)
          setLoading(false)
        }
      } catch (err) {
        if (!cancelled) {
          setError(readableError(err))
          setLoading(false)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [projectId])

  if (loading) {
    return <p className="text-sm text-muted-foreground">加载概览…</p>
  }

  if (error) {
    return <p className="text-sm text-destructive">{error}</p>
  }

  if (!overview) return null

  const metrics: Array<{ label: string; value: number }> = [
    { label: "需求", value: overview.requirementCount },
    { label: "未排期", value: overview.unscheduledCount },
    { label: "未绑 TB", value: overview.unboundTbCount },
    { label: "无负责人", value: overview.ownerlessCount },
    { label: "可运行节点", value: overview.readyNodeCount },
    { label: "等待节点", value: overview.waitingNodeCount },
  ]

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {overview.projectName} · 概览
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
          {metrics.map((metric) => (
            <div key={metric.label} className="rounded-lg border bg-muted/20 p-3">
              <div className="text-2xl font-semibold">{metric.value}</div>
              <div className="text-xs text-muted-foreground">{metric.label}</div>
            </div>
          ))}
        </div>

        <div>
          <h4 className="mb-1 font-medium">里程碑</h4>
          <p className="text-sm text-muted-foreground">
            计划中 {overview.milestonePlanned} · 已达成 {overview.milestoneReached} · 逾期{" "}
            {overview.milestoneOverdue}
          </p>
        </div>

        <div>
          <h4 className="mb-1 font-medium">Heinrich</h4>
          <p className="text-sm text-muted-foreground">
            Major {overview.heinrich.major} · Minor {overview.heinrich.minor} · Trivial{" "}
            {overview.heinrich.trivial}
          </p>
        </div>

        <div>
          <h4 className="mb-2 font-medium">阶段分布</h4>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>阶段</TableHead>
                <TableHead>需求数</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {overview.byPhase.map((item) => (
                <TableRow key={item.phase}>
                  <TableCell>{phaseLabel(item.phase)}</TableCell>
                  <TableCell>{item.count}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  )
}
