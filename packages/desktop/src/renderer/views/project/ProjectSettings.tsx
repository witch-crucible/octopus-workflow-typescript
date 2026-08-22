import { useEffect, useMemo, useState } from "react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { collectBrdPromptPatch, type BrdPromptDraft } from "@/lib/brd"
import { showError, showSuccess, showWarning } from "@/lib/feedback"
import { ACCENT, BRD_PROMPT_IDS, BRD_PROMPT_META } from "@/lib/labels"
import {
  getOctopus,
  type BrdConfig,
  type Project,
  type RequirementSummary,
  type TbStatus,
} from "@/lib/octopus"
import { cn } from "@/lib/utils"

type TeambitionBinding = {
  projectId?: string
  name?: string
  uniqueIdPrefix?: string
}

type VersionRepoBinding = {
  repoId?: string
  pluginId?: string
  tbProjectId?: string
  name?: string
}

type BrdSources = {
  miniprogramCodePath: string
  websiteCodePath: string
  frontendCodePath: string
  backendCodePath: string
  miniprogramBuildArtifact: string
  websiteUrl: string
}

type PromptPreviewItem = {
  id: string
  system?: string
  prompt?: string
}

export type ProjectSettingsProps = {
  projectId: string
  project: Project
  requirements: RequirementSummary[]
  onProjectChange: (project: Project) => void
}

function projectMeta(project: Project): Record<string, string> {
  const meta = project.metadata
  return meta && typeof meta === "object" ? (meta as Record<string, string>) : {}
}

export function ProjectSettings({
  projectId,
  project,
  requirements,
  onProjectChange,
}: ProjectSettingsProps) {
  const binding = project.teambition as TeambitionBinding | undefined
  const versionBinding = project.teambitionVersion as VersionRepoBinding | undefined
  const meta = projectMeta(project)

  const [tbProjectId, setTbProjectId] = useState(binding?.projectId || "")
  const [tbPrefix, setTbPrefix] = useState(binding?.uniqueIdPrefix || "")
  const [versionRepoId, setVersionRepoId] = useState(versionBinding?.repoId || "")
  const [versionPluginId, setVersionPluginId] = useState(versionBinding?.pluginId || "")
  const [versionTbProjectId, setVersionTbProjectId] = useState(versionBinding?.tbProjectId || "")
  const [omniplanFolder, setOmniplanFolder] = useState(meta.omniplanFolder || "")
  const [omniplanFileName, setOmniplanFileName] = useState(meta.omniplanFileName || "")
  const [defaultColor, setDefaultColor] = useState(meta.defaultColor || ACCENT)
  const [tbStatuses, setTbStatuses] = useState<TbStatus[]>([])
  const [showStatuses, setShowStatuses] = useState(false)

  const [brdSources, setBrdSources] = useState<BrdSources>({
    miniprogramCodePath: "",
    websiteCodePath: "",
    frontendCodePath: "",
    backendCodePath: "",
    miniprogramBuildArtifact: "",
    websiteUrl: "",
  })
  const [brdSpecPath, setBrdSpecPath] = useState("")
  const [brdOutputPath, setBrdOutputPath] = useState("")
  const [brdPromptConfig, setBrdPromptConfig] = useState<Record<string, BrdPromptDraft>>({})
  const [brdPromptDrafts, setBrdPromptDrafts] = useState<Record<string, BrdPromptDraft | undefined>>({})
  const [brdPromptClearIds, setBrdPromptClearIds] = useState<string[]>([])
  const [activePromptId, setActivePromptId] =
    useState<(typeof BRD_PROMPT_IDS)[number]>("generate")
  const [previewRequirementId, setPreviewRequirementId] = useState(
    requirements[0]?.requirementId || "",
  )
  const [promptPreview, setPromptPreview] = useState<{
    outputPath?: string
    warnings?: string[]
    prompts: PromptPreviewItem[]
  } | null>(null)

  useEffect(() => {
    setTbProjectId(binding?.projectId || "")
    setTbPrefix(binding?.uniqueIdPrefix || "")
    setVersionRepoId(versionBinding?.repoId || "")
    setVersionPluginId(versionBinding?.pluginId || "")
    setVersionTbProjectId(versionBinding?.tbProjectId || "")
    setOmniplanFolder(meta.omniplanFolder || "")
    setOmniplanFileName(meta.omniplanFileName || "")
    setDefaultColor(meta.defaultColor || ACCENT)
  }, [project])

  useEffect(() => {
    if (!requirements.some((item) => item.requirementId === previewRequirementId)) {
      setPreviewRequirementId(requirements[0]?.requirementId || "")
    }
  }, [requirements, previewRequirementId])

  useEffect(() => {
    const api = getOctopus()
    const loadBrd = api.getProjectBrdDesignConfig
    if (!loadBrd) return
    void (async () => {
      try {
        const config = (await loadBrd(projectId)) as BrdConfig & {
          sources?: Partial<BrdSources>
          brdSpecPath?: string
          brdOutputPath?: string
        }
        const sources = config.sources || {}
        setBrdSources({
          miniprogramCodePath: sources.miniprogramCodePath || "",
          websiteCodePath: sources.websiteCodePath || "",
          frontendCodePath: sources.frontendCodePath || "",
          backendCodePath: sources.backendCodePath || "",
          miniprogramBuildArtifact: sources.miniprogramBuildArtifact || "",
          websiteUrl: sources.websiteUrl || "",
        })
        setBrdSpecPath(config.brdSpecPath || "")
        setBrdOutputPath(config.brdOutputPath || "")
        const prompts: Record<string, BrdPromptDraft> = {}
        for (const [id, value] of Object.entries(config.prompts || {})) {
          if (value && typeof value === "object") {
            prompts[id] = {
              system: value.system || "",
              user: value.user || "",
            }
          }
        }
        setBrdPromptConfig(prompts)
        setBrdPromptDrafts({})
        setBrdPromptClearIds([])
        setPromptPreview(null)
      } catch (error) {
        showError(error)
      }
    })()
  }, [projectId])

  const promptValue = (id: string): BrdPromptDraft => {
    if (brdPromptClearIds.includes(id)) return { system: "", user: "" }
    return brdPromptDrafts[id] || brdPromptConfig[id] || { system: "", user: "" }
  }

  const activePrompt = promptValue(activePromptId)
  const promptState = useMemo(() => {
    if (brdPromptClearIds.includes(activePromptId)) {
      return { text: "保存后使用默认", tone: "warn" as const }
    }
    if (brdPromptDrafts[activePromptId]) {
      return { text: "有未保存修改", tone: "warn" as const }
    }
    if (brdPromptConfig[activePromptId]) {
      return { text: "已自定义", tone: "info" as const }
    }
    return { text: "使用内置默认", tone: "default" as const }
  }, [activePromptId, brdPromptClearIds, brdPromptConfig, brdPromptDrafts])

  const updateActivePrompt = (patch: Partial<BrdPromptDraft>) => {
    setBrdPromptClearIds((prev) => prev.filter((id) => id !== activePromptId))
    const base = brdPromptConfig[activePromptId] || { system: "", user: "" }
    const next = {
      system: patch.system ?? activePrompt.system,
      user: patch.user ?? activePrompt.user,
    }
    setBrdPromptDrafts((prev) => {
      if (next.system === base.system && next.user === base.user) {
        const copy = { ...prev }
        delete copy[activePromptId]
        return copy
      }
      return { ...prev, [activePromptId]: next }
    })
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Teambition 版本仓库</CardTitle>
          <p className="text-sm text-muted-foreground">
            版本端点未确认时会显示明确的不可用状态，不会伪造空列表。
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-1.5">
            <Label htmlFor="settingsVersionRepoId">仓库 ID</Label>
            <Input
              id="settingsVersionRepoId"
              value={versionRepoId}
              placeholder="repoId"
              onChange={(event) => setVersionRepoId(event.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="settingsVersionPluginId">插件 ID（可选）</Label>
            <Input
              id="settingsVersionPluginId"
              value={versionPluginId}
              onChange={(event) => setVersionPluginId(event.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="settingsVersionTbProjectId">TB 项目 ID（可选）</Label>
            <Input
              id="settingsVersionTbProjectId"
              value={versionTbProjectId}
              onChange={(event) => setVersionTbProjectId(event.target.value)}
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              onClick={() => {
                const bindRepo = getOctopus().bindProjectTeambitionRepo
                if (!bindRepo) {
                  showWarning("当前运行时不支持绑定版本仓库")
                  return
                }
                const repoId = versionRepoId.trim()
                if (!repoId) {
                  showWarning("请填写版本仓库 ID")
                  return
                }
                void (async () => {
                  try {
                    const next = await bindRepo(projectId, {
                      repoId,
                      ...(versionPluginId.trim() ? { pluginId: versionPluginId.trim() } : {}),
                      ...(versionTbProjectId.trim()
                        ? { tbProjectId: versionTbProjectId.trim() }
                        : {}),
                    })
                    onProjectChange(next)
                    showSuccess("版本仓库已绑定")
                  } catch (error) {
                    showError(error)
                  }
                })()
              }}
            >
              绑定版本仓库
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                const unbindRepo = getOctopus().unbindProjectTeambitionRepo
                if (!unbindRepo) {
                  showWarning("当前运行时不支持解绑版本仓库")
                  return
                }
                void (async () => {
                  try {
                    const next = await unbindRepo(projectId)
                    onProjectChange(next)
                    showSuccess("版本仓库绑定已解除")
                  } catch (error) {
                    showError(error)
                  }
                })()
              }}
            >
              解绑
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Teambition 绑定</CardTitle>
          <p className="text-sm text-muted-foreground">
            填写 Teambition 项目 ID，或用任务编号前缀解析。未配置凭据时会显示可读错误。
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-1.5">
            <Label htmlFor="settingsTbProjectId">Teambition 项目 ID</Label>
            <Input
              id="settingsTbProjectId"
              value={tbProjectId}
              placeholder="可选"
              onChange={(event) => setTbProjectId(event.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="settingsTbPrefix">前缀（prefix）</Label>
            <Input
              id="settingsTbPrefix"
              value={tbPrefix}
              placeholder="例如：ACME"
              onChange={(event) => setTbPrefix(event.target.value)}
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              onClick={() => {
                void (async () => {
                  try {
                    const next = await getOctopus().bindProjectTeambition(projectId, {
                      ...(tbProjectId.trim() ? { projectId: tbProjectId.trim() } : {}),
                      ...(tbPrefix.trim() ? { prefix: tbPrefix.trim() } : {}),
                    })
                    onProjectChange(next)
                    setTbStatuses([])
                    setShowStatuses(false)
                    showSuccess("已绑定 Teambition 项目")
                  } catch (error) {
                    showError(error)
                  }
                })()
              }}
            >
              绑定
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                void (async () => {
                  try {
                    const next = await getOctopus().unbindProjectTeambition(projectId)
                    onProjectChange(next)
                    setTbStatuses([])
                    setShowStatuses(false)
                    showSuccess("已解除 Teambition 项目绑定")
                  } catch (error) {
                    showError(error)
                  }
                })()
              }}
            >
              解绑
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                void (async () => {
                  try {
                    const list = await getOctopus().listTeambitionCardStatuses(projectId)
                    setTbStatuses(list)
                    setShowStatuses(true)
                    showSuccess(`已加载 ${list.length} 个卡片状态`)
                  } catch (error) {
                    showError(error)
                  }
                })()
              }}
            >
              查看卡片状态
            </Button>
          </div>
          <p className="text-sm text-muted-foreground">
            {binding?.projectId
              ? `已绑定：${binding.name || binding.projectId}`
              : "尚未绑定 Teambition 项目"}
          </p>
          {showStatuses ? (
            <div className="rounded-md border p-3 text-sm">
              {tbStatuses.length ? (
                tbStatuses.map((item) => {
                  const id = String(item.id || item.statusId || "")
                  return (
                    <div key={id}>
                      {item.name || item.statusName || id}{" "}
                      <span className="text-muted-foreground">{id}</span>
                    </div>
                  )
                })
              ) : (
                <div className="text-muted-foreground">暂无卡片状态</div>
              )}
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>OmniPlan</CardTitle>
          <p className="text-sm text-muted-foreground">
            OmniPlan 文件夹名用于导出/导入甘特图。根目录来自配置。
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-1.5">
            <Label htmlFor="settingsOmniplanFolder">文件夹名</Label>
            <Input
              id="settingsOmniplanFolder"
              value={omniplanFolder}
              placeholder="例如：cdc-dior"
              onChange={(event) => setOmniplanFolder(event.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="settingsOmniplanFileName">目标文件名（可选）</Label>
            <Input
              id="settingsOmniplanFileName"
              value={omniplanFileName}
              placeholder="默认使用项目名"
              onChange={(event) => setOmniplanFileName(event.target.value)}
            />
          </div>
          <Button
            type="button"
            onClick={() => {
              const api = getOctopus()
              const saveOmni = api.setProjectOmniPlanMeta
              if (!saveOmni) {
                showWarning("当前运行时不支持 OmniPlan 设置")
                return
              }
              void (async () => {
                try {
                  await saveOmni(projectId, {
                    ...(omniplanFolder.trim() ? { omniplanFolder: omniplanFolder.trim() } : {}),
                    ...(omniplanFileName.trim()
                      ? { omniplanFileName: omniplanFileName.trim() }
                      : {}),
                  })
                  const next = await api.getProject(projectId)
                  onProjectChange(next)
                  showSuccess("OmniPlan 设置已保存")
                } catch (error) {
                  showError(error)
                }
              })()
            }}
          >
            保存 OmniPlan 设置
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>默认颜色</CardTitle>
          <p className="text-sm text-muted-foreground">
            项目级默认颜色，暂用于后续扩展；未设置时不影响现有界面。
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-1.5">
            <Label htmlFor="settingsDefaultColor">默认颜色</Label>
            <Input
              id="settingsDefaultColor"
              type="color"
              value={defaultColor}
              onChange={(event) => setDefaultColor(event.target.value)}
              className="h-10 w-24 p-1"
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              onClick={() => {
                void (async () => {
                  try {
                    const next = await getOctopus().setProjectDefaultColor(projectId, defaultColor)
                    onProjectChange(next)
                    showSuccess("默认颜色已保存")
                  } catch (error) {
                    showError(error)
                  }
                })()
              }}
            >
              保存默认颜色
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                void (async () => {
                  try {
                    const next = await getOctopus().setProjectDefaultColor(projectId, null)
                    onProjectChange(next)
                    setDefaultColor(ACCENT)
                    showSuccess("已清除默认颜色")
                  } catch (error) {
                    showError(error)
                  }
                })()
              }}
            >
              清除
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>BRD 设计</CardTitle>
          <p className="text-sm text-muted-foreground">
            按项目配置小程序/官网/前后端代码与展示信息，供 AI 生成或检查 BRD。提示词可用 CLI{" "}
            <code>octopus brd prompt-set</code> 覆盖。
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          {(
            [
              ["brdMiniprogram", "小程序代码路径", "miniprogramCodePath", "相对项目根或绝对路径"],
              ["brdWebsiteCode", "官网代码路径", "websiteCodePath", ""],
              ["brdFrontend", "前端代码路径", "frontendCodePath", ""],
              ["brdBackend", "后端代码路径", "backendCodePath", ""],
              ["brdMiniArtifact", "小程序编译产物", "miniprogramBuildArtifact", ""],
              ["brdWebsiteUrl", "官网展示域名", "websiteUrl", "https://..."],
            ] as const
          ).map(([id, label, key, placeholder]) => (
            <div key={id} className="grid gap-1.5">
              <Label htmlFor={id}>{label}</Label>
              <Input
                id={id}
                value={brdSources[key]}
                placeholder={placeholder || undefined}
                onChange={(event) =>
                  setBrdSources((prev) => ({ ...prev, [key]: event.target.value }))
                }
              />
            </div>
          ))}
          <div className="grid gap-1.5">
            <Label htmlFor="brdSpecPath">BRD 规范路径</Label>
            <Input
              id="brdSpecPath"
              value={brdSpecPath}
              onChange={(event) => setBrdSpecPath(event.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="brdOutputPath">BRD 产出路径</Label>
            <Input
              id="brdOutputPath"
              value={brdOutputPath}
              placeholder="默认节点目录 brd.md"
              onChange={(event) => setBrdOutputPath(event.target.value)}
            />
          </div>

          <div className="rounded-lg border p-4">
            <div className="mb-3">
              <h4 className="font-medium">提示词编辑</h4>
              <p className="text-xs text-muted-foreground">3 类模板</p>
            </div>
            <p className="mb-3 text-sm text-muted-foreground">
              项目只保存自定义内容；未自定义的类型继续使用内置默认提示词。模板支持{" "}
              <code>{"{{requirementName}}"}</code>、<code>{"{{sourcesSummary}}"}</code> 等变量。
            </p>
            <Tabs
              value={activePromptId}
              onValueChange={(value) =>
                setActivePromptId(value as (typeof BRD_PROMPT_IDS)[number])
              }
            >
              <TabsList>
                {BRD_PROMPT_IDS.map((id) => (
                  <TabsTrigger
                    key={id}
                    value={id}
                    className={cn(
                      brdPromptConfig[id] && !brdPromptClearIds.includes(id) && "font-semibold",
                      (brdPromptDrafts[id] || brdPromptClearIds.includes(id)) && "underline",
                    )}
                  >
                    {BRD_PROMPT_META[id].name}
                  </TabsTrigger>
                ))}
              </TabsList>
              {BRD_PROMPT_IDS.map((id) => (
                <TabsContent key={id} value={id} className="space-y-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <h4 className="font-medium">{BRD_PROMPT_META[id].name}</h4>
                      <p className="text-sm text-muted-foreground">
                        {BRD_PROMPT_META[id].description}
                      </p>
                    </div>
                    <Badge variant={promptState.tone === "default" ? "secondary" : "outline"}>
                      {promptState.text}
                    </Badge>
                  </div>
                  <div className="grid gap-1.5">
                    <div className="flex items-center justify-between">
                      <Label htmlFor={`brdPromptSystem-${id}`}>
                        系统提示词 <code>system</code>
                      </Label>
                      <span className="text-xs text-muted-foreground">
                        {promptValue(id).system.length} 字
                      </span>
                    </div>
                    <Textarea
                      id={`brdPromptSystem-${id}`}
                      rows={7}
                      spellCheck={false}
                      placeholder="未自定义，运行时使用内置 system 提示词"
                      value={promptValue(id).system}
                      onChange={(event) => updateActivePrompt({ system: event.target.value })}
                    />
                  </div>
                  <div className="grid gap-1.5">
                    <div className="flex items-center justify-between">
                      <Label htmlFor={`brdPromptUser-${id}`}>
                        用户提示词 <code>user</code>
                      </Label>
                      <span className="text-xs text-muted-foreground">
                        {promptValue(id).user.length} 字
                      </span>
                    </div>
                    <Textarea
                      id={`brdPromptUser-${id}`}
                      rows={7}
                      spellCheck={false}
                      placeholder="未自定义，运行时使用内置 user 提示词"
                      value={promptValue(id).user}
                      onChange={(event) => updateActivePrompt({ user: event.target.value })}
                    />
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-xs text-muted-foreground">
                      system 与 user 需同时填写；切换类型不会丢失未保存内容。
                    </span>
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => {
                        setBrdPromptDrafts((prev) => {
                          const copy = { ...prev }
                          delete copy[activePromptId]
                          return copy
                        })
                        setBrdPromptClearIds((prev) =>
                          brdPromptConfig[activePromptId]
                            ? prev.includes(activePromptId)
                              ? prev
                              : [...prev, activePromptId]
                            : prev.filter((entry) => entry !== activePromptId),
                        )
                      }}
                    >
                      恢复内置默认
                    </Button>
                  </div>
                </TabsContent>
              ))}
            </Tabs>
          </div>

          <div className="flex flex-wrap items-end gap-3">
            <div className="grid gap-1.5">
              <Label>预览需求</Label>
              <Select
                value={previewRequirementId || "__none__"}
                onValueChange={(value) =>
                  setPreviewRequirementId(value === "__none__" ? "" : value)
                }
              >
                <SelectTrigger className="w-[220px]">
                  <SelectValue placeholder="暂无需求" />
                </SelectTrigger>
                <SelectContent>
                  {requirements.length === 0 ? (
                    <SelectItem value="__none__">暂无需求</SelectItem>
                  ) : (
                    requirements.map((item) => (
                      <SelectItem key={item.requirementId} value={item.requirementId}>
                        {item.requirementName || item.requirementId}
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
            </div>
            <Button
              type="button"
              onClick={() => {
                const api = getOctopus()
                const saveBrd = api.setProjectBrdDesignConfig
                if (!saveBrd) {
                  showWarning("当前运行时不支持 BRD 设置")
                  return
                }
                void (async () => {
                  try {
                    const promptPatch = collectBrdPromptPatch(brdPromptDrafts, brdPromptClearIds)
                    if (promptPatch.invalid) {
                      const { id, hasSystem, hasUser } = promptPatch.invalid
                      setActivePromptId(id as (typeof BRD_PROMPT_IDS)[number])
                      showWarning(
                        hasSystem || hasUser
                          ? `${BRD_PROMPT_META[id as keyof typeof BRD_PROMPT_META].name}的 system 与 user 需同时填写`
                          : `${BRD_PROMPT_META[id as keyof typeof BRD_PROMPT_META].name}如需清空，请使用“恢复内置默认”`,
                      )
                      return
                    }
                    await saveBrd(projectId, {
                      sources: brdSources,
                      brdSpecPath,
                      brdOutputPath,
                      prompts: promptPatch.prompts,
                    })
                    const next = await api.getProject(projectId)
                    onProjectChange(next)
                    const loadBrd = api.getProjectBrdDesignConfig
                    if (loadBrd) {
                      const saved = (await loadBrd(projectId)) as BrdConfig
                      const prompts: Record<string, BrdPromptDraft> = {}
                      for (const [id, value] of Object.entries(saved.prompts || {})) {
                        if (value && typeof value === "object") {
                          prompts[id] = {
                            system: value.system || "",
                            user: value.user || "",
                          }
                        }
                      }
                      setBrdPromptConfig(prompts)
                    }
                    setBrdPromptDrafts({})
                    setBrdPromptClearIds([])
                    setPromptPreview(null)
                    showSuccess("BRD 设置已保存")
                  } catch (error) {
                    showError(error)
                  }
                })()
              }}
            >
              保存 BRD 设置
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={!requirements.length}
              onClick={() => {
                const previewBrd = getOctopus().previewBrdPrompts
                if (!previewBrd) {
                  showWarning("当前运行时不支持提示词预览")
                  return
                }
                if (!previewRequirementId) {
                  showWarning("请先在本项目下创建需求后再预览提示词")
                  return
                }
                void (async () => {
                  try {
                    const preview = (await previewBrd(projectId, previewRequirementId, {
                      mode: "all",
                      includeSummarize: true,
                    })) as {
                      outputPath?: string
                      warnings?: string[]
                      prompts: PromptPreviewItem[]
                    }
                    setPromptPreview(preview)
                    showSuccess(`已预览 ${preview.prompts.length} 条提示词`)
                  } catch (error) {
                    showError(error)
                  }
                })()
              }}
            >
              预览已保存提示词
            </Button>
          </div>

          {promptPreview ? (
            <section className="space-y-3 rounded-lg border p-4">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <h4 className="font-medium">已保存提示词预览</h4>
                  <p className="text-sm text-muted-foreground">
                    已渲染变量 · 产出路径：{promptPreview.outputPath || "未返回"}
                  </p>
                </div>
                <Badge variant="secondary">{promptPreview.prompts.length} 条</Badge>
              </div>
              {promptPreview.warnings?.length ? (
                <p className="text-sm text-amber-600">{promptPreview.warnings.join("；")}</p>
              ) : null}
              <div className="space-y-3">
                {promptPreview.prompts.map((item) => (
                  <article key={item.id} className="rounded-md border p-3">
                    <header className="mb-2 flex items-center gap-2">
                      <strong>
                        {BRD_PROMPT_META[item.id as keyof typeof BRD_PROMPT_META]?.name || item.id}
                      </strong>
                      <code className="text-xs">{item.id}</code>
                    </header>
                    {(
                      [
                        ["system", item.system],
                        ["user", item.prompt],
                      ] as const
                    ).map(([label, value]) => (
                      <div key={label} className="mb-2">
                        <span className="text-xs text-muted-foreground">{label}</span>
                        <pre className="mt-1 overflow-auto rounded bg-muted/40 p-2 text-xs whitespace-pre-wrap">
                          {value || ""}
                        </pre>
                      </div>
                    ))}
                  </article>
                ))}
              </div>
            </section>
          ) : null}
        </CardContent>
      </Card>
    </div>
  )
}
