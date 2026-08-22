import type { ReactNode } from "react"

import { cn } from "@/lib/utils"

export function AppShell({
  header,
  children,
  className,
}: {
  header: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <div className={cn("flex h-dvh min-h-0 flex-col bg-background text-foreground", className)}>
      {header}
      <div className="min-h-0 flex-1 overflow-auto">{children}</div>
    </div>
  )
}
