import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react"

import type { GraphDisplayNode } from "@/lib/graph-model"
import { getWorkflowFocusNodeIds, nodeRoles } from "@/lib/graph-model"
import {
  ACCENT,
  nodeNameZh,
  PHASE_HINTS,
  PHASE_ORDER,
  phaseLabel,
  ROLE_COLORS,
  ROLE_ORDER,
  roleLabel,
  statusLabel,
  truncate,
} from "@/lib/labels"
import { cn } from "@/lib/utils"

export type WorkflowGraphSnapshot = {
  currentNodeIds?: readonly string[]
  readyNodeIds?: readonly string[]
  waitingNodeIds?: readonly string[]
}

export type WorkflowGraphProps = {
  nodes: readonly GraphDisplayNode[]
  snapshot: WorkflowGraphSnapshot
  selectedNodeId: string | null
  zoom: number
  currentPhase?: string
  onSelectNode: (nodeId: string) => void
  onOpenDirectory?: (nodeId: string) => void
  className?: string
}

type NodePosition = {
  x: number
  y: number
  w: number
  h: number
  roleColor: string
}

type GraphPan = {
  pointerId: number
  x: number
  y: number
  scrollLeft: number
  scrollTop: number
  moved: boolean
}

const NODE_W = 250
const NODE_H = 128
const NODE_GAP_Y = 18
const PHASE_HEADER_W = 156
const ROLE_HEADER_H = 72
const CELL_PAD_X = 20
const CELL_PAD_Y = 18
const MARGIN = 20

function wrapLabel(text: string, maxChars: number, maxLines = 2): string[] {
  const value = String(text || "")
  if (value.length <= maxChars) return [value]
  const lines: string[] = []
  let rest = value
  while (rest.length && lines.length < maxLines) {
    if (rest.length <= maxChars || lines.length === maxLines - 1) {
      lines.push(truncate(rest, maxChars))
      break
    }
    let cut = maxChars
    const slice = rest.slice(0, maxChars)
    const breakAt = Math.max(
      slice.lastIndexOf(" "),
      slice.lastIndexOf("，"),
      slice.lastIndexOf("、"),
      slice.lastIndexOf("/"),
    )
    if (breakAt >= Math.floor(maxChars * 0.45)) cut = breakAt + 1
    lines.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trim()
  }
  return lines
}

function nodeDisplayState(node: GraphDisplayNode, snapshot: WorkflowGraphSnapshot): string {
  if (node.activated === false || node.status === "LOCKED") return "locked"
  const classes: string[] = []
  if (snapshot.currentNodeIds?.includes(node.id)) classes.push("current")
  if (snapshot.readyNodeIds?.includes(node.id)) classes.push("ready")
  else if (snapshot.waitingNodeIds?.includes(node.id) && node.status === "PENDING") {
    classes.push("waiting")
  } else {
    classes.push(String(node.status || "PENDING").toLowerCase())
  }
  return classes.join(" ")
}

function isCurrentNode(nodeId: string, snapshot: WorkflowGraphSnapshot): boolean {
  return Boolean(snapshot.currentNodeIds?.includes(nodeId))
}

function edgePath(source: NodePosition, target: NodePosition): string {
  const sameCol = Math.abs(source.x - target.x) < 4
  if (sameCol) {
    const downward = target.y >= source.y
    const x = source.x + source.w / 2
    const sourceY = downward ? source.y + source.h : source.y
    const targetY = downward ? target.y : target.y + target.h
    const bend = Math.max(28, Math.abs(targetY - sourceY) * 0.4)
    return `M ${x} ${sourceY} C ${x} ${sourceY + (downward ? bend : -bend)}, ${x} ${targetY + (downward ? -bend : bend)}, ${x} ${targetY}`
  }
  const rightward = target.x > source.x
  const sourceX = rightward ? source.x + source.w : source.x
  const targetX = rightward ? target.x : target.x + target.w
  const sourceY = source.y + source.h / 2
  const targetY = target.y + target.h / 2
  const bend = Math.max(36, Math.min(96, Math.abs(targetX - sourceX) * 0.35))
  return `M ${sourceX} ${sourceY} C ${sourceX + (rightward ? bend : -bend)} ${sourceY}, ${targetX + (rightward ? -bend : bend)} ${targetY}, ${targetX} ${targetY}`
}

export function WorkflowGraph({
  nodes,
  snapshot,
  selectedNodeId,
  zoom,
  currentPhase,
  onSelectNode,
  onOpenDirectory,
  className,
}: WorkflowGraphProps) {
  const reactId = useId().replace(/:/g, "")
  const arrowId = `arrow-${reactId}`
  const arrowActiveId = `arrow-active-${reactId}`
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const panRef = useRef<GraphPan | null>(null)
  const [isPanning, setIsPanning] = useState(false)
  const [isCentered, setIsCentered] = useState(false)
  const focusNodeIds = useMemo(() => getWorkflowFocusNodeIds(nodes, snapshot), [nodes, snapshot])

  const layout = useMemo(() => {
    if (!nodes.length) {
      return {
        width: 960,
        height: 280,
        roles: [] as string[],
        phases: [] as string[],
        roleBounds: [] as Array<{ role: string; x: number; width: number; color: string }>,
        phaseBounds: [] as Array<{ phase: string; y: number; height: number; isCurrent: boolean }>,
        positions: new Map<string, NodePosition>(),
        currentRoleSet: new Set<string>(),
        originX: MARGIN,
        originY: MARGIN,
      }
    }

    const presentRoles = new Set(nodes.flatMap((node) => nodeRoles(node)))
    const roles = [
      ...ROLE_ORDER.filter((role) => presentRoles.has(role)),
      ...[...presentRoles]
        .filter((role) => !(ROLE_ORDER as readonly string[]).includes(role))
        .sort(),
    ]
    const presentPhases = new Set(nodes.map((node) => node.phase || "Intention"))
    const phases = [
      ...PHASE_ORDER.filter((phase) => presentPhases.has(phase)),
      ...[...presentPhases].filter((phase) => !(PHASE_ORDER as readonly string[]).includes(phase)),
    ]

    const cellMap = new Map<string, GraphDisplayNode[]>()
    for (const node of nodes) {
      const key = `${node.phase || "Intention"}::${node.responsibleRole || "DEV"}`
      const list = cellMap.get(key) || []
      list.push(node)
      cellMap.set(key, list)
    }
    for (const list of cellMap.values()) {
      list.sort((a, b) => String(a.id).localeCompare(String(b.id)))
    }

    const roleColW = CELL_PAD_X * 2 + NODE_W
    const phaseHeights = phases.map((phase) => {
      const maxInRole = Math.max(
        1,
        ...roles.map((role) => (cellMap.get(`${phase}::${role}`) || []).length),
      )
      return CELL_PAD_Y * 2 + maxInRole * NODE_H + Math.max(0, maxInRole - 1) * NODE_GAP_Y
    })

    const width = MARGIN * 2 + PHASE_HEADER_W + roles.length * roleColW
    const height = MARGIN * 2 + ROLE_HEADER_H + phaseHeights.reduce((sum, h) => sum + h, 0)
    const originX = MARGIN
    const originY = MARGIN

    const currentRoleSet = new Set(
      nodes
        .filter(
          (node) =>
            isCurrentNode(node.id, snapshot) || Boolean(snapshot.readyNodeIds?.includes(node.id)),
        )
        .flatMap((node) => nodeRoles(node)),
    )

    const roleBounds = roles.map((role, index) => {
      const x = originX + PHASE_HEADER_W + index * roleColW
      const color = ROLE_COLORS[role as keyof typeof ROLE_COLORS] || "#64748b"
      return { role, x, width: roleColW, color }
    })

    const phaseBounds: Array<{ phase: string; y: number; height: number; isCurrent: boolean }> = []
    let phaseY = originY + ROLE_HEADER_H
    phases.forEach((phase, phaseIndex) => {
      const h = phaseHeights[phaseIndex] ?? NODE_H
      phaseBounds.push({
        phase,
        y: phaseY,
        height: h,
        isCurrent: phase === currentPhase,
      })
      phaseY += h
    })

    const positions = new Map<string, NodePosition>()
    for (const phaseBound of phaseBounds) {
      for (const roleBound of roleBounds) {
        const list = cellMap.get(`${phaseBound.phase}::${roleBound.role}`) || []
        list.forEach((node, index) => {
          positions.set(node.id, {
            x: roleBound.x + CELL_PAD_X,
            y: phaseBound.y + CELL_PAD_Y + index * (NODE_H + NODE_GAP_Y),
            w: NODE_W,
            h: NODE_H,
            roleColor: roleBound.color,
          })
        })
      }
    }

    return {
      width,
      height,
      roles,
      phases,
      roleBounds,
      phaseBounds,
      positions,
      currentRoleSet,
      originX,
      originY,
    }
  }, [nodes, snapshot, currentPhase])

  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap) return
    const padX = 16
    const padY = 28
    const centered =
      layout.width * zoom < wrap.clientWidth - padX ||
      layout.height * zoom < wrap.clientHeight - padY
    setIsCentered(centered)
  }, [layout.width, layout.height, zoom, nodes.length])

  const endPan = useCallback(() => {
    if (!panRef.current) return
    panRef.current = null
    setIsPanning(false)
  }, [])

  const canStartPan = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button === 1) return true
    if (event.button !== 0) return false
    const target = event.target
    if (!(target instanceof Element)) return true
    if (target.closest(".wf-node")) return false
    if (target.closest("button, a, input, textarea, select, label")) return false
    return true
  }, [])

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const wrap = wrapRef.current
      if (!wrap || !canStartPan(event)) return
      event.preventDefault()
      panRef.current = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        scrollLeft: wrap.scrollLeft,
        scrollTop: wrap.scrollTop,
        moved: false,
      }
      setIsPanning(true)
      wrap.setPointerCapture(event.pointerId)
    },
    [canStartPan],
  )

  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const wrap = wrapRef.current
    const pan = panRef.current
    if (!wrap || !pan || event.pointerId !== pan.pointerId) return
    const dx = event.clientX - pan.x
    const dy = event.clientY - pan.y
    if (!pan.moved && (Math.abs(dx) > 2 || Math.abs(dy) > 2)) pan.moved = true
    wrap.scrollLeft = pan.scrollLeft - dx
    wrap.scrollTop = pan.scrollTop - dy
    event.preventDefault()
  }, [])

  const onPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const pan = panRef.current
      if (!pan || event.pointerId !== pan.pointerId) return
      endPan()
    },
    [endPan],
  )

  const nameById = useMemo(() => {
    const map = new Map<string, string>()
    for (const node of nodes) map.set(node.id, nodeNameZh(node))
    return map
  }, [nodes])

  return (
    <div
      ref={wrapRef}
      className={cn(
        "wf-graph-wrap",
        isPanning && "is-panning",
        isCentered && "is-centered",
        className,
      )}
      title="拖拽空白处平移；Ctrl/⌘ + 滚轮缩放"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <div
        className="wf-graph-scaler"
        style={{
          transform: `scale(${zoom})`,
          width: layout.width ? `${Math.ceil(layout.width * zoom)}px` : "auto",
          height: layout.height ? `${Math.ceil(layout.height * zoom)}px` : "auto",
        }}
      >
        <svg
          className="wf-graph"
          width={layout.width}
          height={layout.height}
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          role="img"
          aria-label="工作流角色泳道图"
        >
          <defs>
            <marker
              id={arrowId}
              viewBox="0 0 12 12"
              refX="10"
              refY="6"
              markerWidth="9"
              markerHeight="9"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 12 6 L 0 12 z" fill="var(--edge, #c0c4cc)" />
            </marker>
            <marker
              id={arrowActiveId}
              viewBox="0 0 12 12"
              refX="10"
              refY="6"
              markerWidth="9"
              markerHeight="9"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 12 6 L 0 12 z" fill={ACCENT} />
            </marker>
          </defs>

          {!nodes.length ? (
            <text x={40} y={80} className="empty-graph-text">
              当前阶段暂无节点。推进阶段后会激活后续节点。
            </text>
          ) : (
            <>
              <rect
                x={layout.originX}
                y={layout.originY}
                width={PHASE_HEADER_W}
                height={ROLE_HEADER_H}
                className="phase-header"
              />
              <text
                x={(layout.originX ?? 0) + 16}
                y={(layout.originY ?? 0) + 30}
                className="corner-label"
              >
                角色（人）→
              </text>
              <text
                x={(layout.originX ?? 0) + 16}
                y={(layout.originY ?? 0) + 52}
                className="phase-sub"
              >
                阶段 ↓
              </text>

              {layout.roleBounds.map((roleBound) => {
                const isActiveRole = layout.currentRoleSet.has(roleBound.role)
                return (
                  <g key={`role-${roleBound.role}`}>
                    <rect
                      x={roleBound.x}
                      y={layout.originY}
                      width={roleBound.width}
                      height={ROLE_HEADER_H}
                      className={cn("role-header", isActiveRole && "current-role")}
                    />
                    <rect
                      x={roleBound.x}
                      y={layout.originY}
                      width={roleBound.width}
                      height={6}
                      fill={roleBound.color}
                    />
                    {isActiveRole ? (
                      <rect
                        x={roleBound.x}
                        y={(layout.originY ?? 0) + ROLE_HEADER_H - 3}
                        width={roleBound.width}
                        height={3}
                        fill={ACCENT}
                      />
                    ) : null}
                    <text
                      x={roleBound.x + 16}
                      y={(layout.originY ?? 0) + 34}
                      className="role-header-text"
                    >
                      {roleLabel(roleBound.role)}
                    </text>
                    <text
                      x={roleBound.x + 16}
                      y={(layout.originY ?? 0) + 54}
                      className="role-header-sub"
                    >
                      {isActiveRole ? `${roleBound.role} · 当前` : roleBound.role}
                    </text>
                  </g>
                )
              })}

              {layout.phaseBounds.map((phaseBound) => (
                <g key={`phase-${phaseBound.phase}`}>
                  {layout.roleBounds.map((roleBound, roleIndex) => (
                    <rect
                      key={`${phaseBound.phase}-${roleBound.role}`}
                      x={roleBound.x}
                      y={phaseBound.y}
                      width={roleBound.width}
                      height={phaseBound.height}
                      className={cn(
                        "lane-bg",
                        phaseBound.isCurrent ? "current" : roleIndex % 2 === 1 && "alt",
                      )}
                    />
                  ))}
                  <rect
                    x={layout.originX}
                    y={phaseBound.y}
                    width={PHASE_HEADER_W}
                    height={phaseBound.height}
                    className={cn("phase-header", phaseBound.isCurrent && "current")}
                  />
                  {phaseBound.isCurrent ? (
                    <rect
                      x={layout.originX}
                      y={phaseBound.y}
                      width={6}
                      height={phaseBound.height}
                      fill={ACCENT}
                    />
                  ) : null}
                  <text
                    x={(layout.originX ?? 0) + 18}
                    y={phaseBound.y + 28}
                    className={cn("phase-label", phaseBound.isCurrent && "current")}
                  >
                    {phaseLabel(phaseBound.phase)}
                  </text>
                  <text
                    x={(layout.originX ?? 0) + 18}
                    y={phaseBound.y + 50}
                    className={cn("phase-sub", phaseBound.isCurrent && "current")}
                  >
                    {phaseBound.isCurrent
                      ? `当前 · ${PHASE_HINTS[phaseBound.phase as keyof typeof PHASE_HINTS] || phaseBound.phase}`
                      : PHASE_HINTS[phaseBound.phase as keyof typeof PHASE_HINTS] ||
                        phaseBound.phase}
                  </text>
                  {phaseBound.isCurrent ? (
                    <>
                      <text
                        x={(layout.originX ?? 0) + 18}
                        y={phaseBound.y + 72}
                        className="current-badge-text"
                      >
                        ● 进行中
                      </text>
                      <rect
                        x={(layout.originX ?? 0) + 2}
                        y={phaseBound.y + 2}
                        width={layout.width - MARGIN * 2 - 4}
                        height={phaseBound.height - 4}
                        rx={8}
                        className="current-row-stroke"
                      />
                    </>
                  ) : null}
                </g>
              ))}

              {layout.roleBounds.map((bound, index) =>
                index === 0 ? null : (
                  <line
                    key={`role-div-${bound.role}`}
                    x1={bound.x}
                    y1={layout.originY}
                    x2={bound.x}
                    y2={layout.height - MARGIN}
                    className="role-divider"
                  />
                ),
              )}
              {layout.phaseBounds.map((bound, index) =>
                index === 0 ? null : (
                  <line
                    key={`phase-div-${bound.phase}`}
                    x1={layout.originX}
                    y1={bound.y}
                    x2={layout.width - MARGIN}
                    y2={bound.y}
                    className="lane-divider"
                  />
                ),
              )}

              <g className="edges">
                {nodes.map((node) => {
                  const target = layout.positions.get(node.id)
                  if (!target) return null
                  return (node.dependsOn || []).map((dep) => {
                    const source = layout.positions.get(dep)
                    if (!source) return null
                    const active =
                      isCurrentNode(node.id, snapshot) ||
                      Boolean(snapshot.readyNodeIds?.includes(node.id))
                    return (
                      <path
                        key={`${dep}->${node.id}`}
                        d={edgePath(source, target)}
                        className={cn("edge", active && "active")}
                        markerEnd={active ? `url(#${arrowActiveId})` : `url(#${arrowId})`}
                      >
                        <title>{`${nameById.get(dep) || dep} → ${nameById.get(node.id) || node.id}`}</title>
                      </path>
                    )
                  })
                })}
              </g>

              {nodes.map((node) => {
                const pos = layout.positions.get(node.id)
                if (!pos) return null
                const current = isCurrentNode(node.id, snapshot)
                const ready = Boolean(snapshot.readyNodeIds?.includes(node.id))
                const isFocused = focusNodeIds.has(node.id)
                const isCollapsed = !isFocused
                const roles = nodeRoles(node)
                const zhName = nodeNameZh(node)
                const showEnglish = Boolean(node.name && node.name !== zhName)
                const titleLines = wrapLabel(zhName, 11, 2)
                const titleStartY = current ? 42 : 44
                let cursorY = titleStartY + titleLines.length * 20
                if (showEnglish) cursorY += 18
                else cursorY += 4

                let stateText = statusLabel(node.status)
                if (current && ready) stateText = "当前 · 可运行"
                else if (current) stateText = "当前节点"
                else if (ready) stateText = "可运行"

                const roleSummary = roles.join(" / ")
                const displayState = nodeDisplayState(node, snapshot)

                return (
                  <g
                    key={node.id}
                    className={cn(
                      "wf-node node",
                      displayState,
                      isCollapsed && "is-collapsed",
                      selectedNodeId === node.id && "selected",
                    )}
                    transform={`translate(${pos.x},${pos.y})`}
                    data-node-id={node.id}
                    role="button"
                    tabIndex={0}
                    aria-label={`${zhName}${showEnglish ? `（${node.name}）` : ""}，参与角色：${roles.map((r) => roleLabel(r)).join("、")}，${statusLabel(node.status)}${current ? "，当前" : ""}`}
                    onClick={(event) => {
                      if (event.ctrlKey || event.metaKey) {
                        event.preventDefault()
                        event.stopPropagation()
                        onOpenDirectory?.(node.id)
                        return
                      }
                      onSelectNode(node.id)
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault()
                        onSelectNode(node.id)
                      }
                    }}
                  >
                    <title>
                      {isCollapsed
                        ? "已折叠；单击查看详情"
                        : "单击查看详情；Ctrl/⌘+单击打开脚本目录"}
                    </title>
                    {current ? (
                      <rect
                        x={-6}
                        y={-6}
                        width={pos.w + 12}
                        height={pos.h + 12}
                        rx={14}
                        className="current-ring"
                      />
                    ) : null}
                    <rect x={0} y={0} width={pos.w} height={pos.h} rx={8} className="card" />
                    <path
                      d={`M 12 0 H 8 Q 0 0 0 8 V ${pos.h - 8} Q 0 ${pos.h} 8 ${pos.h} H 12 Z`}
                      fill={pos.roleColor}
                      className="role-bar"
                    />
                    {isCollapsed ? (
                      <>
                        <text x={22} y={52} className="collapsed-label">
                          {truncate(zhName, 15)}
                        </text>
                        <text x={22} y={76} className="collapsed-meta">
                          {truncate(`${stateText} · ${roleSummary}`, 25)}
                        </text>
                        <text x={pos.w - 34} y={22} className="collapsed-mark">
                          ···
                        </text>
                      </>
                    ) : current ? (
                      <>
                        <text x={22} y={20} className="current-tag">
                          ● 当前
                        </text>
                        <text x={78} y={20} className="id">
                          {truncate(node.id, 16)}
                        </text>
                      </>
                    ) : (
                      <text x={22} y={22} className="id">
                        {truncate(node.id, 24)}
                      </text>
                    )}
                    {!isCollapsed &&
                      titleLines.map((line, index) => (
                        <text
                          key={`${node.id}-title-${index}`}
                          x={22}
                          y={titleStartY + index * 20}
                          className="name-zh"
                        >
                          {line}
                        </text>
                      ))}
                    {!isCollapsed && showEnglish ? (
                      <text x={22} y={titleStartY + titleLines.length * 20 + 2} className="name-en">
                        {truncate(node.name, 28)}
                      </text>
                    ) : null}
                    {!isCollapsed ? (
                      <text x={22} y={Math.min(cursorY + 14, pos.h - 12)} className="meta">
                        {truncate(`${stateText} · ${roleSummary}`, 30)}
                      </text>
                    ) : null}
                    {!isCollapsed && roles.length > 1
                      ? roles.map((role, index) => {
                          const startX = pos.w - 18 - (roles.length - 1) * 13
                          return (
                            <circle
                              key={`${node.id}-dot-${role}`}
                              cx={startX + index * 13}
                              cy={pos.h - 12}
                              r={4}
                              fill={ROLE_COLORS[role as keyof typeof ROLE_COLORS] || "#909399"}
                              className="participant-dot"
                            />
                          )
                        })
                      : null}
                  </g>
                )
              })}
            </>
          )}
        </svg>
      </div>
    </div>
  )
}
