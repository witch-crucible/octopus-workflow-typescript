import { useEffect, useState } from "react"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
  getPendingConfirm,
  settleConfirm,
  subscribeConfirm,
  type ConfirmRequest,
} from "@/lib/feedback"

/** Host for imperative confirmAction(); mount once near app root. */
export function ConfirmHost() {
  const [request, setRequest] = useState<ConfirmRequest | null>(getPendingConfirm())

  useEffect(() => {
    return subscribeConfirm(() => setRequest(getPendingConfirm()))
  }, [])

  const open = request !== null
  const isDestructive = request?.type === "error"

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next && getPendingConfirm()) settleConfirm(false)
      }}
    >
      {/* AlertDialog Content omits outside-dismiss handlers; clicks outside never close. */}
      <AlertDialogContent data-confirm-type={request?.type ?? "warning"}>
        <AlertDialogHeader>
          <AlertDialogTitle>{request?.title ?? "请确认"}</AlertDialogTitle>
          <AlertDialogDescription className="whitespace-pre-wrap">
            {request?.message ?? ""}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => settleConfirm(false)}>取消</AlertDialogCancel>
          <AlertDialogAction
            variant={isDestructive ? "destructive" : "default"}
            onClick={() => settleConfirm(true)}
          >
            确认
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
