import { ElMessage, ElMessageBox } from "element-plus"
import "element-plus/dist/index.css"
import "element-plus/theme-chalk/dark/css-vars.css"

window.OctopusElementPlus = {
  message(message, type = "info") {
    ElMessage({ message, type, showClose: true })
  },
  async confirm(message, title = "请确认", type = "warning") {
    try {
      await ElMessageBox.confirm(message, title, {
        type,
        center: true,
        closeOnClickModal: type !== "error",
        confirmButtonText: type === "error" ? "删除" : "确认",
        cancelButtonText: "取消",
        distinguishCancelAndClose: true,
      })
      return true
    } catch (action) {
      if (action === "cancel" || action === "close") return false
      throw action
    }
  },
}
