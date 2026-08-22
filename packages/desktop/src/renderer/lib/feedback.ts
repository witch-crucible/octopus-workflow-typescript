import { toast } from "sonner"

export function readableError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (/未配置 Teambition|integrations\.teambition|凭据/.test(message)) {
    return message.includes("未配置") ? message : `未配置 Teambition 凭据：${message}`
  }
  return message
}

export function showError(error: unknown): void {
  toast.error(readableError(error))
}

export function showSuccess(message: string): void {
  toast.success(message)
}

export function showWarning(message: string): void {
  toast.warning(message)
}

export function showMessage(
  message: string,
  type: "success" | "error" | "info" | "warning" = "info",
): void {
  if (type === "success") {
    toast.success(message)
    return
  }
  if (type === "error") {
    toast.error(message)
    return
  }
  if (type === "warning") {
    toast.warning(message)
    return
  }
  toast.message(message)
}

export type ConfirmType = "warning" | "error"

export type ConfirmRequest = {
  message: string
  title: string
  type: ConfirmType
  resolve: (value: boolean) => void
}

let pendingConfirm: ConfirmRequest | null = null
const confirmListeners = new Set<() => void>()

function notifyConfirmListeners(): void {
  for (const listener of confirmListeners) listener()
}

export function getPendingConfirm(): ConfirmRequest | null {
  return pendingConfirm
}

export function subscribeConfirm(listener: () => void): () => void {
  confirmListeners.add(listener)
  return () => {
    confirmListeners.delete(listener)
  }
}

export function settleConfirm(value: boolean): void {
  const current = pendingConfirm
  pendingConfirm = null
  notifyConfirmListeners()
  current?.resolve(value)
}

export function confirmAction(
  message: string,
  title = "请确认",
  type: ConfirmType = "warning",
): Promise<boolean> {
  return new Promise((resolve) => {
    if (pendingConfirm) {
      pendingConfirm.resolve(false)
    }
    pendingConfirm = { message, title, type, resolve }
    notifyConfirmListeners()
  })
}
