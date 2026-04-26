// Open the side panel when the toolbar action icon is clicked.
chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((e) => console.warn('[gpuMem] sidePanel.setPanelBehavior failed:', e));
