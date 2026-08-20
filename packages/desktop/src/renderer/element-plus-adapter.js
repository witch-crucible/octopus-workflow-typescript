/**
 * 在不改变现有命令式渲染和 DOM 引用的前提下，把静态及动态基础控件接入
 * Element Plus 的 DOM/主题约定。输入元素只移动、不替换，因此已有事件处理器
 * 和 renderer.js 保存的元素引用保持有效。
 */

function syncDisabledState(control, host) {
  host.classList.toggle("is-disabled", control.disabled)
}

function enhanceButton(button) {
  if (button.classList.contains("el-button")) return
  button.classList.add("el-button", "el-button--small")
  if (button.classList.contains("danger")) {
    button.classList.add("el-button--danger")
  } else if (!button.classList.contains("secondary")) {
    button.classList.add("el-button--primary")
  }
  if (button.classList.contains("secondary")) button.classList.add("is-plain")
  syncDisabledState(button, button)
}

function enhanceInput(input) {
  if (["hidden", "checkbox", "radio", "file", "color"].includes(input.type)) return
  if (input.closest(".el-input")) return

  const host = document.createElement("div")
  host.className = "el-input el-input--small octopus-el-control"
  const wrapper = document.createElement("div")
  wrapper.className = "el-input__wrapper"
  input.before(host)
  host.appendChild(wrapper)
  wrapper.appendChild(input)
  input.classList.add("el-input__inner")
  syncDisabledState(input, host)
}

function enhanceSelect(select) {
  if (select.closest(".el-select")) return

  const host = document.createElement("div")
  host.className = "el-select el-select--small octopus-el-control"
  const wrapper = document.createElement("div")
  wrapper.className = "el-select__wrapper"
  select.before(host)
  host.appendChild(wrapper)
  wrapper.appendChild(select)
  select.classList.add("octopus-el-native-select")
  syncDisabledState(select, host)
}

function enhanceTextarea(textarea) {
  if (textarea.closest(".el-textarea")) return

  const host = document.createElement("div")
  host.className = "el-textarea octopus-el-control"
  textarea.before(host)
  host.appendChild(textarea)
  textarea.classList.add("el-textarea__inner")
  syncDisabledState(textarea, host)
}

function enhanceElementPlus(root = document) {
  const query = (selector) => [
    ...(root instanceof Element && root.matches(selector) ? [root] : []),
    ...root.querySelectorAll(selector),
  ]

  query("button").forEach(enhanceButton)
  query("input").forEach(enhanceInput)
  query("select").forEach(enhanceSelect)
  query("textarea").forEach(enhanceTextarea)
  query(".panel-card, .hub-card, .kanban-card").forEach((element) =>
    element.classList.add("el-card"),
  )
  query(".badge").forEach((element) => element.classList.add("el-tag", "el-tag--small", "is-light"))
  query("table").forEach((table) => table.classList.add("el-table__body"))
}

function syncTheme() {
  document.documentElement.classList.toggle(
    "dark",
    document.documentElement.dataset.theme === "dark",
  )
}

enhanceElementPlus()
syncTheme()

const controlObserver = new MutationObserver((mutations) => {
  for (const mutation of mutations) {
    for (const node of mutation.addedNodes) {
      if (node instanceof Element) enhanceElementPlus(node)
    }
    if (mutation.type !== "attributes") continue
    const control = mutation.target
    const host = control.closest?.(".el-input, .el-select, .el-textarea") || control
    syncDisabledState(control, host)
  }
})

controlObserver.observe(document.body, {
  attributes: true,
  attributeFilter: ["disabled"],
  childList: true,
  subtree: true,
})

new MutationObserver(syncTheme).observe(document.documentElement, {
  attributes: true,
  attributeFilter: ["data-theme"],
})

window.OctopusUI = { enhance: enhanceElementPlus }
