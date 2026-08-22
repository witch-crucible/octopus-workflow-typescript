import { useEffect, useMemo, useState } from "react"
import { ThemeProvider } from "next-themes"

import { AppShell } from "@/components/layout/AppShell"
import { ConfirmHost } from "@/components/layout/ConfirmHost"
import { Header } from "@/components/layout/Header"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import {
  navigateHub,
  navigateProject,
  useHashRoute,
} from "@/hooks/useHashRoute"
import { confirmAction } from "@/lib/feedback"
import { applyTheme, preferredTheme, type UiTheme } from "@/lib/theme"
import { HubView } from "@/views/HubView"
import { MineView } from "@/views/MineView"
import { ProjectView } from "@/views/ProjectView"
import { WorkspaceView } from "@/views/WorkspaceView"

function chromeForRoute(view: "hub" | "mine" | "project" | "workspace"): {
  viewPulse: string
  subtitle: string
  projectLabel: string
  statusBadge: string
  statusTone: "good" | "bad" | "neutral"
  showBackToHub: boolean
  showBackToProject: boolean
  title: string
} {
  if (view === "mine") {
    return {
      viewPulse: "项目管理",
      subtitle: "统一管理状态库中的项目",
      projectLabel: "我的工作",
      statusBadge: "我的工作",
      statusTone: "neutral",
      showBackToHub: true,
      showBackToProject: false,
      title: "Octopus Workflow · 我的工作",
    }
  }
  if (view === "project") {
    return {
      viewPulse: "需求管理",
      subtitle: "看板 · 表格 · 甘特 · 设置",
      projectLabel: "项目",
      statusBadge: "项目工作台",
      statusTone: "neutral",
      showBackToHub: true,
      showBackToProject: false,
      title: "Octopus Workflow · 项目需求",
    }
  }
  if (view === "workspace") {
    return {
      viewPulse: "实时监控",
      subtitle: "软件交付工作流 · 角色泳道图",
      projectLabel: "需求工作区",
      statusBadge: "工作区",
      statusTone: "good",
      showBackToHub: true,
      showBackToProject: true,
      title: "Octopus Workflow · 需求工作区",
    }
  }
  return {
    viewPulse: "项目管理",
    subtitle: "统一管理状态库中的项目",
    projectLabel: "项目管理中心",
    statusBadge: "项目管理中心",
    statusTone: "neutral",
    showBackToHub: false,
    showBackToProject: false,
    title: "Octopus Workflow · 项目管理中心",
  }
}

export function App() {
  const route = useHashRoute()
  const [theme, setTheme] = useState<UiTheme>(() => preferredTheme())
  const [workspaceProjectId, setWorkspaceProjectId] = useState<string | undefined>()

  useEffect(() => {
    setTheme(applyTheme(preferredTheme()))
  }, [])

  useEffect(() => {
    window.OctopusConfirm = (message, title) => confirmAction(message, title ?? "请确认", "warning")
    return () => {
      delete window.OctopusConfirm
    }
  }, [])

  const chrome = useMemo(() => chromeForRoute(route.view), [route.view])

  useEffect(() => {
    document.title = chrome.title
  }, [chrome.title])

  useEffect(() => {
    if (route.view === "project") setWorkspaceProjectId(route.projectId)
  }, [route])

  function handleToggleTheme(): void {
    setTheme(applyTheme(theme === "dark" ? "light" : "dark"))
  }

  function handleBackToProject(): void {
    if (route.view === "project") {
      navigateProject(route.projectId)
      return
    }
    if (workspaceProjectId) {
      navigateProject(workspaceProjectId)
      return
    }
    navigateHub()
  }

  return (
    <ThemeProvider attribute="class" forcedTheme={theme} enableSystem={false}>
      <TooltipProvider>
        <AppShell
          header={
            <Header
              viewPulse={chrome.viewPulse}
              subtitle={chrome.subtitle}
              projectLabel={
                route.view === "project"
                  ? route.projectId
                  : route.view === "workspace"
                    ? route.requirementId
                    : chrome.projectLabel
              }
              statusBadge={chrome.statusBadge}
              statusTone={chrome.statusTone}
              showBackToHub={chrome.showBackToHub}
              showBackToProject={chrome.showBackToProject}
              onBackToHub={navigateHub}
              onBackToProject={handleBackToProject}
              onToggleTheme={handleToggleTheme}
              theme={theme}
            />
          }
        >
          {route.view === "hub" ? <HubView /> : null}
          {route.view === "mine" ? <MineView /> : null}
          {route.view === "project" ? (
            <ProjectView projectId={route.projectId} projectTab={route.projectTab} />
          ) : null}
          {route.view === "workspace" ? (
            <WorkspaceView
              requirementId={route.requirementId}
              onProjectKnown={setWorkspaceProjectId}
            />
          ) : null}
        </AppShell>
        <Toaster />
        <ConfirmHost />
      </TooltipProvider>
    </ThemeProvider>
  )
}
