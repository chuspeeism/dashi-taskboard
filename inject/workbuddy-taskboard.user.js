(() => {
  "use strict";

  const ENTRY_ID = "workbuddy-taskboard-entry";
  const PANEL_ID = "workbuddy-taskboard-root";
  const FRAME_ID = "workbuddy-taskboard-frame";
  const TASKBOARD_URL = "http://127.0.0.1:47823/?project=local&host=workbuddy";

  window.__workbuddyTaskboard?.destroy?.();
  document.getElementById(ENTRY_ID)?.remove();
  document.getElementById(PANEL_ID)?.remove();

  const nativeTabs = [...document.querySelectorAll('[role="tab"]')];
  const template = nativeTabs.find((element) =>
    (element.getAttribute("aria-label") || element.textContent || "").includes("自动化"),
  );
  const sidebar = template?.closest(".conversation-sidebar");
  const tabs = template?.parentElement;
  const sidebarGridItem = sidebar?.parentElement;

  if (!template || !sidebar || !tabs || !sidebarGridItem) {
    throw new Error("找不到 WorkBuddy 原生侧边栏");
  }

  const entry = template.cloneNode(true);
  entry.id = ENTRY_ID;
  entry.setAttribute("aria-label", "任务面板");
  entry.setAttribute("aria-selected", "false");
  entry.setAttribute("title", "任务面板");
  entry.classList.remove("active");
  entry.style.order = "60";
  for (const name of [...entry.getAttributeNames()]) {
    if (name.startsWith("data-track") || name.startsWith("dt-")) entry.removeAttribute(name);
  }

  const icon = entry.querySelector("svg");
  if (icon) {
    icon.setAttribute("viewBox", "0 0 16 16");
    icon.innerHTML = '<path fill="currentColor" fill-rule="evenodd" clip-rule="evenodd" d="M4.25 2C2.455 2 1 3.455 1 5.25v5.5C1 12.545 2.455 14 4.25 14h7.5C13.545 14 15 12.545 15 10.75v-5.5C15 3.455 13.545 2 11.75 2h-7.5ZM2.5 5.5a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-7a2 2 0 0 1-2-2v-5Zm8.25-.5a.75.75 0 0 1 .75.75v4.5a.75.75 0 0 1-1.5 0v-4.5a.75.75 0 0 1 .75-.75Z" />';
  }

  const textWalker = document.createTreeWalker(entry, NodeFilter.SHOW_TEXT);
  let textNode = textWalker.nextNode();
  while (textNode) {
    if (textNode.nodeValue.includes("自动化")) {
      textNode.nodeValue = textNode.nodeValue.replace("自动化", "任务面板");
    }
    textNode = textWalker.nextNode();
  }
  tabs.appendChild(entry);

  const panel = document.createElement("section");
  panel.id = PANEL_ID;
  panel.setAttribute("aria-label", "任务面板");
  panel.hidden = true;
  Object.assign(panel.style, {
    position: "fixed",
    top: "0",
    right: "0",
    bottom: "0",
    zIndex: "2147483000",
    overflow: "hidden",
    background: "#fff",
    borderLeft: "1px solid rgba(0, 0, 0, 0.08)",
  });

  const frame = document.createElement("iframe");
  frame.id = FRAME_ID;
  frame.title = "Taskboard";
  frame.src = TASKBOARD_URL;
  Object.assign(frame.style, {
    display: "block",
    width: "100%",
    height: "100%",
    border: "0",
    background: "#fff",
  });
  panel.appendChild(frame);
  document.body.appendChild(panel);

  let active = false;
  let previousNativeTab = null;
  const updateBounds = () => {
    const bounds = sidebarGridItem.getBoundingClientRect();
    panel.style.left = `${Math.round(bounds.right)}px`;
  };
  const close = () => {
    active = false;
    panel.hidden = true;
    entry.classList.remove("active");
    entry.setAttribute("aria-selected", "false");
    if (previousNativeTab?.isConnected) {
      previousNativeTab.classList.add("active");
      previousNativeTab.setAttribute("aria-selected", "true");
    }
  };
  const open = () => {
    active = true;
    updateBounds();
    previousNativeTab = [...tabs.querySelectorAll('[role="tab"]')].find((tab) =>
      tab !== entry && (tab.getAttribute("aria-selected") === "true" || tab.classList.contains("active")),
    ) ?? previousNativeTab;
    for (const tab of tabs.querySelectorAll('[role="tab"]')) {
      tab.classList.remove("active");
      tab.setAttribute("aria-selected", "false");
    }
    entry.classList.add("active");
    entry.setAttribute("aria-selected", "true");
    panel.hidden = false;
  };
  const onDocumentClick = (event) => {
    if (event.target.closest(`#${ENTRY_ID}`)) {
      event.preventDefault();
      event.stopPropagation();
      open();
      return;
    }
    if (active && event.target.closest(".conversation-sidebar")) close();
  };

  document.addEventListener("click", onDocumentClick, true);
  window.addEventListener("resize", updateBounds);
  const resizeObserver = new ResizeObserver(updateBounds);
  resizeObserver.observe(sidebarGridItem);
  updateBounds();

  window.__workbuddyTaskboard = {
    open,
    close,
    destroy() {
      resizeObserver.disconnect();
      window.removeEventListener("resize", updateBounds);
      document.removeEventListener("click", onDocumentClick, true);
      entry.remove();
      panel.remove();
      delete window.__workbuddyTaskboard;
    },
  };
})();
