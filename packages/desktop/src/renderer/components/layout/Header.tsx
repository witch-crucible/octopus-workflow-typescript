import { ChevronLeft, Moon, Sun } from "lucide-react"

import logo from "@/assets/logo.png"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import type { UiTheme } from "@/lib/theme"
import { cn } from "@/lib/utils"

export type StatusTone = "good" | "bad" | "neutral"

export type HeaderProps = {
  viewPulse: string
  subtitle: string
  projectLabel: string
  statusBadge: string
  statusTone: StatusTone
  showBackToHub: boolean
  showBackToProject: boolean
  onBackToHub: () => void
  onBackToProject: () => void
  onToggleTheme: () => void
  theme: UiTheme
}

function statusBadgeClass(tone: StatusTone): string {
  if (tone === "good") {
    return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
  }
  if (tone === "bad") {
    return "border-destructive/30 bg-destructive/10 text-destructive"
  }
  return "border-border bg-muted text-muted-foreground"
}

export function Header({
  viewPulse,
  subtitle,
  projectLabel,
  statusBadge,
  statusTone,
  showBackToHub,
  showBackToProject,
  onBackToHub,
  onBackToProject,
  onToggleTheme,
  theme,
}: HeaderProps) {
  const themeTitle = theme === "dark" ? "切换为白昼主题" : "切换为黑夜主题"

  return (
    <header className="flex h-[var(--header-h)] shrink-0 items-center justify-between gap-4 border-b border-border/80 bg-card px-4 shadow-[0_1px_2px_rgba(15,23,42,0.03)] md:px-5">
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-primary/8 ring-1 ring-primary/10">
          <img src={logo} alt="" width={36} height={36} className="size-9 object-contain" />
        </div>
        <div className="min-w-0">
          <h1 className="truncate text-sm font-semibold tracking-tight md:text-base">
            <span className="text-primary">Octopus</span> Workflow{" "}
            <span className="ml-1 text-xs font-medium text-muted-foreground">{viewPulse}</span>
          </h1>
          <div className="truncate text-[11px] text-muted-foreground md:text-xs">{subtitle}</div>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {showBackToHub ? (
          <Button type="button" variant="ghost" size="sm" onClick={onBackToHub}>
            <ChevronLeft />
            全部项目
          </Button>
        ) : null}
        {showBackToProject ? (
          <Button type="button" variant="ghost" size="sm" onClick={onBackToProject}>
            <ChevronLeft />
            返回项目
          </Button>
        ) : null}
        <span className="hidden max-w-48 truncate text-sm text-muted-foreground sm:inline">
          {projectLabel}
        </span>
        <Badge variant="outline" className={cn(statusBadgeClass(statusTone))}>
          {statusBadge}
        </Badge>
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          title={themeTitle}
          aria-label={themeTitle}
          aria-pressed={theme === "dark"}
          onClick={onToggleTheme}
        >
          {theme === "dark" ? <Sun /> : <Moon />}
        </Button>
      </div>
    </header>
  )
}
