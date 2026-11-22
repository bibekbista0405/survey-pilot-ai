(function () {
  'use strict';

  function $(id) { return document.getElementById(id); }

  async function openSidePanel() {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tab = tabs[0];
      if (chrome.sidePanel && chrome.sidePanel.open) {
        await chrome.sidePanel.open({ tabId: tab.id, windowId: tab.windowId });
      }
      window.close();
    } catch (e) {
      chrome.runtime.openOptionsPage();
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    $('openSidePanel').addEventListener('click', openSidePanel);
  });
})();
